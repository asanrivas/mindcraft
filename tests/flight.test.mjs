/**
 * Creative flight: where to hover, and when flying is available at all.
 *
 *   bun tests/flight.test.mjs
 *
 * The builder walked everywhere because of a measurement that no longer holds ("1,870 forcedMove
 * corrections; the server rejects every flown movement packet"). Re-measured 2026-08-31 with
 * tools/fly_probe.mjs: 0 corrections in 4.7s and 4/4 placements from the air.
 *
 * The first re-run still failed 4/4 - because it drove the climb by setting position AND
 * velocity, so the engine kept integrating after the steering stopped and the bot sailed 8
 * blocks past its target, then tried to place from 15 blocks out of reach. That is why the
 * standoff geometry below is worth testing: "flight is broken" and "the bot is nowhere near the
 * block" produce identical logs.
 */
import { hoverPointFor, hoverCandidates, hoverIsClear, placementPose, canFly, FLY_REACH, EYE_HEIGHT } from '../src/agent/library/flight.js';
import { Vec3 } from 'vec3';

let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const P = { x: 10, y: 70, z: 20 };   // cell centre is (10.5, ., 20.5)

// Approaching from the east: hover to the east, 2 blocks out.
const east = hoverPointFor(P, { x: 30, y: 70, z: 20.5 });
check('hovers on the side we came from (east)', [near(east.x, 12.5), near(east.z, 20.5)], [true, true]);
// Slightly ABOVE the cell, never level with it: the click ray then has an honest angle onto the
// face instead of skimming it.
check('hovers just above the cell', near(east.y, 70.2), true);

const west = hoverPointFor(P, { x: -30, y: 70, z: 20.5 });
check('and on the west when we came from the west', near(west.x, 8.5), true);

const north = hoverPointFor(P, { x: 10.5, y: 70, z: -30 });
check('north approach hovers north', near(north.z, 18.5), true);

// Standing exactly over the cell gives no bearing at all - pick one rather than dividing by
// zero and hovering at NaN, which is the same class of bug fleeFrom guards against.
const onTop = hoverPointFor(P, { x: 10.5, y: 75, z: 20.5 });
check('a zero bearing does not produce NaN', [Number.isFinite(onTop.x), Number.isFinite(onTop.z)], [true, true]);
check('and falls back to a definite side', [near(onTop.x, 12.5), near(onTop.z, 20.5)], [true, true]);
check('a missing "from" is safe too', Number.isFinite(hoverPointFor(P, null).x), true);

// The standoff must be inside interaction range or the hover point is useless by construction.
const d = Math.hypot(east.x - (P.x + 0.5), east.z - (P.z + 0.5));
check('default standoff is 2 blocks', near(d, 2), true);
check('...which is inside FLY_REACH', d < FLY_REACH, true);
check('standoff is tunable', near(hoverPointFor(P, { x: 30, y: 70, z: 20.5 }, 1.5).x, 12.0), true);

// --- availability ---
const creative = { game: { gameMode: 'creative' }, creative: { startFlying() {}, stopFlying() {} } };
check('creative with the plugin can fly', canFly(creative), true);
// Survival is the case that must keep the walking path - the builder refuses non-creative
// anyway, but flyNear is reachable from other callers.
check('survival cannot fly', canFly({ game: { gameMode: 'survival' }, creative: creative.creative }), false);
check('creative without the plugin cannot fly', canFly({ game: { gameMode: 'creative' } }), false);
check('a stubbed bot cannot fly', canFly({}), false);
check('null is safe', canFly(null), false);

// --- hover CANDIDATES: one point is not enough inside a building ---
const cands = hoverCandidates(P, { x: 30, y: 70, z: 20.5 });
check('the preferred side comes first', near(cands[0].x, 12.5), true);
// The preferred side IS one of the four, so it is 4 sides + overhead = 5, not 6.
check('four sides plus two overhead heights', cands.length, 6);
// Overhead is not decorative: at ground level every side of a floor cell is solid and the
// face-aligned pose for an underside sits a body-height below the world. The sky is the only
// reliably clear approach, so there must be more than one height of it.
const overhead = cands.filter((c) => near(c.x, 10.5) && near(c.z, 20.5));
check('two overhead heights are offered', overhead.length, 2);
check('both are within interaction range of the cell centre',
    overhead.every((c) => Math.hypot(0, (c.y + EYE_HEIGHT) - 70.5, 0) < 4.5), true);
