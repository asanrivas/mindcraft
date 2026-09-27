/**
 * ShieldGuard's pure decision layer. No bot, no network, no clock - `shieldVerdict` and
 * `arrowThreat` take fabricated state and return a verdict, exactly the water_exit/follow
 * pattern in this codebase. The live class (physicsTick loop, entitySpawn arrow tracking,
 * `bot._client.on('set_cooldown', ...)`) is a LATER pass; nothing here touches a bot.
 *
 * Read from mineflayer 4.37.1 in node_modules, and verified against this tree's actual copies:
 *
 * - Raise is `bot.activateItem(true)`, lower is `bot.deactivateItem()` -
 *   `node_modules/mineflayer/lib/plugins/inventory.js` (`activateItem`/`deactivateItem`).
 *   `deactivateItem` writes ONE `block_dig status:5` packet regardless of which item is in use,
 *   and `bot.usingHeldItem` is a single shared boolean (set true in `activateItem`, false in
 *   `deactivateItem` AND in the `set_cooldown` handler). A shield lower and a bow release are
 *   the same wire event - CONFIRMED, not assumed.
 * - mineflayer-auto-eat (`node_modules/mineflayer-auto-eat/dist/index.js`) calls
 *   `bot.deactivateItem(); bot.activateItem(offhand)` inside `eat()`, which every `health` event
 *   handler calls unconditionally - `eat()` itself early-returns unless `bot.food <= startAt`.
 *   So: hungry AND just took damage -> the shield channel is seized the instant it matters most.
 *   CONFIRMED live in this tree's installed version.
 * - mineflayer-pvp (`node_modules/mineflayer-pvp/lib/PVP.js`, `attemptAttack`/`checkExplosion`)
 *   dips the shield around its own melee swing (`deactivateItem` -> attack -> `activateItem`)
 *   and raises it for an ignited creeper, all gated on `this.target` (`bot.pvp.target`).
 *   CONFIRMED live in this tree's installed version - a second driver of the same channel while
 *   pvp is engaged would fight it, exactly the "two owners of one control state" class of bug.
 *
 * The single-owner doctrine (CLAUDE.md: SwimAssist owns the jump key while wet, asserted
 * against real state every tick, never a cached flag) applies here verbatim:
 *
 *   1. ShieldGuard never raises while `useOwner === 'bow'` - the bow lock in bow.js already
 *      refuses to draw while another owner holds the channel, so this is the mirror refusal.
 *   2. While `pvpTargetSet`, pvp owns the shield; ShieldGuard stands down completely (the exact
 *      mirror of AutoJump early-returning in water).
 *   3. Auto-eat cannot be locked out (forking the plugin is out of scope, and eating at low
 *      health is also survival) - ShieldGuard stands down for the `eating` window instead.
 *   4. The verdict is recomputed from OBSERVED state every call. There is no persistent belief
 *      inside this module for a caller to desync from; the caller is expected to re-derive
 *      `hasShieldOffhand`/`useOwner`/`eating`/`pvpTargetSet` from the bot each tick (a slot-45
 *      read, `bot.itemUseOwner`, the autoeat_started/finished window, `!!bot.pvp.target`) rather
 *      than cache "I raised it last tick" - the SwimAssist lesson: assert against
 *      `bot.usingHeldItem`, never a remembered flag.
 *
 * Explicitly NOT gated here: digging. Placing/breaking rides `block_dig status 0/2`, a
 * different packet family from the use-item channel, so there is no conflict to guard against -
 * `tests/shield.test.mjs` documents that a `digging` flag is ignored so nobody "fixes" this in
 * later under the mistaken belief it is a missing case.
 *
 * Wet/submerged is a POLICY refusal, not a discovered API fact: vanilla's swim pose cannot
 * block regardless, and SwimAssist already owns look/vertical control while wet (SWIMMING.md) -
 * a shield verdict raising and calling lookAt mid-swim would add a second look-writer during
 * climbBank's carefully sequenced approach.
 */

const DEFAULTS = {
    raiseHoldMs: 1500,     // hysteresis: keep the shield up this long after the last threat
    meleeRange: 3.0,       // creeper/melee proximity that counts as a threat regardless of metadata
    arrowMissMargin: 1.2,  // body width (0.6) plus margin, in blocks
    hurtRecentMs: 3000,    // "hurt_by" stays actionable this long after the damage event
};

/**
 * Decide whether the shield should be up right now.
 *
 * @param {object} state
 * @param {boolean} state.hasShieldOffhand  slot-45 read: is there actually a shield to raise?
 * @param {boolean} [state.wet]             swim.inWater(bot)
 * @param {boolean} [state.submerged]       swim.isSubmerged(bot)
 * @param {string|null} [state.useOwner]    bot.itemUseOwner: 'bow' | 'shield' | null
 * @param {boolean} [state.eating]          inside the autoeat_started..autoeat_finished window
 * @param {boolean} [state.pvpTargetSet]    !!bot.pvp.target
 * @param {number} [state.cooldownUntil]    ms timestamp the axe-disable cooldown clears; 0 = none
 * @param {number} [state.now]              ms timestamp "now"
 * @param {number} [state.raisedForMs]      how long the shield has been continuously raised
 *                                          (unused by the decision itself - kept for callers
 *                                          that want to log/cap raise duration; NOT a hysteresis
 *                                          input, see note below)
 * @param {number} [state.sinceLastThreatMs] ms since a qualifying threat last existed - this,
 *                                          not raisedForMs, drives the lower-after-quiet hysteresis
 * @param {Array<object>} [state.threats]   [{ kind: 'creeper'|'skeleton'|'arrow'|'hurt_by',
 *                                             dist, ignited, incoming, ticksToImpact, ageMs }]
 * @returns {{ raise: boolean, faceIndex: number|null, reason: string }}
 *   faceIndex indexes into state.threats - which threat the caller should lookAt - or null.
 */
