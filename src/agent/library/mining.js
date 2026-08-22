/**
 * Branch mining, built on primitives that actually work on this server.
 *
 * WHY THIS EXISTS
 * ---------------
 * `skills.collectBlock` cannot mine here and fails SILENTLY. It reaches the ore two ways, and
 * both are dead:
 *
 *   - `bot.collectBlock.collect(block)`  -> mineflayer-collectblock -> mineflayer-pathfinder
 *   - `goToPosition(...)`                -> mineflayer-pathfinder
 *
 * Pathfinder will not move this bot at all (see CLAUDE.md: `onGround` reads false while the bot
 * is provably standing, and pathfinder will not even plan over a 1-block step). Three live
 * `!collectBlocks` calls for gold, lapis and copper produced ZERO log output - not a failure
 * message, nothing. That silence is why the mining task looked stalled rather than broken.
 *
 * So this module never calls pathfinder. It uses the same stack the navigation rebuild proved:
 * `nav.navigateTo` / `nav.planPath` for movement and `tools.digWithTool` for breaking blocks.
 *
 * WHAT BRANCH MINING IS
 * ---------------------
 * A main corridor at an ore-rich depth, with short side branches at a fixed spacing. Spacing is
 * the whole point: ore veins are up to 2 blocks wide, so branches 3 apart leave no unseen gap
 * between them while digging a third of the blocks a full clear-out would.
 *
 * SAFETY - EVERY ONE OF THESE HAS A REAL FAILURE BEHIND IT
 * --------------------------------------------------------
 * - Never dig straight down. The bot cannot see what is under the block it stands on; a lava
 *   pocket one block down is unsurvivable, and this bot has already died three times.
 * - Treat an unloaded chunk (`blockAt` -> null) as UNSAFE, never as air. Same invariant the
 *   world guard and swim code both had to learn.
 * - Never break a block with lava adjacent, and never open a wall into a lava lake.
 * - Never stand under gravel/sand while digging - `isFallingBlockName` is canonical in tools.js;
 *   do not re-derive it, `"sandstone".includes("sand")` is why that rule exists.
 * - Bound EVERYTHING. Block budget, wall-clock deadline, and an inventory check, so a mining run
 *   cannot pin the agent the way an unbounded mode action once did for 11 minutes.
 */

import { Vec3 } from 'vec3';
import * as nav from './nav.js';
import * as swim from './swim.js';
import { digWithTool, equipBestTool, isFallingBlockName } from './tools.js';

/** Ores worth stopping for, plus their deepslate variants. */
export const ORE_NAMES = [
    'diamond_ore', 'deepslate_diamond_ore',
    'ancient_debris',
    'emerald_ore', 'deepslate_emerald_ore',
    'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
    'iron_ore', 'deepslate_iron_ore',
    'redstone_ore', 'deepslate_redstone_ore',
    'lapis_ore', 'deepslate_lapis_ore',
    'copper_ore', 'deepslate_copper_ore',
    'coal_ore', 'deepslate_coal_ore',
];

const ORE_SET = new Set(ORE_NAMES);

/** Blocks that end a mining run on contact rather than being dug through. */
const FLUIDS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate']);

/**
 * Y level to mine at. Diamonds peak around -59 in 1.18+ worlds, but the deeper the bot goes the
 * longer the walk home and the more lava it passes. -12 is the compromise this uses by default:
 * deep enough for diamond/redstone/lapis/gold, shallow enough that a failed run is recoverable.
 */
export const DEFAULT_MINE_Y = -12;

/**
 * Navigation options for a ONE-BLOCK step. These overrides are not tuning - they are required.
 *
 * nav's goal tolerances default to `arriveDist: 2` and `arriveY: 1.25`, which are right for
 * travelling to a place but catastrophic for stepping one block: the target is already inside
 * the tolerance, so `navigateTo` returns `arrived: true` WITHOUT MOVING. Observed live - a
 * staircase from y=62 to y=52 burned its whole 200-step budget in one second and never
 * descended, then cheerfully reported "Returned to base".
 *
 * Same lesson this project keeps paying for: trust MEASURED progress, not an arrival flag.
 */
