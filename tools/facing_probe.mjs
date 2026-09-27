#!/usr/bin/env bun
/**
 * Which way does a placed block actually FACE? Measure it; do not trust the comment.
 *
 *   bun tools/facing_probe.mjs --dry                     # no server, no world change
 *   bun tools/facing_probe.mjs --at 4760,68,4650         # live, creative, ANNOUNCE FIRST
 *
 *   --at x,y,z    open natural ground; y at or just above the surface (each column finds its own
 *                 floor within 12 blocks, so a hillside is fine, a building is refused)
 *   --only s1,s2  substring filter over the trial classes
 *   --peek        print the surface around --at and quit; places NOTHING. Use it first at a new
 *                 spot, and to tell a built floor from an unlisted biome
 *   --survey      read the site and report whether it is usable; places NOTHING, and works in
 *                 survival, so it is the safe first call at a new spot
 *   --wait n      seconds to wait to be teleported to the site (default 90). The bot spawns at
 *                 world spawn and cannot walk 2000 blocks, so an operator has to move it:
 *                 `/tp probe1 <x> <y+6> <z>` in game, or `mc "tp ..."` if RCON is healthy
 *   --tidy        remove anything an earlier run left standing (by name, in its own columns only)
 *   --census      read-only: count sub-surface air cells at the site, i.e. damage from a past run
 *   --settle ms   wait this long between the look and the place packet (tests the stale-yaw race)
 *   --keep        leave the test blocks standing to look at them yourself
 *   --out f.json  write the rows for a follow-up test to assert against
 *
 * The question
 * ------------
 * `blueprint_builder.js:16-23` documents an inverse mapping - "stairs/doors/beds/fence gates:
 * blockstate facing == player's look direction", "chests/furnaces/barrels: facing == OPPOSITE of
 * look" - and `lookVecFor()` implements it. **Nothing asserts it.** No suite in `tests/` mentions
 * facing, and `tools/place_probe.mjs` measures whether a placement is ACKNOWLEDGED, not which way
 * the block ended up pointing. A whole class inverted 180 degrees is therefore invisible to the
 * build loop:
 *
 *   - `placeOne` scores a placement on the block NAME only (blueprint_builder.js:662)
 *   - `blueprintStatus` counts a match on the block NAME only (:693, and the tally at :989)
 *
 * So a tower of correctly-named, wrongly-facing stairs reports as a clean build - which is what
 * the Wizard Tower run did on 2026-09-21: coordinates right, facings wrong, `!buildStatus` happy.
 * That is this repo's dominant bug shape (CLAUDE.md): the code measured something true (the name)
 * and concluded something false (the blueprint is satisfied).
 *
 * It is worth measuring because it is not a rounding error: of `blueprints/wizard_tower.json`'s
 * 8335 placements, **1137 carry an orientation** (746 a `facing`, the rest `axis`/`rotation`) -
 * 13.6% of the build that no check in the pipeline can currently see.
 *
 * What this measures
 * ------------------
 * Ground truth, per block class, by doing exactly what the builder does and then READING THE
 * WORLD BACK:
 *
 *   for each cardinal facing F we want
 *     look   = lookVecFor({name, properties:{facing:F}})     <- the code under test
 *     stand  = P - round(look * 2)                           <- the builder's approach rule
 *     place through block_io.placeVerified (the builder's own packet path)
 *     got    = bot.blockAt(P).getProperties().facing         <- what the server actually made
 *
 * and reports per trial: OK (got === want), INVERTED (got === opposite of want), PERPENDICULAR
 * (90 degrees off - usually an axis/face confusion), or NO-PREDICTION (`lookVecFor` returned null,
 * so the orientation is whatever the clicked face gave us and the builder is not steering it).
 *
 * A class that comes back INVERTED on all four facings is a sign error in one line of
 * `lookVecFor`. A class that is OK on two and INVERTED on two is not - that is the approach point
 * or the clicked face, not the mapping.
 *
 * Safety
 * ------
 * - **Creative only.** It refuses otherwise, rather than digging a survival hole for a probe.
 * - **Surveys every cell it needs BEFORE placing anything** and refuses unless all are air or
 *   replaceable growth (CLAUDE.md: establish feasibility before committing to a destructive
 *   step). It therefore cannot chew into a real build even if pointed at one.
 * - **Digs only what it placed**, tracked cell by cell, in reverse order.
 * - Touches no RCON, so it contends with nobody's console. It DOES place ~60 blocks in the live
 *   world: announce it, because another session's gym run is somebody's evidence.
 */
