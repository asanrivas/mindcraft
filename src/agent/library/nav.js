import { Vec3 } from 'vec3';
import { digWithTool, isTreeTrunk, isLavaName, isSwimmable, isBubbleColumn, isWaterName } from './tools.js';
import * as buildGuard from './build_guard.js';
// swim.js imports only tools.js, so this is not a cycle.
import { climbBank } from './swim.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * A self-contained navigator: A* planner + lookahead executor.
 *
 * Written because mineflayer-pathfinder cannot move this bot on this server. The server runs
 * Minecraft 26.1 (protocol 775) while the PrismarineJS stack tops out at 1.21.11, so the bot
 * runs on one-version-stale collision data. The practical symptoms, all measured:
 *   - pathfinder refuses to PLAN any route requiring a 1-block step, so the bot stands still
 *   - when it does try, its jump carries no horizontal momentum (136 jump-ticks, 0.1 blocks moved)
 *
 * What DOES work on this server, also measured: raw walking, raw jumping (1.25 blocks),
 * block reads, and mining. This module is built only on those primitives, so it is unaffected
 * by the version mismatch. Steps are cleared by AutoJump (see auto_jump.js), which presses jump
 * while the bot is still moving.
 *
 * Design notes that matter for speed:
 *   - The planner sees FAR (default 96 blocks). A short horizon was the single biggest cost in
 *     practice: with a 12-block view the bot could not see around a dune wider than 12 blocks,
 *     so it mined straight through instead of walking around. Digging ran ~12s per block.
 *     `digCost` below deliberately makes tunnelling expensive so detours win.
 *   - Movement is 8-way. Cardinal-only paths are ~40% longer and produce constant turning.
 *   - The executor steers at the furthest point within `horizon` blocks that it can reach in a
 *     straight walk, rather than tick-tocking between adjacent blocks. Combined with the
 *     string-pulling pass this turns a staircase of 1-block hops into long straight runs.
 */

const DEFAULTS = {
    maxNodes: 20000,     // search ceiling
    planRange: 96,       // how far the planner will look, in blocks
    maxDrop: 3,          // how far we'll fall on purpose
    stepUp: 1,           // AutoJump handles exactly one block
    horizon: 10,         // executor lookahead, in blocks
    arriveXZ: 0.85,      // horizontal tolerance for "reached this waypoint"
    arriveDist: 2,       // horizontal tolerance for "reached the goal"
    arriveY: 1.25,       // vertical tolerance - see atGoal(); XZ-only "arrival" is a lie
    waypointMs: 6000,    // give up on a single steering target after this
    maxReplans: 6,
    sprint: true,
    hopWhenStuck: true,  // see followPath: the only reliable way to move when onGround is wrong
    digWhenPinned: true, // mine the obstruction when hopping cannot free us
    climbWhenBlocked: true, // place blocks to get up a ledge too tall to jump
    waterExit: true,
    // Jump a gap when the far side is in reach. Tried BEFORE bridging: it costs nothing, leaves
    // the terrain untouched, and is what a player does. Reach and rise are MEASURED - see
    // scratchpad/sim/RESULTS.md.
    jump: true,
    maxJumps: 4,              // per navigateTo call; a jump is irreversible, so bound it tightly
    // Lay blocks across a gap when there is no other way through. Last resort by design: it
    // spends materials and permanently alters terrain the bot is only passing over.
    bridge: true,
    // Per navigateTo call, so a bad reading cannot empty the inventory into a ravine.
    maxBridge: 8,     // recognise a one-block bank on the tick we stall, not 2.5s later
    // Tower straight up - break the ceiling, place under the feet - when the route needs height
    // the horizontal rungs cannot buy. Everything in the ladder before this moves the bot
    // sideways; sealed under a ceiling there IS no sideways, which is why `!climbOut` measured
    // +1 block in 90 seconds against a plug 3 thick. Bounded per call like bridging, because it
    // spends inventory and permanently alters ground.
    tower: true,
    maxTower: 8,
    pinnedMs: 2500,
    heuristicWeight: 1.25, // slight greediness; we replan often so optimality is not worth the nodes

    // Cost model. These are in units of "blocks walked", so digCost 14 literally means
    // "walking 14 blocks around this is cheaper than mining through it".
    digCost: 14,
    // Trees are natural but should still be walked around, not felled: a trunk is 1-2 blocks
    // wide, so a detour is trivial, while chopping is slower and wrecks the landscape. Priced
    // as a strong preference rather than a ban so a bot boxed in by trees cannot deadlock.
    treeDigCost: 60,
    // A cell the ACTIVE BUILD owns. Priced far above treeDigCost because the thing being
    // protected is not scenery - it is the work in progress, and mining through it costs the
    // build twice (once to breach, once to repair). The number is chosen against the site, not
    // picked for feel: the footprint is ~32x31, so walking the long way round the outside is at
    // most ~120 blocks, and 200 keeps "go around" cheaper than "go through" for every route
    // that exists. FINITE on purpose - a bot sealed inside its own walls must still be able to
    // plan an exit, which is why this is a price and build_guard's refusal has an escape valve.
    buildDigCost: 200,
    // Digging a cell that will FLOOD is not a route, it is a longer swim. On land a dug block
    // yields a path; at or below the waterline it yields water, so the bot pays the effort and
    // gains nothing - then does it again one block further on. That is how it "dug a canal"
    // across a lake: repeatedly mining the only block it could reach while floating. Priced
    // near treeDigCost so a detour almost always wins, but not infinite - a bot already in the
    // water must still be able to cut its way out when there is genuinely no other route.
    floodDigCost: 70,
    // Water USED to be priced at 15 on the belief that "with this server's physics the bot
    // barely moves while swimming". That was never measured, and it is false. `!swimProbe` in
    // 7-block-deep water, repeated across five runs:
    //
    //     forward 0.098 b/t = 1.96 blocks/s = ~118 blocks/MINUTE
    //
    // against this bot's measured ~25 blocks/min overland through real terrain. Water is the one
    // part of the physics stack the protocol-775 mismatch does not touch, so swimming is roughly
    // FOUR TIMES faster than walking here. See docs and CLAUDE.md for the full numbers.
    //
    // What actually costs is the transition, not the metres: entering and leaving the water.
    // Hence a low per-cell cost and a separate one-off entry charge. Never set waterCost to 0 -
    // free water lets A* burn its whole node budget on open ocean and route the bot out to sea.
    waterCost: 2,
    waterEntryCost: 6,
    // Off by default so !navTo, moveAway and every mode-driven move keep the proven land-only
    // cost model. travelDirection turns it on. Until then, water is priced at the old 15.
    swimEnabled: false,
    // Descending is priced well above its raw distance because it is ASYMMETRIC: falling into
    // a trench costs one move, climbing back out costs many or is impossible. At 1.5 the planner
    // cheerfully dived into old excavations and then had to route dozens of blocks the wrong way
    // to find an exit (observed: 55 blocks east to reach a staircase).
    dropCost: 5,
    climbCost: 1.5,
    unknownCost: 3,      // unloaded chunk: plan through it, but prefer known-good ground

    // Surface bias. Long overland routes kept ending underground: the bot falls into a cave,
    // and from down there every onward route is also underground, so it just keeps going. A
    // per-move penalty for being below `preferY` makes staying deep expensive in proportion to
    // how long it lasts, which is what actually pulls the route back up to daylight.
    preferY: null,
    yBias: 0.6,
    yBiasCap: 10,
};

// Terrain classes
const AIR = 0, SOLID = 1, WATER = 2, HAZARD = 3, UNKNOWN = 4;

const key = (x, y, z) => `${x},${y},${z}`;

/** Binary min-heap on .f — a linear scan over the open set dominated runtime at this node count. */
class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(n) {
        const a = this.a;
        a.push(n);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].f <= a[i].f) break;
            const t = a[p]; a[p] = a[i]; a[i] = t;
            i = p;
        }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].f < a[m].f) m = l;
                if (r < a.length && a[r].f < a[m].f) m = r;
                if (m === i) break;
                const t = a[m]; a[m] = a[i]; a[i] = t;
                i = m;
            }
        }
        return top;
    }
}

/**
 * Classify a block. Results are memoised per plan: A* re-reads the same columns many times and
 * bot.blockAt is not cheap enough to call ~700k times.
 */
function classify(ctx, x, y, z) {
    const k = key(x, y, z);
    const hit = ctx.cache.get(k);
    if (hit !== undefined) return hit;

    let cls;
    const b = ctx.bot.blockAt(new Vec3(x, y, z));
    if (!b) cls = UNKNOWN;
    else {
        const n = b.name;
        if (n === 'air' || n === 'cave_air' || n === 'void_air') cls = AIR;
        // Exact matching, via the canonical classifiers. The substring test this replaced made
        // `water_cauldron` a swimmable cell and `lava_cauldron` a lava lake.
        // soul_fire included explicitly: 'fire' is an exact match, so soul_fire used to fall
        // through to the bounding-box branch (empty box -> AIR) and the planner would route
        // straight through it. Found during the Nether gap review.
        else if (isLavaName(n) || n === 'lava_cauldron' || n === 'fire' || n === 'soul_fire'
                 || n === 'cactus' || n === 'magma_block' || n === 'powder_snow'
                 || n === 'sweet_berry_bush' || isBubbleColumn(n)) cls = HAZARD;
        else if (isSwimmable(n)) cls = WATER;
        else if (b.boundingBox) cls = b.boundingBox === 'block' ? SOLID : AIR;
        else cls = SOLID;
    }
    ctx.cache.set(k, cls);
    return cls;
}

/** Would the bot be in water standing here? Feet, head or the block underfoot. */
function isWet(ctx, x, y, z) {
    return classify(ctx, x, y, z) === WATER
        || classify(ctx, x, y + 1, z) === WATER
        || classify(ctx, x, y - 1, z) === WATER;
}

/** Block name at a cell, memoised per plan (classify caches the class, not the name). */
function nameAt(ctx, x, y, z) {
    const k = key(x, y, z);
    if (!ctx.names) ctx.names = new Map();
    const hit = ctx.names.get(k);
    if (hit !== undefined) return hit;
    const b = ctx.bot.blockAt(new Vec3(x, y, z));
    const n = b ? b.name : '';
    ctx.names.set(k, n);
    return n;
}

/**
 * Extra cost of standing with feet at (x,y,z), or null if the bot cannot stand there.
 * Solid feet/head means the body does not fit; that cell is only reachable by digging, which
 * the caller prices separately.
 */
function standCost(ctx, x, y, z) {
    const o = ctx.o;
    const feet = classify(ctx, x, y, z);
    const head = classify(ctx, x, y + 1, z);
    const below = classify(ctx, x, y - 1, z);

    return swimCostFor({ feet, head, below }, o);
}

/**
 * Pure half of `standCost`, split out so the cost model can be unit-tested without a world.
 *
 * The water charge is applied ONCE for the whole cell. It used to be applied twice - once for
 * wet feet-or-head and again for a wet block below - so a cell in the middle of a river cost
 * 2 x waterCost, i.e. 30 "blocks walked". That was a bug under any reading of how fast the bot
 * swims, and it is what made even a 6-wide river lose to a 60-block detour.
 *
 * @returns {number|null} extra cost, or null if the bot cannot stand there at all
 */