export const STEP_NAV = { arriveDist: 0.7, arriveY: 0.6, maxReplans: 2, allowDig: true };

/** How many consecutive no-progress steps before we call a descent or corridor dead. */
export const MAX_STALLS = 3;

export function isOreName(name) {
    return ORE_SET.has(name);
}

/**
 * Read a block, treating "not loaded" as its own answer.
 * @returns {{name:string, block:object|null, known:boolean}}
 */
export function readBlock(bot, pos) {
    const b = bot.blockAt(pos);
    if (!b) return { name: 'unknown', block: null, known: false };
    return { name: b.name, block: b, known: true };
}

const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';

/**
 * Is it safe to break this cell? Pure enough to unit-test with a fake reader.
 *
 * @param {(dx:number,dy:number,dz:number)=>string} at  block name relative to the target cell
 * @returns {{ok:boolean, reason?:string}}
 */
export function safeToBreak(at) {
    const self = at(0, 0, 0);
    if (self === 'unknown') return { ok: false, reason: 'unloaded chunk' };
    if (UNBREAKABLE.has(self)) return { ok: false, reason: self };
    if (FLUIDS.has(self)) return { ok: false, reason: self };

    // Opening a wall into lava floods the corridor. Check all six neighbours, not just ahead.
    const sides = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [dx, dy, dz] of sides) {
        const n = at(dx, dy, dz);
        if (n === 'lava' || n === 'flowing_lava') return { ok: false, reason: 'lava adjacent' };
        if (n === 'unknown') return { ok: false, reason: 'unloaded neighbour' };
    }
    // Gravel or sand directly above pours into the corridor - and onto the bot's head.
    if (isFallingBlockName(at(0, 1, 0))) return { ok: false, reason: `falling block above (${at(0, 1, 0)})` };
    return { ok: true };
}

/** Build the relative reader `safeToBreak` wants, for a real bot and an absolute position. */
function readerAt(bot, pos) {
    return (dx, dy, dz) => readBlock(bot, pos.offset(dx, dy, dz)).name;
}

/**
 * Dig one cell if it is safe and solid. Returns what happened, never throws.
 * @returns {Promise<'dug'|'skipped'|'blocked'|'unsafe'>}
 */
export async function digCell(bot, pos, opts = {}) {
    const { name, block, known } = readBlock(bot, pos);
    if (!known) return 'unsafe';
    if (isAir(name)) return 'skipped';

    const verdict = safeToBreak(readerAt(bot, pos));
    if (!verdict.ok) {
        if (opts.onUnsafe) opts.onUnsafe(pos, verdict.reason);
        return 'unsafe';
    }
    try {
        await digWithTool(bot, block);
        return 'dug';
    } catch {
        return 'blocked';
    }
}

/**
 * Ores exposed within `radius` of the bot, nearest first.
 *
 * Deliberately a local scan rather than `world.getNearestBlocks` over 64 blocks: an ore 60 blocks
 * away through solid rock is not "found", it is a 60-block dig the caller did not ask for. Branch
 * mining wins by covering ground cheaply, not by chasing distant reads.
 */
export function exposedOres(bot, radius = 4) {
    const out = [];
    const p = bot.entity.position.floored();
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const pos = p.offset(dx, dy, dz);
                const { name, known } = readBlock(bot, pos);
                if (!known || !isOreName(name)) continue;
                out.push({ pos, name, d: Math.abs(dx) + Math.abs(dy) + Math.abs(dz) });
            }
        }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
}

/** Count how many of the named items the bot holds. */
export function countItems(bot, names) {
    const set = new Set(names);
    return bot.inventory.items().filter(i => set.has(i.name)).reduce((n, i) => n + i.count, 0);
}

/**
 * Descend to `targetY` by cutting a staircase.
 *
 * A staircase, never a vertical shaft: digging the block under your own feet is how a bot falls
 * into lava it could not see. Each step digs the cell ahead at head and foot height, then the
 * one below it, and walks in - so the bot always has a floor it has already inspected.
 */