import { Vec3 } from 'vec3';
import { writeFileSync, readFileSync } from 'node:fs';
import real from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import * as mc from '../src/utils/mcdata.js';
import * as blockIO from '../src/agent/library/block_io.js';
import * as flight from '../src/agent/library/flight.js';
import { lookVecFor } from '../src/agent/library/blueprint_builder.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);
const log = (m) => console.log(`[facing] ${m}`);

const FACE = {
    north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0),
    up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0),
};
const SIDE_FACES = ['north', 'south', 'west', 'east'];
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
const CARDINALS = ['north', 'east', 'south', 'west'];
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass',
    'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'seagrass']);

/**
 * The classes to measure, and why each one is here: `count` is how many times it appears in
 * wizard_tower.json, so a defect found in a high-count class explains more of what you can see
 * from the ground. `kind` is the attach geometry the builder chooses for it:
 *
 *   top  - click the UP face of a support underneath (the builder's default path)
 *   side - click the side face of a support BEHIND the cell (its trapdoor path, :463)
 *   wall - support-attached: orientation comes from the clicked face, not from look (:447)
 *   axis - log/pillar: the clicked face's normal IS the axis (:472)
 */
const TRIALS = [
    { block: 'spruce_trapdoor', kind: 'side', count: 311 },
    { block: 'oak_log', kind: 'axis', count: 266 },
    { block: 'spruce_stairs', kind: 'top', count: 191 },
    { block: 'cobbled_deepslate_stairs', kind: 'top', count: 88 },
    { block: 'spruce_door', kind: 'top', count: 18 },
    { block: 'chiseled_bookshelf', kind: 'top', count: 18 },
    { block: 'spruce_fence_gate', kind: 'top', count: 9 },
    { block: 'barrel', kind: 'top', count: 7 },
    { block: 'chest', kind: 'top', count: 4 },
    { block: 'magenta_wall_banner', kind: 'wall', item: 'magenta_banner', count: 4 },
];

// NOT `stone`: stone is also natural terrain in this world, so a name-based cleanup sweep cannot
// tell a pedestal from the hillside - the first version of `tidy` listed 184 "leftovers" across 49
// columns, most of them the badlands' own stone, and started digging them. smooth_stone does not
// generate naturally, so every block this probe places is unambiguously its own.
const SUPPORT = 'smooth_stone';

// How far ABOVE `--at`'s y to start each column's downward scan. Generous on purpose: a fixed small
// offset keeps landing inside a slope. Measured on the badlands dune at 4683,63,4571, which rises
// from y 63 to past 69 across the grid - +4 found sand INSIDE the dune and refused every far column
// because the target cell was solid. From high air the first non-replaceable block IS the surface.
const SCAN_ABOVE = 24;

/** The builder's approach rule, verbatim from blueprint_builder.js:572-580. */
function approachFor(P, look, faceName, faceVec) {
    if (look) return P.minus(new Vec3(Math.round(look.x * 2), 0, Math.round(look.z * 2)));
    if (SIDE_FACES.includes(faceName)) return P.plus(new Vec3(faceVec.x * 2, 0, faceVec.z * 2));
    return P;
}

/** Which cell do we click, and on which face, for this attach geometry? */
function refFor(P, kind, want) {
    switch (kind) {
        case 'side':
        case 'wall':
            // support BEHIND the cell; we click the face pointing at the cell
            return { support: P.minus(FACE[want]), faceName: want, faceVec: FACE[want] };
        case 'axis': {
            // axis == the clicked face's normal, so click along the axis we want
            const faceName = { x: 'east', y: 'up', z: 'south' }[want];
            return { support: P.minus(FACE[faceName]), faceName, faceVec: FACE[faceName] };
        }
        default:
            return { support: P.offset(0, -1, 0), faceName: 'up', faceVec: FACE.up };
    }
}

/** Name a horizontal unit vector as a cardinal, or null if it is not one. */
function dirName(v) {
    if (!v) return null;
    return SIDE_FACES.find(f => FACE[f].x === Math.round(v.x) && FACE[f].z === Math.round(v.z)) ?? null;
}

function wantsOf(kind) { return kind === 'axis' ? ['x', 'y', 'z'] : CARDINALS; }
function propKeyOf(kind) { return kind === 'axis' ? 'axis' : 'facing'; }

/**
 * Lay the trial cells out in a GRID of columns - rows of 5, 4 blocks apart - so no two trials
 * share a support, a pedestal or a stand point. The y is NOT fixed here: each column resolves its
 * own ground when the probe runs, so the site does not have to be flat and the probe does not
 * have to be aimed at a plaza.
 *
 * The grid grows toward -x/-z, so `--at` is its HIGHEST corner. That is not arbitrary: a site
 * picked near a build is usually picked on the near side of it, and this world's builds sit at
 * higher coordinates (the Wizard Tower footprint starts at x 4700, z 4600). Growing away from
 * them means a 20x28 grid does not have to be re-aimed, and the survey still refuses anything
 * built if the aim is wrong anyway.
 */
