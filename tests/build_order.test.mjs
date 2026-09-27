/**
 * Build order: infill before perimeter, and a continuous path instead of a raster.
 *
 *   bun tests/build_order.test.mjs
 *
 * Why it matters, in the two numbers this suite asserts:
 *
 * ACCESSIBILITY. The nozzle of a 3D printer lives outside its model; ours lives inside. Sorting
 * placements by `y, x, z` interleaves walls and interior fittings at the same height, so the shell
 * closes around the bot while it is still working inside - and it then has to fly back INTO a
 * sealed room. That cost 23 hours on 2026-09-21: 5,238 `flyNear ... failed` lines and `140-216x out
 * of reach (no clear hover within range)` per pass, with the planner always finding a route the
 * body could not fly. Placing a cell before the cells that enclose it avoids the problem rather
 * than getting better at it.
 *
 * ZIGZAG. A raster crosses the whole footprint on every row - 25 blocks on survival_base, 69 on the
 * cathedral - and every crossing is a flight leg that can wedge. The travel assertions below are
 * the point of the exercise, so they are measured against the real blueprints rather than a
 * synthetic grid.
 */
import fs from 'fs';
import { orderForBuild, chain } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
    else console.log(`ok   ${name}`);
}
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

const keyOf = (p) => `${p.x},${p.y},${p.z}`;
const setOf = (cells) => new Set(cells.map(keyOf));
/** Total horizontal travel if the bot visits the cells in this order. */
const travel = (cells) => cells.reduce((sum, p, i) =>
    i === 0 ? 0 : sum + Math.hypot(p.x - cells[i - 1].x, p.z - cells[i - 1].z), 0);
const raster = (cells) => [...cells].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);

// ---- a room: 9x9 floor with a wall ring on top of its edge
function room(y0 = 0) {
    const cells = [];
    for (let x = 0; x < 9; x++) for (let z = 0; z < 9; z++) cells.push({ x, y: y0, z, name: 'stone' });
    for (let x = 0; x < 9; x++) for (let z = 0; z < 9; z++) {
        if (x === 0 || x === 8 || z === 0 || z === 8) cells.push({ x, y: y0 + 1, z, name: 'stone' });
    }
    return cells;
}

// ---- layers must stay in ascending order: a support exists before what it supports
{
    const cells = room();
    const out = orderForBuild(cells, setOf(cells));
    check('nothing is lost or duplicated', out.length, cells.length);
    check('the same cells come back', new Set(out.map(keyOf)).size, cells.length);
    let ascending = true;
    for (let i = 1; i < out.length; i++) if (out[i].y < out[i - 1].y) ascending = false;
    check('layers stay in ascending y', ascending, true);
}

// ---- infill before perimeter WITHIN a layer: the floor's middle before its edge
{
    const cells = room();
    const out = orderForBuild(cells, setOf(cells)).filter(p => p.y === 0);
    const isEdge = (p) => p.x === 0 || p.x === 8 || p.z === 0 || p.z === 8;
    const lastInfill = out.reduce((last, p, i) => (!isEdge(p) ? i : last), -1);
    const firstEdge = out.findIndex(isEdge);
    report('every infill cell precedes every perimeter cell', lastInfill < firstEdge,
        `last infill at ${lastInfill}, first perimeter at ${firstEdge}`);
}

// ---- the zigzag assertion, on the real blueprints
//
// Per-blueprint ceilings, not one blanket ratio: the raster penalty grows with the FOOTPRINT, since
// a raster crosses the full width on every row. Measured 2026-09-22 with a little headroom each, so
// a regression shows up as a number rather than a pass/fail with no story:
//   survival_base 25x28   10718 -> 5803  (54%)
//   wizard_tower  45x35   29422 -> 13285 (45%)
//   cathedral     69x110  331214 -> 73156 (22%)
const CEILING = { 'survival_base.json': 0.60, 'wizard_tower.json': 0.50, 'cathedral.json': 0.30 };
for (const file of ['survival_base.json', 'wizard_tower.json', 'cathedral.json']) {
    const path = `blueprints/${file}`;
    if (!fs.existsSync(path)) { console.log(`skip ${file} (absent)`); continue; }
    const cells = (JSON.parse(fs.readFileSync(path, 'utf8')).placements || [])
        .filter(p => typeof p.x === 'number');
    const before = travel(raster(cells));
    const t0 = Date.now();
    const after = travel(orderForBuild(cells, setOf(cells)));
    const ms = Date.now() - t0;
    const ratio = after / before;
    report(`${file}: travel is cut`, ratio < CEILING[file],
        `${Math.round(before)} -> ${Math.round(after)} blocks (${(ratio * 100).toFixed(0)}% of raster), ${cells.length} cells in ${ms}ms`);
    // Ordering 35k cells must not become the slow part of a build that already takes hours, but it
    // also must not be so slow that nobody runs the suite.
    report(`${file}: ordering is cheap`, ms < 4000, `${ms}ms`);
}

