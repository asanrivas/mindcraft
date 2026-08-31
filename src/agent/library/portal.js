/**
 * Nether portal geometry, frame validation, obsidian-cast planning, and the 8:1 coordinate
 * mapping between the overworld and the Nether.
 *
 * PURE ONLY. No bot, no network, no filesystem, no clock — every decision here takes its
 * inputs by explicit argument (a `getName(x,y,z)` lookup stands in for the world), the same
 * shape as `world_guard.js` and `nav.js`'s `waterExitVerdict`. Verify with:
 *
 *   bun tests/portal.test.mjs
 *
 * This is deliberately the "pure core" slice of docs/gaps/nether.exec.md §4.1/§5 — the
 * portal BUILDER, traversal, `!enterNether`, and the lava-crossing policy are out of scope
 * here and are explicitly deferred by that plan. Nothing in this file touches a live bot.
 *
 * --- Vanilla frame rules implemented here (verified against the Minecraft wiki, not assumed) ---
 *
 * A Nether portal frame is a hollow rectangle of obsidian, one block thick, oriented along
 * either the X or Z axis. Its four CORNER cells are NOT required to be obsidian — the game's
 * own frame-completion search only walks the four straight EDGES. That means the minimum
 * frame (interior 2 wide x 3 tall, so an outer rectangle 4 wide x 5 tall) needs only
 * **10 obsidian blocks** if the corners are skipped, or **14** if they are filled in as well
 * — both are valid, lit, working portals. `framePlan` returns `frame` (the 10 required
 * edge cells for a minimum frame; more in general, see below), `corners` (the 4 optional
 * cells), and `interior` (the 6 cells that must stay clear) as separate lists so a caller —
 * or a validator — can treat the corners as decoration.
 *
 * General size: for an outer frame `width` x `height`, the required edge count is
 * `2*(width-2) + 2*(height-2)` and the interior is `(width-2) * (height-2)`. Minimum is
 * width=4, height=5 (interior 2x3) — the width-2/height-3 lower bound is vanilla's real
 * rule, not a rounder-looking 2x2 or 3x3. Maximum is an outer 23x23 (interior 21x21) — a
 * bigger rectangle exceeds vanilla's search radius and will not link as one portal.
 *
 * `crying_obsidian` LOOKS like obsidian (and contains the substring "obsidian") but does
 * **not** form a portal frame — CLAUDE.md's `isFallingBlockName` lesson ("never
 * substring-match block names") applies here word for word, so every material check below is
 * a strict `=== 'obsidian'`.
 */

// ---- Frame size bounds --------------------------------------------------------------------

export const MIN_INTERIOR_WIDTH = 2;
export const MAX_INTERIOR_WIDTH = 21;
export const MIN_INTERIOR_HEIGHT = 3;
export const MAX_INTERIOR_HEIGHT = 21;

export const MIN_FRAME_WIDTH = MIN_INTERIOR_WIDTH + 2;   // 4
export const MAX_FRAME_WIDTH = MAX_INTERIOR_WIDTH + 2;   // 23
export const MIN_FRAME_HEIGHT = MIN_INTERIOR_HEIGHT + 2; // 5
export const MAX_FRAME_HEIGHT = MAX_INTERIOR_HEIGHT + 2; // 23

/** Is this outer width/height a buildable vanilla frame size? */
export function isValidFrameSize(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) &&
        width >= MIN_FRAME_WIDTH && width <= MAX_FRAME_WIDTH &&
        height >= MIN_FRAME_HEIGHT && height <= MAX_FRAME_HEIGHT;
}

// ---- Geometry ------------------------------------------------------------------------------

/**
 * The frame cells (edges, corners optional), interior cells, and stand cell for a candidate
 * portal at `anchor` (the {x,y,z} of the bottom-left frame cell, i.e. the corner at
 * width-index 0, height-index 0) along `axis` ('x' or 'z' — the direction the portal's WIDTH
 * runs; the portal is always 1 block thick along the other horizontal axis, and unscaled
 * along Y).
 *
 * @param {{x:number,y:number,z:number}} anchor
 * @param {'x'|'z'} axis
 * @param {{width?:number, height?:number}} [opts]  outer size; defaults to the vanilla minimum (4x5)
 * @returns {{frame:Array, interior:Array, corners:Array, standCell:object, width:number, height:number, axis:string, anchor:object}}
 */