function planSite(origin, trials) {
    const plan = [];
    let i = 0;
    for (const t of trials) {
        for (const want of wantsOf(t.kind)) {
            const col = { x: origin.x - (i % 5) * 4, z: origin.z - Math.floor(i / 5) * 4 };
            const look = lookVecFor({ name: t.block, properties: { [propKeyOf(t.kind)]: want } });
            plan.push({ ...t, want, col, look, item: t.item ?? t.block });
            i++;
        }
    }
    return plan;
}

// ---------------------------------------------------------------- dry mode

function predictionTable(plan) {
    const dirOf = (v) => dirName(v) ?? '-';
    log('PREDICTED look direction per desired orientation (no server involved):');
    console.log('  block                       kind  want   look      relation');
    for (const p of plan) {
        const look = dirOf(p.look);
        const rel = !p.look ? 'none (clicked face decides)'
            : look === p.want ? 'look == want'
                : look === OPPOSITE[p.want] ? 'look == OPPOSITE of want' : `look=${look}`;
        console.log(`  ${p.block.padEnd(27)} ${p.kind.padEnd(5)} ${String(p.want).padEnd(6)} ${look.padEnd(9)} ${rel}`);
    }
}

/**
 * Which oriented blocks in a blueprint does `lookVecFor` even have an opinion about? A name with
 * no prediction is not necessarily wrong - wall-attached blocks take their orientation from the
 * clicked face - but it is a name whose facing the builder is not steering, and those are where
 * an unexplained orientation is most likely to come from.
 */
function coverage(file) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const rows = new Map();
    for (const p of (raw.placements || raw)) {
        const pr = p.properties || {};
        if (pr.facing === undefined && pr.axis === undefined && pr.rotation === undefined) continue;
        const r = rows.get(p.name) || { n: 0, steered: 0 };
        r.n++;
        if (lookVecFor(p)) r.steered++;
        rows.set(p.name, r);
    }
    const all = [...rows.entries()].sort((a, b) => b[1].n - a[1].n);
    const tot = all.reduce((s, [, r]) => s + r.n, 0);
    const unsteered = all.filter(([, r]) => r.steered === 0).reduce((s, [, r]) => s + r.n, 0);
    log(`${file}: ${tot} oriented placements across ${all.length} names; `
        + `${tot - unsteered} get a computed look, ${unsteered} do not`);
    console.log('  count  steered  block');
    for (const [name, r] of all.slice(0, 20))
        console.log(`  ${String(r.n).padStart(5)}  ${String(r.steered).padStart(7)}  ${name}`);
}

// ---------------------------------------------------------------- live mode

// Solid AND natural. A probe aimed carelessly then stands on terrain and never on somebody's
// roof - the survey refuses a column whose top block is anything built.
const NATURAL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'stone',
    'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'red_sand', 'gravel', 'sandstone',
    'red_sandstone', 'clay', 'moss_block', 'mud', 'packed_mud', 'snow_block', 'calcite', 'ice',
    'packed_ice',
    // Badlands: red sand over terracotta bands. Measured at 4683,63,4571 - leaving these out made
    // the probe refuse a perfectly good dune as "not natural ground".
    'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta',
    'red_terracotta', 'light_gray_terracotta']);

/**
 * The highest natural floor at or below `yTop` in this column.
 *
 * Callers pass `--at`'s y PLUS a few blocks, because a y given at eye level on a slope is already
 * inside the ground: at 4683,63,4571 the surface is red_sand at 64, so scanning down from 63 found
 * the badlands terracotta UNDER the sand and the whole site was refused as built-on. Start above
 * the surface and the same aim just works.
 */
function groundOf(bot, x, z, yTop, depth = 40) {
    for (let y = yTop; y > yTop - depth; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) return { y: null, why: `column (${x},${z}) is not loaded` };
        if (REPLACEABLE.has(b.name)) continue;
        if (!NATURAL.has(b.name)) return { y: null, why: `(${x},${y},${z}) holds ${b.name} - not natural ground` };
        return { y, block: b };
    }
    return { y: null, why: `no floor within ${depth} blocks of y=${yTop} at (${x},${z})` };
}

/**
 * Resolve one trial against the real terrain: where the block goes, what we click, and which
 * pedestal cells have to exist first. The target always sits two above its column's floor, so
 * the site can be a hillside.
 */
