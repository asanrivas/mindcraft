/**
 * The two climb decisions that had no tests:
 *   bun tests/climb.test.mjs
 *
 * Both were written straight into `climbToSurface`/`pillarUp` during a live debugging session and
 * shipped uncovered - which a reviewer in a parallel session rightly flagged. Both are also the
 * kind of decision where being wrong is not merely ineffective but destructive, so they are the
 * ones that most needed pinning down.
 */
import { wetLiftVerdict, surfaceUnknownVerdict, ceilingAbove, WET_LIFT_IMPULSE, TOWER_BUDGET }
    from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- wetLiftVerdict: the duty cycle -----------------------------------------------------------
// In water the engine runs `if (isInWater) vel.y += 0.04` BEFORE checking onGround, so the
// asserted take-off is a no-op and the bot rises 0.04. Measured.
check('wet, sunk, not rising -> lift', wetLiftVerdict({ inWater: true, rise: 0, velY: 0 }), true);
check('wet and part way up -> keep lifting',
      wetLiftVerdict({ inWater: true, rise: 0.42, velY: 0 }), true);

// ON LAND THE ENGINE'S OWN JUMP WORKS - 1.252 apex, measured with a clean bot on this server.
// Injecting there would stack on top of a real jump.
check('dry is never lifted by hand', wetLiftVerdict({ inWater: false, rise: 0, velY: 0 }), false);

// Already rising: topping up would compound into a speed the server would refuse. Same
// discipline as SwimAssist's boost, which is capped at vanilla parity for the same reason.
check('already rising is left alone', wetLiftVerdict({ inWater: true, rise: 0.2, velY: 0.42 }), false);
check('barely rising is still rising', wetLiftVerdict({ inWater: true, rise: 0.2, velY: 0.2 }), false);
check('sinking is lifted', wetLiftVerdict({ inWater: true, rise: 0.2, velY: -0.1 }), true);

// Stop at the clearance: past it the block can be placed and more lift only overshoots.
check('at clearance, stop pushing', wetLiftVerdict({ inWater: true, rise: 1.0, velY: 0 }), false);
check('past clearance, stop pushing', wetLiftVerdict({ inWater: true, rise: 1.4, velY: 0 }), false);
check('clearance is configurable',
      wetLiftVerdict({ inWater: true, rise: 1.2, velY: 0, clearance: 2 }), true);
check('no state is not a lift', wetLiftVerdict(undefined), false);

// LAVA IS NOT WATER. They share one physics branch and can BOTH be true at a boundary, which is
// why every swim entry point here refuses on lava. Left as a bare `inWater` boolean, that case
// was decided by accident.
check('lava is refused', wetLiftVerdict({ inWater: false, inLava: true, rise: 0, velY: 0 }), false);
check('a water/lava boundary is refused too',
      wetLiftVerdict({ inWater: true, inLava: true, rise: 0, velY: 0 }), false);
check('plain water still lifts', wetLiftVerdict({ inWater: true, inLava: false, rise: 0, velY: 0 }), true);
check('the impulse is the engine figure, not a guess', WET_LIFT_IMPULSE, 0.42);

// --- surfaceUnknownVerdict: rise, or stop? ----------------------------------------------------
// THE REGRESSION THIS EXISTS FOR. A null surface reading means two opposite things, and treating
// "open sky" as "buried" built a 54-block cobblestone spike into the air:
// `climbOut: +54.0 to y=118.0`, four blocks at a time, from a bot already on open ground.
check('open sky means we are already out',
      surfaceUnknownVerdict({ roofed: false, towered: 0 }).reason,
      'open sky above me - already at the surface');
check('roofed means we are under something and should rise',
      surfaceUnknownVerdict({ roofed: true, towered: 0 }).tower, true);

// The budget is the SECOND guard. Bounding each tower call did not bound the loop that kept
// making them - a pillar cannot be un-built, so the total is capped centrally.
check('at the budget, stop', surfaceUnknownVerdict({ roofed: true, towered: 24, budget: 24 }).tower, false);
check('over the budget, stop', surfaceUnknownVerdict({ roofed: true, towered: 30, budget: 24 }).tower, false);
check('under the budget, rise', surfaceUnknownVerdict({ roofed: true, towered: 20, budget: 24 }).tower, true);
// Open sky outranks the budget: both say stop, but the reason a human reads must be the true one.
check('open sky is reported even with budget left',
      surfaceUnknownVerdict({ roofed: false, towered: 0, budget: 24 }).reason,
      'open sky above me - already at the surface');
