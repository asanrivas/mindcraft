/**
 * ShieldGuard's pure decision layer. No server, no bot:
 *   bun tests/shield.test.mjs
 *
 * The refusals matter more than the raises - shieldVerdict shares ONE wire channel
 * (`bot.usingHeldItem` / `block_dig status:5`) with bow release, and mineflayer-auto-eat and
 * mineflayer-pvp both drive that same channel unconditionally while active (verified against
 * this tree's installed copies - see shield_guard.js's header for the exact source lines).
 * A verdict that raises into any of those is the shield-equivalent of the jump-key contention
 * documented in docs/SWIMMING.md, which killed buoyancy silently while `!stats` still reported
 * `jump=true`. The corresponding case here is "do not trust a cached flag" - shieldVerdict takes
 * no memory of its own; every case below passes freshly observed state.
 */
import { shieldVerdict, arrowThreat } from '../src/agent/library/shield_guard.js';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}: got ${g}, expected ${w}`); failures++; }
};
const checkTrue = (label, cond) => {
    if (!cond) { console.error(`FAIL ${label}`); failures++; }
};

const BASE = {
    hasShieldOffhand: true,
    wet: false,
    submerged: false,
    useOwner: null,
    eating: false,
    pvpTargetSet: false,
    cooldownUntil: 0,
    now: 1000,
    sinceLastThreatMs: null,
    threats: [],
};

// -------------------------------------------------------------------------------------------
// MUST raise
// -------------------------------------------------------------------------------------------

checkTrue('creeper at melee range raises unconditionally',
    shieldVerdict({ ...BASE, threats: [{ kind: 'creeper', dist: 2.9 }] }).raise);

checkTrue('ignited creeper at 5 blocks raises (extended range)',
    shieldVerdict({ ...BASE, threats: [{ kind: 'creeper', dist: 5, ignited: true }] }).raise);

{
    const r = shieldVerdict({ ...BASE, threats: [{ kind: 'arrow', incoming: true, missDistance: 0.8, ticksToImpact: 9 }] });
    checkTrue('incoming arrow raises', r.raise);
    check('incoming arrow points the caller at threat 0', r.faceIndex, 0);
}

checkTrue('recent hurt_by (known source, in front) raises',
    shieldVerdict({ ...BASE, threats: [{ kind: 'hurt_by', ageMs: 1200 }] }).raise);

{
    // Models the channel being stolen and re-asserted: raisedForMs is caller-tracked bookkeeping,
    // not a decision input, so the verdict must not waver when it resets to 0.
    const withThreat = (raisedForMs) => shieldVerdict({
        ...BASE, raisedForMs, threats: [{ kind: 'creeper', dist: 2 }],
    }).raise;
    checkTrue('raise persists across a raisedForMs of 4000', withThreat(4000));
    checkTrue('raise persists even when raisedForMs resets to 0 (channel re-stolen)', withThreat(0));
}

// -------------------------------------------------------------------------------------------
// MUST NOT raise - each refusal verified against the actual mineflayer/plugin source, not
// assumed (see shield_guard.js header for the exact files/lines).
// -------------------------------------------------------------------------------------------

check('bow owns the channel: verdict refuses even with a live creeper',
    shieldVerdict({ ...BASE, useOwner: 'bow', threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('pvp target set: pvp manages its own dip/raise around the swing',
    shieldVerdict({ ...BASE, pvpTargetSet: true, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('auto-eat mid-cycle: it owns the channel for ~1.6s regardless of threat',
    shieldVerdict({ ...BASE, eating: true, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('shield disabled (axe cooldown window)',
    shieldVerdict({ ...BASE, cooldownUntil: 5000, now: 4000, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('no shield in offhand: nothing to raise',
    shieldVerdict({ ...BASE, hasShieldOffhand: false, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('wet: SwimAssist owns the jump key and look while swimming; ShieldGuard stands down',
    shieldVerdict({ ...BASE, wet: true, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('submerged: same policy refusal as wet',
    shieldVerdict({ ...BASE, submerged: true, threats: [{ kind: 'creeper', dist: 1 }] }).raise, false);

check('arrow flying away is not a threat',
    shieldVerdict({ ...BASE, threats: [{ kind: 'arrow', incoming: false, missDistance: null, ticksToImpact: null }] }).raise, false);

check('arrow passing wide (missDistance > margin) is not a threat',
    shieldVerdict({ ...BASE, threats: [{ kind: 'arrow', incoming: false, missDistance: 3.5, ticksToImpact: 5 }] }).raise, false);

check('stale hurt_by (past the actionable window) does not raise',
    shieldVerdict({ ...BASE, threats: [{ kind: 'hurt_by', ageMs: 9000 }] }).raise, false);

check('no threat, never raised: refuses',
    shieldVerdict({ ...BASE }).raise, false);

// --- hysteresis: both directions -------------------------------------------------------------
checkTrue('threat gone < 1.5s ago: still raised (hysteresis)',
    shieldVerdict({ ...BASE, sinceLastThreatMs: 900 }).raise);
check('threat gone > 1.5s ago: lowered',
    shieldVerdict({ ...BASE, sinceLastThreatMs: 2000 }).raise, false);

// --- explicitly not gated: digging rides a different packet family (block_dig status 0/2), not
// the use-item channel, so shieldVerdict must ignore it entirely. This test exists so nobody
// "fixes" this into a refusal later under the mistaken belief it is a missing case.
{
    const withDigging = shieldVerdict({ ...BASE, digging: true, threats: [{ kind: 'creeper', dist: 1 }] });
    const withoutDigging = shieldVerdict({ ...BASE, threats: [{ kind: 'creeper', dist: 1 }] });
    check('a digging flag does not affect the verdict', withDigging.raise, withoutDigging.raise);
}

// --- refusals must be diagnosable, not silent (same discipline as waterExitVerdict) ----------
for (const [label, over] of [
    ['bow', { useOwner: 'bow' }], ['pvp', { pvpTargetSet: true }], ['eating', { eating: true }],
    ['cooldown', { cooldownUntil: 5000, now: 4000 }], ['no shield', { hasShieldOffhand: false }],
    ['wet', { wet: true }], ['submerged', { submerged: true }], ['idle', {}],
]) {
    const r = shieldVerdict({ ...BASE, ...over });
    if (!r.reason || typeof r.reason !== 'string') { console.error(`FAIL ${label}: no reason given`); failures++; }
}

// -------------------------------------------------------------------------------------------
// arrowThreat geometry
// -------------------------------------------------------------------------------------------

{
    // Head-on: arrow flying straight at the bot from 9 blocks away, speed 3 b/t.
    const r = arrowThreat({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 9, y: 0, z: 0 });
    checkTrue('head-on arrow is incoming', r.incoming);
    check('head-on arrow has ~0 miss distance', Math.round(r.missDistance * 100) / 100, 0);
    check('head-on ticksToImpact is 3', r.ticksToImpact, 3);
}

{
    // Oblique hit: passes close enough to the bot's body (< 1.2) to count.
    const r = arrowThreat({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 1 }, { x: 9, y: 0, z: 3 });
    checkTrue('oblique near-miss counts as incoming', r.incoming);
}

{
    // Oblique miss: same heading, but the bot is far enough off the line to be safe.
    const r = arrowThreat({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 9, y: 0, z: 10 });
    check('oblique wide miss is not incoming', r.incoming, false);
}

{
    // Zero/unknown velocity: the spawn tick, before entity_velocity arrives. Must not be NaN.
    const r1 = arrowThreat({ x: 0, y: 0, z: 0 }, null, { x: 5, y: 0, z: 0 });
    check('null velocity (pre entity_velocity) is not incoming', r1.incoming, false);
    check('null velocity ticksToImpact is null, not NaN', r1.ticksToImpact, null);

    const r2 = arrowThreat({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    check('zero velocity is not incoming', r2.incoming, false);
    checkTrue('zero velocity does not produce NaN', !Number.isNaN(r2.missDistance ?? 0));
}

console.log(failures === 0 ? 'shield: all checks passed' : `shield: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
