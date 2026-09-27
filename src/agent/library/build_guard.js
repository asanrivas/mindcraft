/**
 * Don't mine the house to get to the other side of the house.
 *
 * THE ASYMMETRY THIS FIXES
 * ------------------------
 * `blueprint_builder.js` already respects its own work: `scaffoldTo` refuses to pillar in any
 * cell the blueprint owns (`ctx.occupied`), so the scaffold never fights the structure. The
 * NAVIGATOR knows none of that. Its stall ladder exists for open country, where digging through
 * and bridging across are exactly right, and it applies the same reflexes inside a building -
 * where the obstacle in front of the bot is the wall it just finished.
 *
 * Both halves were measured on the live run of 2026-08-30:
 *
 *   [bob] bridge: laid dirt at (4716, 67, 4614) - gap of 7 to a landing 8 ahead
 *
 * (4716, 67, 4614) is blueprint-local (16, 0, 14), which the blueprint owns and wants to hold a
 * `brown_carpet`. The dirt was still sitting there an hour later. And `digAhead` will mine
 * anything in front of it that is not air, water, a tree trunk, or a hole that would flood - a
 * finished stone-brick wall very much included.
 *
 * WHY THIS IS A PRICE AND A REFUSAL, NEVER A PROHIBITION
 * -----------------------------------------------------
 * An absolute "never touch the build" seals the bot inside its own house. The walls go up around
 * it, every route out is a blueprint cell, and a bot that cannot dig is a bot that is stuck
 * forever - which is strictly worse than a hole that the builder's verification pass repairs
 * anyway. So the balance is three-layered, weakest first:
 *
 *   1. PLAN around it.   `buildDigCost` prices a protected cell far above `digCost`, so A* only
 *                        routes through the structure when there is genuinely no way round.
 *   2. REFUSE in the executor. The stall ladder skips protected cells the way it already skips
 *                        tree trunks - walk around, do not fell.
 *   3. RELENT when trapped. If the bot is enclosed, digging out beats standing still until the
 *                        watchdog kills it. The builder rebuilds what it removed.
 *
 * Layer 3 is what keeps this safe to turn on. Without it, the better the builder gets at walls,
 * the more reliably it entombs itself.
 *
 * TWO GAPS THE CELL GUARD ALONE LEFT OPEN (reported as "andy breaks my building/fence")
 * ------------------------------------------------------------------------------------
 *   - The guard is per PROCESS, and every bot is its own process. Bob's blueprint protected
 *     Bob's build from Bob and from nobody else. Fixed by `shareBuilds` below.
 *   - Nothing protected a build nobody had registered: a finished house, a player's fence.
 *     Fixed by `isPlayerMadeName` below, which needs no registration at all.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** @type {{cells: Set<string>, minX:number, maxX:number, minY:number, maxY:number, minZ:number, maxZ:number}|null} */
let guard = null;

/**
 * Register the cells a build owns, in WORLD coordinates.
 * `blueprint_builder` holds its occupancy set in blueprint-local coords; converting once here
 * keeps the navigator's lookup a plain Set hit rather than an origin subtraction per probe.
 */
export function protectBuild(cells) {
    const set = new Set();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of cells) {
        set.add(`${c.x},${c.y},${c.z}`);
        if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
        if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    }
    guard = set.size ? { cells: set, minX, maxX, minY, maxY, minZ, maxZ } : null;
    if (guard) publish(); else unpublish();
    return guard ? set.size : 0;
}

/** Stand the guard down. MUST run in a `finally`, or the next task inherits a build that ended. */
export function clearProtectedBuild() { guard = null; unpublish(); }

/** Is a build currently registered - by this bot, or by any other live bot sharing with us? */
export function isProtecting() { return guard !== null || foreignGuards().length > 0; }

function inGuard(g, bx, by, bz) {
    if (bx < g.minX || bx > g.maxX || by < g.minY || by > g.maxY
        || bz < g.minZ || bz > g.maxZ) return false;
    return g.cells.has(`${bx},${by},${bz}`);
}

/**
 * Does an active build own this world cell?
 *
 * The bounding-box test first is not premature optimisation: this is called from the planner's
 * per-move cost function, which runs tens of thousands of times per plan, and the overwhelming
 * majority of those cells are nowhere near the site.
 */
export function isProtected(x, y, z) {
    const others = foreignGuards();
    if (!guard && others.length === 0) return false;
    // FLOOR FIRST, then bound. Callers pass entity positions as well as block coords, and
    // comparing 4716.8 against a maxX of 4716 rejects the very cell it is standing in - the
    // fast path would then quietly answer "not protected" for the busiest cells of all.
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (guard && inGuard(guard, bx, by, bz)) return true;
    for (const g of others) if (inGuard(g, bx, by, bz)) return true;
    return false;
}

