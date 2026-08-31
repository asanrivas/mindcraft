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
 */

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
    return guard ? set.size : 0;
}

/** Stand the guard down. MUST run in a `finally`, or the next task inherits a build that ended. */
export function clearProtectedBuild() { guard = null; }

/** Is a build currently registered? */
export function isProtecting() { return guard !== null; }

/**
 * Does an active build own this world cell?
 *
 * The bounding-box test first is not premature optimisation: this is called from the planner's
 * per-move cost function, which runs tens of thousands of times per plan, and the overwhelming
 * majority of those cells are nowhere near the site.
 */
export function isProtected(x, y, z) {
    if (!guard) return false;
    // FLOOR FIRST, then bound. Callers pass entity positions as well as block coords, and
    // comparing 4716.8 against a maxX of 4716 rejects the very cell it is standing in - the
    // fast path would then quietly answer "not protected" for the busiest cells of all.
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (bx < guard.minX || bx > guard.maxX || by < guard.minY || by > guard.maxY
        || bz < guard.minZ || bz > guard.maxZ) return false;
    return guard.cells.has(`${bx},${by},${bz}`);
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
 * The registered build's bounding box in WORLD coordinates, or null when nothing is registered.
 *
 * Exported for layer 3 only. "Is the bot walled in by the build" cannot be answered from the
 * cell set alone - it is a question about the free space AROUND those cells, which needs a
 * world. `nav.trappedByBuild` supplies that half; this supplies the footprint it searches.
 */
export function protectedBox() {
    if (!guard) return null;
    const { minX, maxX, minY, maxY, minZ, maxZ } = guard;
    return { minX, maxX, minY, maxY, minZ, maxZ };
}