export function swimCostFor({ feet, head, below }, o) {
    if (feet === HAZARD || head === HAZARD || below === HAZARD) return null;
    if (feet === SOLID || head === SOLID) return null;

    const waterCost = o.swimEnabled ? o.waterCost : 15;
    const wet = feet === WATER || head === WATER || below === WATER;

    let c = wet ? waterCost : 0;
    if (feet === UNKNOWN || head === UNKNOWN) c += o.unknownCost;

    if (below === SOLID || below === WATER) return c;
    if (below === UNKNOWN) return c + o.unknownCost;
    return null; // nothing underfoot
}

export { WATER as WATER_CLASS, SOLID as SOLID_CLASS, AIR as AIR_CLASS, UNKNOWN as UNKNOWN_CLASS, HAZARD as HAZARD_CLASS };

/** Cost of tunnelling into a cell we cannot otherwise occupy, or null if we must not. */
function digCostAt(ctx, x, y, z) {
    const o = ctx.o;
    if (!o.allowDig) return null;
    const feet = classify(ctx, x, y, z);
    const head = classify(ctx, x, y + 1, z);
    const below = classify(ctx, x, y - 1, z);
    if (feet === HAZARD || head === HAZARD || below === HAZARD) return null;
    if (below !== SOLID && below !== UNKNOWN) return null; // nothing to land on after digging
    // Will the hole fill in behind us? Any water touching the cell - beside it or directly
    // above - means digging it produces water, not passage.
    const floods = (yy) => {
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (classify(ctx, x + ax, yy, z + az) === WATER) return true;
        }
        return classify(ctx, x, yy + 1, z) === WATER;
    };

    let cost = 0, n = 0;
    for (const dy of [0, 1]) {
        if ((dy === 0 ? feet : head) !== SOLID) continue;
        n++;
        // A cell the active build owns is priced so high that A* only routes through the
        // structure when there is genuinely no way round it - high, but FINITE, because a bot
        // sealed inside its own walls still has to be able to plan an exit. See build_guard.js.
        const base = buildGuard.isProtected(x, y + dy, z) ? o.buildDigCost
                   : isTreeTrunk(nameAt(ctx, x, y + dy, z)) ? o.treeDigCost
                   : o.digCost;
        cost += floods(y + dy) ? Math.max(base, o.floodDigCost) : base;
    }
    if (n === 0) return null;
    return cost;
}

/** Octile distance — admissible for 8-way movement, so A* stays both fast and sane. */
function heuristic(o, x, y, z, gx, gy, gz) {
    const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
    const diag = Math.min(dx, dz);
    const vertical = o.goalXZOnly ? 0 : Math.abs(y - gy) * 0.5;
    return ((dx + dz) - (2 - Math.SQRT2) * diag + vertical) * o.heuristicWeight;
}

const NEIGHBOURS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],              // cardinal, cost 1
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2],                    // diagonal
    [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Plan a route with A*. Returns an array of Vec3 waypoints (feet positions), or null.
 * If the goal is unreachable, returns the best partial route so the caller still makes progress.
 * @param {MinecraftBot} bot
 * @param {Vec3} goal
 * @param {object} opts
 */
export function planPath(bot, goal, opts = {}) {
    const o = { allowDig: true, goalXZOnly: false, ...DEFAULTS, ...opts };
    const ctx = { bot, o, cache: new Map() };

    const s = bot.entity.position.floored();
    const gx = Math.floor(goal.x), gy = Math.floor(goal.y), gz = Math.floor(goal.z);

    const start = { x: s.x, y: s.y, z: s.z, g: 0, parent: null };
    start.f = heuristic(o, s.x, s.y, s.z, gx, gy, gz);

    const open = new Heap();
    open.push(start);
    const best = new Map([[key(s.x, s.y, s.z), 0]]);
    const closed = new Set();
    let expanded = 0;
    let bestNode = start, bestH = start.f;

    while (open.size && expanded < o.maxNodes) {
        const cur = open.pop();
        const ck = key(cur.x, cur.y, cur.z);
        if (closed.has(ck)) continue;
        closed.add(ck);
        expanded++;

        const hCur = heuristic(o, cur.x, cur.y, cur.z, gx, gy, gz);
        if (hCur < bestH) { bestH = hCur; bestNode = cur; }

        const atGoal = cur.x === gx && cur.z === gz && (o.goalXZOnly || Math.abs(cur.y - gy) <= 1);
        if (atGoal) return rebuild(cur);

        // Stay inside the planning window; beyond it the world data is stale or absent anyway.
        if (Math.abs(cur.x - s.x) > o.planRange || Math.abs(cur.z - s.z) > o.planRange) continue;

        // Charged once, on the dry -> wet transition. What makes a river expensive is getting in
        // and out of it, not the metres in between: at 0.098 b/t the swimming itself is fast, but
        // entering costs momentum and leaving needs `outOfLiquidImpulse` to fire against a bank.
        // Pricing it per-cell instead would make a wide ocean look proportionally reasonable.
        const curWet = isWet(ctx, cur.x, cur.y, cur.z);
        const entryFor = (x, y, z) =>
            (o.swimEnabled && !curWet && isWet(ctx, x, y, z)) ? o.waterEntryCost : 0;

        for (const [dx, dz, base] of NEIGHBOURS) {
            const nx = cur.x + dx, nz = cur.z + dz;
            const diagonal = dx !== 0 && dz !== 0;

            // Never cut a corner through a solid block — the body would clip it and stall.
            if (diagonal) {
                if (standCost(ctx, cur.x + dx, cur.y, cur.z) === null) continue;
                if (standCost(ctx, cur.x, cur.y, cur.z + dz) === null) continue;
            }

            // same level
            const level = standCost(ctx, nx, cur.y, nz);
            if (level !== null) { relax(cur, nx, cur.y, nz, base + level + entryFor(nx, cur.y, nz)); continue; }

            // step up one (AutoJump does the work); cardinal only, diagonal hops are unreliable
            if (!diagonal && o.stepUp > 0) {
                const up = standCost(ctx, nx, cur.y + 1, nz);
                if (up !== null && classify(ctx, cur.x, cur.y + 2, cur.z) !== SOLID) {
                    relax(cur, nx, cur.y + 1, nz, base + o.climbCost + up + entryFor(nx, cur.y + 1, nz));
                    continue;
                }
            }

            // drop down. The bot has to WALK OFF the ledge, so the target column must be clear
            // at the height we are leaving from - checking only the cells below produces paths
            // that step into a walled column, where the bot just wedges against the block face
            // and stops dead (observed: pinned at x=3932.71 against a block at x=3933).
            const entryFeet = classify(ctx, nx, cur.y, nz);
            const entryHead = classify(ctx, nx, cur.y + 1, nz);
            const entryBlocked = entryFeet === SOLID || entryHead === SOLID
                              || entryFeet === HAZARD || entryHead === HAZARD;
            let dropped = false;
            for (let d = 1; !entryBlocked && d <= o.maxDrop; d++) {
                const down = standCost(ctx, nx, cur.y - d, nz);
                if (down !== null) {
                    relax(cur, nx, cur.y - d, nz, base + d * o.dropCost + down + entryFor(nx, cur.y - d, nz));
                    dropped = true;
                    break;
                }
                if (classify(ctx, nx, cur.y - d, nz) === SOLID) break; // hit ground we can't stand in
            }
            if (dropped) continue;

            // last resort: mine through. Priced high so detours win whenever one exists.
            if (!diagonal) {
                const dig = digCostAt(ctx, nx, cur.y, nz);
                if (dig !== null) relax(cur, nx, cur.y, nz, base + dig);
            }
        }
    }

    return bestNode === start ? null : rebuild(bestNode);

    function relax(cur, x, y, z, cost) {
        const k = key(x, y, z);
        if (closed.has(k)) return;
        let extra = 0;
        if (o.preferY !== null && y < o.preferY)
            extra = Math.min(o.yBiasCap, (o.preferY - y) * o.yBias);
        const g = cur.g + cost + extra;
        const prev = best.get(k);
        if (prev !== undefined && prev <= g) return;
        best.set(k, g);
        open.push({ x, y, z, g, f: g + heuristic(o, x, y, z, gx, gy, gz), parent: cur });
    }

    function rebuild(node) {
        const out = [];
        for (let n = node; n; n = n.parent) out.push(new Vec3(n.x + 0.5, n.y, n.z + 0.5));
        out.reverse();
        return smooth(ctx, out);
    }
}

/**
 * String-pulling: replace runs of waypoints with a straight line whenever the bot can actually
 * walk that line. A* returns a block-by-block staircase; walking it literally means a turn every
 * block. Only flat runs are collapsed — merging across a height change would skip the step-up
 * that AutoJump needs to see coming.
 */
function smooth(ctx, path) {
    if (path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = i + 1;
        for (let k = path.length - 1; k > i + 1; k--) {
            if (path[k].y !== path[i].y) continue;
            if (walkableLine(ctx, path[i], path[k])) { j = k; break; }
        }
        out.push(path[j]);
        i = j;
    }
    return out;
}

/**
 * Is every column the bot's body overlaps at (x,z) standable?
 * The bot is 0.6 blocks wide, so testing only the centre point lets a smoothed diagonal clip a
 * block corner. That is not a near miss - the body wedges on the corner and the bot stops dead
 * with velocity 0 (observed: pinned at x=3987.61 by a block at (3987,55,4865) while the centre
 * line through it was clear).
 */
function bodyClear(ctx, x, y, z) {
    const r = 0.32;
    for (const ox of [-r, r]) {
        for (const oz of [-r, r]) {
            if (standCost(ctx, Math.floor(x + ox), y, Math.floor(z + oz)) === null) return false;
        }
    }
    return true;
}

/** Can the bot walk the straight segment a->b at a constant height, body width included? */
function walkableLine(ctx, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 48) return false;
    const steps = Math.ceil(dist / 0.3);
    for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        if (!bodyClear(ctx, a.x + dx * t, a.y, a.z + dz * t)) return false;
    }
    return true;
}

/**
 * Nearest cell the bot can stand on that is genuinely dry (air, not water). Used to get out of
 * a river: swimming barely moves this bot, so the way out is to head for the closest bank
 * rather than to keep pushing toward a distant goal through the water.
 */
export function nearestDryLand(bot, radius = 8) {
    const ctx = { bot, o: DEFAULTS, cache: new Map() };
    const p = bot.entity.position.floored();
    let best = null, bestD = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = -2; dy <= 3; dy++) {
                const x = p.x + dx, y = p.y + dy, z = p.z + dz;
                if (classify(ctx, x, y, z) !== AIR) continue;
                if (classify(ctx, x, y + 1, z) !== AIR) continue;
                if (classify(ctx, x, y - 1, z) !== SOLID) continue;
                const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
                if (d < bestD) { bestD = d; best = new Vec3(x + 0.5, y, z + 0.5); }
            }
        }
    }
    return best;
}

/**
 * Highest standable Y in a column, searching down from `from`. Returns null if the whole column
 * is solid or unknown. Used to decide what "the surface" means for surface-biased travel.
 */
export function surfaceY(bot, x, z, from = 100, to = 0) {
    const ctx = { bot, o: DEFAULTS, cache: new Map() };
    for (let y = Math.floor(from); y >= to; y--) {
        if (standCost(ctx, Math.floor(x), y, Math.floor(z)) !== null
            && classify(ctx, Math.floor(x), y - 1, Math.floor(z)) === SOLID) return y;
    }
    return null;
}