function resolve(bot, p, originY) {
    const g = groundOf(bot, p.col.x, p.col.z, originY + SCAN_ABOVE);
    if (g.y === null) return { why: g.why };
    // Three above the floor, not two. The stand point for a look-steered placement sits at the
    // TRIAL's y in a neighbouring column, and on a slope that cell is inside the hill - which sends
    // flight into its overhead fallback and silently destroys the yaw the measurement depends on.
    const P = new Vec3(p.col.x, g.y + 3, p.col.z);
    const { support, faceName, faceVec } = refFor(P, p.kind, p.want);
    const fillers = [];
    if (support.x === P.x && support.z === P.z) {
        // A FULL column from the floor up to the support, not just the support cell: with the trial
        // at floor+3 the support sits at floor+2 and has nothing under it to click, which reported
        // as `pedestal: nothing solid under (...)` for every look-steered trial in one run.
        for (let y = g.y + 1; y <= support.y; y++) fillers.push(new Vec3(P.x, y, P.z));
    } else {
        const gs = groundOf(bot, support.x, support.z, originY + SCAN_ABOVE);   // beside: pedestal up from its own floor
        if (gs.y === null) return { why: gs.why };
        for (let y = gs.y + 1; y <= support.y; y++) fillers.push(new Vec3(support.x, y, support.z));
    }
    return { P, support, faceName, faceVec, fillers };
}

async function flyToWithin(bot, dest, target, reach = 4.5) {
    await flight.flyTo(bot, dest, { timeoutMs: 4000 });
    if (flight.eyeDistanceTo(bot, target) <= reach) return null;
    const pose = flight.placementPose(target, FACE.up, 2.0);
    const short = await flight.flyTo(bot, pose.feet, { timeoutMs: 3000 });
    if (flight.eyeDistanceTo(bot, target) <= reach) return null;
    return `out of reach (short by ${short.toFixed(1)}, eye ${flight.eyeDistanceTo(bot, target).toFixed(1)})`;
}

async function equip(bot, itemName) {
    if (bot.heldItem?.name === itemName) return true;
    try {
        // Slot 36 is hotbar 0. Never pass waitTimeout: 0 here - mineflayer leaks its per-slot busy
        // flag and every later write to that slot throws for the life of the process (CLAUDE.md).
        await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
    } catch (e) { log(`equip ${itemName}: ${e.message}`); return false; }
    for (let i = 0; i < 20; i++) {                    // poll: the ack precedes the inventory copy
        if (bot.inventory.findInventoryItem(itemName)) break;
        await new Promise(r => setTimeout(r, 50));
    }
    try { await bot.equip(mc.makeItem(itemName, 1).type, 'hand'); } catch (e) { /* already held */ }
    return bot.heldItem?.name === itemName;
}

/** One pedestal block, clicked onto whatever is directly beneath it. */
async function placeStone(bot, cell) {
    const below = bot.blockAt(cell.offset(0, -1, 0));
    if (!below || REPLACEABLE.has(below.name)) return { ok: false, why: `nothing solid under (${cell.x},${cell.y},${cell.z})` };
    if (!(await equip(bot, SUPPORT))) return { ok: false, why: `no ${SUPPORT}` };
    const pose = flight.placementPose(cell, FACE.up, 2.0);
    const far = await flyToWithin(bot, pose.feet, cell);
    if (far) return { ok: false, why: far };
    await blockIO.snapLook(bot, pose.faceCentre);
    return blockIO.placeVerified(bot, below, FACE.up, { expectName: SUPPORT });
}

/** How many blocks the run will place: every pedestal cell, plus the trial block itself. */
function placedCount(resolved) {
    return resolved.reduce((n, r) => n + r.fillers.length + 1, 0);
}

/** The cardinal the bot is actually facing, from its live yaw. */
function yawToCardinal(yaw) {
    const v = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
    let best = null, bestDot = -Infinity;
    for (const f of SIDE_FACES) {
        const d = FACE[f].x * v.x + FACE[f].z * v.z;
        if (d > bestDot) { bestDot = d; best = f; }
    }
    return best;
}

/** Every block name this probe is ever allowed to remove. Nothing else is touched, ever. */
const OURS = new Set([SUPPORT, ...TRIALS.map(t => t.block),
    // `--also name,name` widens the set for one run. It exists for exactly one situation: an
    // earlier run used a different support block (this probe's was `stone` before the collision
    // with natural terrain was found) and its pedestals are still standing. It is only safe
    // BECAUSE tidy stops at the first block that is not ours, so a widened set still cannot chew
    // downward into the hillside.
    ...(arg('also', '').split(',').filter(Boolean))]);