export function shieldVerdict(state) {
    const opts = DEFAULTS;
    const {
        hasShieldOffhand = false,
        wet = false,
        submerged = false,
        useOwner = null,
        eating = false,
        pvpTargetSet = false,
        cooldownUntil = 0,
        now = 0,
        sinceLastThreatMs = null,
        threats = [],
    } = state || {};

    // --- refusals that stand ShieldGuard down entirely, regardless of threats -----------------
    if (!hasShieldOffhand) return { raise: false, faceIndex: null, reason: 'no shield in offhand' };
    if (wet || submerged) return { raise: false, faceIndex: null, reason: 'wet: SwimAssist owns this' };
    if (useOwner === 'bow') return { raise: false, faceIndex: null, reason: 'bow owns the use channel' };
    if (pvpTargetSet) return { raise: false, faceIndex: null, reason: 'pvp owns the shield while engaged' };
    if (eating) return { raise: false, faceIndex: null, reason: 'auto-eat owns the channel' };
    if (cooldownUntil && now < cooldownUntil) return { raise: false, faceIndex: null, reason: 'shield disabled (cooldown)' };

    // --- find the most urgent qualifying threat -----------------------------------------------
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < threats.length; i++) {
        const t = threats[i];
        if (!t || !qualifies(t, opts)) continue;
        const score = threatScore(t);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx !== -1) {
        return { raise: true, faceIndex: bestIdx, reason: `threat: ${threats[bestIdx].kind}` };
    }

    // --- no live threat: hysteresis on how recently one existed --------------------------------
    if (sinceLastThreatMs != null && sinceLastThreatMs < opts.raiseHoldMs) {
        return { raise: true, faceIndex: null, reason: `holding (${sinceLastThreatMs}ms since last threat)` };
    }

    return { raise: false, faceIndex: null, reason: 'no threat' };
}

function qualifies(t, opts) {
    switch (t.kind) {
        case 'creeper':
            // Unconditional at melee range - never trust ignition metadata alone (it is a
            // version-sensitive metadata index, per the plan's own honesty statement). Ignited
            // extends the range at which it counts.
            if (t.ignited) return typeof t.dist !== 'number' || t.dist <= opts.meleeRange * 2;
            return typeof t.dist === 'number' && t.dist <= opts.meleeRange;
        case 'skeleton':
            return typeof t.dist === 'number' && t.dist <= opts.meleeRange;
        case 'arrow':
            return !!t.incoming;
        case 'hurt_by':
            return typeof t.ageMs === 'number' && t.ageMs <= opts.hurtRecentMs;
        default:
            return false;
    }
}

function threatScore(t) {
    // Higher = more urgent. Incoming arrows about to land outrank everything; closer melee
    // threats outrank farther ones; a stale hurt_by is the weakest signal.
    if (t.kind === 'arrow') {
        const ticks = typeof t.ticksToImpact === 'number' ? t.ticksToImpact : 999;
        return 1000 - ticks;
    }
    if (t.kind === 'hurt_by') {
        return 10 - (t.ageMs || 0) / 1000;
    }
    // creeper / skeleton: closer is more urgent
    const dist = typeof t.dist === 'number' ? t.dist : 999;
    return 100 - dist;
}

/**
 * Is an arrow entity on a course to hit the bot, and how soon?
 *
 * Velocity is read one tick AFTER an arrow's `entitySpawn` (`entity_velocity` is a companion
 * packet, per mineflayer's entities.js) - a zero/missing velocity on the spawn tick must read as
 * "not incoming", not throw or produce NaN.
 *
 * @param {{x:number,y:number,z:number}} arrowPos
 * @param {{x:number,y:number,z:number}|null} arrowVel  blocks/tick; null/zero = not yet known
 * @param {{x:number,y:number,z:number}} botPos
 * @param {number} [missMargin] how close the arrow's flight line must pass, in blocks
 * @returns {{ incoming: boolean, ticksToImpact: number|null, missDistance: number|null }}
 */
export function arrowThreat(arrowPos, arrowVel, botPos, missMargin = DEFAULTS.arrowMissMargin) {
    if (!arrowVel) return { incoming: false, ticksToImpact: null, missDistance: null };

    const speedSq = arrowVel.x * arrowVel.x + arrowVel.y * arrowVel.y + arrowVel.z * arrowVel.z;
    if (!(speedSq > 0)) return { incoming: false, ticksToImpact: null, missDistance: null };

    const toBot = { x: botPos.x - arrowPos.x, y: botPos.y - arrowPos.y, z: botPos.z - arrowPos.z };
    const dot = toBot.x * arrowVel.x + toBot.y * arrowVel.y + toBot.z * arrowVel.z;

    // Moving away from (or perpendicular to, at the limit) the bot: never a threat.
    if (dot <= 0) return { incoming: false, ticksToImpact: null, missDistance: null };

    const speed = Math.sqrt(speedSq);
    const tClosest = dot / speedSq; // ticks until closest approach along the velocity ray
    const closest = {
        x: arrowPos.x + arrowVel.x * tClosest,
        y: arrowPos.y + arrowVel.y * tClosest,
        z: arrowPos.z + arrowVel.z * tClosest,
    };
    const missDistance = Math.hypot(closest.x - botPos.x, closest.y - botPos.y, closest.z - botPos.z);

    if (missDistance >= missMargin) {
        return { incoming: false, ticksToImpact: null, missDistance };
    }
    return { incoming: true, ticksToImpact: Math.max(0, tClosest), missDistance };
}
