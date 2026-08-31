/**
 * The build guard: don't mine the house to get to the other side of the house.
 *
 *   bun tests/build_guard.test.mjs
 *
 * Reported as "bob destroys blocks he built to get into path", and both halves are in the live
 * log of 2026-08-30:
 *   [bob] bridge: laid dirt at (4716, 67, 4614)   <- blueprint-local (16,0,14), wants brown_carpet
 * plus a `digAhead` that will mine anything not air/water/tree/flooding - finished walls included.
 *
 * The cases that must ALLOW matter as much as the ones that must refuse. An absolute ban seals
 * the bot inside its own walls, and the better the builder gets at walls the more reliably it
 * entombs itself - so "walled in" has to win over "protected".
 */
import {
    protectBuild, clearProtectedBuild, isProtecting, isProtected, protectVerdict, protectedBox,
} from '../src/agent/library/build_guard.js';
import { planPath, trappedByBuild } from '../src/agent/library/nav.js';
import { Vec3 } from 'vec3';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

// --- nothing registered: the guard must be completely inert ---
clearProtectedBuild();
check('inert when no build is registered', isProtecting(), false);
check('nothing is protected when inert',   isProtected(4716, 67, 4614), false);
check('an unprotected cell is allowed',     protectVerdict({ protectedCell: false }).allow, true);

// --- the real cells from the run that produced the report ---
const n = protectBuild([
    { x: 4716, y: 67, z: 4614 },   // the cell the navigator bridged dirt into
    { x: 4709, y: 68, z: 4608 },
    { x: 4711, y: 68, z: 4608 },
]);
check('registering returns the cell count', n, 3);
check('now protecting', isProtecting(), true);
check('the bridged cell is protected', isProtected(4716, 67, 4614), true);
check('a neighbour is not',            isProtected(4717, 67, 4614), false);
check('a cell above is not',           isProtected(4716, 68, 4614), false);
// The planner calls this with fractional positions; a cell is a cell.
check('fractional coords floor into the cell', isProtected(4716.8, 67.2, 4614.9), true);
// The bounding-box fast path must not report cells outside the box as protected...
check('far away is not protected', isProtected(-100, 5, -100), false);
// ...nor let a cell INSIDE the box but not in the set through.
check('inside the box but not in the set', isProtected(4710, 67, 4610), false);

// --- the policy ---
check('a protected cell is refused',
    protectVerdict({ protectedCell: true, enclosed: false }).allow, false);
check('and names itself "build" so digAhead can log it',
    protectVerdict({ protectedCell: true, enclosed: false }).why, 'build');
// LAYER 3. Without this the guard is a trap, not a guard.
check('WALLED IN beats protected',
    protectVerdict({ protectedCell: true, enclosed: true }).allow, true);
check('an unprotected cell is allowed even when walled in',
    protectVerdict({ protectedCell: false, enclosed: true }).allow, true);
check('a missing state is allowed, not refused', protectVerdict(null).allow, true);
check('enclosed defaults to false rather than undefined-truthy',
    protectVerdict({ protectedCell: true }).allow, false);

// --- teardown must be complete, or every later journey routes around a finished building ---
clearProtectedBuild();
check('clearing stands the guard down', isProtecting(), false);
check('and nothing is protected afterwards', isProtected(4716, 67, 4614), false);
check('registering an empty build registers nothing', protectBuild([]), 0);
check('an empty build leaves the guard inert', isProtecting(), false);

// ==================================================================================================
// The other two layers, against a fake world. The pure verdict above says what the policy IS;
// these say that the planner and the escape valve actually see it.
// ==================================================================================================

// A flat stone plain at y=63, air above, plus whatever cells `solid` names.
function plainWorld(solid) {
    return (px, pz, py = 64) => ({
        entity: { position: new Vec3(px + 0.5, py, pz + 0.5) },
        blockAt(v) {
            const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z);
            if (y <= 63) return { name: 'stone', boundingBox: 'block' };
            if (solid.has(`${x},${y},${z}`)) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        },
    });
}
const cells = (set) => [...set].map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });

