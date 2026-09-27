import { Vec3 } from 'vec3';
import { isSwimmable } from './tools.js';
import { inWater, isSubmerged, inLava, oxygen, deepestWaterNear, waterDepthBelow } from './swim.js';

/**
 * Measure what the bot can actually do in water on THIS server.
 *
 * This exists because `nav.js` prices water at `waterCost: 15` on the strength of a comment -
 * "with this server's physics the bot barely moves while swimming" - and reading
 * prismarine-physics says that should not be true. Water is the one part of the physics stack
 * the protocol-775 mismatch does not touch: `isInWater` comes from a block scan, and the
 * swim-up branch is checked before the (broken) `onGround` branch.
 *
 * Predicted, from the constants (liquidAcceleration 0.02, waterInertia 0.8, waterGravity 0.005):
 *
 *   forward            0.100 b/t  (2.0 blocks/s)
 *   forward + sprint   0.100 b/t  - sprint is a NO-OP in the library's water branch
 *   boost 0.026        0.130 b/t
 *   boost 0.032        0.160 b/t  - vanilla sprint-swim
 *   rise (jump held)  +0.175 b/t
 *   sink (nothing)    -0.025 b/t
 *
 * A whole cost model rests on which of those two stories is right, so measure rather than argue.
 * Steady-state only: the first 40 ticks of each phase are the inertia ramp (velocity approaches
 * terminal geometrically at 0.8 per tick), so averaging them in understates the result by ~20%.
 */

const RAMP_TICKS = 40;
const SAMPLE_TICKS = 60;
const PHASE_TICKS = RAMP_TICKS + SAMPLE_TICKS;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Face down the longest lane of open water.
 *
 * A phase runs ~100 ticks at up to 0.16 b/t, so it travels up to 16 blocks. A fixed heading
 * beaches the bot on the far bank of any river before the steady-state window even opens, and a
 * beached bot measures walking, not swimming. Re-picked before every phase, so consecutive
 * phases naturally swim back and forth within the same body of water.
 *
 * @returns {{yaw:number, run:number}} run = clear water blocks in that direction
 */
function bestHeading(bot, maxLook = 24) {
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const p = bot.entity.position.floored();
    let best = { yaw: bot.entity.yaw, run: 0 };
    for (const [dx, dz] of dirs) {
        let run = 0;
        for (let i = 1; i <= maxLook; i++) {
            const b = bot.blockAt(new Vec3(p.x + dx * i, p.y, p.z + dz * i));
            if (!b || !isSwimmable(b.name)) break;
            run = i;
        }
        // Normalise diagonals so a 10-block diagonal does not beat a 12-block straight run.
        const norm = run / Math.hypot(dx, dz);
        if (norm > best.run) best = { yaw: Math.atan2(-dx, -dz), run: norm };
    }
    return best;
}

/**
 * Run one phase and return mean per-tick speeds over the steady-state window.
 * @returns {Promise<{horiz:number, vert:number, ticks:number, ramped:boolean, forced:number}>}
 */
async function phase(bot, { forward, jump, sprint, accel, ticks = PHASE_TICKS, from = RAMP_TICKS, to = null }) {
    const samples = [];
    let last = bot.entity.position.clone();
    let n = 0;
    let forced = 0;
    let stuck = true;
    const onForced = () => { forced++; };
    bot.on('forcedMove', onForced);

    const onTick = () => {
        const p = bot.entity.position;
        samples.push({
            horiz: Math.hypot(p.x - last.x, p.z - last.z),
            vert: p.y - last.y,
        });
        last = p.clone();
        n++;
    };

    const savedAccel = bot.physics ? bot.physics.liquidAcceleration : null;
    try {
        if (accel != null && bot.physics) bot.physics.liquidAcceleration = accel;
        bot.setControlState('forward', !!forward);
        bot.setControlState('jump', !!jump);
        bot.setControlState('sprint', !!sprint);
        bot.on('physicsTick', onTick);

        const deadline = Date.now() + ticks * 50 + 2000;
        let dry = 0;
        while (n < ticks && Date.now() < deadline) {
            if (bot.interrupt_code) break;
            // Beached. Anything measured from here is walking, not swimming, so stop and let the
            // caller re-aim rather than quietly averaging land speed into the result.
            if (!inWater(bot)) { if (++dry >= 3) break; } else dry = 0;
            await sleep(50);
        }
        // Did our setting survive the phase? Something else writing liquidAcceleration every
        // tick would otherwise be invisible, and the result would look like "the boost does
        // nothing" rather than "the boost was overwritten". That exact confusion cost a run.
        if (accel != null && bot.physics) stuck = bot.physics.liquidAcceleration === accel;
    } finally {
        bot.removeListener('physicsTick', onTick);
        bot.removeListener('forcedMove', onForced);
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sprint', false);
        if (bot.physics && savedAccel !== null) bot.physics.liquidAcceleration = savedAccel;
    }

    const steady = samples.slice(from, to ?? undefined);
    if (!steady.length) return { horiz: 0, vert: 0, ticks: samples.length, ramped: false, forced, stuck };
    const mean = (key) => steady.reduce((s, x) => s + x[key], 0) / steady.length;
    return { horiz: mean('horiz'), vert: mean('vert'), ticks: samples.length, ramped: true, forced, stuck };
}