/**
 * Is the bot walled in - no standable cell in any of the eight directions, at any of the heights
 * an ordinary move could reach?
 *
 * IT WAS WRITTEN TO DECIDE NOTHING, AND THAT IS NO LONGER TRUE. This docstring used to say "not
 * used to decide anything" - it existed only so the bot could SAY it was walled in, because a bot
 * grinding silently against stone with no pickaxe is indistinguishable, from outside, from a bot
 * ignoring you. That reporting use is still live (`skills.js` names the obstacle with it).
 *
 * Two consumers now DECIDE on it: the `sealed` field below, and the trapped-relent valve in
 * `digAhead`, which pairs it with `trappedByBuild`. Read the next paragraph before adding a third.
 *
 * WHAT IT CANNOT ANSWER: "am I sealed inside a structure?" It asks whether ONE adjacent standable
 * cell exists, which is true for any bot standing in a room - it can walk around inside its own
 * tomb. Passing it as the "walled in" signal is exactly the bug that made build_guard's relent
 * valve unreachable, so a bot sealed in its own finished build refused every wall and recentred
 * until the watchdog killed it. Reachability needs a search, not a neighbour probe:
 * `trappedByBuild` does that. Keep this one for the local, one-step question only.
 */
export function enclosed(bot) {
    const ctx = { bot, o: DEFAULTS, cache: new Map() };
    const p = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        for (let dy = 1; dy >= -DEFAULTS.maxDrop; dy--) {
            if (standCost(ctx, p.x + dx, p.y + dy, p.z + dz) !== null) return false;
        }
    }
    return true;
}

/**
 * How much free space we will search before giving up on finding a way out. See FAILS OPEN below.
 */
const TRAP_FLOOD_BUDGET = 2000;

/**
 * Is the bot inside the ACTIVE BUILD with no way out that does not go through it?
 *
 * This is build_guard's layer 3 - the thing that makes the guard safe to turn on at all. A
 * refusal to mine the walls has to relent when the walls are the only thing between the bot and
 * the rest of the world, or, in build_guard's own words, the better the builder gets at walls
 * the more reliably it entombs itself.
 *
 * `enclosed()` above cannot answer this and must not be used for it: it asks whether there is a
 * standable cell in any of the eight directions, which is true for ANY bot standing in a room.
 * A bot sealed in a finished house walks around inside it perfectly well, so `enclosed` reads
 * false and the valve never fires in the one situation it exists for.
 *
 * So: a flood fill over standable cells, using the same moves the planner has (eight
 * directions, one step up, `maxDrop` down), bounded to the build's own XZ footprint. Reaching
 * any standable cell OUTSIDE the footprint means there is a way out - a door, an unfinished
 * side, a gap - and the refusal stands. Running out of frontier means there is not.
 *
 * FAILS OPEN, the same way `openObstruction` in chest.js does. An exhausted budget answers
 * "trapped", because being wrong that way costs one block that the builder's verification pass
 * repairs, while being wrong the other way costs the bot until someone restarts it.
 */
export function trappedByBuild(bot) {
    const box = buildGuard.protectedBox();
    if (!box) return false;                       // no build registered: nothing to be trapped by
    const p = bot.entity.position.floored();
    const outside = (x, z) => x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ;
    // Off the footprint already, or standing on top of it under open sky: whatever is pinning
    // the bot, it is not the build sealing it in - and relenting there would let the navigator
    // mine a wall it is merely walking past, which is the bug the guard exists to stop.
    if (outside(p.x, p.z) || p.y > box.maxY) return false;

    const ctx = { bot, o: DEFAULTS, cache: new Map() };
    const seen = new Set([key(p.x, p.y, p.z)]);
    const queue = [[p.x, p.y, p.z]];
    for (let head = 0; head < queue.length; head++) {
        if (seen.size > TRAP_FLOOD_BUDGET) return true;
        const [x, y, z] = queue[head];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            for (let dy = DEFAULTS.stepUp; dy >= -DEFAULTS.maxDrop; dy--) {
                const nx = x + dx, ny = y + dy, nz = z + dz;
                const k = key(nx, ny, nz);
                if (seen.has(k)) continue;
                if (standCost(ctx, nx, ny, nz) === null) continue;
                if (outside(nx, nz)) return false;   // a way out that is not through the build
                seen.add(k);
                queue.push([nx, ny, nz]);
            }
        }
    }
    return true;
}

/**
 * Look `range` blocks along a heading and report what is coming, so callers can react before
 * walking into it rather than after stalling against it.
 * @returns {{clear:boolean, distance:number|null, kind:string|null, rise:number, drop:number, water:number}}
 */
export function scanAhead(bot, dx, dz, range = 10) {
    const o = DEFAULTS;
    const ctx = { bot, o, cache: new Map() };
    const p = bot.entity.position.floored();
    let rise = 0, drop = 0, water = 0;
    let y = p.y;

    for (let d = 1; d <= range; d++) {
        const x = p.x + Math.round(dx * d), z = p.z + Math.round(dz * d);

        if (classify(ctx, x, y, z) === HAZARD || classify(ctx, x, y - 1, z) === HAZARD)
            return { clear: false, distance: d, kind: 'hazard', rise, drop, water };

        // follow the surface: try level, then up to +stepUp, then down to -maxDrop
        let ny = null;
        if (standCost(ctx, x, y, z) !== null) ny = y;
        else if (standCost(ctx, x, y + 1, z) !== null) { ny = y + 1; rise = Math.max(rise, 1); }
        if (ny === null) {
            for (let k = 1; k <= o.maxDrop + 2; k++) {
                if (standCost(ctx, x, y - k, z) !== null) { ny = y - k; drop = Math.max(drop, k); break; }
            }
        }
        if (ny === null) {
            const solidFeet = classify(ctx, x, y, z) === SOLID || classify(ctx, x, y + 1, z) === SOLID;
            return { clear: false, distance: d, kind: solidFeet ? 'wall' : 'gap', rise, drop, water };
        }
        if (classify(ctx, x, ny, z) === WATER || classify(ctx, x, ny - 1, z) === WATER) water++;
        y = ny;
    }
    return { clear: true, distance: null, kind: null, rise, drop, water };
}

/**
 * Walk a planned path using raw controls, steering at the furthest reachable point within
 * `horizon` blocks instead of at the very next waypoint. AutoJump handles 1-block rises.
 * @returns {Promise<{reached:boolean, covered:number, waypoints:number}>}
 */
