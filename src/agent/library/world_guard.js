import { Vec3 } from 'vec3';

/**
 * Guards for destructive world edits.
 *
 * Written after a single night in which two unguarded edits cost the bot everything it had:
 *
 *   11:40:25  !serverSetblock("snow_block", -2572, 63, 5269)
 *             ^ the exact cell of its own bed. "Creating a solid path to the bed" destroyed
 *               the bed. With no valid respawn, the next death sent it to world spawn 7000
 *               blocks away, at night, where it died again and lost its inventory.
 *
 *   11:44:51  !serverFill snow_block -2573 63 5268 -> -2571 65 5270
 *             ^ a SOLID fill over the volume the bot was standing in: self-entombment.
 *
 * Neither was malice or a bad model - both are the obvious next move if you cannot see that
 * the target cell already contains something you need. So the fix is not a better prompt. The
 * world edit itself must refuse.
 *
 * Everything here is pure except the block reads, and the decision functions take an injected
 * `getName(x,y,z)` so they can be unit-tested against a fake world.
 */

/**
 * Blocks that are expensive or impossible to replace, and whose loss is not obvious at the
 * moment of the edit. Beds lead the list because losing one silently relocates the bot's
 * respawn to world spawn - the single most costly block in the game to overwrite by accident.
 */
export const PROTECTED_SUFFIXES = ['_bed', '_shulker_box', '_sign', '_door', '_banner'];
export const PROTECTED_EXACT = new Set([
    'chest', 'trapped_chest', 'ender_chest', 'barrel', 'hopper', 'dispenser', 'dropper',
    'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'anvil', 'chipped_anvil',
    'damaged_anvil', 'enchanting_table', 'brewing_stand', 'beacon', 'conduit', 'lodestone',
    'respawn_anchor', 'spawner', 'trial_spawner', 'vault', 'jukebox', 'lectern', 'grindstone',
    'smithing_table', 'cartography_table', 'fletching_table', 'loom', 'composter', 'bell',
    'bee_nest', 'beehive', 'end_portal_frame', 'nether_portal', 'end_portal',
]);

export function isProtectedName(name) {
    if (!name) return false;
    if (PROTECTED_EXACT.has(name)) return true;
    return PROTECTED_SUFFIXES.some(s => name.endsWith(s));
}

/** Blocks that do not trap a bot: it can stand, swim or walk in them. */
const NON_TRAPPING = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water']);

export function isTrappingBlock(name) {
    return !!name && !NON_TRAPPING.has(name);
}

/** Inclusive integer bounds for a region given two corners. */
export function regionBounds(a, b) {
    return {
        x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x),
        y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y),
        z1: Math.min(a.z, b.z), z2: Math.max(a.z, b.z),
    };
}

export function regionVolume(a, b) {
    const r = regionBounds(a, b);
    return (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) * (r.z2 - r.z1 + 1);
}

export function inRegion(p, a, b) {
    const r = regionBounds(a, b);
    return p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2 && p.z >= r.z1 && p.z <= r.z2;
}

/** Is this cell on the outer shell of the region (as opposed to its interior)? */
export function isShellCell(p, a, b) {
    if (!inRegion(p, a, b)) return false;
    const r = regionBounds(a, b);
    return p.x === r.x1 || p.x === r.x2 || p.y === r.y1 || p.y === r.y2 || p.z === r.z1 || p.z === r.z2;
}

/**
 * What a given cell becomes under a vanilla /fill mode.
 *
 * This distinction is load-bearing, not pedantry: `hollow` fills the SHELL with blockType and
 * only the interior with air. Substituting 'air' for the whole region (the first version of
 * this guard) meant a bot standing on the shell of its own hollow fill was encased in stone
 * while the entombment check was skipped entirely - the precise accident the guard exists to
 * prevent. `outline` is the mirror case: shell painted, interior untouched, so refusing
 * because the bot sits in the untouched middle is a false alarm.
 *
 * @returns {'blockType'|'air'|'untouched'}
 */
export function cellFate(p, a, b, mode = 'replace') {
    const shell = isShellCell(p, a, b);
    switch (mode) {
        case 'hollow':  return shell ? 'blockType' : 'air';
        case 'outline': return shell ? 'blockType' : 'untouched';
        default:        return 'blockType';   // replace, destroy, keep
    }
}

/**
 * Decide whether an edit should be refused.
 *
 * @param {object} req
 *   @param {{x,y,z}} req.a           corner A (inclusive)
 *   @param {{x,y,z}} req.b           corner B (inclusive)
 *   @param {string}  req.blockType   what the region becomes
 *   @param {(x,y,z)=>string|null} req.getName  block name lookup
 *   @param {{x,y,z}} [req.botPos]    bot feet position (floored)
 *   @param {{x,y,z}} [req.spawnPos]  the bot's respawn point
 *   @param {number}  [req.maxScan]   cells to inspect before giving up on the scan
 * @returns {{ok:boolean, reason:string|null, protectedHits:Array, entombs:boolean, hitsSpawn:boolean, scanned:number}}
 */