export function framePlan(anchor, axis, opts = {}) {
    const width = opts.width ?? MIN_FRAME_WIDTH;
    const height = opts.height ?? MIN_FRAME_HEIGHT;

    const cellAt = (i, j) => axis === 'z'
        ? { x: anchor.x, y: anchor.y + j, z: anchor.z + i }
        : { x: anchor.x + i, y: anchor.y + j, z: anchor.z };

    const frame = [];
    const corners = [];
    for (const j of [0, height - 1]) {
        for (let i = 0; i < width; i++) {
            const c = cellAt(i, j);
            if (i === 0 || i === width - 1) corners.push(c);
            else frame.push(c);
        }
    }
    for (const i of [0, width - 1]) {
        for (let j = 1; j <= height - 2; j++) frame.push(cellAt(i, j));
    }

    const interior = [];
    for (let i = 1; i <= width - 2; i++) {
        for (let j = 1; j <= height - 2; j++) interior.push(cellAt(i, j));
    }

    return { frame, interior, corners, standCell: cellAt(1, 1), width, height, axis, anchor };
}

// ---- Frame validation ------------------------------------------------------------------------

const PASSABLE_INTERIOR = new Set(['air', 'cave_air', 'void_air']);

/**
 * Does the candidate site at `anchor`/`axis` already hold a valid, unobstructed portal frame?
 * Pure — `getName(x,y,z)` stands in for the world and may return `null` for an unloaded chunk,
 * which is treated as "not obsidian" / "obstructed", never as a free pass (same rule
 * `world_guard.js` uses for unknown cells: unknown is not safe).
 *
 * @param {(x:number,y:number,z:number)=>string|null} getName
 * @param {{x,y,z}} anchor
 * @param {'x'|'z'} axis
 * @param {{width?:number, height?:number}} [opts]
 * @returns {{ok:boolean, reason:string|null, missing:Array, obstructions:Array, lit:boolean, litCount:number, plan:object}}
 */
export function validateFrame(getName, anchor, axis, opts = {}) {
    const plan = framePlan(anchor, axis, opts);

    const missing = [];
    for (const c of plan.frame) {
        const found = getName(c.x, c.y, c.z);
        if (found !== 'obsidian') missing.push({ ...c, found });
    }

    const obstructions = [];
    let litCount = 0;
    for (const c of plan.interior) {
        const found = getName(c.x, c.y, c.z);
        if (found === 'nether_portal') { litCount++; continue; }
        if (!PASSABLE_INTERIOR.has(found)) obstructions.push({ ...c, found });
    }

    const lit = plan.interior.length > 0 && litCount === plan.interior.length;
    const ok = missing.length === 0 && obstructions.length === 0;

    let reason = null;
    if (!ok) {
        if (missing.length) {
            const m = missing[0];
            reason = `frame incomplete: ${missing.length} cell(s) are not obsidian, e.g. `
                + `(${m.x}, ${m.y}, ${m.z}) has ${m.found ?? 'unknown/unloaded'}`;
        } else {
            const o = obstructions[0];
            reason = `interior obstructed: ${obstructions.length} cell(s) blocked, e.g. `
                + `(${o.x}, ${o.y}, ${o.z}) has ${o.found ?? 'unknown/unloaded'}`;
        }
    }

    return { ok, reason, missing, obstructions, lit, litCount, plan };
}

// ---- Obsidian-cast planning (lava + water) ----------------------------------------------------

/**
 * The ordered cast schedule for building the frame from lava + water rather than carried
 * obsidian: bottom row first, then each side column bottom-to-top, then the top row last, so
 * every pour has something solid behind and (except the top row, which bridges between the
 * two already-cast columns) below it before the lava is placed. Planning only — this returns
 * the schedule, it does not place anything.
 *
 * `pourAgainst` is the backing-wall cell the water is poured from behind (the side of the
 * frame away from the portal's interior). `requiresSolid` lists the cell(s) that must already
 * be solid before this pour: always the backing wall, plus — for the bottom row and the side
 * columns — the cell directly below, which is either natural mold (ground, a dug backing
 * wall) or a frame cell this same plan scheduled earlier. The top row is a horizontal bridge
 * over the (necessarily clear) interior, so its only requirement is the backing wall.
 *
 * @param {{x,y,z}} anchor
 * @param {'x'|'z'} axis
 * @param {{width?:number, height?:number}} [opts]
 * @returns {Array<{cell:object, pourAgainst:object, requiresSolid:Array}>}
 */