export async function followPath(bot, path, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const ctx = { bot, o, cache: new Map() };
    const startPos = bot.entity.position.clone();
    if (!path || path.length === 0) return { reached: true, covered: 0, waypoints: 0 };

    // mineflayer-pathfinder rewrites control states every physics tick while it holds a goal,
    // which silently cancels ours. It must be fully stood down before we drive the bot.
    try {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.stop();
    } catch (err) { /* plugin may be absent; that's fine */ }
    bot.clearControlStates();

    let i = 0;                    // index of the waypoint we are currently heading for
    let lastYaw = null;
    let stallSince = Date.now();
    let bestRemaining = Infinity;
    let dbgAt = 0;
    let lastProgress = Date.now();
    let hops = 0;
    // Water-exit gate. `climbBank` is an 8s commitment, so a failed attempt must not re-fire on
    // the next 100ms iteration; and after a few tries the existing ladder (dig, footing, replan)
    // deserves its turn rather than us looping on a bank that will not take us.
    /**
     * THE RECOVERY LADDER MUST FIT INSIDE THE LEG, or it never runs at all.
     *
     * `followPlayer` asks for `waypointMs: 1500` because the target moves and it wants to
     * re-evaluate often. But digging, climbing and bridging are gated on `pinnedMs` (2500) and
     * on two hops (700ms apart) - so the leg ALWAYS broke first and the bot silently had no
     * recovery whatsoever. That is "Andy cannot reach me with blocks around him": he walks into
     * the wall, the leg times out at 1500ms, navigateTo spends its 2 replans, followPlayer polls,
     * and nothing ever reaches for the pickaxe.
     *
     * So scale the trigger to the budget the caller actually gave us rather than ignoring it.
     * On a default leg (6000ms) this changes nothing.
     */
    const shortLeg = o.waypointMs < o.pinnedMs * 2;
    const pinnedAt = shortLeg ? Math.floor(o.waypointMs * 0.45) : o.pinnedMs;
    // Hopping is free and digging is destructive, so hops normally go first. On a short leg
    // there is only time for one.
    const hopsBeforeDig = shortLeg ? 1 : 2;

    let legJumps = 0;
    let jumpCooldownUntil = 0;
    let exitAttempts = 0;
    let exitCooldownUntil = 0;
    const final = path[path.length - 1];

    try {
        bot.setControlState('forward', true);
        while (i < path.length) {
            if (bot.interrupt_code) break;
            const p = bot.entity.position;

            // Retire every waypoint we have actually reached. This has to consider height:
            // an XZ-only test discards a "drop down 3" waypoint the moment the bot is standing
            // above it, so the bot then steers at the waypoint *after* the drop and walks
            // straight into the cliff face instead of stepping off it.
            // Buoyancy carries the bot up and it overshoots, so waypoints need a wider catchment
            // while swimming than while walking.
            const wet = bot.entity.isInWater === true;
            // `wet` is not one state, and conflating the two paralysed the bot.
            //
            //   AFLOAT  - head under, or nothing solid under the feet. Jump is buoyancy here and
            //             SwimAssist owns the key; hopping only makes the bot bob.
            //   WADING  - in water with solid ground under the feet: a puddle, a ford, a
            //             shoreline. For propulsion this is LAND.
            //
            // While wading, SwimAssist releases the jump key (its `auto` mode presses only when
            // the head is submerged) and AutoJump stands down (it bails on any `isInWater`) - so
            // NOTHING presses jump, `onGround` reads false as it always does on this server, and
            // prismarine-physics applies no acceleration from any source at all. Measured at
            // (4281, 62, 4935), in one block of water with dry land two blocks east:
            // vel=(0.000, 0.000, 0.000) with `forward` held, unchanged for twenty minutes,
            // through four process restarts. The bot was in the one state where every
            // subsystem correctly refused to act.
            // Read the blocks live, NOT through `ctx.cache`: that cache is per-plan and the bot
            // is standing in terrain it may have just mined.
            // Biased up 0.15 before flooring - see skills.js travelToward: a surface float
            // dips below the block boundary and flips this classification every few ticks.
            const wadeFeet = bot.entity.position.offset(0, 0.15, 0).floored();
            const wadeHead = bot.blockAt(wadeFeet.offset(0, 1, 0));
            const wadeBelow = bot.blockAt(wadeFeet.offset(0, -1, 0));
            const wading = wet
                && !!wadeBelow && wadeBelow.boundingBox === 'block'
                && !(wadeHead && (wadeHead.name === 'water' || wadeHead.name === 'flowing_water'));
            const arriveXZ = wet ? Math.max(o.arriveXZ, 1.2) : o.arriveXZ;

            while (i < path.length) {
                const wp = path[i];
                const dxz = Math.hypot(wp.x - p.x, wp.z - p.z);
                const dy = p.y - wp.y;
                if (dxz <= arriveXZ && dy <= 1.2 && dy >= -0.6) { i++; continue; }
                break;
            }
            if (i >= path.length) break;

            // Steer at the furthest waypoint within the horizon we can reach in a straight walk.
            let aim = i;
            for (let k = Math.min(path.length - 1, i + 24); k > i; k--) {
                const wp = path[k];
                if (Math.hypot(wp.x - p.x, wp.z - p.z) > o.horizon) continue;
                if (wp.y !== Math.floor(p.y)) continue;
                if (walkableLine(ctx, new Vec3(p.x, Math.floor(p.y), p.z), wp)) { aim = k; break; }
            }
            const target = path[aim];

            const yaw = Math.atan2(-(target.x - p.x), -(target.z - p.z));
            if (lastYaw === null || Math.abs(angleDelta(yaw, lastYaw)) > 0.05) {
                await bot.look(yaw, 0, true);
                lastYaw = yaw;
            }

            // Sprint only when the way ahead is genuinely open; sprinting into a step wastes
            // the jump and bounces the bot backwards.
            if (o.sprint) {
                // In water there is no step to bounce off, so the "is the way flat" gate does not
                // apply - just hold sprint. It is a no-op in the library's fluid branch, but it
                // is what SwimAssist keys the vanilla-parity sprint-swim boost off, and near the
                // surface the bot spends part of each tick in the air branch where it does apply.
                const flat = aim > i && Math.hypot(target.x - p.x, target.z - p.z) > 3;
                bot.setControlState('sprint', wet || flat);
            }

            if (o.debug && (Date.now() - dbgAt) > 1000) {
                dbgAt = Date.now();
                // Print EVERY control state, not just `forward`. A control left latched on by a
                // skill that exited badly - sneak in particular, which prismarine-physics uses
                // to suppress movement at block edges - looks identical from outside to "the
                // physics is broken", and the two need completely different fixes.
                const cs = bot.controlState ?? {};
                const held = Object.keys(cs).filter(k => cs[k]).join(',') || 'none';
                console.warn(`[nav] pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) `
                    + `i=${i}/${path.length} aim=${aim} tgt=(${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)}) `
                    + `yaw=${bot.entity.yaw.toFixed(2)}/${yaw.toFixed(2)} held=[${held}] `
                    + `wet=${wet} wading=${wading} onGround=${bot.entity.onGround} `
                    + `vel=(${bot.entity.velocity.x.toFixed(3)},${bot.entity.velocity.y.toFixed(3)},${bot.entity.velocity.z.toFixed(3)})`);
            }

            // Evaluated EVERY iteration (~100ms) so the answer is available the instant the
            // bot stops making progress, instead of after the 2500ms/6000ms stall timers.
            const exitProbe = (o.waterExit && wet)
                ? probeWaterExit(bot, yaw, wet, {
                      cooldown: Date.now() < exitCooldownUntil,
                      attemptsSpent: exitAttempts >= 3,
                  })
                : null;
            const exitVerdict = exitProbe
                ? waterExitVerdict(exitProbe)
                : { climb: false, reason: 'dry' };

            const remaining = Math.hypot(final.x - p.x, final.z - p.z);
            if (remaining < bestRemaining - 0.25) {
                bestRemaining = remaining;
                stallSince = Date.now();
                lastProgress = Date.now();
                hops = 0;
            } else if (exitVerdict.climb) {
                // CLIMB OUT NOW - on the tick we stopped moving, not 2.5s later, and via
                // climbBank rather than digAhead. See waterExitVerdict for why both matter.
                exitAttempts++;
                const r = await climbBank(bot, exitProbe.dx, exitProbe.dz);
                exitCooldownUntil = Date.now() + 1200;
                lastProgress = Date.now();
                hops = 0;
                // A successful climb changes the whole situation: give the steering a clean
                // slate rather than letting the pre-climb stall immediately end the leg.
                if (r.out) { stallSince = Date.now(); bestRemaining = Infinity; }
                console.log(`[${bot.username ?? '?'}] waterExit: attempt ${exitAttempts} `
                    + `-> ${r.out ? 'OUT' : 'still wet'}, gained ${r.gained.toFixed(2)} `
                    + `(${exitVerdict.reason})`);
            } else if (Date.now() - stallSince > o.waypointMs) {
                break; // not converging; let the caller replan
            } else if (wet && !wading) {
                // No hopping, no digging while afloat. Jump is buoyancy in water, not
                // propulsion, so pulsing it makes the bot bob instead of advance; and neither
                // mining nor placing works while floating, for the same reason pillaring does
                // not. SwimAssist owns the jump key here - followPath must not touch it.
                //
                // But it must still be able to LEAVE the water. Buoyancy only holds jump while
                // the head is submerged, so a bot floating at the surface next to a one-block
                // ledge can never rise onto it - it just presses into the wall forever. That
                // stranded the bot outside its own igloo for 20 minutes: the planner found the
                // route in 3ms, and the executor could not climb the final block.
                //
                // Ask the assist to climb whenever the route goes up. Rising is 0.175 b/t, so
                // the bot floats up and the held-forward carries it onto the ledge - which is
                // exactly how a player exits water onto a bank.
                if (bot.swimAssist) {
                    bot.swimAssist.setMode(target.y > Math.floor(p.y) ? 'climb' : 'auto');
                }
                lastProgress = Date.now();
            } else if (o.digWhenPinned && Date.now() - stallSince > pinnedAt && hops >= hopsBeforeDig) {
                // Genuinely pinned against a block face: hopping cannot help, and the planner
                // already priced a dig move here. Mine the obstruction rather than grinding.
                lastProgress = Date.now();
                hops = 0;
                // AFLOAT AND PINNED: build a footing before reaching for the pickaxe. Digging
                // here is how the bot "solves" a one-block bank by mining a channel through it
                // at water level and swimming on - measured in the test gym at every depth: it
                // ends up east of the bank still at water height, having destroyed the bank
                // rather than climbed it. Placing a block on the pool floor under its feet makes
                // the water shallow enough to stand in, and the ordinary step-up does the rest.
                console.log(`[${bot.username ?? '?'}] pinned: wet=${wet} wading=${wading} `
                    + `hops=${hops} pos=(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`);
                if (wet && !wading) {
                    const { buildFootingBelow } = await import('./skills.js');
                    if (await buildFootingBelow(bot, 2)) { continue; }
                }
                const climbed = await climbAhead(bot, yaw);
                // BRIDGE ONLY WHEN EVERYTHING ELSE HAS FAILED. mineflayer-pathfinder built
                // scaffolding into its movement generator, so any `goto` could span a gap; we
                // replaced that executor (its own cannot move this bot) and the ability went
                // with it - `travelToward` kept a bridge step, `navigateTo` had none, so a
                // one-block gap stopped `!navTo`, `followPlayer`, `moveAway` and every
                // mode-driven move dead. It goes last on purpose: placing costs materials and
                // permanently alters ground the bot is only passing through, so climbing,
                // digging and walking round are all preferable when they work.
                const bridged = climbed ? { placed: false }
                    : await bridgeAhead(bot, yaw, wet);
                const dug = (!climbed && !bridged.placed) ? await digAhead(bot, yaw) : false;
                if (!climbed && !bridged.placed && !dug) {
                    // NAME THE RUNG THAT FAILED. This is the recovery of last resort, and it was
                    // entirely silent when every rung declined - leaving "the bot is against a
                    // wall and does nothing" with no way to tell whether it could not climb,
                    // could not place, could not mine, or never got here at all.
                    console.log(`[${bot.username ?? '?'}] pinned: nothing worked `
                        + `(climb=no bridge=${bridged.reason ?? 'no'} dig=no) - recentring`);
                    // Nothing to mine, so we are wedged on a corner rather than blocked by a
                    // block we can see ahead. Backing into the middle of our own cell frees the
                    // body and lets the next steering pass start from a clean position.
                    const cx = Math.floor(p.x) + 0.5, cz = Math.floor(p.z) + 0.5;
                    if (Math.hypot(cx - p.x, cz - p.z) > 0.1) {
                        await bot.look(Math.atan2(-(cx - p.x), -(cz - p.z)), 0, true);
                        await new Promise((r) => setTimeout(r, 350));
                        lastYaw = null;
                    }
                }
            } else if (o.hopWhenStuck && Date.now() - lastProgress > 700) {
                // JUMP BEFORE THE BLIND PULSE, and before the pinned branch's climb/bridge/dig at
                // 2500ms - so "jump first, bridge as fallback" holds by TIME as well as by branch
                // order. This is also the one existing decision point that already presses jump,
                // so nothing new competes for the key.
                //
                // The blind pulse below STAYS. It is what actually keeps this bot moving on an
                // ordinary `onGround` stall, and trading a working stall-breaker for a
                // conditional one would be a bad deal.
                if (o.jump && !wet && legJumps < o.maxJumps) {
                    const jv = jumpVerdict(probeJump(bot, yaw, wet, {
                        cooldown: Date.now() < jumpCooldownUntil,
                        attemptsSpent: legJumps >= JUMP_ATTEMPTS,
                        failedHere: false,
                    }));
                    if (jv.jump) {
                        legJumps++;
                        jumpCooldownUntil = Date.now() + JUMP_COOLDOWN_MS;
                        const r = await jumpAcross(bot, yaw, wet, {
                            cooldown: false, attemptsSpent: false, failedHere: false,
                        });
                        lastProgress = Date.now();
                        hops = 0;
                        if (r.jumped) { stallSince = Date.now(); bestRemaining = Infinity; }
                        continue;
                    }
                }
                // Hop to break the deadlock. `onGround` is unreliable on this server, so the
                // physics engine withholds ground acceleration and the bot sits at vel=0 with
                // forward held - measured directly. Airborne acceleration still applies, so a
                // hop is what actually converts held-forward into movement here. AutoJump does
                // not help: it gates on onGround and therefore never fires in this state.
                lastProgress = Date.now();
                hops++;
                bot.setControlState('jump', true);
                await new Promise((r) => setTimeout(r, 150));
                bot.setControlState('jump', false);
            }

            await new Promise((r) => setTimeout(r, 100));
        }
    } finally {
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        // Hand buoyancy back to its default. Leaving it in 'climb' would keep shoving the bot
        // upward against whatever is overhead long after the leg ended.
        if (bot.swimAssist) bot.swimAssist.setMode('auto');
    }

    const covered = bot.entity.position.distanceTo(startPos);
    return { reached: i >= path.length, covered, waypoints: i };
}

/**
 * Place blocks to get up a ledge that is too tall to jump.
 *
 * AutoJump clears exactly one block, so a 2-3 block rise stops the bot dead - it just grinds
 * against the face. Building a step up is the non-destructive answer and, unlike mining, leaves
 * the terrain it is crossing intact. Tried BEFORE digging for that reason.
 *
 * @returns {Promise<boolean>} true if height was gained.
 */