// --- LAYER 1: the price. A long wall between the bot and the goal. --------------------------------
// The detour round a +-30 wall costs more than mining through it at digCost, so an UNGUARDED
// planner digs. That is the control: if it detoured anyway, "the guard changed the route" would
// prove nothing.
const wall = new Set();
for (let z = -30; z <= 30; z++) for (let y = 64; y <= 65; y++) wall.add(`10,${y},${z}`);
const wallBot = plainWorld(wall)(0, 0);
const hitsWall = (path) => !!path && path.some((q) =>
    wall.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)
    || wall.has(`${Math.floor(q.x)},${Math.floor(q.y) + 1},${Math.floor(q.z)}`));

clearProtectedBuild();
const unguardedPath = planPath(wallBot, new Vec3(20, 64, 0), {});
check('CONTROL: with no guard the planner mines straight through the wall', hitsWall(unguardedPath), true);

protectBuild(cells(wall));
const guardedPath = planPath(wallBot, new Vec3(20, 64, 0), {});
check('a protected wall is routed around, not mined', hitsWall(guardedPath), false);
check('...and the detour really goes round the end of it',
    !!guardedPath && Math.max(...guardedPath.map((q) => Math.abs(q.z))) > 30, true);

clearProtectedBuild();
const clearedPath = planPath(wallBot, new Vec3(20, 64, 0), {});
check('once the guard is cleared the cost model is unchanged again', hitsWall(clearedPath), true);
check('and the cleared plan is identical to the unguarded one',
    JSON.stringify(clearedPath), JSON.stringify(unguardedPath));

// --- LAYER 3: the escape valve, against a bot that is actually sealed in ---------------------------
// A hollow box: walls on the ring, a roof, interior 11..19. This is the shape the guard is for,
// and the shape `nav.enclosed` cannot see - a bot in here can walk around inside it all day.
const box = new Set();
for (let x = 10; x <= 20; x++) for (let z = 10; z <= 20; z++) for (let y = 64; y <= 66; y++) {
    if (x === 10 || x === 20 || z === 10 || z === 20 || y === 66) box.add(`${x},${y},${z}`);
}
const boxWorld = plainWorld(box);

clearProtectedBuild();
check('no build registered: nothing can be trapped by it', trappedByBuild(boxWorld(15, 15)), false);
check('and there is no bounding box to search', protectedBox(), null);

protectBuild(cells(box));
check('the box has a bounding box', protectedBox().minX, 10);
check('SEALED INSIDE THE BUILD is trapped', trappedByBuild(boxWorld(15, 15)), true);
// The cases that must NOT relent matter more: each one is the navigator being allowed to mine a
// finished wall it was merely walking past.
check('standing outside the footprint is not trapped', trappedByBuild(boxWorld(30, 15)), false);
check('standing on top of the build is not trapped', trappedByBuild(boxWorld(15, 15, 67)), false);

// A doorway is a way out, so the refusal must stand.
const holed = new Set(box);
holed.delete('10,64,15'); holed.delete('10,65,15');
const doorWorld = plainWorld(holed);
clearProtectedBuild();
protectBuild(cells(holed));
check('a doorway means NOT trapped - walk out, do not mine out',
    trappedByBuild(doorWorld(15, 15)), false);

// And the price stays finite, so a sealed bot can still PLAN its way out - the executor's
// relent would be useless if the planner refused to draw the route.
clearProtectedBuild();
protectBuild(cells(box));
const exit = planPath(boxWorld(15, 15), new Vec3(30, 64, 15), {});
check('a sealed bot can still plan an exit through its own wall',
    !!exit && exit.some((q) => box.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)), true);
clearProtectedBuild();
check('teardown after the world tests', isProtecting(), false);

// ==================================================================================================
// `bridgeAhead` had layer 2 (refuse) but not layer 3 (relent): it returned
// `{ placed: false, reason: 'that cell belongs to the build' }` unconditionally the moment the
// footing cell it wanted to bridge onto was protected - no escape path at all. That cannot
// entomb the bot the way the digAhead bug could (bridging is only reached at a gap, not every
// wall), but it can strand it at a gap it will refuse to span forever, with the goal on the
// other side and no other route.
//
// `bridgeAhead` is not exported (it needs a live bot, block_io and skills.js to actually place a
// block), so the pieces it is built from - `trappedByBuild` and `protectVerdict` - are exercised
// directly with geometry shaped like a bridge, not a sealed room: a gap in a wall whose far
// landing cell is inside the build. The wiring itself (does `bridgeAhead` actually call them, and
// does it log the relent) is checked against the source, the same way this suite's sibling
// `tests/bridge.test.mjs` already checks integration-level wiring it cannot mock (the pinned-leg
// scaling, `goToPlayer`'s distance check) - by reading the function body and asserting on it.
// ==================================================================================================