/**
 * Remove cells the probe placed, and REPORT what would not go.
 *
 * Flight first, then dig, then RE-READ - and retry once. `bot.dig` resolved without error for 86
 * cells in the first run and left oak_log and spruce_stairs standing, because the bot had drifted
 * out of range and the server simply ignored the dig: the same "API resolves, world disagrees"
 * shape as the placement path. A silent partial cleanup is worse than a noisy one, because the
 * leftovers then fail the NEXT run's survey as "not natural ground".
 */
async function removeOwn(bot, cells) {
    const left = [];
    for (const c of cells) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const b = bot.blockAt(c);
            if (!b || REPLACEABLE.has(b.name)) break;
            if (!OURS.has(b.name)) break;               // not ours - leave it alone
            const pose = flight.placementPose(c, FACE.up, 2.0);
            await flight.flyTo(bot, pose.feet, { timeoutMs: 3000 });
            if (flight.eyeDistanceTo(bot, c) > 4.5) continue;
            try { await bot.dig(bot.blockAt(c), true); } catch (e) { /* re-read decides */ }
        }
        const after = bot.blockAt(c);
        if (after && !REPLACEABLE.has(after.name) && OURS.has(after.name))
            left.push(`(${c.x},${c.y},${c.z}) ${after.name}`);
    }
    return left;
}

/**
 * Sweep the whole site for anything this probe left behind on an earlier run, by NAME and only in
 * its own columns. Deliberately does not use `groundOf`: a leftover block IS the top of its column,
 * so resolving the plan would shift every cell and miss exactly the blocks being hunted.
 */
async function tidy(bot, plan, originY) {
    const columns = new Map();
    for (const p of plan) {
        for (const c of [p.col, refFor(new Vec3(p.col.x, originY, p.col.z), p.kind, p.want).support])
            columns.set(`${c.x},${c.z}`, { x: c.x, z: c.z });
    }
    // Top-down, and STOP at the first block that is not ours. Our blocks always sit on top of the
    // terrain, so anything below the first foreign block is the world's, not the probe's.
    const found = [];
    for (const { x, z } of columns.values()) {
        for (let y = originY + 24; y > originY - 16; y--) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (!b) break;
            if (REPLACEABLE.has(b.name)) continue;
            if (!OURS.has(b.name)) break;
            found.push(new Vec3(x, y, z));
        }
    }
    if (!found.length) { log('tidy: nothing of mine is standing at the site'); return; }
    log(`tidy: ${found.length} leftover blocks of mine across ${columns.size} columns`);
    const started = flight.beginFlight(bot);
    const left = await removeOwn(bot, found);
    flight.endFlight(bot, started);
    log(left.length ? `tidy: ${left.length} would NOT go: ${left.slice(0, 6).join(', ')}` : 'tidy: all removed');
}

/**
 * Read-only damage census. Player-dug holes are `air`; natural cave voids are `cave_air`, and the
 * generator uses that distinction consistently - so an `air` cell UNDER the surface in one of this
 * probe's own columns is almost certainly a block the probe removed. Indicative, not proof: a
 * player-dug tunnel from any other source reads the same.
 */
function census(bot, plan, originY) {
    const columns = new Map();
    for (const p of plan) columns.set(`${p.col.x},${p.col.z}`, p.col);
    let holes = 0, caves = 0;
    const where = [];
    for (const { x, z } of columns.values()) {
        let surface = null;
        for (let y = originY + 24; y > originY - 20; y--) {
            const b = bot.blockAt(new Vec3(x, y, z));
            if (!b) break;
            if (surface === null) { if (!REPLACEABLE.has(b.name)) surface = y; continue; }
            if (b.name === 'air') { holes++; if (where.length < 10) where.push(`(${x},${y},${z})`); }
            else if (b.name === 'cave_air') caves++;
        }
    }
    log(`census over ${columns.size} columns: ${holes} sub-surface AIR cells (probably dug), `
        + `${caves} cave_air (natural). ${where.length ? 'e.g. ' + where.join(' ') : ''}`);
}

function verdictFor(kind, want, got) {
    if (!got) return 'NO-STATE';
    if (got === want) return 'OK';
    if (kind === 'axis') return 'WRONG-AXIS';
    if (got === OPPOSITE[want]) return 'INVERTED';
    if (['up', 'down'].includes(got)) return `VERTICAL(${got})`;
    return 'PERPENDICULAR';
}