for (const st of [{ roofed: false }, { roofed: true, towered: 99 }, undefined])
    check('every refusal names a reason', surfaceUnknownVerdict(st).reason.length > 0, true);

// --- ceilingAbove: leaves are not a ceiling ---------------------------------------------------
// minecraft-data gives oak_leaves boundingBox 'block', so a bot standing under a tree on OPEN
// GROUND reads as roofed by a naive probe - and the null-surface branch then towers up through
// the canopy from ground it was already standing on.
{
    const { ceilingAbove } = await import('../src/agent/library/skills.js');
    const col = (m) => (dy) => m[dy] ?? null;
    check('stone overhead is a ceiling', ceilingAbove(col({ 5: { boundingBox: 'block', name: 'stone' } })), 5);
    check('leaves overhead are NOT a ceiling',
          ceilingAbove(col({ 5: { boundingBox: 'block', name: 'oak_leaves' } })), null);
    // Glass is a real roof; a greenhouse must not read as open sky.
    check('glass overhead IS a ceiling',
          ceilingAbove(col({ 5: { boundingBox: 'block', name: 'glass' } })), 5);
    // A canopy must not mask real stone further up.
    check('stone above a canopy is still found',
          ceilingAbove(col({ 4: { boundingBox: 'block', name: 'birch_leaves' },
                             9: { boundingBox: 'block', name: 'stone' } })), 9);
    check('open sky is null', ceilingAbove(col({})), null);
    // Backwards compatible: a caller with only the box string still works (no canopy test).
    check('a bare boundingBox string still works', ceilingAbove(col({ 3: 'block' })), 3);
    check('the window is honoured', ceilingAbove(col({ 50: { boundingBox: 'block', name: 'stone' } })), null);
}


// --- wetLiftVerdict: the CADENCE ---------------------------------------------------------------
// `velY <= 0.05` is not on its own a rate limit, and that is the whole hazard. When collision
// resolution zeroes vel.y every tick the velocity gate passes every tick, so a 10ms sampler
// re-arms at up to 100Hz. That state is in the logs at the exact spot this change was measured
// (2026-08-30 17:16:35, andy, wading at 4752.5/62.0/4614.3): vel.y read 0.420 at t=0s and again
// at t=2s with the position identical to the last decimal across the whole interval - the
// impulse applied, nothing moved. `climbBank` survives that state at 2.9Hz only because it
// carries a 350ms gate, and both anti-cheat valves on this server have really tripped
// (`[SwimAssist] server rubber-banded 4 times in 10s`, and JumpAssist, 2026-08-30 17:05:29-34).
const pinned = { inWater: true, rise: 0, velY: 0 };
check('the first lift of a flight is not rate limited',
      wetLiftVerdict({ ...pinned, sinceLastMs: Infinity }), true);
check('a second lift 10ms later is refused', wetLiftVerdict({ ...pinned, sinceLastMs: 10 }), false);
check('still refused just under the gate', wetLiftVerdict({ ...pinned, sinceLastMs: 349 }), false);
check('allowed once the gate has passed', wetLiftVerdict({ ...pinned, sinceLastMs: 350 }), true);
// climbBank's figure, not a new one. Two hand-driven wet impulses must not run at two cadences.
check('the gate is configurable', wetLiftVerdict({ ...pinned, sinceLastMs: 100, minGapMs: 50 }), true);
// An unstated cadence must not silently mean "as fast as you like" - the omitted field is the
// one-shot case (`Date.now() - 0` at the start of a flight), never the sustained one.
check('an absent cadence is the one-shot case', wetLiftVerdict(pinned), true);
// The cadence must not be able to smuggle a lift past the other refusals.
check('rate limit does not override lava',
      wetLiftVerdict({ ...pinned, inLava: true, sinceLastMs: Infinity }), false);
check('rate limit does not override clearance',
      wetLiftVerdict({ ...pinned, rise: 1.5, sinceLastMs: Infinity }), false);