export function checkEdit({ a, b, blockType, getName, botPos = null, spawnPos = null, maxScan = 32768, mode = 'replace' }) {
    const r = regionBounds(a, b);
    const volume = regionVolume(a, b);
    const result = { ok: true, reason: null, protectedHits: [], entombs: false, hitsSpawn: false,
                     scanned: 0, oversized: false, warning: null, unknownCells: 0 };

    const filling = isTrappingBlock(blockType);

    // Self-entombment: a trapping fill over the cells the body occupies. Checked before the scan
    // because it needs no block reads and is the most immediately fatal. Mode-aware: only cells
    // that actually receive blockType can bury us.
    if (filling && botPos) {
        const feet = { x: Math.floor(botPos.x), y: Math.floor(botPos.y), z: Math.floor(botPos.z) };
        const head = { x: feet.x, y: feet.y + 1, z: feet.z };
        const buried = [feet, head].some(c =>
            inRegion(c, a, b) && cellFate(c, a, b, mode) === 'blockType');
        if (buried) {
            result.entombs = true;
            result.ok = false;
            result.reason = `that would seal ${blockType} around me - I am standing inside the region `
                + `(${feet.x}, ${feet.y}, ${feet.z})${mode !== 'replace' ? ` (mode ${mode})` : ''}.`;
            return result;
        }
    }

    // The respawn point. Losing it is silent until the next death, which is exactly what makes
    // it worth a hard refusal rather than a warning.
    if (spawnPos) {
        const sp = { x: Math.floor(spawnPos.x), y: Math.floor(spawnPos.y), z: Math.floor(spawnPos.z) };
        for (const dy of [0, 1]) {
            if (inRegion({ x: sp.x, y: sp.y + dy, z: sp.z }, a, b)) {
                result.hitsSpawn = true;
                result.ok = false;
                result.reason = `that would overwrite my respawn point at (${sp.x}, ${sp.y}, ${sp.z}). `
                    + `If I die after this I respawn at world spawn, possibly thousands of blocks away.`;
                return result;
            }
        }
    }

    if (volume > maxScan) {
        // Too big to inspect. SAY SO rather than pretending it was checked - the largest fills
        // are the ones most likely to sweep up a bed or a chest, so a silent pass here would
        // exempt exactly the dangerous cases. Callers must surface `warning`.
        result.scanned = 0;
        result.oversized = true;
        result.warning = `region is ${volume} cells (> ${maxScan}); protected blocks were NOT checked`;
        return result;
    }

    const MAX_HITS = 8;
    // Labelled break: an inner-only `break` left x/y iterating, so a large fill over a village
    // accumulated hundreds of hits, all joined into the refusal string and handed to the LLM.
    // This codebase already fights context exhaustion; a multi-kilobyte refusal is a hazard.
    scan:
    for (let x = r.x1; x <= r.x2; x++) {
        for (let y = r.y1; y <= r.y2; y++) {
            for (let z = r.z1; z <= r.z2; z++) {
                // 'outline' leaves the interior alone - do not refuse over blocks it never touches.
                if (cellFate({ x, y, z }, a, b, mode) === 'untouched') continue;
                const n = getName(x, y, z);
                result.scanned++;
                // UNKNOWN IS NOT SAFE. blockAt returns null outside the bot's loaded chunks,
                // and /fill and /setblock act server-side regardless of what the bot can see.
                // Measured: with the bot 200 blocks away, a setblock happily destroyed a bed
                // the guard had refused to touch minutes earlier from close range. Same
                // invariant the swimming code already carries - an unloaded chunk is a wall,
                // never air.
                if (n === null) { result.unknownCells++; continue; }
                if (isProtectedName(n)) {
                    result.protectedHits.push({ name: n, x, y, z });
                    if (result.protectedHits.length >= MAX_HITS) { result.truncated = true; break scan; }
                }
            }
        }
    }

    // Cannot certify what we cannot see. Refuse rather than pretend, and point at the override.
    if (result.unknownCells > 0 && !result.protectedHits.length) {
        result.ok = false;
        result.reason = `I cannot check that area - ${result.unknownCells} of ${result.scanned} `
            + `cell(s) are outside my loaded chunks, so I cannot tell what is there. `
            + `Go there first, or use the force variant if you have checked it yourself.`;
        return result;
    }

    if (result.protectedHits.length) {
        const list = result.protectedHits
            .map(h => `${h.name} at (${h.x}, ${h.y}, ${h.z})`)
            .join(', ');
        result.ok = false;
        result.reason = `that would destroy ${result.protectedHits.length}${result.truncated ? '+' : ''} `
            + `irreplaceable block(s): ${list}${result.truncated ? ', and more' : ''}.`;
    }
    return result;
}

/** Convenience wrapper that reads the live world and the bot's own state. */
export function checkEditForBot(bot, a, b, blockType, opts = {}) {
    const getName = (x, y, z) => {
        const blk = bot.blockAt(new Vec3(x, y, z));
        return blk ? blk.name : null;
    };
    // mineflayer initialises spawnPoint to (0,0,0) and only replaces it when a spawn_position
    // packet arrives. Treating the placeholder as real would refuse every edit near world
    // origin for no reason, so require it to be set to something.
    let spawnPos = null;
    const sp = bot.spawnPoint;
    if (sp && !(sp.x === 0 && sp.y === 0 && sp.z === 0)) spawnPos = sp;
    return checkEdit({
        a, b, blockType, getName,
        botPos: bot.entity?.position,
        spawnPos,
        ...opts,
    });
}