async function runLive(bot, plan, originY, opts) {
    // ---- resolve and survey EVERYTHING before placing anything (feasibility, then ground broken)
    const resolved = [];
    const blocked = [];
    for (const p of plan) {
        const r = resolve(bot, p, originY);
        if (r.why) { blocked.push(`${p.block}/${p.want}: ${r.why}`); continue; }
        for (const c of [r.P, ...r.fillers]) {
            const b = bot.blockAt(c);
            if (!b) { blocked.push(`${p.block}/${p.want}: (${c.x},${c.y},${c.z}) unloaded`); r.bad = true; break; }
            if (!REPLACEABLE.has(b.name)) { blocked.push(`${p.block}/${p.want}: (${c.x},${c.y},${c.z}) holds ${b.name}`); r.bad = true; break; }
        }
        if (!r.bad) resolved.push({ ...p, ...r });
    }
    if (blocked.length) {
        log(`REFUSING: ${blocked.length} of ${plan.length} trials have no clear site.`);
        for (const b of blocked.slice(0, 8)) log(`  ${b}`);
        log('Nothing was placed and nothing was dug. Aim --at somewhere open and level-ish.');
        return null;
    }
    const ys = resolved.map(r => r.P.y);
    const xs = resolved.map(r => r.P.x), zs = resolved.map(r => r.P.z);
    log(`site clear: ${resolved.length} trials in x ${Math.min(...xs)}-${Math.max(...xs)}, `
        + `z ${Math.min(...zs)}-${Math.max(...zs)}, y ${Math.min(...ys)}-${Math.max(...ys)} `
        + `(${placedCount(resolved)} blocks will be placed, all of them dug out again)`);
    if (opts.surveyOnly) { log('--survey: the site is usable and NOTHING was placed.'); return null; }

    const placedByUs = [];          // the ONLY cells this probe will ever dig
    const rows = [];
    const started = flight.beginFlight(bot);
    try {
        for (const p of resolved) {
            const row = { block: p.block, kind: p.kind, want: p.want, got: null, verdict: 'NOT-PLACED', why: '' };
            rows.push(row);

            let ok = true;
            for (const c of p.fillers) {                        // pedestal, bottom-up
                const r = await placeStone(bot, c);
                if (!r.ok) { row.why = `pedestal: ${r.why}`; ok = false; break; }
                placedByUs.push(c.clone());
            }
            if (!ok) continue;

            if (!(await equip(bot, p.item))) { row.why = `no item ${p.item}`; continue; }
            const ref = bot.blockAt(p.support);
            if (!ref || REPLACEABLE.has(ref.name)) { row.why = 'support vanished'; continue; }

            // the builder's own approach rule, then its own packet path
            const clickPoint = flight.placementPose(p.P, p.faceVec, 0).faceCentre;
            const stand = approachFor(p.P, p.look, p.faceName, p.faceVec);
            const dest = p.look
                ? new Vec3(stand.x + 0.5, p.P.y + 0.2, stand.z + 0.5)
                : flight.placementPose(p.P, p.faceVec, 2.0).feet;
            const far = await flyToWithin(bot, dest, p.P);
            if (far) { row.why = far; continue; }
            await blockIO.snapLook(bot, clickPoint);
            // Let the LOOK reach the server before the placement does. The hypothesis under test:
            // the server derives a look-steered facing from the yaw it last received, and
            // `block_place` written immediately after `bot.look` can overtake it - which would make
            // every stairs/door/gate facing depend on where the bot happened to be looking on the
            // PREVIOUS trial. Run 3 showed exactly that shape: look achieved correctly on all 37
            // trials, results still scattered, several equal to the previous trial's look.
            const settle = Number(arg('settle', 0));
            if (settle > 0) {
                if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(Math.max(1, Math.round(settle / 50)));
                else await new Promise(r => setTimeout(r, settle));
            }
            // What did we ACTUALLY end up looking at? A trial placed from the wrong side measures
            // the probe's flight, not the builder's mapping, and must not be scored as if it had
            // measured the mapping. (CLAUDE.md: measure the thing you are concluding about.)
            const lookWanted = p.look ? dirName(p.look) : null;
            const lookGot = yawToCardinal(bot.entity.yaw);
            row.lookWanted = lookWanted;
            row.lookGot = lookGot;
            const r = await blockIO.placeVerified(bot, ref, p.faceVec, { expectName: p.block, placeOpts: { swingArm: 'right' } });
            if (!r.ok) { row.why = r.why; continue; }
            placedByUs.push(p.P.clone());

            const got = bot.blockAt(p.P)?.getProperties?.() ?? {};
            row.got = got[propKeyOf(p.kind)] ?? null;
            row.half = got.half ?? null;
            row.at = `${p.P.x},${p.P.y},${p.P.z}`;
            row.verdict = (lookWanted && lookGot !== lookWanted)
                ? 'UNPOSITIONED'          // the probe never got on the right side; says nothing about the mapping
                : verdictFor(p.kind, p.want, row.got);
            row.why = `look wanted ${lookWanted ?? 'none'}, got ${lookGot}, face=${p.faceName}`;
            log(`${p.block} want ${p.want} -> got ${row.got} : ${row.verdict}`);
        }
    } finally {
        if (opts.keep) {
            log(`--keep: left ${placedByUs.length} blocks standing at the site for inspection`);
        } else {
            const left = await removeOwn(bot, placedByUs.slice().reverse());
            log(left.length
                ? `cleanup: ${placedByUs.length - left.length}/${placedByUs.length} removed - STILL STANDING: ${left.join(', ')}`
                : `cleanup: all ${placedByUs.length} cells removed`);
        }
        flight.endFlight(bot, started);
    }
    return rows;
}