/**
 * Run a phase, re-aiming down the longest water lane first. Retries once on a short/beached
 * run so a single unlucky heading does not become the published number.
 */
async function aimedPhase(bot, spec, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const h = bestHeading(bot);
        await bot.look(h.yaw, 0, true);
        await sleep(150);
        const r = await phase(bot, spec);
        if (r.ramped && r.ticks >= RAMP_TICKS + 10) return r;
        console.warn(`[swimProbe] ${label}: short run (${r.ticks} ticks, lane ${h.run.toFixed(0)} blocks), retrying.`);
    }
    return { horiz: 0, vert: 0, ticks: 0, ramped: false };
}

/**
 * Measure swimming end to end.
 *
 * SwimAssist must be told to keep its hands off first - it holds jump whenever the head is
 * submerged, which would contaminate every phase.
 *
 * @returns {Promise<object>} raw numbers, all in blocks/tick.
 */
export async function measureSwim(bot, opts = {}) {
    const assist = bot.swimAssist || null;
    const oxygenStart = oxygen(bot);
    let forcedMoves = 0;
    const onForced = () => { forcedMoves++; };

    if (!inWater(bot)) return { error: 'not_in_water' };
    if (inLava(bot)) return { error: 'in_lava' };

    const savedAccel = bot.physics ? bot.physics.liquidAcceleration : null;
    bot.on('forcedMove', onForced);
    if (assist) assist.setMode('off');

    const out = { submergedAtStart: isSubmerged(bot), oxygenStart, boostAccelDefault: savedAccel };

    try {
        out.lane = bestHeading(bot).run;
        out.depth = waterDepthBelow(bot);

        // Baseline first: this server emits a `position` packet - and therefore a forcedMove -
        // far more often than a vanilla one. Counting corrections without knowing the idle rate
        // says nothing about whether the boost is being rejected. 100 idle ticks, no controls.
        const idle = await phase(bot, {});
        out.baselineForced = idle.forced;
        out.sink = idle.vert;

        // Get the head under before measuring horizontal speed, when the water allows it.
        // Half-submerged at the surface the bot spends part of each tick in the AIR branch, so
        // the numbers are a blend of two physics regimes - which is why the sprint-swim boost
        // read as "no effect" at depth 2: liquidAcceleration only applies while actually in the
        // fluid branch. Nothing holds jump here (SwimAssist is off), so it just sinks.
        out.submerged = isSubmerged(bot);
        if (!out.submerged && out.depth >= 3) {
            const until = Date.now() + 8000;
            while (Date.now() < until && !isSubmerged(bot) && !bot.interrupt_code) await sleep(100);
            out.submerged = isSubmerged(bot);
        }

        // Vertical FIRST, while the bot is still where we submerged it. Measured last, five
        // horizontal phases (~25s, ~50 blocks) had already carried it onto a bank, and a rise
        // measured on dry land reads zero for reasons that have nothing to do with water.
        // Rise uses an EARLY window, not the steady-state one. At 0.175 b/t the bot reaches the
        // surface within ~10 ticks and then just bobs, so averaging ticks 40-100 measures
        // floating and reports ~0 - which reads as "the bot cannot rise" when it plainly can.
        out.rise = (await phase(bot, { jump: true, from: 3, to: 20 })).vert;

        out.fwd = (await aimedPhase(bot, { forward: true }, 'fwd')).horiz;
        out.fwdJump = (await aimedPhase(bot, { forward: true, jump: true }, 'fwdJump')).horiz;
        out.sprint = (await aimedPhase(bot, { forward: true, sprint: true }, 'sprint')).horiz;
        const b26 = await aimedPhase(bot, { forward: true, sprint: true, accel: 0.026 }, 'boost26');
        const b32 = await aimedPhase(bot, { forward: true, sprint: true, accel: 0.032 }, 'boost32');
        out.boost26 = b26.horiz;
        out.boost32 = b32.horiz;
        out.boostHeld = b26.stuck !== false && b32.stuck !== false;
    } finally {
        if (bot.physics && savedAccel !== null) bot.physics.liquidAcceleration = savedAccel;
        bot.removeListener('forcedMove', onForced);
        bot.clearControlStates();
        if (assist) assist.setMode('auto');
    }

    out.forcedMoves = forcedMoves;
    out.oxygenEnd = oxygen(bot);
    // Vertical rates need water deep enough to actually float in. Point at some if this is not.
    if (out.depth < 3) {
        const deep = deepestWaterNear(bot, 64, 4);
        if (deep && deep.depth > out.depth) out.deeperAt = deep;
    }
    return out;
}