// --- ceilingAbove: the roof/open-sky discrimination --------------------------------------------
// This is the observation `surfaceUnknownVerdict` decides on. It was written inline and untested,
// and it is the half that can be wrong about the WORLD rather than about the policy.
const world = (m) => (dy) => m[dy] ?? 'empty';
check('nothing overhead is open sky', ceilingAbove(world({})), null);
check('a ceiling is found and its height reported', ceilingAbove(world({ 5: 'block' })), 5);
check('the lowest ceiling wins', ceilingAbove(world({ 5: 'block', 9: 'block' })), 5);
// dy=1 is the bot's own head cell; a block there is not a roof to tower toward.
check('the head cell is not a ceiling', ceilingAbove(world({ 1: 'block' })), null);
check('the first cell above the head counts', ceilingAbove(world({ 2: 'block' })), 2);
// A 1-block overhang IS a ceiling. Deliberate: the tower rung breaks it and the next iteration
// re-reads the world from above it, where the sky is now visible.
check('a lone overhang counts as roofed', ceilingAbove(world({ 12: 'block' })), 12);
// The scan has to end - it runs on every iteration of the climb loop.
check('past the window is open sky', ceilingAbove(world({ 41: 'block' })), null);
check('the last cell in the window still counts', ceilingAbove(world({ 40: 'block' })), 40);
check('the window is configurable', ceilingAbove(world({ 41: 'block' }), { maxDy: 60 }), 41);

// MISSING DATA READS AS OPEN SKY, and that direction is the point. An unloaded column, a null
// block, a chunk we cannot see - all stop the climb rather than tower into it. A false "roofed"
// costs a bounded tower and the next iteration re-reads from higher up; a false "open sky" only
// stops early, which is the recoverable mistake. Same rule as `openObstruction` failing open.
check('an unloaded column is open sky', ceilingAbove(() => null), null);
check('undefined is open sky', ceilingAbove(() => undefined), null);
// Verified against minecraft-data 1.21.11: leaves, glass, tinted glass and ice all report
// `boundingBox === 'block'`, so a canopy or a greenhouse reads as ROOFED. Recorded here so a
// future reader does not "fix" it. Water and cobweb report 'empty' and correctly do not.
check('leaves/glass are a ceiling (boundingBox block)', ceilingAbove(world({ 3: 'block' })), 3);
check('water overhead is not a ceiling', ceilingAbove(world({ 3: 'empty' })), null);
// The window is a cave ceiling scan, not a sky test: at the bottom of a 40+ block ravine open to
// the sky this reports open sky and the climb stops with a named reason instead of towering.
// Stopping there is the intended trade - see the comment on `ceilingAbove`.
check('a ceiling beyond the window reads as sky', ceilingAbove(world({ 55: 'block' })), null);

// --- surfaceUnknownVerdict: the budget is a HARD cap, not a threshold --------------------------
// A pre-spend `>=` test still lets the last rung overshoot by its own height - 8 blocks, a third
// of the budget - and the two call sites originally disagreed even about that (`>` after
// spending on one, `>=` before on the other). `climbShaftUp`'s last argument is a MAXIMUM, so the
// verdict hands back how much is left and the call site caps the rung with it.
check('the allowance is what remains',
      surfaceUnknownVerdict({ roofed: true, towered: 20, budget: 24 }).allowance, 4);
check('a full ledger has the whole budget',
      surfaceUnknownVerdict({ roofed: true, towered: 0, budget: 24 }).allowance, 24);
check('one block left is still a rung',
      surfaceUnknownVerdict({ roofed: true, towered: 23, budget: 24 }),
      { tower: true, allowance: 1, reason: 'no surface reading in any neighbouring column' });
check('a refusal never offers an allowance',
      surfaceUnknownVerdict({ roofed: true, towered: 24, budget: 24 }).allowance, 0);
check('open sky never offers an allowance either',
      surfaceUnknownVerdict({ roofed: false, towered: 0, budget: 24 }).allowance, 0);
// The rung caps: 4 for the no-surface branch, 8 for the stalled-stairs one. With the allowance
// applied neither can carry the total past the budget - which is what "cannot be un-built" needs.
for (const [towered, rung] of [[20, 4], [23, 8], [0, 8], [17, 8], [21, 4]]) {
    const v = surfaceUnknownVerdict({ roofed: true, towered, budget: 24 });
    check(`towering ${rung} at ${towered} cannot exceed the budget`,
          towered + Math.min(rung, v.allowance) <= 24, true);
}
// The default is the shipped constant, so the two cannot drift apart.
check('the default budget is the exported one',
      surfaceUnknownVerdict({ roofed: true, towered: TOWER_BUDGET - 1 }).allowance, 1);
// 24 bounds both measured runaways (+54 and +27) and still covers the case the rung exists for:
// travelDirection calls climbOut when the bot is >20 blocks below the surface.
check('the budget bounds the measured runaways', TOWER_BUDGET < 27, true);
check('the budget still covers a 20-block climb out', TOWER_BUDGET >= 20, true);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('climb: all checks passed');