export function castPlan(anchor, axis, opts = {}) {
    const { width, height } = framePlan(anchor, axis, opts);

    const cellAt = (i, j) => axis === 'z'
        ? { x: anchor.x, y: anchor.y + j, z: anchor.z + i }
        : { x: anchor.x + i, y: anchor.y + j, z: anchor.z };
    // The backing wall sits one cell behind the portal plane, on the axis the portal is thin on.
    const back = (c) => axis === 'z' ? { x: c.x - 1, y: c.y, z: c.z } : { x: c.x, y: c.y, z: c.z - 1 };
    const below = (c) => ({ x: c.x, y: c.y - 1, z: c.z });

    const steps = [];

    // Bottom row, left to right (corners excluded — they are optional, see framePlan).
    for (let i = 1; i <= width - 2; i++) {
        const cell = cellAt(i, 0);
        steps.push({ cell, pourAgainst: back(cell), requiresSolid: [back(cell), below(cell)] });
    }
    // Side columns, bottom to top, left column then right column.
    for (const i of [0, width - 1]) {
        for (let j = 1; j <= height - 2; j++) {
            const cell = cellAt(i, j);
            steps.push({ cell, pourAgainst: back(cell), requiresSolid: [back(cell), below(cell)] });
        }
    }
    // Top row last: a bridge over the open interior, so no "below" requirement.
    for (let i = 1; i <= width - 2; i++) {
        const cell = cellAt(i, height - 1);
        steps.push({ cell, pourAgainst: back(cell), requiresSolid: [back(cell)] });
    }

    return steps;
}

// ---- The 8:1 overworld <-> nether coordinate mapping -------------------------------------------

/**
 * Overworld -> Nether. X and Z scale 8:1 and use FLOOR, not truncation — the two disagree on
 * every negative, non-multiple-of-8 coordinate (e.g. -17 floors to -3, truncates to -2; the
 * truncated answer is the wrong nether column). Y passes through unscaled: the Nether has its
 * own vertical build limits and the game does not compress height.
 */
export function overworldToNether(pos) {
    return { x: Math.floor(pos.x / 8), y: pos.y, z: Math.floor(pos.z / 8) };
}

/** Nether -> Overworld. Plain multiplication; Y again passes through unscaled. */
export function netherToOverworld(pos) {
    return { x: pos.x * 8, y: pos.y, z: pos.z * 8 };
}

// ---- Dimension naming ------------------------------------------------------------------------

const NETHER_DIMENSION_NAMES = new Set(['the_nether', 'minecraft:the_nether', 'world_nether']);

/** True only for a recognised Nether DIMENSION name — not a biome (e.g. 'nether_wastes'). */
export function isNetherDimension(name) {
    return typeof name === 'string' && NETHER_DIMENSION_NAMES.has(name);
}

// ---- Return-trip targeting ---------------------------------------------------------------------

/**
 * Where to head for the return trip. A remembered portal position always wins over coordinate
 * math — the 8:1 pairing only links to ANY portal within a search radius of the linked
 * column, so it is a hint of where to look, never a guarantee of the exact block.
 *
 * @param {{remembered?:{x,y,z}, hereDim?:string, herePos?:{x,y,z}}} args
 * @returns {{target:object, source:'remembered'|'coord-hint'} | {refuse:string}}
 */
export function portalReturnTarget({ remembered, hereDim, herePos } = {}) {
    if (remembered) return { target: { ...remembered }, source: 'remembered' };
    if (herePos && hereDim) {
        const target = isNetherDimension(hereDim)
            ? netherToOverworld(herePos)
            : overworldToNether(herePos);
        return { target, source: 'coord-hint' };
    }
    return { refuse: 'no remembered portal position and no current position to compute a coordinate hint from' };
}
