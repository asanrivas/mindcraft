/**
 * The water-exit decision, as a pure function. No server, no bot:
 *   bun tests/water_exit.test.mjs
 *
 * WHY THIS IS A TICK-LEVEL PREDICATE. The old answer came out of followPath's stall ladder,
 * whose branch order is: progress -> waypointMs(6000) -> afloat -> pinnedMs(2500) && hops>=2
 * -> hop(700ms). From a dead stop that is a hop at 700ms, a hop at 1400ms, and the FIRST climb
 * attempt at 2500ms. Measured on this server, one real bank at (4434, 62, 4682):
 *
 *   16:02:02  leg 3 ends
 *   16:02:05  pinned   16:02:07 pinned   16:02:11 pinned   16:02:13 pinned
 *   16:02:14  leg 4: moved=-0.01 -> RECOVERY      <- 12s spent CONCLUDING it was stuck
 *   16:02:14  climbBank attempt 1 -> jammed
 *   16:02:20  climbBank attempt 2 -> OUT
 *
 * Twelve seconds of detection for six seconds of climbing. Worse, the routine the 2500ms branch
 * reaches is `climbAhead`, which only handles rises of 2 or 3 - so a ONE-block bank fell through
 * to `digAhead` and the bot mined the shore at water level. That is the "Andy dug a canal"
 * behaviour, reached by exactly this path.
 *
 * A false positive is expensive: climbBank is an 8-second commitment that hijacks the leg. So
 * the refusals below carry more weight than the acceptance, and every one of them is a branch a
 * live test could only reach if the world happened to be in that shape.
 */
import { waterExitVerdict } from '../src/agent/library/nav.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); failures++; }
};
// A one-block bank dead ahead, in reach, nothing in the way: the case that must fire.
const OK = {
    wet: true, lava: false, faceAhead: true, riseNeeded: 1,
    landingStandable: true, headroom: true, gapToFace: 0.85,
    cooldown: false, attemptsSpent: false,
};
const climbs = (label, over) => check(label, waterExitVerdict({ ...OK, ...over }).climb, true);
const refuses = (label, over) => check(label, waterExitVerdict({ ...OK, ...over }).climb, false);

// --- the case it exists for ------------------------------------------------------------------
climbs('one-block bank in reach', {});
climbs('flush against the face', { gapToFace: 0.80 });
climbs('at the edge of the reach window', { gapToFace: 1.6 });

// --- dry land is not this function's business -------------------------------------------------
refuses('not in water', { wet: false });
check('...and says why', waterExitVerdict({ ...OK, wet: false }).reason, 'not in water');

// --- lava. Both fluids share ONE physics branch and can read true together at a boundary, so
// every swim entry point refuses on lava and so must this one - it routes into climbBank.
refuses('lava', { lava: true });
refuses('lava wins even with a perfect bank', { lava: true, faceAhead: true, gapToFace: 0.8 });

// --- geometry that is not a one-block bank ----------------------------------------------------
refuses('open water, nothing ahead', { faceAhead: false });
// 2 and 3 are climbLedgeByPlacing's job; climbBank caps at maxRise 1 by measurement - at the
// surface the bot gets neither the swim impulse nor the (dead) land jump.
refuses('two-block wall', { riseNeeded: 2 });
refuses('three-block wall', { riseNeeded: 3 });
refuses('a hole, not a bank', { riseNeeded: 0 });
refuses('overhang - nowhere to stand on top', { landingStandable: false });
refuses('ceiling over the bank', { headroom: false });

// --- distance. Committing 8s to a wall we are not touching wastes the leg. --------------------
refuses('bank too far to be what is stopping us', { gapToFace: 2.4 });
refuses('across the pool', { gapToFace: 6.0 });

// --- the gates that replace what the stall timer used to give for free -----------------------
// Without a cooldown a failed climb re-fires on the next 100ms iteration, forever.
refuses('cooling down after a failed attempt', { cooldown: true });
// And after a few tries the existing ladder (footing, dig, replan) deserves its turn - this
// must never become a loop that outlives the leg.
refuses('attempts spent, hand back to the ladder', { attemptsSpent: true });

// --- precedence: a refusal must not be overridden by a good-looking geometry -------------------
check('cooldown refusal names itself',
    waterExitVerdict({ ...OK, cooldown: true }).reason, 'attempt cooling down');
check('rise refusal reports the actual rise',
    waterExitVerdict({ ...OK, riseNeeded: 2 }).reason, 'rise is 2, not a one-block bank');

// --- every refusal carries a reason; a silent false is undebuggable in a 100ms loop -----------
for (const [label, over] of [
    ['dry', { wet: false }], ['lava', { lava: true }], ['no face', { faceAhead: false }],
    ['rise', { riseNeeded: 4 }], ['landing', { landingStandable: false }],
    ['headroom', { headroom: false }], ['far', { gapToFace: 9 }],
    ['cooldown', { cooldown: true }], ['spent', { attemptsSpent: true }],
]) {
    const r = waterExitVerdict({ ...OK, ...over });
    if (!r.reason || typeof r.reason !== 'string') { console.error(`FAIL ${label}: no reason given`); failures++; }
}

console.log(failures === 0 ? 'water_exit: all checks passed' : `water_exit: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