export async function staircaseDown(bot, targetY, opts = {}) {
    const o = { maxSteps: 200, deadlineMs: 180000, ...opts };
    const t0 = Date.now();
    const dir = pickOpenDirection(bot);
    let steps = 0, dug = 0, stalls = 0;

    while (bot.entity.position.y > targetY + 0.5) {
        if (bot.interrupt_code) return { reached: false, reason: 'interrupted', dug, steps };
        if (steps++ >= o.maxSteps) return { reached: false, reason: 'step budget', dug, steps };
        if (Date.now() - t0 > o.deadlineMs) return { reached: false, reason: 'timeout', dug, steps };

        const p = bot.entity.position.floored();
        const ahead = p.offset(dir.x, 0, dir.z);
        const yBefore = bot.entity.position.y;

        // Cut the doorway (feet + head), then the floor below it, then step down into it.
        for (const cell of [ahead, ahead.offset(0, 1, 0), ahead.offset(0, -1, 0)]) {
            const r = await digCell(bot, cell);
            if (r === 'dug') dug++;
            if (r === 'unsafe') return { reached: false, reason: 'unsafe cell', dug, steps };
        }

        const target = ahead.offset(0, -1, 0);
        await nav.navigateTo(bot, { x: target.x + 0.5, y: target.y, z: target.z + 0.5 },
                             { ...STEP_NAV, timeoutMs: 8000 });

        // Judge on MEASURED descent, never on nav's arrived flag - at these tolerances the flag
        // reads true before the bot has moved at all.
        if (yBefore - bot.entity.position.y < 0.5) {
            if (++stalls >= MAX_STALLS) {
                return { reached: false, reason: 'no descent progress', dug, steps };
            }
        } else {
            stalls = 0;
        }
    }
    return { reached: true, reason: 'ok', dug, steps, y: bot.entity.position.y };
}

/** Pick a horizontal direction with the least solid rock in front, to start a corridor. */
export function pickOpenDirection(bot) {
    const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    const p = bot.entity.position.floored();
    let best = dirs[0], bestScore = -Infinity;
    for (const d of dirs) {
        let score = 0;
        for (let i = 1; i <= 6; i++) {
            const { name, known } = readBlock(bot, p.offset(d.x * i, 0, d.z * i));
            if (!known) { score -= 5; break; }          // unloaded: least attractive
            if (FLUIDS.has(name)) { score -= 20; break; } // never tunnel toward fluid
            if (isAir(name)) score += 1;
        }
        if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
}

/**
 * Dig a 2-high corridor `length` blocks in `dir`, collecting any ore it exposes.
 * @returns {Promise<{dug:number, ores:number, stopped:string|null, walked:number}>}
 */
export async function mineCorridor(bot, dir, length, opts = {}) {
    const o = { deadlineMs: 240000, oreRadius: 3, onOre: null, ...opts };
    const t0 = Date.now();
    let dug = 0, ores = 0, walked = 0, stalls = 0;

    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) return { dug, ores, stopped: 'interrupted', walked };
        if (Date.now() - t0 > o.deadlineMs) return { dug, ores, stopped: 'timeout', walked };
        if (bot.inventory.emptySlotCount() === 0) return { dug, ores, stopped: 'inventory full', walked };

        const p = bot.entity.position.floored();
        const feet = p.offset(dir.x, 0, dir.z);
        const head = feet.offset(0, 1, 0);

        for (const cell of [feet, head]) {
            const r = await digCell(bot, cell);
            if (r === 'dug') dug++;
            if (r === 'unsafe') return { dug, ores, stopped: 'unsafe cell', walked };
        }

        const from = bot.entity.position.clone();
        await nav.navigateTo(bot, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 },
                             { ...STEP_NAV, timeoutMs: 6000 });
        // Measured, not reported: a one-block goal sits inside nav's default arrival tolerance,
        // so `arrived` is true before the bot moves. Distance actually covered is the truth.
        const moved = bot.entity.position.distanceTo(from);
        walked += moved;
        if (moved < 0.3) {
            if (++stalls >= MAX_STALLS) return { dug, ores, stopped: 'stuck', walked };
        } else {
            stalls = 0;
        }

        ores += await harvestExposedOres(bot, o.oreRadius, { onOre: o.onOre, deadlineMs: o.deadlineMs - (Date.now() - t0) });
    }
    return { dug, ores, stopped: null, walked };
}