/**
 * The decision rule from the plan, applied to a measurement. Pure, so it is unit-testable.
 *
 * The threshold that matters is 0.08 b/t = 1.6 blocks/s = 96 blocks/min, against this bot's
 * measured overland travel of ~25 blocks/min. Anything at or above that means routing around
 * water is costing more than swimming through it.
 *
 * @returns {{verdict:'swim'|'neutral'|'avoid', reason:string}}
 */
export function verdictFor({ fwd, fwdJump, forcedMoves = 0, baselineForced = null, boost26, boost32, sprint, depth = null }) {
    // The fastest control combination the bot can actually hold is what a route should be
    // costed against, so take the best of them rather than plain `fwd`. Measured live: forward
    // alone 0.098, +jump 0.117, +sprint 0.127 - judging on `fwd` would understate swimming by
    // 30%. (Sprint is a no-op in the library's water branch, but near the surface the bot spends
    // part of each tick in the AIR branch, where sprint very much applies.)
    const best = Math.max(fwd ?? 0, fwdJump ?? 0, sprint ?? 0);
    if (!Number.isFinite(best) || best === 0) return { verdict: 'invalid', reason: 'no measurement' };

    // Depth 0 means the bot was never in water and the run measures walking.
    //
    // Shallower-than-2 does NOT invalidate a horizontal measurement, though it looked like it
    // would: the first live run read 0.021 b/t in one-block-deep water and the obvious story was
    // "the bot is standing on the riverbed in the broken land-physics regime". It was not. A
    // clean re-run in the SAME one-block water read 0.098 b/t - textbook water terminal speed -
    // and the first run turned out to have been interrupted by the self-prompt loop. The AABB
    // that decides isInWater still intersects water at depth 1, so water physics apply.
    // Vertical rates are a different matter: they need room to float, hence `verticalValid`.
    if (depth === 0) {
        return { verdict: 'invalid', reason: 'not in water - this measures walking' };
    }

    // Corrections only mean something relative to this server's idle rate; it emits position
    // packets constantly, so an absolute count is noise.
    if (baselineForced !== null && baselineForced > 0) {
        const perPhase = forcedMoves / 7;
        if (perPhase > baselineForced * 2) {
            return { verdict: 'avoid', reason: `rubber-banding ${(perPhase / baselineForced).toFixed(1)}x above idle baseline` };
        }
    }

    const shallowNote = (depth !== null && depth < 3) ? '; vertical rates NOT measurable at this depth' : '';
    if (best >= 0.08) {
        // Judge the boost on the BEST boosted phase, not the last one. The 0.032 phase runs last,
        // by which point ~40 blocks of swimming has often carried the bot onto a bank, and a
        // beached phase reads low - which reported "boost had no effect" in the same run where
        // the 0.026 phase clearly showed one (0.127 vs 0.098 baseline).
        const bestBoost = Math.max(boost26 ?? 0, boost32 ?? 0);
        const boostNote = (bestBoost > 0 && typeof sprint === 'number' && bestBoost <= sprint * 1.05)
            ? '; boost had no effect, ship sprint-swim disabled' : '';
        return { verdict: 'swim', reason: `${(best * 20).toFixed(2)} blocks/s - faster than walking here${boostNote}${shallowNote}` };
    }
    if (best >= 0.04) return { verdict: 'neutral', reason: `${(best * 20).toFixed(2)} blocks/s - comparable to walking` };
    return { verdict: 'avoid', reason: `${(best * 20).toFixed(2)} blocks/s - the waterCost:15 comment stands` };
}

/** One machine-checkable line, in this project's VERIFIED style. */
export function formatProbe(m) {
    if (m.error) return `SWIM PROBE FAILED: ${m.error}.`;
    const bs = (v) => `${v.toFixed(3)} b/t (${(v * 20).toFixed(2)} b/s)`;
    const v = verdictFor(m);
    return `VERIFIED SWIM PROBE: fwd=${bs(m.fwd)} | +jump=${m.fwdJump.toFixed(3)} | `
        + `+sprint=${m.sprint.toFixed(3)} | boost26=${m.boost26.toFixed(3)} | boost32=${m.boost32.toFixed(3)} | `
        + `rise=${m.rise >= 0 ? '+' : ''}${m.rise.toFixed(3)} | sink=${m.sink.toFixed(3)} | `
        + `depth=${m.depth}b ${m.submerged ? '(SUBMERGED)' : '(at surface)'} | lane=${(m.lane ?? 0).toFixed(0)}b | `
        + `forcedMove=${m.forcedMoves} (idle baseline ${m.baselineForced}/phase) | `
        + `oxygen ${m.oxygenStart}->${m.oxygenEnd} | `
        + `boostHeld=${m.boostHeld === false ? 'NO (overwritten)' : 'yes'} | `
        + `VERDICT=${v.verdict} (${v.reason})`
        + (m.deeperAt
            ? ` | deeper water: ${m.deeperAt.depth}b at (${m.deeperAt.pos.x.toFixed(0)}, `
              + `${m.deeperAt.pos.y.toFixed(0)}, ${m.deeperAt.pos.z.toFixed(0)}), `
              + `${m.deeperAt.distance.toFixed(0)} blocks away`
            : '');
}