// A straight wall with ONE gap in it (a doorway), and the footing cell a bridge would land on is
// the far side of that gap, INSIDE the build. There is a way around, `trappedByBuild` sees the
// doorway, so this is "merely walking past a wall" - the refusal must stand.
const wallWithGap = new Set();
for (let z = -10; z <= 10; z++) for (let y = 64; y <= 66; y++) {
    if (z === 0) continue;   // the gap
    wallWithGap.add(`10,${y},${z}`);
}
const gapWorld = plainWorld(wallWithGap);

clearProtectedBuild();
protectBuild(cells(wallWithGap));
check('walking past a wall with an open route is NOT trapped',
    trappedByBuild(gapWorld(10, 0)), false);
check('...so the refusal for that footing cell must stand',
    protectVerdict({ protectedCell: true, enclosed: trappedByBuild(gapWorld(10, 0)) }).allow, false);

// A bot genuinely boxed in, where the only cell it could bridge across is protected: this is
// the box from LAYER 3 above, reused for the bridging case specifically. `trappedByBuild` must
// say true, and the policy must relent.
clearProtectedBuild();
protectBuild(cells(box));
check('boxed in with only a protected cell to cross must be seen as trapped',
    trappedByBuild(boxWorld(15, 15)), true);
check('...and the policy relents rather than stranding the bot at the gap',
    protectVerdict({ protectedCell: true, enclosed: trappedByBuild(boxWorld(15, 15)) }).allow, true);

// A footing cell outside the build's footprint entirely must never enter this decision at all -
// `bridgeAhead` only calls `trappedByBuild`/`protectVerdict` once `isProtected` says yes.
check('a footing cell outside the build is simply unprotected, not evaluated',
    isProtected(4900, 67, 4900), false);

clearProtectedBuild();
check('teardown after the bridge-relent geometry', isProtecting(), false);

// --- the wiring: does bridgeAhead itself actually call the relent, and does it log it? ---------
{
    const src = (await import('fs')).readFileSync(
        new URL('../src/agent/library/nav.js', import.meta.url), 'utf8');
    const start = src.indexOf('async function bridgeAhead');
    const end = src.indexOf('// Jumping - the cheap way across a gap', start);
    check('found bridgeAhead in nav.js', start >= 0 && end > start, true);
    const fn = src.slice(start, end);

    check('bridgeAhead measures whether it is actually trapped before refusing',
        /trappedByBuild\(bot\)/.test(fn), true);
    check('...using the same enclosed() || trappedByBuild() pattern digAhead uses',
        /enclosed\(bot\)\s*\|\|\s*trappedByBuild\(bot\)/.test(fn), true);
    check('...and asks the same policy digAhead does',
        /buildGuard\.protectVerdict\(\{\s*protectedCell:\s*true,\s*enclosed:/.test(fn), true);
    // The refusal must be CONDITIONAL on the verdict, not unconditional - otherwise the relent
    // is computed and then ignored, which reads identically to "fixed" in a diff but changes
    // nothing at runtime.
    check('the refusal only fires when the verdict disallows it',
        /if\s*\(!v\.allow\)\s*\{\s*return \{ placed: false, reason: 'that cell belongs to the build' \};/.test(fn),
        true);
    // Refusals must be logged (CLAUDE.md: a silent refusal path is indistinguishable from a
    // branch that never runs at all). The relent is the far more dangerous silence, since it is
    // the one case where the bot is about to breach its own build. Require the log call, the
    // verdict's own reason (`v.why`, matching digAhead rather than a hardcoded string that could
    // drift from the policy), and the words that say what happened, all within the relent branch.
    const afterAllow = fn.slice(fn.indexOf('if (!v.allow)'));
    check('a relent is logged, naming the breach - never silent',
        /console\.log/.test(afterAllow) && /v\.why/.test(afterAllow)
        && /breaching the build/.test(afterAllow), true);
}

console.log(failures === 0 ? 'build_guard: all checks passed' : `build_guard: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