/**
 * Should the bot stop trying to WALK and start climbing OUT of the water, right now?
 *
 * This is a per-tick predicate, and that is the entire point. The old answer arrived through
 * the stall ladder in `followPath`, whose branch order is:
 *
 *     progress? -> waypointMs(6000) break -> afloat -> pinnedMs(2500) && hops>=2 -> hop(700ms)
 *
 * From a dead stop that is a hop at 700ms, a hop at 1400ms, and the FIRST climb attempt at
 * 2500ms - and the routine it reaches then is `climbAhead`, which only handles rises of 2 or 3
 * (see below). A one-block bank therefore falls through to `digAhead`, which mines the bank.
 * That is the "Andy dug a canal" behaviour: failing to climb a 1-block bank fell through to the
 * dig recovery and the bot cut a channel through the shore at water level instead of stepping
 * over it. The routine that actually works for banks - `swim.climbBank` - was gated behind the
 * 6000ms leg timeout and `travelToward`'s recovery ladder.
 *
 * Every input here is already recomputed every physics tick (`isInWater` is an AABB scan, block
 * reads are synchronous), so the decision costs nothing and can be made the moment the bot stops
 * making progress - ~100ms, the loop period - rather than 2.5s or 6s later.
 *
 * Pure so all the branches can be tested. The ones that must NOT fire matter most: a false
 * positive hijacks a leg that was walking fine, and `climbBank` is an 8-second commitment.
 *
 * @returns {{climb: boolean, reason: string}}
 */
export function waterExitVerdict(s) {
    if (!s.wet) return { climb: false, reason: 'not in water' };
    // Both fluids share one physics branch and can read true at a boundary; every swim entry
    // point refuses on lava and so does this one.
    if (s.lava) return { climb: false, reason: 'lava' };
    if (s.cooldown) return { climb: false, reason: 'attempt cooling down' };
    if (s.attemptsSpent) return { climb: false, reason: 'attempts spent, leaving it to the ladder' };
    if (!s.faceAhead) return { climb: false, reason: 'nothing solid ahead to climb' };
    // climbBank caps at maxRise 1 by measurement, not by taste: at the surface the bot is in
    // neither regime - not "in water" enough for the swim impulse, and onGround is false so the
    // land jump is dead - and a 2-block bank is climbLedgeByPlacing's job.
    if (s.riseNeeded !== 1) return { climb: false, reason: `rise is ${s.riseNeeded}, not a one-block bank` };
    if (!s.landingStandable) return { climb: false, reason: 'nowhere to stand on top' };
    if (!s.headroom) return { climb: false, reason: 'no headroom above the bank' };
    // Beyond about a block and a half the thing ahead is not what is stopping us, and committing
    // to an 8s climb against a wall we are not touching wastes the leg.
    if (s.gapToFace > 1.6) return { climb: false, reason: `bank is ${s.gapToFace.toFixed(2)} away` };
    return { climb: true, reason: `one-block bank at ${s.gapToFace.toFixed(2)}` };
}

/** Gather `waterExitVerdict`'s inputs from the world along the current heading. */
function probeWaterExit(bot, yaw, wet, gate) {
    // Quantise the heading to a block direction: every block-level helper indexes as p + d*n,
    // and a fractional d reads the wrong column.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = Math.abs(fx) >= Math.abs(fz) ? Math.sign(fx) : 0;
    const dz = Math.abs(fz) > Math.abs(fx) ? Math.sign(fz) : 0;
    const p = bot.entity.position;
    // Biased up 0.15 before flooring, for the same reason `wading` is: a surface float dips
    // below the block boundary and flips the classification every few ticks.
    const base = Math.floor(p.y + 0.15);
    const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
    // Live reads, NOT through ctx.cache - that cache is per-plan and the shore may have changed.
    const ctx = { bot, o: DEFAULTS, cache: new Map() };

    // Lava and water share one physics branch and can both read true at a boundary, so decide
    // it here from the block the body is actually in rather than trusting `isInWater` alone.
    const feetName = bot.blockAt(new Vec3(Math.floor(p.x), base, Math.floor(p.z)))?.name;
    const headName = bot.blockAt(new Vec3(Math.floor(p.x), base + 1, Math.floor(p.z)))?.name;
    const lava = isLavaName(feetName ?? '') || isLavaName(headName ?? '');

    const faceAhead = classify(ctx, x, base, z) === SOLID;
    const landingStandable = standCost(ctx, x, base + 1, z) !== null;
    const headroom = classify(ctx, x, base + 2, z) !== SOLID;
    // Distance from the bot's centre to the near FACE of the bank column, along the heading.
    const faceCoord = dx !== 0 ? (dx > 0 ? x : x + 1) : (dz > 0 ? z : z + 1);
    const along = dx !== 0 ? p.x : p.z;
    const gapToFace = Math.abs(faceCoord - along);

    return {
        wet, lava, faceAhead, landingStandable, headroom, gapToFace,
        riseNeeded: 1,
        cooldown: gate.cooldown, attemptsSpent: gate.attemptsSpent,
        dx, dz,
    };
}

/**
 * How far ahead a landing may be and still be worth bridging to.
 *
 * The rule this constant enforces is "never bridge into the unknown": we only build toward a
 * standable cell we can actually SEE. A bot that bridges hopefully into a ravine spends its
 * whole inventory and ends up stranded in mid-air over the same gap.
 */
const BRIDGE_REACH = 8;   // matches maxBridge: never promise a span we would refuse to finish

/**
 * How far ahead to look for the EDGE of the gap.
 *
 * A leg ends when the bot is within `arriveDist` of its last waypoint, so it routinely stops a
 * block short of the drop rather than on the lip of it. Probing only the adjacent cell reads
 * "solid ground ahead" and refuses to bridge a gap the bot is looking straight into - measured,
 * the bot halted at x=4613.5 with the gap starting at 4615.
 */
const EDGE_REACH = 3;

/**
 * Should we bridge across the gap ahead? Pure, so every refusal is testable.
 *
 * mineflayer-pathfinder could do this because scaffolding was built into its MOVEMENT
 * GENERATOR - any `goto` could place blocks. We took over the executor (its own executor cannot
 * move this bot at all) and the capability went with it: `travelToward` kept a bridge step in
 * its recovery ladder, but `navigateTo` - which is `!navTo`, `followPlayer`, `moveAway`, the
 * chest approach and every mode-driven move - had none, so a one-block gap simply stopped it.
 *
 * This is deliberately the LAST resort, after climbing and digging have both failed. Placing
 * blocks costs materials and permanently alters terrain the bot is only passing through, so
 * walking round is better whenever walking round is possible.
 *
 * @returns {{bridge: boolean, reason: string}}
 */
export function bridgeVerdict(s) {
    if (!s.hasBlocks) return { bridge: false, reason: 'nothing to build with' };
    // Placing does not work while floating, for the same reason pillaring does not - there is
    // nothing under the bot to build against. Same invariant as the swim code.
    if (s.wet) return { bridge: false, reason: 'afloat - cannot place from here' };
    if (s.lava) return { bridge: false, reason: 'lava' };
    if (!s.gapAhead) return { bridge: false, reason: 'not a gap - something is in the way' };
    if (s.footingBlocked) return { bridge: false, reason: 'there is already a floor there' };
    if (s.landingDist == null || s.landingDist > BRIDGE_REACH)
        return { bridge: false, reason: `no landing within ${BRIDGE_REACH} blocks` };
    return { bridge: true, reason: `gap of ${s.landingDist - 1} to a landing ${s.landingDist} ahead` };
}

/** Gather `bridgeVerdict`'s inputs along the current heading. */
function probeBridge(bot, yaw, wet, hasBlocks) {
    // Quantised, like every other block-level probe here: `p + d*n` on a fractional heading
    // reads the wrong column.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = Math.abs(fx) >= Math.abs(fz) ? Math.sign(fx) : 0;
    const dz = Math.abs(fz) > Math.abs(fx) ? Math.sign(fz) : 0;

    const p = bot.entity.position;
    const base = Math.floor(p.y);
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z);
    const ctx = { bot, o: DEFAULTS, cache: new Map() };

    const feetName = bot.blockAt(new Vec3(x0, base, z0))?.name;
    const headName = bot.blockAt(new Vec3(x0, base + 1, z0))?.name;
    const lava = isLavaName(feetName ?? '') || isLavaName(headName ?? '');

    // FIND THE EDGE, do not assume we are standing on it. A leg ends when the bot is within
    // `arriveDist` of its last waypoint, so it habitually stops a block or so short of the drop
    // - measured, the bot halted at x=4613.5 with the gap starting at 4615. Probing only the
    // adjacent cell then reads "solid ground ahead" and refuses to bridge a gap it is looking
    // straight at.
    let edgeDist = null;
    for (let d = 1; d <= EDGE_REACH; d++) {
        if (standCost(ctx, x0 + dx * d, base, z0 + dz * d) === null) { edgeDist = d; break; }
    }

    let bodyClear = false, footingBlocked = false, landingDist = null;
    let footing = null;
    if (edgeDist !== null) {
        const ex = x0 + dx * edgeDist, ez = z0 + dz * edgeDist;
        // A GAP is: the body could pass through the cell, but there is nothing to stand on.
        // A wall fails this and is `digAhead`'s job; a step up is `climbAhead`'s.
        bodyClear = classify(ctx, ex, base, ez) !== SOLID
                 && classify(ctx, ex, base + 1, ez) !== SOLID;
        footingBlocked = classify(ctx, ex, base - 1, ez) === SOLID;
        footing = new Vec3(ex, base - 1, ez);
        // A landing at OUR OWN level that we can see, beyond the edge. Not below us: dropping
        // into a hole is what the planner's `dropCost` is for, and climbing out is the
        // expensive half.
        for (let d = edgeDist + 1; d <= edgeDist + BRIDGE_REACH; d++) {
            if (standCost(ctx, x0 + dx * d, base, z0 + dz * d) !== null) { landingDist = d - edgeDist; break; }
        }
    }

    return { hasBlocks, wet, lava, gapAhead: edgeDist !== null && bodyClear, footingBlocked,
             landingDist, edgeDist, dx, dz, footing };
}

/**
 * Lay one block into the gap directly ahead, and report whether it is really there.
 *
 * One block per call, verified by reading the world back - the recovery ladder re-fires every
 * couple of seconds, so a wide gap is crossed a plank at a time with a fresh look at the
 * terrain between each. That is slower than laying a whole span blind, and it is the reason a
 * failed placement cannot turn into a bot walking off the end of its own half-built bridge.
 */