// ---- the CLEAR phase has the same zigzag problem, on scattered targets
//
// Terrain intruding into a footprint is sparse and scattered, so a raster over x-then-z puts
// consecutive DIGS arbitrarily far apart - the bot flies across the site, digs one block, flies
// back. From outside that looks like the bot switching between two places for no reason; in the
// log it is flight legs that place nothing.
{
    // a realistic scatter: ~8% of a 45x35 footprint, deterministic so the numbers are stable
    const targets = [];
    let seed = 7;
    for (let x = 0; x < 45; x++) {
        for (let z = 0; z < 35; z++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            if ((seed % 100) < 8) targets.push({ x, y: 1, z });
        }
    }
    const rasterTravel = travel([...targets].sort((a, b) => a.x - b.x || a.z - b.z));
    const chained = chain(targets, { x: 0, z: 0 });
    const chainedTravel = travel(chained);
    check('every target is still visited', chained.length, targets.length);
    check('and none is visited twice', new Set(chained.map(t => `${t.x},${t.z}`)).size, targets.length);
    report('scattered clear targets are chained, not rastered', chainedTravel < rasterTravel * 0.35,
        `${Math.round(rasterTravel)} -> ${Math.round(chainedTravel)} blocks over ${targets.length} digs`);
}

// ---- EVERY cell must have something to click when its turn comes
//
// This is the property the first version of the ordering did not have, and the failure it produced
// is unmistakable in a live build: `161x"no solid neighbor (self=air below=air/empty)"`, 45% of all
// failures on the wizard tower, because a nearest-neighbour chain rings out to a fresh cluster
// whose first cell has no placed neighbour. Travel order and dependency order are different
// problems.
{
    // an upper storey that is NOT fully supported from below: a ring of wall on top of a floor
    // that only covers the middle, so the ring's cells depend on each other
    const cells = [];
    for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) cells.push({ x, y: 0, z, name: 'stone' });
    for (let x = 0; x <= 8; x++) for (let z = 0; z <= 8; z++)
        if (x === 0 || x === 8 || z === 0 || z === 8) cells.push({ x, y: 1, z, name: 'stone' });
    const all = setOf(cells);
    const out = orderForBuild(cells, all);

    const placed = new Set();
    let unsupported = 0, islandStarts = 0;
    for (const p of out) {
        const hasBelow = all.has(`${p.x},${p.y - 1},${p.z}`);
        const hasNeighbour = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .some(([dx, dz]) => placed.has(`${p.x + dx},${p.y},${p.z + dz}`));
        if (!hasBelow && !hasNeighbour) {
            // One start per disconnected region is unavoidable - the builder's retry pass exists
            // for those - but they must be RARE, not the rule.
            islandStarts++;
            if (islandStarts > 2) unsupported++;
        }
        placed.add(keyOf(p));
    }
    report('cells are emitted with something to click against', unsupported === 0,
        `${out.length} cells, ${islandStarts} unavoidable island starts, ${unsupported} genuinely unsupported`);
}

// the same property on the real blueprint that exposed it
{
    const cells = (JSON.parse(fs.readFileSync('blueprints/wizard_tower.json', 'utf8')).placements || [])
        .filter(p => typeof p.x === 'number');
    const all = setOf(cells);
    const placed = new Set();
    let noClick = 0;
    for (const p of orderForBuild(cells, all)) {
        const hasBelow = all.has(`${p.x},${p.y - 1},${p.z}`);
        const hasNeighbour = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .some(([dx, dz]) => placed.has(`${p.x + dx},${p.y},${p.z + dz}`));
        if (!hasBelow && !hasNeighbour) noClick++;
        placed.add(keyOf(p));
    }
    const pct = (noClick / cells.length) * 100;
    report('wizard_tower: few cells lack a face to click', pct < 3,
        `${noClick} of ${cells.length} (${pct.toFixed(1)}%) start a region with nothing placed beside or below`);
}

// ---- determinism: an order that changes between runs cannot be compared between runs
{
    const cells = room();
    const a = orderForBuild(cells, setOf(cells)).map(keyOf).join('|');
    const b = orderForBuild(cells, setOf(cells)).map(keyOf).join('|');
    check('the order is deterministic', a === b, true);
}

// ---- disjoint islands must not be dropped: a layer can be two separate rooms
{
    const cells = [
        { x: 0, y: 5, z: 0, name: 'stone' }, { x: 1, y: 5, z: 0, name: 'stone' },
        { x: 40, y: 5, z: 40, name: 'stone' }, { x: 41, y: 5, z: 40, name: 'stone' },
    ];
    const out = orderForBuild(cells, setOf(cells));
    check('both islands are built', out.length, 4);
}

console.log(failures === 0 ? 'build_order: all checks passed' : `build_order: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