/**
 * Dig out every ore currently visible near the bot. Re-scans after each one, since breaking a
 * vein commonly exposes the next block of the same vein.
 */
export async function harvestExposedOres(bot, radius = 3, opts = {}) {
    const o = { maxPerCall: 12, deadlineMs: 60000, onOre: null, ...opts };
    const t0 = Date.now();
    let got = 0;

    for (let n = 0; n < o.maxPerCall; n++) {
        if (bot.interrupt_code || Date.now() - t0 > o.deadlineMs) break;
        const found = exposedOres(bot, radius);
        if (!found.length) break;

        const target = found[0];
        // Walk adjacent first: reach is ~4.5 blocks and a dig at the limit silently no-ops.
        if (target.d > 3) {
            const res = await nav.navigateTo(bot,
                { x: target.pos.x + 0.5, y: target.pos.y, z: target.pos.z + 0.5 },
                { maxReplans: 1, allowDig: true, timeoutMs: 6000 });
            if (!res.arrived && res.covered < 0.3) break;
        }
        const r = await digCell(bot, target.pos);
        if (r !== 'dug') break;
        got++;
        if (o.onOre) o.onOre(target.name);
        // Dropped items need a moment to be picked up; the bot walks over them next step anyway.
        await new Promise(res => setTimeout(res, 120));
    }
    return got;
}

/**
 * Full branch-mining run: descend, cut a main corridor, cut branches, come home.
 *
 * The return trip is part of the job, not an afterthought: a bot that mines perfectly and then
 * cannot find its way out has produced nothing. `home` is remembered before the first dig.
 *
 * @returns {Promise<object>} a report; never throws
 */
