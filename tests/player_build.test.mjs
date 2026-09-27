/**
 * Player-made blocks and the shared build guard: don't mine anybody's house on the way past.
 *
 *   bun tests/player_build.test.mjs
 *
 * Reported as "andy breaks my building/fence sometimes" and "blueprint belong to bob". Three
 * separate holes, one per section below:
 *
 *   1. A fence is 1.5 tall but `classify` calls it an ordinary SOLID cell, so the planner stepped
 *      "up onto" it, the bot pinned against it, and the last-resort `digAhead` mined it. The
 *      live log has the same thing with a wall: `[andy] digAhead: 0:sandstone_wall dig-failed`.
 *   2. Only a REGISTERED build was protected, so a finished house or a player's fence was plain
 *      `digCost` - fourteen blocks of detour and the fence lost.
 *   3. Every bot is its own process and the guard was module state, so Bob's registered build was
 *      invisible to Andy.
 *
 * As in build_guard.test.mjs, the cases that must still ALLOW matter as much as the refusals:
 * a bot fenced into a pen must still be able to plan its way out.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isPlayerMadeName, isTallCollisionName, shareBuilds, protectBuild, clearProtectedBuild,
    isProtecting, isProtected, protectedBox,
} from '../src/agent/library/build_guard.js';
import { planPath, planGoesThrough } from '../src/agent/library/nav.js';
import { Vec3 } from 'vec3';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

// --- the names ------------------------------------------------------------------------------------
for (const n of ['oak_fence', 'dark_oak_fence', 'spruce_fence_gate', 'cobblestone_wall', 'sandstone_wall',
    'spruce_stairs', 'dark_oak_slab', 'spruce_planks', 'glass_pane', 'white_stained_glass',
    'spruce_trapdoor', 'red_carpet', 'stone_bricks', 'deepslate_bricks', 'deepslate_tiles',
    'cobbled_deepslate', 'stripped_spruce_log', 'chest', 'wall_torch']) {
    check(`player-made: ${n}`, isPlayerMadeName(n), true);
}
// Terrain. Every one of these is something the bot must stay free to dig through on a journey.
for (const n of ['stone', 'dirt', 'grass_block', 'sand', 'sandstone', 'deepslate', 'gravel',
    'oak_log', 'netherrack', 'andesite', 'water', 'air', '', undefined]) {
    check(`terrain, not player-made: ${n}`, isPlayerMadeName(n), false);
}
for (const n of ['oak_fence', 'nether_brick_fence', 'oak_fence_gate', 'cobblestone_wall', 'sandstone_wall']) {
    check(`1.5-tall collision: ${n}`, isTallCollisionName(n), true);
}
for (const n of ['wall_torch', 'oak_wall_sign', 'stone', 'oak_slab', 'oak_stairs', undefined]) {
    check(`not tall: ${n}`, isTallCollisionName(n), false);
}

// --- a fake world: stone plain at y=63, air above, plus named blocks ------------------------------
function world(blocks) {
    return (px, pz, py = 64) => ({
        entity: { position: new Vec3(px + 0.5, py, pz + 0.5) },
        blockAt(v) {
            const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z);
            if (y <= 63) return { name: 'stone', boundingBox: 'block' };
            const n = blocks.get(`${x},${y},${z}`);
            if (n) return { name: n, boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        },
    });
}
const onLine = (path, x) => !!path && path.some((q) => Math.floor(q.x) === x);
const widest = (path) => Math.max(...path.map((q) => Math.abs(q.z)));

// --- 1. a one-high fence across the route ---------------------------------------------------------
// CONTROL: the same cells as stone are a one-block step, and the planner rightly walks over them.
// If it detoured round the stone too, "the fence changed the route" would prove nothing.
const line = (name, h = 1) => {
    const m = new Map();
    for (let z = -30; z <= 30; z++) for (let y = 64; y < 64 + h; y++) m.set(`10,${y},${z}`, name);
    return m;
};
const stepPath = planPath(world(line('stone'))(0, 0), new Vec3(20, 64, 0), {});
check('CONTROL: a one-high stone line is stepped over', !!stepPath && stepPath.some((q) =>
    Math.floor(q.x) === 10 && Math.floor(q.y) === 65), true);

const fencePath = planPath(world(line('oak_fence'))(0, 0), new Vec3(20, 64, 0), {});
check('a fence is never stood on', !!fencePath && fencePath.some((q) =>
    Math.floor(q.x) === 10 && Math.floor(q.y) === 65), false);
check('a fence is not mined through either', onLine(fencePath, 10), false);
check('the route goes round the end of the fence', !!fencePath && widest(fencePath) > 30, true);

// --- 2. a two-high wall nobody registered ----------------------------------------------------------
// CONTROL, from build_guard.test.mjs: the same wall in stone is mined straight through.
clearProtectedBuild();
const stoneWall = planPath(world(line('stone', 2))(0, 0), new Vec3(20, 64, 0), {});
check('CONTROL: an unregistered stone wall is mined through', onLine(stoneWall, 10), true);
const plankWall = planPath(world(line('spruce_planks', 2))(0, 0), new Vec3(20, 64, 0), {});
check('an unregistered planks wall is routed around', onLine(plankWall, 10), false);
check('...round the end of it', !!plankWall && widest(plankWall) > 30, true);

// --- the escape valve: a bot fenced into a pen must still get out ---------------------------------
const pen = new Map();
for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if (Math.abs(x) === 3 || Math.abs(z) === 3) pen.set(`${x},64,${z}`, 'oak_fence');
}
const penPath = planPath(world(pen)(0, 0), new Vec3(20, 64, 0), {});
check('FENCED IN: the planner still finds a way out', !!penPath && penPath.length > 0, true);
const breach = penPath && penPath.find((q) => pen.has(`${Math.floor(q.x)},64,${Math.floor(q.z)}`));
check('...by going through exactly one fence post', !!breach, true);
if (breach) {
    const post = { x: Math.floor(breach.x), y: 64, z: Math.floor(breach.z) };
    // This is what lets digAhead mine it. Without it the pen is a tomb.
    check('digAhead sees the plan going through that post', planGoesThrough(penPath, post), true);
    check('...at head height too', planGoesThrough(penPath, { ...post, y: 65 }), true);
}
check('a plan that goes round does not license a dig',
    planGoesThrough(fencePath, { x: 10, y: 64, z: 0 }), false);
check('no plan licenses nothing', planGoesThrough(null, { x: 0, y: 64, z: 0 }), false);

// --- 3. sharing: Andy sees Bob's build -------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active_builds-'));
const bobCell = { x: 4716, y: 67, z: 4614 };
const bobFile = (pid) => path.join(dir, `${pid}.json`);
// Our parent (the runner, or the shell) is a process we KNOW is alive: it plays Bob.
fs.writeFileSync(bobFile(process.ppid), JSON.stringify({ pid: process.ppid, cells: [`${bobCell.x},${bobCell.y},${bobCell.z}`] }));

check('OFF by default: another bot\'s file is ignored', isProtected(bobCell.x, bobCell.y, bobCell.z), false);
check('OFF by default: not protecting', isProtecting(), false);

shareBuilds(dir);
check('sharing on: Bob\'s cell is protected here', isProtected(bobCell.x, bobCell.y, bobCell.z), true);
check('sharing on: protecting', isProtecting(), true);
check('a neighbour of Bob\'s cell is not', isProtected(bobCell.x + 1, bobCell.y, bobCell.z), false);
check('Bob\'s footprint is in the trap box', protectedBox()?.minX, bobCell.x);

// Our own build is published for Bob, and our own file is not read back as someone else's.
protectBuild([{ x: 1, y: 64, z: 1 }]);
check('registering publishes it', fs.existsSync(bobFile(process.pid)), true);
check('both builds are protected', isProtected(1, 64, 1) && isProtected(bobCell.x, bobCell.y, bobCell.z), true);
check('the trap box is the union', protectedBox().minX === 1 && protectedBox().maxX === bobCell.x, true);
clearProtectedBuild();
check('clearing unpublishes it', fs.existsSync(bobFile(process.pid)), false);
check('Bob\'s build is still honoured after ours ends', isProtected(bobCell.x, bobCell.y, bobCell.z), true);

// A bot killed with SIGKILL leaves its file behind. Honouring it would fence off the site forever.
fs.unlinkSync(bobFile(process.ppid));
const dead = 2 ** 22 + 12345;   // above the default pid_max, so never a live process
fs.writeFileSync(bobFile(dead), JSON.stringify({ pid: dead, cells: [`${bobCell.x},${bobCell.y},${bobCell.z}`] }));
shareBuilds(dir);               // force a rescan instead of waiting out FOREIGN_RESCAN_MS
check('a dead bot\'s build is ignored', isProtected(bobCell.x, bobCell.y, bobCell.z), false);
check('and nothing is protected', isProtecting(), false);

shareBuilds(null);
check('turning sharing off leaves the guard inert', isProtecting(), false);
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? 'player_build: all checks passed' : `player_build: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