async function bridgeAhead(bot, yaw, wet) {
    // skills.js imports this module too; both are fully loaded by the time a leg is running.
    const skills = await import('./skills.js');
    const probe = probeBridge(bot, yaw, wet, skills.hasBuildingBlocks(bot));
    const verdict = bridgeVerdict(probe);
    if (!verdict.bridge) return { placed: false, reason: verdict.reason };

    const material = skills.pickBuildMaterial(bot);
    const f = probe.footing;
    // Never scaffold into the build. Measured 2026-08-30: `bridge: laid dirt at (4716, 67, 4614)`
    // put dirt in a cell the blueprint wanted to hold a brown_carpet, and it was still there an
    // hour later. Self-healing eventually - the builder digs it out when it reaches that cell -
    // but until then it is litter inside the house, and the dig is work that need not exist.
    //
    // Same relent as `digAhead`: refuse, UNLESS there is no way off the build's footprint that
    // does not cross this cell - a bot that will not bridge its own only way out is stuck at the
    // gap forever, which is worse than a plank the builder's verification pass repairs. Computed
    // only when a protected cell is actually in the way, since the flood fill is not free; see
    // `digAhead` and `trappedByBuild` for why `enclosed(bot)` alone is not the right measurement.
    if (buildGuard.isProtected(f.x, f.y, f.z)) {
        const trapped = enclosed(bot) || trappedByBuild(bot);
        const v = buildGuard.protectVerdict({ protectedCell: true, enclosed: trapped });
        if (!v.allow) {
            return { placed: false, reason: 'that cell belongs to the build' };
        }
        // Say it out loud. Breaching the build is the one thing this guard exists to prevent,
        // so the case where it is allowed must never be silent.
        console.log(`[${bot.username ?? '?'}] bridge: ${v.why} - `
            + `breaching the build at (${f.x}, ${f.y}, ${f.z})`);
    }
    // 'top' asks to build off the block BELOW the target first; the cell under our own feet is
    // solid and horizontally adjacent, so placeBlock's fallback sweep finds that face. At ~1.22
    // blocks the target is outside placeBlock's 1.1 "too close" retreat, which is why the
    // footing goes one cell ahead and not under the feet.
    await skills.placeBlock(bot, material, f.x, f.y, f.z, 'top');
    const now = bot.blockAt(f);
    const placed = !!now && now.boundingBox === 'block';
    console.log(`[${bot.username ?? '?'}] bridge: ${placed ? 'laid' : 'FAILED to lay'} `
        + `${material} at (${f.x}, ${f.y}, ${f.z}) - ${verdict.reason}`);
    return { placed, reason: verdict.reason };
}

// ---------------------------------------------------------------------------
// Jumping - the cheap way across a gap, and up a step from a standstill
// ---------------------------------------------------------------------------

/**
 * Constants MEASURED in `scratchpad/sim/` against the real physics engine, not chosen from
 * vanilla theory. Full working in `scratchpad/sim/RESULTS.md`.
 */
const JUMP_REACH = 3;       // gap cells clearable. 4 is reachable but only in a narrow take-off
                            // window (7 of 11 leads) - a coin flip once server lag is involved.
const JUMP_RISE = 1;        // vanilla apex is 1.25 blocks. A 2-block ledge is NOT jumpable, and
                            // the sim confirms it: rise 2 fails at every width and every lead.
const JUMP_RISE_REACH = 2;  // a rise costs a block of reach - widths 0-2 clear at every lead,
                            // width 3 drops to 7/11.
const JUMP_MAX_DROP = 3;    // matches DEFAULTS.maxDrop; deeper is a fall, not a jump
/**
 * A floor within this many blocks makes a miss survivable.
 *
 * MUST EXCEED `maxDrop` (3), or the rule contradicts itself: the planner walks down into any drop
 * of 3 or less, so every gap it REFUSES to walk into is deeper than 3 - and at 4 that was every
 * gap we refused to jump. Measured in the gym: with the floor set shallow enough to pass the
 * safety rule, the planner simply routed down into the trench instead (and then could not climb
 * the far side, `stepUp` being 1); set one block deeper, the jump was refused. There was no gap
 * geometry in between.
 *
 * 8 is where "lethal" starts to mean something: vanilla fall damage is `distance - 3` half-hearts,
 * so an 8-block miss costs 2.5 hearts on a bot that this verdict already refuses to jump when hurt.
 */
const JUMP_FALL_SAFE = 8;
/**
 * How wide a gap we will still jump when a miss would be fatal.
 *
 * The first version refused ANY lethal-drop gap wider than one block, which sounds prudent and is
 * useless: a gap in a walkway over a ravine is the situation gaps actually occur in, and the rule
 * refused every one of them. The real protection is that we only jump toward a landing we can SEE
 * and that is inside a MEASURED reach - and the sim says widths 0-2 clear at every one of eleven
 * take-off leads, sprint or not. That margin is what makes 2 defensible where 3 (11/11 with
 * sprint, 10/11 without) is not, when the cost of a miss is the bot.
 */
const JUMP_SAFE_SPAN = 2;
const JUMP_COOLDOWN_MS = 1200;
const TICK_MS = 50;         // one server tick; the arc is ~12 of them
const JUMP_ATTEMPTS = 3;    // per leg, matching the water-exit gate

/**
 * Should we jump? Pure, so every refusal is testable.
 *
 * The refusals ARE the feature. Bridging's worst case is a wasted plank; jumping's worst case is
 * a bot at the bottom of a ravine with no way back up, because **a jump is the only recovery in
 * this navigator that cannot be undone**. Order is diagnostic - every branch refuses, so it
 * decides the reason string, never the answer.
 *
 * @returns {{jump: boolean, reason: string}}
 */
export function jumpVerdict(s) {
    // First, so a bot that is bridging instead of jumping says why.
    if (s.disabled) return { jump: false, reason: 'jumping disabled (server corrections)' };
    // The only refusal whose absence causes a CONTENTION bug rather than a terrain one:
    // SwimAssist owns the jump key whenever the bot is wet, and climbBank is the water path.
    if (s.wet) return { jump: false, reason: 'wet - SwimAssist owns the jump key' };
    // Both fluids share one physics branch and read true together at a boundary. This is the one
    // outcome here that is unrecoverable: death plus the whole inventory.
    if (s.lava) return { jump: false, reason: 'lava' };
    if (s.cooldown) return { jump: false, reason: 'jump cooling down' };
    if (s.attemptsSpent) return { jump: false, reason: 'jump attempts spent' };
    // Deterministic inputs give a deterministic failure: without a memo the bot repeats the same
    // failed jump until a budget runs out, and every repeat is another chance to fall.
    if (s.failedHere) return { jump: false, reason: 'already failed this jump' };
    // Fall damage on a hurt bot is fatal where bridging is merely slow.
    if (s.lowHealth && s.landingDrop > 0) return { jump: false, reason: 'too hurt to risk a drop' };
    // Read from the world, never `onGround` - that flag is the reason this module exists.
    if (!s.grounded) return { jump: false, reason: 'not standing on anything to jump from' };
    if (!s.headroom) return { jump: false, reason: 'no headroom to jump into' };
    // THE HONESTY REFUSAL. Trying anyway is the bunny-hop-against-a-wall behaviour auto_jump.js
    // was written to stop; 2-3 block rises belong to climbAhead.
    if (s.rise > JUMP_RISE) return { jump: false, reason: `rise is ${s.rise} - too tall to jump` };
    // A one-wide trench with a floor one below is a route the PLANNER already has (drop 1, step
    // up 1). Jumping it overrides a working plan with a riskier move.
    if (s.stepDownAhead) return { jump: false, reason: 'that is a step down, not a gap' };
    // A wall is digAhead's job and a step is AutoJump's. Also the guard against jumping when the
    // stall was really a corner wedge rather than a gap.
    if (!s.gapAhead) return { jump: false, reason: 'not a gap - something is in the way' };
    // NEVER JUMP INTO THE UNKNOWN. A wasted plank is recoverable; a leap into a ravine is not.
    const reach = s.rise > 0 ? JUMP_RISE_REACH : JUMP_REACH;
    if (s.span == null || s.span > reach)
        return { jump: false, reason: `no landing within ${reach} blocks` };
    if (!s.landingStandable) return { jump: false, reason: 'nowhere to stand on the far side' };
    if (!s.landingHeadroom) return { jump: false, reason: 'no headroom on the far side' };
    // A block at head height mid-arc cancels the move; UNKNOWN counts as blocked, the same rule
    // `corridorClear` uses in swim.js.
    if (!s.corridorClear) return { jump: false, reason: 'something overhead along the way' };
    // LAVA UNDERNEATH IS NOT THE SAME AS A LONG DROP, and giving them one threshold was wrong.
    // A missed jump into a ravine costs health, which the bot recovers; a missed jump into lava
    // costs the bot AND its whole inventory, and nothing recovers that. Caught in the gym, which
    // happily jumped a 2-wide gap over lava under the shared rule. Bridge those instead.
    if (s.hazardBelow) return { jump: false, reason: 'lava or fire under the gap' };
    // THE REFUSAL THAT DECIDES WHETHER THIS IS SAFE. Water counts as a benign floor - SwimAssist
    // and climbBank recover from it - so a gap over water is the safest place to jump.
    if (s.lethalFall && s.span > JUMP_SAFE_SPAN)
        return { jump: false, reason: `${s.span}-wide gap over a lethal drop` };
    return { jump: true, reason: `span ${s.span}, rise ${s.rise}` };
}

/** Gather `jumpVerdict`'s inputs along the current heading. */
function probeJump(bot, yaw, wet, gate) {
    // Cardinal only. A diagonal span is 1.414 cells per step with a different hitbox profile, and
    // every block helper here indexes as `p + d*n`, which a fractional heading reads wrong.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = Math.abs(fx) >= Math.abs(fz) ? Math.sign(fx) : 0;
    const dz = Math.abs(fz) > Math.abs(fx) ? Math.sign(fz) : 0;

    const p = bot.entity.position;
    const base = Math.floor(p.y);
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z);
    const ctx = { bot, o: DEFAULTS, cache: new Map() };

    const feetName = bot.blockAt(new Vec3(x0, base, z0))?.name;
    const headName = bot.blockAt(new Vec3(x0, base + 1, z0))?.name;
    const lava = isLavaName(feetName ?? '') || isLavaName(headName ?? '');

    // Find the lip, the same way probeBridge does and for the same reason: a leg ends within
    // `arriveDist`, so the bot habitually stops a block SHORT of the drop.
    let edgeDist = null;
    for (let d = 1; d <= EDGE_REACH; d++) {
        if (standCost(ctx, x0 + dx * d, base, z0 + dz * d) === null) { edgeDist = d; break; }
    }

    const out = {
        wet, lava, dx, dz, edgeDist,
        disabled: !!bot.jumpAssist?.disabled,
        cooldown: gate.cooldown, attemptsSpent: gate.attemptsSpent, failedHere: gate.failedHere,
        lowHealth: (bot.health ?? 20) <= 10,
        grounded: !!bot.jumpAssist?.grounded?.(),
        headroom: classify(ctx, x0, base + 2, z0) !== SOLID,
        gapAhead: false, stepDownAhead: false, corridorClear: false,
        lethalFall: false, hazardBelow: false,
        span: null, rise: 0, landingDrop: 0,
        landingStandable: false, landingHeadroom: false, landing: null,
    };
    if (edgeDist === null) return out;

    const ex = x0 + dx * edgeDist, ez = z0 + dz * edgeDist;
    out.gapAhead = classify(ctx, ex, base, ez) !== SOLID && classify(ctx, ex, base + 1, ez) !== SOLID;
    // A cell you can simply step down into is not a gap; the planner already prices that.
    out.stepDownAhead = standCost(ctx, ex, base - 1, ez) !== null;

    // Look for a landing, nearest first, level or one up, then progressively lower. Level and
    // rise are what the sim measured; a drop is the easy direction and bounded by maxDrop.
    //
    // `span` is the GAP WIDTH - the number of unstandable cells to cross - so it means the same
    // thing as the width the sim swept and `JUMP_REACH` is expressed in. The first version
    // counted cells-to-traverse instead, which is width + 1, and silently shrank the reach by a
    // block: a 2-wide gap reported `span=3` and was refused.
    search:
    for (let m = 1; m <= JUMP_REACH + 1; m++) {
        // JUMP_RISE + 1 is searched ON PURPOSE, so the verdict can say "too tall to jump"
        // instead of "no landing" - a 2-block ledge is the commonest thing a person will expect
        // the bot to hop onto, and "no landing within 3 blocks" is a misleading way to refuse a
        // ledge that is plainly right there.
        for (const dy of [0, JUMP_RISE, JUMP_RISE + 1, -1, -2, -JUMP_MAX_DROP]) {
            const lx = ex + dx * m, lz = ez + dz * m;
            if (standCost(ctx, lx, base + dy, lz) === null) continue;
            out.span = m;
            out.rise = Math.max(0, dy);
            out.landingDrop = Math.max(0, -dy);
            out.landing = new Vec3(lx, base + dy, lz);
            out.landingStandable = true;
            out.landingHeadroom = classify(ctx, lx, base + dy + 1, lz) !== SOLID;
            break search;
        }
    }
    if (!out.landing) return out;

    // The arc has to be clear at head height the whole way, and the gap under it has to be
    // survivable if we come up short.
    out.corridorClear = true;
    out.lethalFall = false;
    for (let n = 0; n < out.span; n++) {
        const cx = ex + dx * n, cz = ez + dz * n;   // ex is the first gap cell
        if (classify(ctx, cx, base + 1, cz) === SOLID || classify(ctx, cx, base + 2, cz) === SOLID)
            out.corridorClear = false;
        let floor = null;
        for (let d = 1; d <= JUMP_FALL_SAFE; d++) {
            const c = classify(ctx, cx, base - d, cz);
            if (c === HAZARD) { floor = 'hazard'; break; }
            // Water is a BENIGN floor: the bot falls in and the swim stack gets it out.
            if (c === WATER) { floor = 'water'; break; }
            if (c === SOLID) { floor = 'solid'; break; }
        }
        if (floor === 'hazard') out.hazardBelow = true;
        if (floor === null || floor === 'hazard') out.lethalFall = true;
    }
    return out;
}