export async function branchMine(bot, opts = {}) {
    const o = {
        targetY: DEFAULT_MINE_Y,
        mainLength: 24,
        branchLength: 8,
        branchSpacing: 3,     // veins are <=2 wide, so 3 leaves no unseen gap
        deadlineMs: 900000,   // 15 min hard ceiling
        returnHome: true,
        ...opts,
    };

    // PRECONDITIONS. Refuse loudly rather than performing a vacuous run.
    //
    // The first live attempt started while the bot was floating in a river: nothing can be dug
    // or placed while afloat (the same reason pillaring does not work - see CLAUDE.md), so the
    // descent made no progress and the run still reported "VERIFIED MINE ... Returned to base".
    // A report that says success while nothing happened is worse than an error, and is precisely
    // the failure mode that made `collectBlock` look fine for months.
    if (swim.inWater(bot)) {
        return { ...emptyReport(bot), stopped: 'standing in water - move to dry land first' };
    }
    if (swim.inLava(bot)) {
        return { ...emptyReport(bot), stopped: 'standing in lava' };
    }

    const home = bot.entity.position.clone();
    const startCounts = countItems(bot, ORE_NAMES);
    const t0 = Date.now();
    const report = {
        home: { x: Math.round(home.x), y: Math.round(home.y), z: Math.round(home.z) },
        descended: false, minedY: null, dug: 0, ores: 0, branches: 0,
        oreNames: {}, returned: false, stopped: null, seconds: 0,
    };
    const noteOre = (name) => { report.oreNames[name] = (report.oreNames[name] || 0) + 1; };
    const left = () => o.deadlineMs - (Date.now() - t0);
    const finish = (stopped) => {
        report.stopped = stopped;
        report.seconds = Math.round((Date.now() - t0) / 1000);
        report.gained = countItems(bot, ORE_NAMES) - startCounts;
        return report;
    };

    // 1. Descend.
    if (bot.entity.position.y > o.targetY + 1) {
        const d = await staircaseDown(bot, o.targetY, { deadlineMs: Math.min(300000, left()) });
        report.dug += d.dug;
        report.descended = d.reached;
        if (!d.reached) {
            // Not fatal - mine at whatever depth we reached rather than abandoning the run.
            report.descendStopped = d.reason;
        }
    } else {
        report.descended = true;
    }
    report.minedY = Math.round(bot.entity.position.y);
    if (left() <= 0) return finish('timeout during descent');

    // 2. Main corridor, harvesting as it goes.
    const dir = pickOpenDirection(bot);
    const main = await mineCorridor(bot, dir, o.mainLength,
        { deadlineMs: Math.min(left(), 300000), onOre: noteOre });
    report.dug += main.dug; report.ores += main.ores;
    if (main.stopped === 'inventory full') return finish('inventory full');
    if (left() <= 0) return finish('timeout in main corridor');

    // 3. Branches, alternating sides off the main corridor.
    const side = { x: -dir.z, z: dir.x };
    for (let b = 0; b < Math.floor(o.mainLength / o.branchSpacing); b++) {
        if (bot.interrupt_code) { finish('interrupted'); break; }
        if (left() < 60000) break;                       // leave time to walk home
        if (bot.inventory.emptySlotCount() === 0) return finish('inventory full');

        const bdir = b % 2 === 0 ? side : { x: -side.x, z: -side.z };
        const r = await mineCorridor(bot, bdir, o.branchLength,
            { deadlineMs: Math.min(left(), 90000), onOre: noteOre });
        report.dug += r.dug; report.ores += r.ores; report.branches++;
        if (r.stopped === 'inventory full') return finish('inventory full');
    }

    // 4. Home.
    if (o.returnHome) {
        const res = await nav.navigateTo(bot, { x: home.x, y: home.y, z: home.z },
            { maxReplans: 8, allowDig: true, timeoutMs: Math.max(30000, left()) });
        report.returned = res.arrived;
        report.distanceHome = Math.round(bot.entity.position.distanceTo(home));
    }
    return finish(report.stopped);
}

/** A report for a run that never started. */
function emptyReport(bot) {
    const p = bot.entity.position;
    return {
        home: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        descended: false, minedY: Math.round(p.y), dug: 0, ores: 0, branches: 0,
        oreNames: {}, returned: false, seconds: 0, gained: 0, refused: true,
    };
}

/**
 * One-line summary in the VERIFIED style the rest of the codebase uses.
 *
 * A run that dug nothing is NOT a VERIFIED anything. The whole point of the VERIFIED prefix in
 * this codebase is that it means measured success; spending it on a no-op teaches the model that
 * mining "worked" and it will happily move on to the next step of its plan.
 */
export function formatMineReport(r) {
    if (r.refused) return `MINE REFUSED: ${r.stopped}.`;
    if (r.dug === 0 && r.ores === 0) {
        let s = `MINE FAILED: dug nothing at y=${r.minedY}`;
        if (r.descendStopped) s += ` (descent: ${r.descendStopped})`;
        if (r.stopped) s += ` (${r.stopped})`;
        return s + '.';
    }
    return verifiedLine(r);
}

function verifiedLine(r) {
    const kinds = Object.entries(r.oreNames).sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n.replace('deepslate_', '')}x${c}`).join(' ');
    let s = `VERIFIED MINE: y=${r.minedY}, dug ${r.dug} block(s), ${r.ores} ore(s)`;
    if (kinds) s += ` [${kinds}]`;
    if (typeof r.gained === 'number') s += `, inventory +${r.gained}`;
    s += `, ${r.branches} branch(es), ${r.seconds}s`;
    s += r.returned ? '. Returned to base.'
                    : `. NOT back at base (${r.distanceHome ?? '?'} blocks away).`;
    if (r.stopped) s += ` Stopped: ${r.stopped}.`;
    if (r.descendStopped) s += ` Descent ended early: ${r.descendStopped}.`;
    return s;
}