function report(rows) {
    const byClass = new Map();
    for (const r of rows) {
        const k = `${r.block} (${r.kind})`;
        if (!byClass.has(k)) byClass.set(k, []);
        byClass.get(k).push(r);
    }
    console.log('\n  block                              want   got    verdict');
    for (const r of rows)
        console.log(`  ${r.block.padEnd(27)} ${r.kind.padEnd(5)} ${String(r.want).padEnd(6)} ${String(r.got ?? '-').padEnd(6)} ${r.verdict}${r.why ? '  ' + r.why : ''}`);
    log('VERDICT by class:');
    for (const [k, rs] of byClass) {
        const ok = rs.filter(r => r.verdict === 'OK').length;
        const inv = rs.filter(r => r.verdict === 'INVERTED').length;
        const unplaced = rs.filter(r => r.verdict === 'NOT-PLACED').length;
        const unpos = rs.filter(r => r.verdict === 'UNPOSITIONED').length;
        const scored = rs.length - unplaced - unpos;
        let note = `${ok}/${scored || rs.length} correct`;
        if (unpos) note += `, ${unpos} placed from the WRONG SIDE (probe's flight, not the mapping)`;
        if (inv === rs.length) note += ' - WHOLE CLASS INVERTED: one sign error in lookVecFor';
        else if (inv) note += `, ${inv} inverted - approach or clicked face, not the mapping`;
        if (unplaced) note += `, ${unplaced} never placed (measured nothing)`;
        console.log(`  ${k.padEnd(36)} ${note}`);
    }
    const measured = rows.filter(r => r.verdict !== 'NOT-PLACED').length;
    log(`${measured} of ${rows.length} trials produced a measurement. `
        + 'A trial that never placed is not evidence of anything.');
}

/**
 * The bot spawns wherever the server puts it, which is usually not the site - and `blockAt`
 * returns null for an unloaded chunk, so surveying from across the world reports "not loaded" for
 * a site that is perfectly fine. A null read is not evidence (CLAUDE.md): wait to actually BE
 * there, and say so, rather than concluding anything from the distance.
 */
async function waitForSite(bot, origin, timeoutMs = Number(arg('wait', 90)) * 1000) {
    const near = () => bot.entity.position.distanceTo(origin) < 96 && !!bot.blockAt(origin);
    if (near()) return true;
    // Move ourselves if the server lets us. probe1 is an operator for exactly this reason: the bot
    // spawns at world spawn, ~2000 blocks from any site worth measuring, and it cannot walk that.
    // Doing it from inside the bot means a run needs no RCON round trip and no human - and RCON on
    // this server stops accepting connections after ~13 rapid ones, so not needing it is the point.
    const dest = `${origin.x} ${origin.y + 6} ${origin.z}`;
    log(`teleporting myself to ${dest}`);
    bot.chat(`/tp ${bot.username} ${dest}`);
    const deadline = Date.now() + timeoutMs;
    let asked = false;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        if (near()) { log(`at the site: ${bot.entity.position.floored()}`); return true; }
        // A negative read is not evidence until a positive control returns something: if the self
        // teleport did nothing, say what to run by hand instead of concluding the site is bad.
        if (!asked && Date.now() > deadline - timeoutMs + 5000) {
            asked = true;
            log(`self teleport did not move me (am I an operator?) - run: mc "tp ${bot.username} ${dest}"`);
        }
    }
    log(`never got to the site (still ${bot.entity.position.distanceTo(origin).toFixed(0)} blocks away). Nothing measured.`);
    return false;
}

/**
 * What is actually at a candidate site? `--peek` prints the surface around `--at` - block name and
 * height per column - and places nothing. It exists because "not natural ground" has two very
 * different causes: a player-built floor (move the site) and a biome this probe's NATURAL set does
 * not list, such as the terracotta of a badlands (widen the set). The refusal alone cannot tell
 * them apart, and guessing which it is means either damaging a build or refusing a fine site.
 */