/**
 * Jump the gap ahead, and report whether we actually landed on the far side.
 *
 * Shaped like `climbBank`: own the controls for the window, act, then VERIFY by reading the
 * world - `onGround` is unusable, so nothing here may consult it.
 */
async function jumpAcross(bot, yaw, wet, gate) {
    const probe = probeJump(bot, yaw, wet, gate);
    const verdict = jumpVerdict(probe);
    const say = (msg) => console.log(`[${bot.username ?? '?'}] jump: ${msg}`);
    if (!verdict.jump) {
        // Log the REFUSAL too. Bounded by maxJumps and the leg's attempt cap, so this cannot
        // flood the way a per-tick line would - and without it "the bot did not jump" is
        // indistinguishable from "the branch never ran", which is exactly where the first live
        // run stalled.
        say(`span=${probe.span ?? '-'} rise=${probe.rise} edge=${probe.edgeDist ?? '-'} `
            + `-> REFUSED (${verdict.reason})`);
        return { jumped: false, reason: verdict.reason };
    }

    const land = probe.landing;
    const start = bot.entity.position.clone();
    // Aim square down the lane. `applyHeading` reads yaw every tick and the sprint-jump boost
    // uses it too, so an off-axis yaw curves the arc into the side wall.
    await bot.look(Math.atan2(-probe.dx, -probe.dz), 0, true);
    await sleep(120);

    if (!bot.jumpAssist?.begin(probe.dx, probe.dz))
        return { jumped: false, reason: 'jump assist refused (not grounded)' };

    let apex = 0, landed = false, reason = 'timeout';
    try {
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        // Sneak PREVENTS walking off a block edge (prismarine-physics index.js:175), so a sneak
        // latched on by a skill that exited badly cancels the take-off entirely and looks
        // exactly like broken physics.
        bot.setControlState('sneak', false);

        const deadline = Date.now() + 1800;
        while (Date.now() < deadline) {
            // An interrupt cannot un-jump us, so keep running to the landing rather than
            // returning with the flight still in flight - see JumpAssist's leak warning.
            await sleep(TICK_MS);
            const p = bot.entity.position;
            apex = Math.max(apex, p.y - start.y);
            // OVERSHOOTING IS SUCCESS. The first version demanded the bot be within 0.6 of the
            // landing cell's centre, so a jump that cleared the gap and kept going reported
            // TIMEOUT with `axial=14.21` - it had crossed fourteen blocks earlier. What matters
            // is being PAST the near edge of the landing, on solid ground, at the right height.
            // Same lesson as climbBank accepting a lip-perch rather than insisting on the centre.
            const along = (p.x - start.x) * probe.dx + (p.z - start.z) * probe.dz;
            const need = (probe.dx !== 0 ? Math.abs(land.x - Math.floor(start.x))
                                         : Math.abs(land.z - Math.floor(start.z))) - 0.4;
            if (along >= need && bot.jumpAssist.grounded() && Math.abs(p.y - land.y) < 0.6) {
                landed = true; reason = 'landed'; break;
            }
            if (p.y < start.y - JUMP_FALL_SAFE) { reason = 'fell'; break; }
        }
    } finally {
        bot.jumpAssist.end();
        bot.setControlState('sprint', false);
        if (bot.controlState?.jump) bot.setControlState('jump', false);
    }

    bot.jumpAssist.noteOutcome(apex > 0.3);
    const p = bot.entity.position;
    const axial = (p.x - start.x) * probe.dx + (p.z - start.z) * probe.dz;
    say(`span=${probe.span} rise=${probe.rise} -> ${landed ? 'LANDED' : reason.toUpperCase()} `
        + `axial=${axial.toFixed(2)} apex=${apex.toFixed(2)} (${verdict.reason})`);
    return { jumped: landed, reason, axial, apex };
}

async function climbAhead(bot, yaw) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const p = bot.entity.position;
    const ctx = { bot, o: DEFAULTS, cache: new Map() };
    const x = Math.floor(p.x + fx), z = Math.floor(p.z + fz);
    const base = Math.floor(p.y);

    // Only worth it if there is somewhere to stand once we are up there.
    for (let up = 2; up <= 3; up++) {
        if (standCost(ctx, x, base + up, z) === null) continue;
        // skills.js dynamically imports this module too; both are fully loaded by call time.
        const skills = await import('./skills.js');
        return (await skills.climbLedgeByPlacing(bot, fx, fz, up)) > 0.5;
    }
    return false;
}

/**
 * Mine whatever is directly ahead at feet and head height. Used only when the bot is pinned:
 * the planner already charges `digCost` for routes that need this, so acting on it here is
 * honouring the plan, not improvising around it.
 */
async function digAhead(bot, yaw) {
    const p = bot.entity.position;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const skipped = [];
    let trapped = null;   // lazily measured, and only when a protected cell is actually in the way
    for (const dy of [0, 1]) {
        const t = new Vec3(Math.floor(p.x + fx * 0.8), Math.floor(p.y) + dy, Math.floor(p.z + fz * 0.8));
        const b = bot.blockAt(t);
        if (!b || b.name.includes('water')) { skipped.push(`${dy}:${b ? b.name : 'unloaded'}`); continue; }
        if (b.name === 'air' || b.name === 'cave_air') { skipped.push(`${dy}:air`); continue; }
        if (isTreeTrunk(b.name)) { skipped.push(`${dy}:tree`); continue; }   // walk around, do not fell
        // Same rule, for the bot's own construction: walk around, do not demolish. Relented on
        // only when there is no way out that is not through the build - a bot that cannot dig
        // its way out of its own walls stays there until the watchdog kills it, and the builder
        // repairs whatever it removes on the verification pass.
        if (buildGuard.isProtected(t.x, t.y, t.z)) {
            // `enclosed(bot)` is NOT the measurement this wants, and passing it made the valve
            // decorative: it only fires for a bot in a literal one-cell pocket, and a bot sealed
            // inside a finished room walks around inside it perfectly well. `trappedByBuild`
            // asks the real question - is there any way off the footprint that is not through
            // the build. `enclosed` is kept as the degenerate case, and it is the cheap one, so
            // it goes first. Computed at most once per call: the flood fill is not free.
            trapped ??= (enclosed(bot) || trappedByBuild(bot));
            const v = buildGuard.protectVerdict({ protectedCell: true, enclosed: trapped });
            if (!v.allow) { skipped.push(`${dy}:build`); continue; }
            // Say it out loud. Breaching the build is the one thing this guard exists to
            // prevent, so the case where it is allowed must never be silent.
            console.log(`[${bot.username ?? '?'}] digAhead: ${v.why} - `
                + `breaching the build at (${t.x}, ${t.y}, ${t.z})`);
        }
        // REFUSE TO DIG A HOLE THAT WILL FLOOD. Underwater a dug block yields water, not
        // passage: the bot pays the effort, gains a longer swim, and repeats one block on. That
        // is exactly how it mined a canal instead of climbing a one-block bank - measured at
        // `leg 1: moved=10.36` through solid ground at water level, all inside a single leg, so
        // the traveller never even saw a stall. The planner already prices this
        // (`floodDigCost`); the executor has to honour it too or it just overrides the plan.
        if (wouldFlood(bot, t)) { skipped.push(`${dy}:would-flood`); continue; }
        if (await digWithTool(bot, b)) return true;
        skipped.push(`${dy}:${b.name} dig-failed`);
    }
    // Say what was in the way and why it was left. A silent `false` here is the difference
    // between "there was nothing to mine" and "there was, and the dig failed" - and when a bot
    // is walled in, that distinction is the whole diagnosis.
    if (skipped.length) console.log(`[${bot.username ?? '?'}] digAhead: ${skipped.join(', ')}`);
    return false;
}

/** Would a hole at `t` immediately fill with water from a neighbour or from above? */
function wouldFlood(bot, t) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        const n = bot.blockAt(t.offset(dx, dy, dz));
        if (n && isWaterName(n.name)) return true;
    }
    return false;
}