/**
 * May the bot break or overwrite this cell?
 *
 * Pure, so the policy is testable without a bot or a world. `enclosed` is the caller's measured
 * answer to "is there any way out that is not through the build" - see layer 3 above.
 *
 * THAT IS NOT THE SAME QUESTION AS `nav.enclosed()`, and the difference is the whole valve.
 * `nav.enclosed` asks "is there a standable cell in any of the eight directions", which is TRUE
 * for any bot standing in a room - it can walk around inside its own tomb. Passing it here made
 * layer 3 decorative: it could only fire for a bot in a literal one-cell pocket, which is
 * precisely the state a finished building never puts it in. `nav.trappedByBuild()` is the
 * measurement this field wants.
 *
 * @param {{protectedCell: boolean, enclosed?: boolean}} s
 * @returns {{allow: boolean, why: string}}
 */
export function protectVerdict(s) {
    if (!s || !s.protectedCell) return { allow: true, why: 'not part of a build' };
    if (s.enclosed) return { allow: true, why: 'walled in - digging out beats standing still' };
    return { allow: false, why: 'build' };
}

/**
 * The registered builds' bounding box in WORLD coordinates, or null when nothing is registered.
 * With another bot's build in the mix this is the UNION of the boxes - Andy standing inside
 * Bob's finished walls must be able to measure himself trapped, or the shared guard entombs him.
 *
 * Exported for layer 3 only. "Is the bot walled in by the build" cannot be answered from the
 * cell set alone - it is a question about the free space AROUND those cells, which needs a
 * world. `nav.trappedByBuild` supplies that half; this supplies the footprint it searches.
 */
export function protectedBox() {
    const all = guard ? [guard, ...foreignGuards()] : foreignGuards();
    if (all.length === 0) return null;
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const g of all) {
        box.minX = Math.min(box.minX, g.minX); box.maxX = Math.max(box.maxX, g.maxX);
        box.minY = Math.min(box.minY, g.minY); box.maxY = Math.max(box.maxY, g.maxY);
        box.minZ = Math.min(box.minZ, g.minZ); box.maxZ = Math.max(box.maxZ, g.maxZ);
    }
    return box;
}

// =================================================================================================
// SHARING THE GUARD ACROSS BOTS
//
// `agent_process.js` spawns one process per bot, so `guard` is per bot. A bot that registers a
// build therefore also PUBLISHES it - one file per process under bots/.active_builds/, never one
// shared file (two writers on one file is how package.json's suite list silently lost eight
// suites). Readers merge every OTHER live process's file.
//
// OFF until `shareBuilds()` is called, and only init_agent.js calls it. The suites import this
// module in the same checkout the live bots run in: if reading were on by default, whatever Bob
// happens to be building would leak into tests/build_guard.test.mjs as protected cells.
// =================================================================================================

const DEFAULT_SHARE_DIR = fileURLToPath(new URL('../../../bots/.active_builds/', import.meta.url));
// The planner calls `isProtected` tens of thousands of times per plan. This keeps that a clock
// read rather than a readdir; a build Bob starts reaches Andy's planner within two seconds.
const FOREIGN_RESCAN_MS = 2000;

let shareDir = null;
let foreign = [];
let foreignScannedAt = 0;
const parsedFiles = new Map();   // file -> { mtimeMs, entry } so an unchanged build is parsed once
let exitHookInstalled = false;

/**
 * Publish this bot's builds and honour every other bot's. `null` turns sharing off again.
 * @param {string|null} [dir]
 */
export function shareBuilds(dir = DEFAULT_SHARE_DIR) {
    unpublish();
    shareDir = dir;
    foreign = [];
    foreignScannedAt = 0;
    parsedFiles.clear();
    if (!dir) return;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* another bot may have made it */ }
    if (!exitHookInstalled) { exitHookInstalled = true; process.on('exit', unpublish); }
    if (guard) publish();
}

function ownFile() { return shareDir ? path.join(shareDir, `${process.pid}.json`) : null; }

function publish() {
    const file = ownFile();
    if (!file || !guard) return;
    // Write-then-rename so a reader never parses half a file.
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, cells: [...guard.cells] }));
        fs.renameSync(tmp, file);
    } catch (err) {
        console.warn(`build_guard: could not publish the build to other bots: ${err.message}`);
    }
}