function peek(bot, origin, span = 8, step = 2) {
    log(`surface around (${origin.x},${origin.z}), scanning down from y=${origin.y + 8}:`);
    for (let dz = span; dz >= -span; dz -= step) {
        let line = '';
        for (let dx = -span; dx <= span; dx += step) {
            const x = origin.x + dx, z = origin.z + dz;
            let cell = '        ?';
            for (let y = origin.y + 8; y > origin.y - 12; y--) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (!b) { cell = ' unloaded'; break; }
                if (REPLACEABLE.has(b.name)) continue;
                cell = `${b.name.replace(/^minecraft:/, '').slice(0, 14)}@${y}`;
                break;
            }
            line += cell.padEnd(20);
        }
        console.log(`  z=${String(origin.z + dz).padStart(5)} ${line}`);
    }
    log('--peek: nothing was placed. A flat rectangle at ONE height is a floor; '
        + 'mixed names at mixed heights is terrain.');
}

// ---------------------------------------------------------------- main

const only = arg('only', null);
const trials = only ? TRIALS.filter(t => only.split(',').some(s => t.block.includes(s))) : TRIALS;
if (!trials.length) { log(`--only ${only} matched none of: ${TRIALS.map(t => t.block).join(', ')}`); process.exit(2); }

if (has('dry')) {
    const plan = planSite(new Vec3(0, 64, 0), trials);
    predictionTable(plan);
    console.log('');
    coverage(arg('blueprint', 'blueprints/wizard_tower.json'));
    log('dry run: nothing was connected to and nothing was placed.');
    process.exit(0);
}

const at = arg('at', null);
if (!at) { log('need --at x,y,z (an EMPTY spot; it surveys and refuses otherwise), or --dry'); process.exit(2); }
const [ax, ay, az] = at.split(',').map(Number);
if ([ax, ay, az].some(Number.isNaN)) { log(`--at ${at} is not x,y,z`); process.exit(2); }

// The repo's own factory, not `mineflayer.createBot`. Two reasons, one of them load-bearing:
// `mc.initBot` installs the minecraft-data tables when the version is known, and WITHOUT it
// `mc.makeItem` throws `mcdata.itemsByName is null` - which this probe first hit as 39 trials
// reporting `pedestal: no stone`, a placement failure that was really an inventory failure. It
// also goes through the settings.mc_client seam, so the probe measures whatever client the agent
// uses. Host, port and version therefore come from settings.js, exactly as the agent's do.
// mcdata reads the LIVE settings object (src/agent/settings.js), which only the agent's own
// startup normally fills - so a standalone tool has to do it, and has to resolve the version
// itself. "auto" is not usable here: ViaVersion advertises the newest version it supports in the
// ping (measured: `Server version '26.1.2' is not supported`), which is its whole job, and
// mineflayer's testedVersions gate then refuses to load. Connect as 1.21.11 - the server's own
// version, per CLAUDE.md and the note at settings.js:2 - rather than chasing the ping.
setSettings({ ...real, minecraft_version: arg('version', '1.21.11') });
const bot = mc.initBot(arg('username', 'probe1'));
bot.on('kicked', (r) => { log(`kicked: ${r}`); process.exit(1); });
bot.on('error', (e) => { log(`error: ${e.message}`); });

bot.once('spawn', async () => {
    log(`spawned as ${bot.username} at ${bot.entity.position.floored()}, gameMode=${bot.game?.gameMode}`);
    // A probe that digs a survival hole to answer a cosmetic question is not worth the hole.
    if (bot.game?.gameMode !== 'creative' && !has('survey')) {
        log('REFUSING: not in creative. Put this bot in creative first (it needs to fly and to '
            + 'conjure the blocks it tests). Nothing was placed.');
        return bot.quit();
    }
    const plan = planSite(new Vec3(ax, ay, az), trials);
    predictionTable(plan);
    if (!(await waitForSite(bot, new Vec3(ax, ay, az)))) return bot.quit();
    if (has('peek')) { peek(bot, new Vec3(ax, ay, az)); return bot.quit(); }
    if (has('census')) { census(bot, plan, ay); return bot.quit(); }
    if (has('tidy')) { await tidy(bot, plan, ay); census(bot, plan, ay); return bot.quit(); }
    const rows = await runLive(bot, plan, ay, { keep: has('keep'), surveyOnly: has('survey') });
    if (rows) {
        report(rows);
        const out = arg('out', null);
        if (out) { writeFileSync(out, JSON.stringify(rows, null, 2)); log(`wrote ${out}`); }
    }
    bot.quit();
});