// Overhead is LAST: looking straight down skims the top face and gives the interaction check
// the least honest ray - but it is the one approach a roofless build always has.
const last = cands[cands.length - 1];
check('the highest overhead is last', [near(last.x, 10.5), near(last.z, 20.5), near(last.y, 73)], [true, true, true]);
// Key on all three axes: the two overhead candidates deliberately share x/z and differ only in
// height, so an x/z-only key would call them duplicates.
check('no duplicate candidates', new Set(cands.map((c) => `${c.x},${c.y},${c.z}`)).size, cands.length);

// --- hover CLEARANCE: flying removes gravity, not collision ---
const world = (map) => ({ blockAt: (v) => map[`${v.x},${v.y},${v.z}`] ?? null });
const air = { boundingBox: 'empty' }, solid = { boundingBox: 'block' };
check('clear when body and head cells are free',
    hoverIsClear(world({ '12,70,20': air, '12,71,20': air }), { x: 12.5, y: 70.2, z: 20.5 }), true);
check('blocked when the body cell is solid',
    hoverIsClear(world({ '12,70,20': solid, '12,71,20': air }), { x: 12.5, y: 70.2, z: 20.5 }), false);
// The bot is 1.8 tall - a free foot cell with a solid head cell still wedges it.
check('blocked when only the HEAD cell is solid',
    hoverIsClear(world({ '12,70,20': air, '12,71,20': solid }), { x: 12.5, y: 70.2, z: 20.5 }), false);
// A null block is an unloaded chunk, not free space. Guessing "clear" there flies into terrain
// we simply have not received yet.
check('an unloaded chunk is NOT clear',
    hoverIsClear(world({}), { x: 12.5, y: 70.2, z: 20.5 }), false);

// --- placementPose: stand back along the clicked face's normal, in EYE space ---
// The server ray-checks from the eye, so a pose that is "close enough" by feet distance can
// still put the look ray past the face. These check all six faces, because the side-picking
// fallback cannot express top or bottom at all.
const C = new Vec3(10, 70, 20);   // cell centre (10.5, 70.5, 20.5)

const top = placementPose(C, new Vec3(0, 1, 0), 2);
check('top face: eye sits directly above the face centre',
    [near(top.eye.x, 10.5), near(top.eye.z, 20.5), near(top.eye.y, 71 + 2)], [true, true, true]);
// The whole point of eye space: the FEET go a head-height lower, so the EYE lands where we
// aimed. Placing the feet there instead would look at the face from 1.62 blocks too high.
check('...and the feet are EYE_HEIGHT below the eye', near(top.feet.y, top.eye.y - EYE_HEIGHT), true);

const bottom = placementPose(C, new Vec3(0, -1, 0), 2);
check('bottom face: eye sits below the block', near(bottom.eye.y, 70 - 2), true);
check('...which the side-picking fallback cannot express at all', bottom.eye.y < C.y, true);

const poseEast = placementPose(C, new Vec3(1, 0, 0), 2);
check('east face: eye is out along +x, level with the cell centre',
    [near(poseEast.eye.x, 11 + 2), near(poseEast.eye.y, 70.5), near(poseEast.eye.z, 20.5)], [true, true, true]);
const poseNorth = placementPose(C, new Vec3(0, 0, -1), 2);
check('north face: eye is out along -z', near(poseNorth.eye.z, 20 - 2), true);

// The face centre is the point we actually look AT, so it must be on the block's surface -
// half a block from the centre, not a whole one.
check('face centre is on the block surface', near(top.faceCentre.y, 71), true);
check('and the eye stands off from the FACE, not from the cell centre',
    near(top.eye.minus(top.faceCentre).norm(), 2), true);

// Standoff must keep the eye inside interaction range or the pose is useless by construction.
check('a 2-block standoff is within reach',
    top.eye.distanceTo(new Vec3(10.5, 70.5, 20.5)) < 4.5, true);

console.log(failures === 0 ? 'flight: all checks passed' : `flight: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