function unpublish() {
    const file = ownFile();
    if (!file) return;
    try { fs.unlinkSync(file); } catch { /* nothing published */ }
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function guardFromKeys(keys) {
    const set = new Set(keys);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const k of set) {
        const [x, y, z] = k.split(',').map(Number);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return set.size ? { cells: set, minX, maxX, minY, maxY, minZ, maxZ } : null;
}

/** Every OTHER live bot's registered build. A file whose process has died is ignored, not trusted. */
function foreignGuards() {
    if (!shareDir) return foreign;
    const now = Date.now();
    if (now - foreignScannedAt < FOREIGN_RESCAN_MS) return foreign;
    foreignScannedAt = now;
    let names;
    try { names = fs.readdirSync(shareDir); } catch { foreign = []; return foreign; }
    const next = [];
    const seen = new Set();
    for (const f of names) {
        const m = /^(\d+)\.json$/.exec(f);
        if (!m) continue;
        const pid = Number(m[1]);
        // A bot killed with SIGKILL never runs its exit hook, so its file outlives it. Its build
        // is not being worked on any more; honouring it would fence off a site forever.
        if (pid === process.pid || !isAlive(pid)) continue;
        const file = path.join(shareDir, f);
        seen.add(file);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        let hit = parsedFiles.get(file);
        if (!hit || hit.mtimeMs !== st.mtimeMs) {
            try {
                hit = { mtimeMs: st.mtimeMs, entry: guardFromKeys(JSON.parse(fs.readFileSync(file, 'utf8')).cells) };
            } catch { continue; }
            parsedFiles.set(file, hit);
        }
        if (hit.entry) next.push(hit.entry);
    }
    for (const k of parsedFiles.keys()) if (!seen.has(k)) parsedFiles.delete(k);
    foreign = next;
    return foreign;
}

// =================================================================================================
// PLAYER-MADE BLOCKS - protection that needs no registered build
//
// The cell guard only knows builds a bot registered, and only while it runs: once a blueprint
// finishes its guard is cleared, and a house the player built was never registered at all. What
// the navigator CAN always see is the block name. Nothing below generates as ordinary terrain -
// the list is things somebody built with.
//
// This is a PRICE and an executor refusal with an escape valve, never a ban. `skills.js` once
// hard-refused `stone_bricks` and stranded a bot for 97 minutes against a wall it was forbidden
// to mine; that is why bricks were left out of its list. Here the planner prices them like a
// build, so it goes round when a way round exists, and `digAhead` still mines one when the
// PLAN itself routes through it - which it only does when there is no cheaper route at all.
// =================================================================================================

export const PLAYER_MADE_EXACT = new Set([
    'chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
    'crafting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'beacon', 'conduit',
    'enchanting_table', 'brewing_stand', 'cauldron', 'lodestone', 'respawn_anchor',
    'jukebox', 'note_block', 'bookshelf', 'lectern', 'composter', 'loom', 'grindstone',
    'smithing_table', 'cartography_table', 'fletching_table', 'stonecutter', 'bell',
    'hopper', 'dispenser', 'dropper', 'observer', 'piston', 'sticky_piston', 'tnt',
    'torch', 'wall_torch', 'soul_torch', 'lantern', 'soul_lantern', 'campfire', 'ladder',
    'scaffolding', 'item_frame', 'painting', 'flower_pot', 'armor_stand',
    // Plain `glass_pane` does not end in `_glass_pane`, so the family below never caught it.
    'glass', 'tinted_glass', 'glass_pane', 'bricks',
    'cobbled_deepslate', 'smooth_stone', 'quartz_block',
]);

export const PLAYER_MADE_SUFFIXES = [
    '_bed', '_door', '_trapdoor', '_sign', '_banner', '_shulker_box', '_glazed_terracotta',
    '_wool', '_carpet', '_concrete', '_glass_pane', '_stained_glass', '_candle', '_planks',
    // The shapes a building is made of, and the ones the navigator was actually breaking.
    '_fence', '_fence_gate', '_wall', '_stairs', '_slab', '_bricks', '_tiles',
];

/** Did somebody build with this? Exact names and whole families - never a substring. */
export function isPlayerMadeName(name) {
    if (!name) return false;
    if (PLAYER_MADE_EXACT.has(name)) return true;
    if (name.startsWith('stripped_')) return true;   // bark only comes off with an axe
    return PLAYER_MADE_SUFFIXES.some(s => name.endsWith(s));
}

/**
 * Blocks whose collision box is 1.5 tall: `classify` sees an ordinary SOLID cell, so the planner
 * believed the bot could step up onto one. It cannot - a jump peaks at 1.252 - so the bot pinned
 * itself against the fence and the last-resort `digAhead` mined it. Open gates have no collision
 * box and classify as AIR, so they stay walkable.
 */
export function isTallCollisionName(name) {
    return !!name && (name.endsWith('_fence') || name.endsWith('_fence_gate') || name.endsWith('_wall'));
}
