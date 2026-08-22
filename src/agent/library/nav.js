import { Vec3 } from 'vec3';
import { digWithTool, isTreeTrunk } from './tools.js';

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
    waypointMs: 6000,    // give up on a single steering target after this
    maxReplans: 6,
    sprint: true,
    hopWhenStuck: true,  // see followPath: the only reliable way to move when onGround is wrong
    digWhenPinned: true, // mine the obstruction when hopping cannot free us
    climbWhenBlocked: true, // place blocks to get up a ledge too tall to jump
    pinnedMs: 2500,
    heuristicWeight: 1.25, // slight greediness; we replan often so optimality is not worth the nodes

    // Cost model. These are in units of "blocks walked", so digCost 14 literally means
    // "walking 14 blocks around this is cheaper than mining through it".
    digCost: 14,
    // Trees are natural but should still be walked around, not felled: a trunk is 1-2 blocks
    // wide, so a detour is trivial, while chopping is slower and wrecks the landscape. Priced
    // as a strong preference rather than a ban so a bot boxed in by trees cannot deadlock.
    treeDigCost: 60,
    // Water is priced high, not merely inconvenient: with this server's physics the bot barely
    // moves while swimming, so a route through a river is far worse than a long detour round it.
    waterCost: 15,
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
        else if (n.includes('lava') || n === 'fire' || n === 'cactus' || n === 'magma_block'
                 || n === 'powder_snow' || n === 'sweet_berry_bush') cls = HAZARD;
        else if (n.includes('water') || n === 'seagrass' || n === 'kelp' || n === 'kelp_plant') cls = WATER;
        else if (b.boundingBox) cls = b.boundingBox === 'block' ? SOLID : AIR;
        else cls = SOLID;
    }
    ctx.cache.set(k, cls);
    return cls;
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

    if (feet === HAZARD || head === HAZARD || below === HAZARD) return null;
    if (feet === SOLID || head === SOLID) return null;

    let c = 0;
    if (feet === WATER || head === WATER) c += o.waterCost;
    if (feet === UNKNOWN || head === UNKNOWN) c += o.unknownCost;

    if (below === SOLID) return c;
    if (below === WATER) return c + o.waterCost;
    if (below === UNKNOWN) return c + o.unknownCost;
    return null; // nothing underfoot
}

/** Cost of tunnelling into a cell we cannot otherwise occupy, or null if we must not. */
function digCostAt(ctx, x, y, z) {
    const o = ctx.o;
    if (!o.allowDig) return null;
    const feet = classify(ctx, x, y, z);
    const head = classify(ctx, x, y + 1, z);
    const below = classify(ctx, x, y - 1, z);
    if (feet === HAZARD || head === HAZARD || below === HAZARD) return null;
    if (below !== SOLID && below !== UNKNOWN) return null; // nothing to land on after digging
    let cost = 0, n = 0;
    for (const dy of [0, 1]) {
        if ((dy === 0 ? feet : head) !== SOLID) continue;
        n++;
        cost += isTreeTrunk(nameAt(ctx, x, y + dy, z)) ? o.treeDigCost : o.digCost;
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
            if (level !== null) { relax(cur, nx, cur.y, nz, base + level); continue; }

            // step up one (AutoJump does the work); cardinal only, diagonal hops are unreliable
            if (!diagonal && o.stepUp > 0) {
                const up = standCost(ctx, nx, cur.y + 1, nz);
                if (up !== null && classify(ctx, cur.x, cur.y + 2, cur.z) !== SOLID) {
                    relax(cur, nx, cur.y + 1, nz, base + o.climbCost + up);
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
                if (down !== null) { relax(cur, nx, cur.y - d, nz, base + d * o.dropCost + down); dropped = true; break; }
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
            while (i < path.length) {
                const wp = path[i];
                const dxz = Math.hypot(wp.x - p.x, wp.z - p.z);
                const dy = p.y - wp.y;
                if (dxz <= o.arriveXZ && dy <= 1.2 && dy >= -0.6) { i++; continue; }
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
                const flat = aim > i && Math.hypot(target.x - p.x, target.z - p.z) > 3;
                bot.setControlState('sprint', flat);
            }

            if (o.debug && (Date.now() - dbgAt) > 1000) {
                dbgAt = Date.now();
                console.warn(`[nav] pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) `
                    + `i=${i}/${path.length} aim=${aim} tgt=(${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)}) `
                    + `yaw=${bot.entity.yaw.toFixed(2)}/${yaw.toFixed(2)} fwd=${bot.controlState?.forward} `
                    + `onGround=${bot.entity.onGround} vel=(${bot.entity.velocity.x.toFixed(3)},${bot.entity.velocity.z.toFixed(3)})`);
            }

            const remaining = Math.hypot(final.x - p.x, final.z - p.z);
            if (remaining < bestRemaining - 0.25) {
                bestRemaining = remaining;
                stallSince = Date.now();
                lastProgress = Date.now();
                hops = 0;
            } else if (Date.now() - stallSince > o.waypointMs) {
                break; // not converging; let the caller replan
            } else if (o.digWhenPinned && Date.now() - stallSince > o.pinnedMs && hops >= 2) {
                // Genuinely pinned against a block face: hopping cannot help, and the planner
                // already priced a dig move here. Mine the obstruction rather than grinding.
                lastProgress = Date.now();
                hops = 0;
                const climbed = await climbAhead(bot, yaw);
                if (!climbed && !(await digAhead(bot, yaw))) {
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
    for (const dy of [0, 1]) {
        const t = new Vec3(Math.floor(p.x + fx * 0.8), Math.floor(p.y) + dy, Math.floor(p.z + fz * 0.8));
        const b = bot.blockAt(t);
        if (!b || b.name.includes('water')) continue;
        if (isTreeTrunk(b.name)) continue;   // walk around trees; do not fell them
        if (await digWithTool(bot, b)) return true;
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
export async function navigateTo(bot, goal, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const startPos = bot.entity.position.clone();
    let replans = 0;
    let weakLegs = 0;

    for (let attempt = 0; attempt < o.maxReplans; attempt++) {
        if (bot.interrupt_code) break;
        const p = bot.entity.position;
        if (Math.hypot(goal.x - p.x, goal.z - p.z) <= o.arriveDist) break;

        const path = planPath(bot, goal, o);
        if (!path || path.length < 2) break;
        replans++;

        const res = await followPath(bot, path.slice(1), o);
        // Two consecutive legs that barely moved means the plan is not executable here;
        // hand control back so the caller can dig, bridge or sidestep instead of grinding.
        if (res.covered < 0.5) { if (++weakLegs >= 2) break; } else weakLegs = 0;
    }

    const p = bot.entity.position;
    return {
        arrived: Math.hypot(goal.x - p.x, goal.z - p.z) <= o.arriveDist,
        covered: p.distanceTo(startPos),
        replans,
    };
}