/** Shortest signed difference between two angles. */
function angleDelta(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/**
 * Plan and walk to a position, replanning as needed.
 * @returns {Promise<{arrived:boolean, covered:number, replans:number}>}
 */

/**
 * Have we actually reached the goal?
 *
 * The horizontal test alone is not enough, and this is the same mistake CLAUDE.md already
 * records for WAYPOINT retirement - it just also lived at the goal level. Measured: asked to
 * enter a doorway at y=63, the bot floating in water at y=62 outside the wall was 1.48 blocks
 * away horizontally, so `arriveDist: 2` reported `arrived=true covered=0.0` while it sat
 * outside the building. "Arrived" that ignores height means "gave up next to the target".
 *
 * goalXZOnly callers opt out entirely. arriveY is deliberately tight: one block covers standing on the target cell or on the block
 * below it, which is the honest range for "I am there".
 */
function reachedGoal(p, goal, o) {
    if (Math.hypot(goal.x - p.x, goal.z - p.z) > o.arriveDist) return false;
    // goalXZOnly callers (travelDirection walks toward a compass heading) genuinely do not care
    // about height - honour that, or every travel leg would report failure.
    if (o.goalXZOnly) return true;
    return Math.abs(p.y - goal.y) <= (o.arriveY ?? 1.25);
}

/**
 * Turn toward the goal and lay one block into the gap in front of us.
 *
 * Separated from `bridgeAhead` because the probe reads the QUANTISED heading: without turning
 * first the bot would sample whichever of the eight directions it last happened to face, which
 * on a stalled leg is rarely the way it wants to go.
 */
/**
 * Turn toward the goal and jump the gap in front of us.
 *
 * Separate from `jumpAcross` for the same reason `bridgeTowardGoal` is separate from
 * `bridgeAhead`: the probe reads the QUANTISED heading, and on a stalled leg the bot is rarely
 * facing the way it wants to go.
 */
async function jumpTowardGoal(bot, goal, gate) {
    const p = bot.entity.position;
    const dx = goal.x - p.x, dz = goal.z - p.z;
    if (Math.hypot(dx, dz) < 0.5) return { jumped: false, reason: 'already there' };
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    await sleep(120);
    const wet = !!bot.entity.isInWater;
    return await jumpAcross(bot, bot.entity.yaw, wet, gate);
}

/** A full block under the FEET CELL. The world's answer, never `onGround`. */
function standingOnSolid(bot) {
    const b = bot.blockAt?.(bot.entity.position.floored().offset(0, -1, 0));
    return !!b && b.boundingBox === 'block';
}

/**
 * Should a stuck bot tower straight up?
 *
 * Pure, so the refusals are testable (`tests/shaft.test.mjs`). Two different questions can make
 * the answer yes, and it matters which:
 *
 *  - the GOAL is above us, so rising is progress toward it - this is the `!followPlayer` case,
 *    where the person is on the surface and the bot is in the cave it was mining;
 *  - we are SEALED IN, so rising is the only way to be anywhere else at all - the buried case,
 *    where the goal may be flat but every horizontal route is behind a wall.
 *
 * Everything else in the pinned ladder moves the bot sideways, so neither case has any other
 * rung that can help. `wet` is excluded because leaving water belongs to `climbBank`, which is
 * tuned for it; pillaring does not work while afloat anyway.
 *
 * @returns {{ok: boolean, rise: number, reason: string}}
 */
export function towerUpVerdict(s) {
    const no = (reason, rise = 0) => ({ ok: false, rise, reason });
    if (!s) return no('no state');
    if (s.wet) return no('afloat - nothing under my feet to place against');
    if (!s.hasBlocks) return no('nothing stackable to pillar with');

    const cap = s.maxRise ?? 8;
    if (cap < 1) return no('tower budget spent');

    const toGoal = Math.floor((s.goalY ?? s.botY) - s.botY);
    if (toGoal >= (s.minRise ?? 2))
        return { ok: true, rise: Math.min(toGoal, cap), reason: `goal is ${toGoal} above me` };
    if (s.sealed)
        return { ok: true, rise: cap, reason: 'sealed in - up is the only way out' };
    return no(`goal is ${toGoal} above me and I am not sealed in`, toGoal);
}

/**
 * Tower toward the goal. Last rung of the ladder, after jumping and bridging have declined.
 *
 * @returns {Promise<number>} height gained.
 */
async function towerTowardGoal(bot, goal, budget) {
    const { climbShaftUp, hasBuildingBlocks } = await import('./skills.js');
    const p = bot.entity.position;
    const feet = p.floored();
    const ceiling = bot.blockAt(feet.offset(0, 2, 0));
    const v = towerUpVerdict({
        botY: p.y,
        goalY: goal.y,
        // AFLOAT, not merely WET. Those are different states and conflating them is documented
        // (CLAUDE.md, "WADING is not AFLOAT") as paralysing the bot completely - which is exactly
        // what it did here. Found live: andy in one block of water against a 0.50-block bank,
        // `climbBank: jammed` on repeat, and BOTH fallbacks standing down for it -
        // `jump: REFUSED (wet - SwimAssist owns the jump key)` and
        // `tower: REFUSED (wet - climbBank owns leaving the water)`. Nothing was left to act.
        //
        // Afloat, towering is genuinely impossible: there is nothing under the feet to place
        // against. WADING is land for this purpose - the bot is standing on solid ground with
        // its head in air, and can place a block and step up like anywhere else.
        wet: !!bot.entity.isInWater && !standingOnSolid(bot),
        hasBlocks: hasBuildingBlocks(bot),
        // Roofed AND with nowhere to walk. `enclosed` existed only so the bot could SAY it was
        // walled in; this is the first thing that decides anything on it, and the pairing is
        // deliberate - roofed alone is a house, enclosed alone is a pit with open sky that
        // climbAhead should handle.
        sealed: !!ceiling && ceiling.boundingBox === 'block' && enclosed(bot),
        maxRise: budget,
    });
    if (!v.ok) {
        console.log(`[${bot.username ?? '?'}] tower: REFUSED (${v.reason})`);
        return 0;
    }
    console.log(`[${bot.username ?? '?'}] tower: ${v.reason} - rising ${v.rise}`);
    return await climbShaftUp(bot, Math.floor(p.y) + v.rise, v.rise + 2);
}

async function bridgeTowardGoal(bot, goal) {
    const p = bot.entity.position;
    const dx = goal.x - p.x, dz = goal.z - p.z;
    if (Math.hypot(dx, dz) < 0.5) return false;
    await bot.look(Math.atan2(-dx, -dz), 0, true);
    await new Promise(r => setTimeout(r, 120));
    const wet = !!bot.entity.isInWater;
    const r = await bridgeAhead(bot, bot.entity.yaw, wet);
    return r.placed;
}

export async function navigateTo(bot, goal, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const startPos = bot.entity.position.clone();
    let replans = 0;
    let weakLegs = 0;
    let bridged = 0;
    let towered = 0;
    let jumps = 0;
    // Latched when a jump ended in a fall: the terrain read that produced the verdict was wrong,
    // so do not re-derive the same verdict from the same world for the rest of this call.
    let fellThisCall = false;
    // Set when the previous iteration laid a plank, so the leg that STEPS ONTO it is refunded
    // too. Laying a block and walking onto it is one unit of progress, not two spent replans -
    // and without this the replan budget, not `maxBridge`, is what decides how wide a gap can
    // be crossed: measured, widths 1-5 crossed and 6 and 8 stopped with five planks laid and
    // the bot standing on the end of its own unfinished bridge.
    let justBridged = false;

    let attempt = 0;
    while (attempt < o.maxReplans) {
        if (bot.interrupt_code) break;
        const p = bot.entity.position;
        if (reachedGoal(p, goal, o)) break;

        const path = planPath(bot, goal, o);
        if (!path || path.length < 2) {
            // NO ROUTE AT ALL - and a gap is the commonest reason for that.
            //
            // The planner's moves are all cell-to-adjacent-cell, so it has no way to express
            // crossing even a ONE-BLOCK gap: the neighbouring cell is not standable, no move
            // exists, and the search fails outright. `followPath`'s bridge step never gets a
            // chance, because followPath is only ever reached by way of a plan. That is why
            // mineflayer-pathfinder could cross gaps and we could not - its scaffolding lived
            // in the movement generator, so the PLAN already contained the placements.
            //
            // Rather than teach the planner to place blocks (which would change which nodes win
            // the whole A* frontier, not just the ones over gaps - the same trap the water cost
            // carries), lay one plank toward the goal and replan. If it helped, the next search
            // finds a route across it; if it did not, we stop.
            // JUMP FIRST. It costs nothing and leaves the ground intact; bridging spends
            // inventory and permanently alters terrain the bot is only crossing.
            if (o.jump && jumps < o.maxJumps && !fellThisCall) {
                const j = await jumpTowardGoal(bot, goal, {
                    cooldown: false, attemptsSpent: false, failedHere: false,
                });
                if (j.jumped) { jumps++; continue; }   // does NOT spend a replan
                if (j.reason === 'fell') fellThisCall = true;
            }
            if (o.bridge && bridged < o.maxBridge && await bridgeTowardGoal(bot, goal)) {
                bridged++;
                continue;           // deliberately does NOT spend a replan
            }
            // NOTHING SIDEWAYS WORKED. Every rung above this one moves the bot horizontally, so
            // a bot sealed under a ceiling exhausts all of them without touching the block that
            // is actually in its way. Towering is the only rung that gains height on its own.
            if (o.tower && towered < o.maxTower) {
                const lifted = await towerTowardGoal(bot, goal, o.maxTower - towered);
                if (lifted >= 0.5) { towered += Math.round(lifted); continue; }
            }
            break;
        }
        attempt++;
        replans++;

        const res = await followPath(bot, path.slice(1), o);
        if (res.covered < 0.5) {
            // A LEG THAT WENT NOWHERE, with the goal still ahead. The commonest cause is a gap:
            // `planPath` returns a stub that walks to the lip and stops - measured,
            // `length=2 first=last=(4614.5, 111, 4701.5)` against a goal 10 blocks further on -
            // so the "no route at all" branch above never fires and the bot simply grinds.
            // Everything else has already been tried by now: followPath's own ladder has hopped,
            // climbed and dug, and the planner has had its go. This is the last resort.
            // Jump before bridging, for the same reason. ONE refund, not two: bridging refunds
            // twice because it is two units of work (lay the plank, then step onto it), and a
            // jump is one - it puts the bot on the far side by itself. A second refund would
            // make a FAILED jump free, and the loop would then attempt jumps at zero cost.
            if (o.jump && jumps < o.maxJumps && !fellThisCall
                && !reachedGoal(bot.entity.position, goal, o)) {
                const j = await jumpTowardGoal(bot, goal, {
                    cooldown: false, attemptsSpent: false, failedHere: false,
                });
                if (j.jumped) {
                    jumps++;
                    weakLegs = 0;
                    if (attempt > 0) attempt--;
                    continue;
                }
                if (j.reason === 'fell') fellThisCall = true;
            }
            if (o.bridge && bridged < o.maxBridge && !reachedGoal(bot.entity.position, goal, o)
                && await bridgeTowardGoal(bot, goal)) {
                bridged++;
                weakLegs = 0;
                // Give the replan back. Laying a plank is progress, not a wasted attempt - and
                // the leg that discovers the gap always costs one, so a 3-block span burned four
                // of the six replans and the loop exited with the bridge FINISHED and the bot
                // still standing on it. Measured exactly that: three `bridge: laid` lines, the
                // span complete, and the bot stopped at x=4615.9. `maxBridge` is the real bound.
                if (attempt > 0) attempt--;
                justBridged = true;
                continue;           // replan; the next search can cross what we just laid
            }
            // Same last rung as the no-route branch. A leg that went nowhere with a ceiling
            // overhead is the buried case: followPath's own ladder has hopped, climbed and dug,
            // and every one of those is horizontal.
            if (o.tower && towered < o.maxTower && !reachedGoal(bot.entity.position, goal, o)) {
                const lifted = await towerTowardGoal(bot, goal, o.maxTower - towered);
                if (lifted >= 0.5) {
                    towered += Math.round(lifted);
                    weakLegs = 0;
                    // Refunded for the same reason bridging is: rising toward the goal is
                    // progress, and the leg that discovers the ceiling always costs one.
                    if (attempt > 0) attempt--;
                    continue;
                }
            }
            // Two consecutive legs that barely moved means the plan is not executable here;
            // hand control back so the caller can dig or sidestep instead of grinding.
            if (++weakLegs >= 2) break;
        } else {
            weakLegs = 0;
            if (justBridged && attempt > 0) attempt--;   // the step onto the new plank
            justBridged = false;
        }
    }

    const p = bot.entity.position;
    return {
        arrived: reachedGoal(bot.entity.position, goal, o),
        covered: p.distanceTo(startPos),
        replans,
    };
}
