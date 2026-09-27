/**
 * Creative flight, for reaching work a walking builder cannot.
 *
 * WHY THIS EXISTS, AND WHY IT WAS SWITCHED OFF BEFORE
 * --------------------------------------------------
 * `blueprint_builder.js` walks everywhere and says why:
 *
 *   "Client-driven creative flight is dead on this server: measured 1,870 forcedMove
 *    corrections in one run - the server rejects every flown movement packet and pins the
 *    player, after which all placements fail from range."
 *
 * That measurement no longer holds, and it was load-bearing for the builder's single biggest
 * cost: with no flight, anything above walking reach needs a dirt pillar, and the pillar is
 * where the original run died - "measured: 3,138 of 3,648 blocks failed exactly this way".
 *
 * Re-measured 2026-08-31 with `tools/fly_probe.mjs`:
 *
 *   lift: 9.80 blocks in 1465ms, held steady (missed the target by 0.20)
 *   corrections: 0 in 4.7s        <- not 1,870; the server does not reject this at all
 *   placement from the air: 4/4   <- acked in 39-48ms
 *
 * Two things changed underneath the old figure: the premise that `onGround` is broken here was
 * wrong, and placement no longer waits on mineflayer's unsatisfiable `blockUpdate` - it writes
 * the packet and reads the server's ack. Both fed "placements fail from range".
 *
 * THE TRAP THAT PRODUCED THE OLD NUMBER
 * -------------------------------------
 * Driving the climb by setting position AND velocity makes the engine keep integrating the
 * velocity after the caller stops steering, so the bot sails past its target. The first re-run
 * asked for +10, arrived at +17.8, drifted to +22, and failed 4/4 placements - from 15 blocks
 * out of reach. That reads exactly like "flight breaks placement" and is nothing of the kind.
 * So: position only, velocity zeroed every step, and a standoff before placing. A flying
 * builder still obeys the same ~4.5 block interaction range as a walking one.
 */
import { Vec3 } from 'vec3';
import { isLavaName } from './tools.js';

/** How close the body must get before a placement is worth attempting. */
export const FLY_REACH = 3.0;
/**
 * Eye height above the feet. The server range-checks and ray-checks from the EYE, not from the
 * feet, so every placement geometry here is computed in eye space and converted at the end.
 */
export const EYE_HEIGHT = 1.62;
/** Per-step distance. Small enough that the server sees a smooth path, not a teleport. */
const STEP = 0.35;

/**
 * Where to put the BODY so the eye looks squarely at the face we intend to click.
 *
 * This is the geometry `hoverPointFor` gets wrong. That one picks a side based on where the bot
 * happens to be standing and always sits level with the cell - so clicking a TOP face puts the
 * eye 1.82 blocks above the block looking down past it, and clicking an UNDERSIDE is simply
 * unreachable. The builder already knows this matters:
 *
 *   "Modern servers (1.20.2+ interaction validation, which this one has) verify that the click
 *    is plausible from the player's eye: a look ray that never intersects the clicked face gets
 *    the placement silently rejected (observed: 94% blockUpdate timeouts with a horizontal
 *    forced yaw)."
 *
 * So do it as vectors instead of cases. The face we click has a centre and an outward normal;
 * stand back along that normal and the ray hits the face dead-on for every one of the six
 * faces, with no special-casing:
 *
 *   faceCentre = P + (0.5, 0.5, 0.5) + faceVec * 0.5
 *   eye        = faceCentre + faceVec * standoff
 *   feet       = eye - (0, EYE_HEIGHT, 0)
 *
 * @param {Vec3} P        the cell to fill
 * @param {Vec3} faceVec  outward normal of the face being clicked, e.g. (0,1,0) for its top
 * @param {number} [standoff] how far back along the normal to sit, in blocks
 * @returns {{feet: Vec3, eye: Vec3, faceCentre: Vec3}}
 */
export function placementPose(P, faceVec, standoff = 2.0) {
    const cell = new Vec3(P.x + 0.5, P.y + 0.5, P.z + 0.5);
    const n = new Vec3(faceVec.x, faceVec.y, faceVec.z);
    const faceCentre = cell.plus(n.scaled(0.5));
    const eye = faceCentre.plus(n.scaled(standoff));
    return { faceCentre, eye, feet: eye.offset(0, -EYE_HEIGHT, 0) };
}

/**
 * Where should the bot hover to work on cell `P`?
 *
 * Beside and very slightly above, never inside: the server refuses a placement whose
 * destination the body occupies, which is the same rule `bodyClearsCell` encodes for pillaring.
 * The side is chosen to face where the bot is coming from, so the approach does not cross the
 * structure it is building.
 *
 * Pure, so the geometry is testable without a bot or a world.
 *
 * @param {{x:number,y:number,z:number}} P     the cell being filled
 * @param {{x:number,y:number,z:number}} from  where the bot is now
 * @param {number} [standoff]
 * @returns {{x:number,y:number,z:number}}
 */
export function hoverPointFor(P, from, standoff = 2.0) {
    const cx = P.x + 0.5, cz = P.z + 0.5;
    let dx = (from?.x ?? cx) - cx;
    let dz = (from?.z ?? cz) - cz;
    const len = Math.hypot(dx, dz);
    // Directly above the cell is a legal approach and sometimes the only one, but it is a poor
    // default: the bot then looks straight down and the click ray skims the top face. Coming in
    // from a side gives the validation an honest angle.
    if (len < 0.01) { dx = 1; dz = 0; }
    else { dx /= len; dz /= len; }
    return { x: cx + dx * standoff, y: P.y + 0.2, z: cz + dz * standoff };
}

/** Distance from the bot's EYE to the centre of a cell - what the server range-checks. */
export function eyeDistanceTo(bot, P) {
    return bot.entity.position.offset(0, 1.62, 0).distanceTo(new Vec3(P.x + 0.5, P.y + 0.5, P.z + 0.5));
}

/**
 * Is flight available at all? Creative only - and `bot.creative` is a core auto-loaded plugin,
 * so its absence means a stubbed bot in a test rather than a server that forbids flying.
 */
export function canFly(bot) {
    return bot?.game?.gameMode === 'creative' && typeof bot?.creative?.startFlying === 'function';
}

/**
 * Begin flying, once. Returns whether WE started it, which the caller must remember.
 *
 * `stopFlying` without a prior `startFlying` sets `bot.physics.gravity` to null - creative.js
 * captures normalGravity lazily - and that breaks walking physics for the rest of the session.
 * So the two are strictly paired and the caller owns the flag.
 */
export function beginFlight(bot) {
    if (!canFly(bot)) return false;
    try { bot.creative.startFlying(); return true; } catch (e) { return false; }
}

/** End a flight WE started. Never call this speculatively - see beginFlight. */
export function endFlight(bot, weStarted) {
    if (!weStarted) return;
    try { bot.creative.stopFlying(); } catch (e) { /* best effort; gravity is restored on respawn */ }
}

/**
 * Fly to a point and hold there, going OVER obstructions rather than through them.
 *
 * A straight line is right in open air and wrong inside a building. Flight removes gravity, not
 * collision, so a direct run from outside to an interior cell stops dead at the first wall -
 * measured 2026-08-31 once the build was a few courses high: eight hover candidates in a row all
 * reporting `flew short by 7-10, eye 9.2-10.5`, the distance barely changing, because every
 * straight line crossed the same masonry.
 *
 * So on a blocked run, do what a player does: climb clear, cross, descend. Cruise altitude is
 * above BOTH endpoints because the obstruction can be at either end, and the sky over an
 * unfinished build is the one reliably empty corridor.
 *
 * @returns {Promise<number>} how far short of `dest` we finished
 */
export async function flyTo(bot, dest, opts = {}) {
    const target0 = new Vec3(dest.x, dest.y, dest.z);
    const direct = await flyDirect(bot, target0, opts);
    if (direct <= 1.0 || opts.noDetour) return direct;

    // Over the top. Each leg is direct; only the route is bent.
    const p = bot.entity.position;
    const cruise = Math.max(p.y, target0.y) + (opts.cruise ?? 4);
    const budget = { ...opts, timeoutMs: Math.max(1200, (opts.timeoutMs ?? 4000) / 2) };
    // If the CLIMB does not move us, we are under a ceiling - and the cross and descent legs
    // will then fail for the same reason, three times, for nothing. Bail on the first leg that
    // makes no progress rather than paying the whole route to learn it twice more. (The general
    // rule this repo keeps re-earning: a retry that can fail identically must not be taken.)
    const beforeClimb = bot.entity.position.y;
    await flyDirect(bot, new Vec3(p.x, cruise, p.z), budget);
    if (bot.entity.position.y - beforeClimb >= 0.5 || cruise - beforeClimb <= 1) {
        await flyDirect(bot, new Vec3(target0.x, cruise, target0.z), budget);
        const overTop = await flyDirect(bot, target0, budget);
        if (overTop <= 1.0) return overTop;
    }
    // Neither the straight line nor the climb worked. Under a roof, inside a shell, in a stairwell
    // - the cases where a route exists but no heuristic finds it. Plan one.
    //
    // ROUTING IS ON BY DEFAULT, and only `flyNear`'s per-candidate probing opts out. It was the
    // other way round at first, which silently left every OTHER caller unrouted - including the
    // builder's wedge rescue at blueprint_builder.js:242, the one call that runs precisely when the
    // bot is stuck inside its own build. The symptom was a bot walled in at 26 blocks from its
    // station repeating `wedged - returned to station above the build (26.4 short)` every 37
    // seconds with an unchanging shortfall, while `no route` stayed at 0 because nothing ever asked
    // for a route. A default that excludes the case the feature exists for is not a default.
    if (opts.route === false) return bot.entity.position.distanceTo(target0);
    // SAY WHEN THERE IS NO ROUTE. This path used to return silently, so a caller that is sealed in
    // looked identical to one whose flight merely fell short - and the `no route (sealed)` counter
    // in flyNear reported 0 while the builder's wedge rescue was failing by the same 26 blocks
    // every 37 seconds. An absence has to be announced or it defaults to "fine".
    const route = planFlight(bot, target0, opts);
    if (!route) {
        const d = bot.entity.position.distanceTo(target0);
        console.log(`[${bot.username ?? '?'}] flyTo (${target0.x.toFixed(0)}, ${target0.y.toFixed(0)}, `
            + `${target0.z.toFixed(0)}): NO ROUTE for a 0.6x1.8 body, ${d.toFixed(1)} away `
            + `- sealed in, or no body-sized opening`);
        return d;
    }
    return await flyRoute(bot, route, opts);
}

/** One straight-line leg. The primitive `flyTo` bends into a route when a leg is blocked. */
async function flyDirect(bot, dest, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? 4000);
    const target = new Vec3(dest.x, dest.y, dest.z);
    // STAND THE GROUND DRIVER DOWN FIRST. This is the same lesson `followPath` already carries
    // about mineflayer-pathfinder: it rewrites control states every tick and silently cancels
    // ours. A held `forward` plus an active goal fights every position write, and the signature
    // is unmistakable once you know it - measured 2026-08-31, seven hover candidates tried in a
    // row all reporting `eye 7.2`, the SAME distance every time, because the bot never moved a
    // millimetre between attempts. Flight looked broken; it was being driven backwards.
    try { bot.pathfinder?.setGoal?.(null); } catch (e) { /* plugin may be absent */ }
    try { bot.pathfinder?.stop?.(); } catch (e) { /* ditto */ }
    try { bot.clearControlStates?.(); } catch (e) { /* ditto */ }
    while (Date.now() < deadline) {
        if (bot.interrupt_code) break;
        const p = bot.entity.position;
        const d = target.minus(p);
        const dist = d.norm();
        if (dist < 0.35) break;
        const u = d.scaled(1 / dist);
        const step = Math.min(STEP, dist);
        bot.entity.position.set(p.x + u.x * step, p.y + u.y * step, p.z + u.z * step);
        // Zero it EVERY step. Leaving velocity set is what made the first measurement overshoot
        // by 8 blocks and misread as "the server rejects flight".
        bot.entity.velocity.set(0, 0, 0);
        await new Promise((r) => setTimeout(r, opts.tickMs ?? 50));
    }
    bot.entity.velocity.set(0, 0, 0);
    return bot.entity.position.distanceTo(target);
}

// ---------------------------------------------------------------------------------------------
// Routing through geometry
//
// Straight line, then over the top, then THIS. The first two cannot enter a closed volume, and
// that is precisely where a builder spends the end of a build: measured 2026-09-22 on the Wizard
// Tower, bob parked at its station at (4672, 89.5, 4618) with the remaining cells at y 73-79
// inside the finished shell - 5,238 consecutive `flyNear ... failed: flew short by 11-15 | budget
// spent` lines, the builder's own tally `0 placed, 183 failed` with `140-216x out of reach (no
// clear hover within range)` per pass, and `wedged - returned to station above the build` putting
// it back where nothing is reachable. Nothing was wrong with flight itself: zero forcedMove
// events on our side and zero `moved too quickly` on the server's. The bot simply had no route,
// because "fly at it and climb if blocked" is not a route.
//
// So: A* over cells the BODY fits in. Deliberately not `nav.planPath` - that planner is about
// standing (`standCost`, drops, jumps, dig costs, support underfoot), and a flying body has none
// of those constraints while having one the walker does not: it must clear overhead too. Sharing
// it would mean teaching every ground cost model to ignore itself.
// ---------------------------------------------------------------------------------------------

/** Search ceiling. A route inside a building is short; a long search means there is no way in. */
const ROUTE_MAX_NODES = 6000;
/**
 * flyNear's ONE planned attempt, which searches for ANY of its clear candidates at once. Measured
 * 2026-09-26 replaying 530 of the cathedral's 3,176 leftover cells against the live world, each
 * from the previous cell's hover, at the default 64-block range: first candidate only at 6,000
 * nodes (the old call) routed 430 (81%), 15ms a cell; the goal set in one search routed 438 at
 * 6,000, 476 at 20,000 (90%, 23ms a cell), 490 at 60,000 (28ms). None of the 3,176 is actually
 * sealed - a flood fill from outside reached a hover for every one - so each "no route" was the
 * search, not the building. Against the ~20s a failed attempt cost in retry round 1 (1.4 placed a
 * minute), any of these is free; 20,000 is where the gain flattens.
 */
export const FLYNEAR_ROUTE_MAX_NODES = 20000;
/** How far outside the start/goal box the search may wander, in blocks. */
const ROUTE_PAD = 16;
/**
 * Longest flight this will plan. Flight is a LOCAL manoeuvre - get into the room, round the wall,
 * down the stairwell. Crossing country is `skills.travelToward`'s job, over ground, with
 * checkpoints and a survey behind it (docs/MARATHON.md). Planning a 400-block flight would also
 * promise something the per-leg timeouts cannot deliver, which reads as a stall rather than as a
 * refusal.
 */
const ROUTE_MAX_RANGE = 64;
const ROUTE_MOVES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

const ckey = (x, y, z) => `${x},${y},${z}`;

/**
 * Can the body occupy this cell? Feet cell and head cell both free, both loaded, neither lethal.
 *
 * An UNLOADED cell is blocked, not free: `blockAt` returning null means we cannot see it, and
 * flying into what we cannot see is how a bot ends up inside a wall. Same rule `hoverIsClear`
 * already applies - this is its cell-indexed, memoised form, because A* re-reads columns.
 */
function flyable(bot, x, y, z, cache) {
    const k = ckey(x, y, z);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let ok = false;
    const at = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    if (at && head && at.boundingBox === 'empty' && head.boundingBox === 'empty'
        && !isLavaName(at.name) && !isLavaName(head.name)
        && at.name !== 'fire' && at.name !== 'soul_fire' && at.name !== 'powder_snow') ok = true;
    cache.set(k, ok);
    return ok;
}

/** Binary min-heap on .f. Same shape as the planner's in nav.js, kept local to avoid a new export. */
class FHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(n) {
        const a = this.a; a.push(n);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].f <= a[i].f) break;
            const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
        }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l].f < a[m].f) m = l;
                if (r < a.length && a[r].f < a[m].f) m = r;
                if (m === i) break;
                const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
            }
        }
        return top;
    }
}

/**
 * Is the straight segment a->b flyable BY THE BODY throughout?
 *
 * The body is 0.6 wide, and the plan is a line of points. Checking only the cell each sample point
 * falls in passes a diagonal that shaves a corner the hitbox cannot: measured 2026-09-22 in the
 * live build as `route of 5 legs left 10.2, eye 13.0` - the plan was clear, the flight was not.
 * A* itself is safe without this (its moves are axis-aligned centre-to-centre, so the body stays
 * inside the two cells), but SMOOTHING introduces the diagonals, so the smoother has to answer the
 * question the body will ask.
 */
const HALF_WIDTH = 0.3;
const BODY_HEIGHT = 1.8;
/** Exported for flyNear's skip rule and its test; `cache` is optional. */
export function lineIsClear(bot, a, b, cache = new Map()) {
    return clearLine(bot, new Vec3(a.x, a.y, a.z), new Vec3(b.x, b.y, b.z), cache);
}
function clearLine(bot, a, b, cache) {
    const d = b.minus(a);
    const steps = Math.ceil(d.norm() / 0.25);
    for (let i = 0; i <= steps; i++) {
        const p = a.plus(d.scaled(i / steps));
        // EVERY CELL THE BODY OVERLAPS, not just the feet cell and the one above. `flyable` clears
        // two cells, which is the body exactly at an integer y - but a leg that climbs or descends
        // puts the feet at FRACTIONAL y, where a 1.8-tall body reaches into a THIRD cell that was
        // never checked. Measured 2026-09-26 against the live cathedral: 13 of 183 planned legs (in
        // 10 of 82 routes) crossed a cell the body could not fit, every one passed by this check,
        // and the flight then pressed into the ceiling - `route leg made no progress ... rose 1.9`,
        // the pattern behind the wedge that stopped the build at 95.5%.
        const yTop = Math.floor(p.y + BODY_HEIGHT - 1e-6);
        for (const ox of [-HALF_WIDTH, HALF_WIDTH]) {
            for (const oz of [-HALF_WIDTH, HALF_WIDTH]) {
                const x = Math.floor(p.x + ox), z = Math.floor(p.z + oz);
                if (!flyable(bot, x, Math.floor(p.y), z, cache)) return false;
                // flyable(y) covers y and y+1; the body only needs y+2 when it pokes into it
                if (yTop > Math.floor(p.y) + 1 && !flyable(bot, x, Math.floor(p.y) + 1, z, cache)) return false;
            }
        }
    }
    return true;
}

/**
 * Plan a flight from where the bot is to `dest` as cell waypoints, or null if there is no way.
 *
 * Pure with respect to the world: it only reads `bot.blockAt` and `bot.entity.position`, so it is
 * testable against a fake grid with no server (tests/flight_route.test.mjs).
 *
 * @returns {Vec3[]|null} waypoints, cell centres, ending at the destination cell
 */
export function planFlight(bot, dest, opts = {}) {
    const maxNodes = opts.maxNodes ?? ROUTE_MAX_NODES;
    const pad = opts.pad ?? ROUTE_PAD;
    const cache = opts.cache ?? new Map();
    const s = bot.entity.position.floored();
    // `dest` may be ONE point or a SET of them - any hover that puts the cell in reach will do, so
    // search once for the nearest reachable one rather than committing to the first (see
    // FLYNEAR_ROUTE_MAX_NODES for the measurement).
    const maxRange = opts.maxRange ?? ROUTE_MAX_RANGE;
    const goals = [];
    for (const d of Array.isArray(dest) ? dest : [dest]) {
        const g = new Vec3(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z));
        if (s.distanceTo(g) > maxRange) continue;
        // A DESTINATION may legitimately be a cell the body cannot occupy (a hover point computed
        // against geometry that has since been filled). That is a "no route", not a crash - drop
        // it rather than searching the whole box for something that cannot be entered.
        if (!flyable(bot, g.x, g.y, g.z, cache)) continue;
        if (!goals.some(o => o.equals(g))) goals.push(g);
    }
    if (!goals.length) return null;
    const goalKeys = new Set(goals.map(g => ckey(g.x, g.y, g.z)));

    const lo = new Vec3(Math.min(s.x, ...goals.map(g => g.x)) - pad, Math.min(s.y, ...goals.map(g => g.y)) - pad, Math.min(s.z, ...goals.map(g => g.z)) - pad);
    const hi = new Vec3(Math.max(s.x, ...goals.map(g => g.x)) + pad, Math.max(s.y, ...goals.map(g => g.y)) + pad, Math.max(s.z, ...goals.map(g => g.z)) + pad);
    const inBox = (x, y, z) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y && z >= lo.z && z <= hi.z;
    // Admissible for a goal SET: the distance to the nearest goal.
    const h = (x, y, z) => { let m = Infinity; for (const g of goals) m = Math.min(m, Math.hypot(g.x - x, g.y - y, g.z - z)); return m; };

    const start = { x: s.x, y: s.y, z: s.z, g: 0, parent: null };
    start.f = h(s.x, s.y, s.z);
    const open = new FHeap();
    open.push(start);
    const best = new Map([[ckey(s.x, s.y, s.z), 0]]);
    const closed = new Set();
    let expanded = 0;

    while (open.size && expanded < maxNodes) {
        const cur = open.pop();
        const k = ckey(cur.x, cur.y, cur.z);
        if (closed.has(k)) continue;
        closed.add(k);
        expanded++;

        if (goalKeys.has(k)) {
            const out = [];
            for (let n = cur; n; n = n.parent) out.unshift(new Vec3(n.x + 0.5, n.y, n.z + 0.5));
            return smoothRoute(bot, out, cache);
        }

        for (const [dx, dy, dz] of ROUTE_MOVES) {
            const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
            if (!inBox(nx, ny, nz)) continue;
            const nk = ckey(nx, ny, nz);
            if (closed.has(nk)) continue;
            if (!flyable(bot, nx, ny, nz, cache)) continue;
            const ng = cur.g + 1;
            if (best.has(nk) && best.get(nk) <= ng) continue;
            best.set(nk, ng);
            open.push({ x: nx, y: ny, z: nz, g: ng, parent: cur, f: ng + h(nx, ny, nz) });
        }
    }
    return null;   // no way in, or the budget ran out - both mean "do not pretend to fly there"
}

/**
 * The NEAREST WAY OUT of a footprint: breadth-first over cells the body fits in, to the first one
 * outside `box` (beyond its x/z edges, or above topY). Waypoints like planFlight, or null.
 *
 * The wedge rescue aims at ONE point - `parkSpot`, just beyond the nearest wall at the bot's own
 * height - and plans to it with the ordinary 6,000-node A*. From deep inside a finished building
 * that point is behind the wall, and the way to it winds out through a door or a window first.
 * Measured 2026-09-26: the cathedral stopped at 95.5% with bob in the nave, `33.0 from open ground`,
 * five rescues moving him under 1.6 blocks - while a flood fill from outside had already shown every
 * interior hover there connects to open air. The question a rescue asks is "which way is out", not
 * "how do I get to that point", and BFS answers it directly.
 */
export const ESCAPE_MAX_NODES = 60000;
export function planEscape(bot, box, opts = {}) {
    const maxNodes = opts.maxNodes ?? ESCAPE_MAX_NODES;
    const cache = opts.cache ?? new Map();
    const s = bot.entity.position.floored();
    const out = (x, y, z) => x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ
        || (box.topY !== undefined && box.topY !== null && y > box.topY);
    const nodes = [{ x: s.x, y: s.y, z: s.z, parent: null }];
    const seen = new Set([ckey(s.x, s.y, s.z)]);
    for (let i = 0; i < nodes.length && i < maxNodes; i++) {
        const cur = nodes[i];
        if (i > 0 && out(cur.x, cur.y, cur.z)) {
            const path = [];
            for (let n = cur; n; n = n.parent) path.unshift(new Vec3(n.x + 0.5, n.y, n.z + 0.5));
            return smoothRoute(bot, path, cache);
        }
        for (const [dx, dy, dz] of ROUTE_MOVES) {
            const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
            const k = ckey(nx, ny, nz);
            if (seen.has(k)) continue;
            seen.add(k);
            if (!flyable(bot, nx, ny, nz, cache)) continue;
            nodes.push({ x: nx, y: ny, z: nz, parent: cur });
        }
    }
    return null;
}

/** Drop every waypoint the previous one can already see, so the route is few long legs. */
function smoothRoute(bot, path, cache) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        while (j > i + 1 && !clearLine(bot, path[i], path[j], cache)) j--;
        out.push(path[j]);
        i = j;
    }
    return out;
}

/**
 * Fly a planned route leg by leg. Each leg is a straight line by construction, so `noDetour` is
 * correct here: a leg that cannot be flown means the world changed under the plan, and the answer
 * is to replan, not to improvise a climb.
 *
 * @returns {Promise<number>} distance remaining to the last waypoint
 */
export async function flyRoute(bot, path, opts = {}) {
    const last = path[path.length - 1];
    // HONOUR THE INTERRUPT, or this function becomes a busy loop that kills the client.
    // `flyDirect` breaks instantly while `bot.interrupt_code` is set, so every leg returns with no
    // progress, `freeSelf` does the same, and the caller replans - as fast as the CPU allows.
    // Measured 2026-09-22 after a `!stop`: 1,524 `made no progress` lines and 781 wedges in 70
    // seconds (4-6 per second, each reporting a 3535ms budget it never waited on), then
    // `Agent bob disconnected` and `exited with code 1`. That is CLAUDE.md's "await is not a yield":
    // a loop whose awaits all resolve immediately starves the event loop and the server drops us.
    if (bot.interrupt_code) return bot.entity.position.distanceTo(last);
    // UNSTRADDLE FIRST. The plan is a chain of cell centres and the body is 0.6 wide, so a bot
    // sitting off-centre straddles two cells - and if either is solid it cannot leave along ANY
    // leg until it centres itself. That is what produced `route leg 2/6 made no progress: needed
    // 5.0, budget 1200ms, still 4.6 away`: 1200ms is 8 blocks of travel at 7 blocks/second, and
    // the bot moved nothing at all, so the obstacle was never the budget. path[0] is the cell the
    // bot is already in, which the loop below skips; flying to it is the cheap unwedge.
    // SNAP TO THE GRID THE PLAN WAS MADE ON. Waypoints are cell centres at integer y, and
    // `flyable` therefore clears exactly two cells - feet and head. A bot at a FRACTIONAL y (which
    // is what `freeSelf` leaves behind: rise 1.9 from 67.5 and you are at 69.4) has its 1.8-tall
    // body spanning THREE cells, and the third was never checked. Flying such a body along a plan
    // that assumed two is how a 2.3-block leg with a 1200ms budget moves nothing at all.
    if (path.length) {
        // The vertical snap is a SUB-STEP move and must not go through flyDirect, which returns
        // immediately for anything under STEP (`if (dist < 0.35) break`). Measured 2026-09-22: the
        // first version of this snap used flyDirect and therefore could never perform the one move
        // it exists for - the log still read `body is off-grid at y=72.25 (fraction 0.25)` right
        // after it ran. A 0.25-block correction is exactly the case it refuses.
        //
        // Safe because path[0] is the cell the bot is already in and the planner has already
        // asserted the body fits there; dropping to that cell's floor cannot enter a new block.
        const here = bot.entity.position;
        const floorY = Math.floor(here.y);
        if (here.y - floorY > 0.05) {
            bot.entity.position.set(here.x, floorY, here.z);
            bot.entity.velocity.set(0, 0, 0);
            await new Promise(r => setTimeout(r, 50));
        }
        // Then the horizontal unstraddle, which IS a normal move.
        await flyDirect(bot, new Vec3(path[0].x, Math.floor(bot.entity.position.y), path[0].z),
            { ...opts, timeoutMs: 900, noDetour: true });
        const frac = bot.entity.position.y - Math.floor(bot.entity.position.y);
        if (frac > 0.15 && frac < 0.85) {
            console.log(`[${bot.username ?? '?'}] route: body still off-grid at `
                + `y=${bot.entity.position.y.toFixed(2)} after snapping - something is holding it there`);
        }
    }
    for (let i = 1; i < path.length; i++) {
        if (bot.interrupt_code) return bot.entity.position.distanceTo(last);
        const w = path[i];
        const before = bot.entity.position.clone();
        const need = before.distanceTo(w);
        // A BUDGET THAT CANNOT COVER THE DISTANCE IS NOT A TIMEOUT, IT IS A REFUSAL. A flat 2500ms
        // cannot fly a leg longer than ~10 blocks, and smoothing exists precisely to produce long
        // legs: measured 2026-09-22 in the live build as 12 routes reached against 50
        // planned-and-abandoned leaving 16-18 blocks.
        //
        // The rate is MEASURED, not derived. STEP/tick suggests 0.35 per 50ms = 7 blocks/second,
        // but `tools/flight_check.mjs` in open air flew 20 blocks in 5251ms - 262ms per block, less
        // than half the theoretical rate, because each step awaits a timer rather than riding the
        // physics tick. Budgeting from the theoretical figure is how the first version of this line
        // came out under-funded: 320ms/block leaves margin over the measurement instead.
        const ms = Math.max(opts.minLegMs ?? 1200, Math.min(opts.maxLegMs ?? 9000, need * 320));
        const short = await flyDirect(bot, w, { ...opts, timeoutMs: ms, noDetour: true });
        const moved = bot.entity.position.distanceTo(before);
        if (short <= 1.0) continue;
        // Stuck on a leg the plan called clear: the world is not what the plan assumed. Say WHICH
        // leg and by how much - "route left 16.8" alone cannot distinguish a wedged start from a
        // budget that ran out halfway, and those need opposite fixes.
        if (moved < 0.5) {
            // Unwedge, then hand back so the caller REPLANS. Retrying this same waypoint after
            // freeSelf has lifted the body two blocks flies a stale leg from a position the plan
            // never saw - measured as `needed 2.3 ... rose 2.0, still 3.0 away`, i.e. the retry
            // ended FURTHER from the waypoint than it started. A plan invalidated by our own
            // recovery is not a plan to retry; it is one to throw away.
            const rose = await freeSelf(bot, 3);
            console.log(`[${bot.username ?? '?'}] route leg ${i}/${path.length - 1} made no progress: `
                + `needed ${need.toFixed(1)}, budget ${ms.toFixed(0)}ms, rose ${rose.toFixed(1)} - replanning`);
            return bot.entity.position.distanceTo(last);
        }
        console.log(`[${bot.username ?? '?'}] route leg ${i}/${path.length - 1} short: needed `
            + `${need.toFixed(1)}, moved ${moved.toFixed(1)}, ${short.toFixed(1)} left (budget ${ms.toFixed(0)}ms)`);
    }
    return bot.entity.position.distanceTo(last);
}

/**
 * Candidate hover points for a cell, best first.
 *
 * A single hover point is not enough INSIDE a structure, which is exactly where this gets used.
 * `hoverPointFor` aims at the side the bot came from, and two blocks that way is very often
 * solid wall - the flight then parks the body inside geometry and the placement fails as
 * "out of reach" while the bot sits a metre from the target. Measured on the first flight-
 * enabled run: 7 such failures in the first 200 blocks, in a stretch where the WALKING build
 * had none.
 *
 * So: the preferred side first, then the other three, then directly overhead. Overhead is last
 * because looking straight down skims the top face and gives the server's interaction check the
 * least honest ray - but it is the one approach a roofless build always has.
 */
export function hoverCandidates(P, from, standoff = 2.0) {
    const out = [hoverPointFor(P, from, standoff)];
    const cx = P.x + 0.5, cz = P.z + 0.5;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = { x: cx + dx * standoff, y: P.y + 0.2, z: cz + dz * standoff };
        if (!out.some((o) => Math.abs(o.x - p.x) < 0.01 && Math.abs(o.z - p.z) < 0.01)) out.push(p);
    }
    // OVERHEAD, at two heights. Not a stylistic last resort - at ground level it is usually the
    // ONLY clear approach, because every side of a cell in the floor of a building is solid and
    // the face-aligned pose for an underside puts the feet below the world surface (measured:
    // `blocked@4710.5,63.4,4619.5` for a cell at y=67, i.e. 3.6 blocks inside bedrock-side fill).
    // The sky above an unfinished build is clear by definition, so these two almost always pass
    // hoverIsClear. +2 puts the eye 3.1 from the cell centre and +3 puts it 4.1 - both inside
    // interaction range, and the second exists for when the first is roofed by later courses.
    out.push({ x: cx, y: P.y + 2, z: cz });
    out.push({ x: cx, y: P.y + 3, z: cz });
    return out;
}

/**
 * Any clear body position near `P` whose EYE lands within interaction range, nearest first.
 *
 * The fixed candidates are all within ~2 blocks of the cell, which is fine outdoors and wrong
 * inside a finished building: the six or seven points around an interior cell are frequently
 * all wall, and the routine then declares "out of reach" while standing in a room that can see
 * the target perfectly well. Measured 2026-08-31 in a late pass: unreachable cells spread evenly
 * across every level y=67-74, i.e. interior detail rather than anything about height.
 *
 * The eye only has to be within about 4.5 blocks, so scan a small neighbourhood and take real
 * clearance wherever it exists. Sorted by eye distance so the closest honest angle wins.
 */
export function nearbyClearHovers(bot, P, radius = 3, maxEye = 4.0) {
    const out = [];
    const centre = new Vec3(P.x + 0.5, P.y + 0.5, P.z + 0.5);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -1; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (!dx && !dy && !dz) continue;
                const p = { x: P.x + dx + 0.5, y: P.y + dy, z: P.z + dz + 0.5 };
                const eyeD = new Vec3(p.x, p.y + EYE_HEIGHT, p.z).distanceTo(centre);
                if (eyeD > maxEye || eyeD < 1.2) continue;
                if (!hoverIsClear(bot, p)) continue;
                out.push({ p, eyeD, boxed: isBoxedIn(bot, p) });
            }
        }
    }
    // OPEN CELLS FIRST, then by distance. A free cell under a roof is a place the body can get
    // INTO and then not get out of: measured 2026-09-23 on the wizard tower, where bob was
    // repeatedly sealed inside his own build (`NO ROUTE for a 0.6x1.8 body ... no body-sized
    // opening`, and an escape that reported `the obstruction is sideways`). Only 45 of the 922
    // cells he had left actually required being inside - he was ending up there because this scan
    // returns "anywhere nearby that is free" and a roofed cell is nearer than an open one.
    //
    // A PREFERENCE, NOT A FILTER. Interior work is real work, and refusing roofed hovers would
    // make the inside of every finished building unbuildable. Ordering costs nothing when the open
    // cell works and loses nothing when it does not, because the roofed candidates are still
    // there, just later.
    out.sort((a, b) => (a.boxed - b.boxed) || (a.eyeD - b.eyeD));
    return out.map((o) => o.p);
}

/**
 * Is this hover point under a roof - i.e. somewhere the body can enter and then be sealed into?
 *
 * A cheap proxy for "connected to open air": scan straight up. Anything solid overhead within
 * `lift` means the cell is inside something. It cannot distinguish a courtyard from open sky, and
 * does not try: it only has to rank two free cells against each other, and the cost of being wrong
 * is trying the second candidate instead of the first.
 *
 * An unloaded chunk reads as null, which is NOT free space - the same rule hoverIsClear follows -
 * so an unreadable column counts as boxed in rather than open.
 */
export function isBoxedIn(bot, p, lift = 6) {
    const x = Math.floor(p.x), z = Math.floor(p.z), y0 = Math.floor(p.y);
    for (let dy = 2; dy <= lift; dy++) {
        const b = bot.blockAt(new Vec3(x, y0 + dy, z));
        if (!b) return 1;
        if (b.boundingBox === 'block') return 1;
    }
    return 0;
}

/**
 * Is there room for the body at this hover point?
 *
 * The bot is 1.8 tall, so both the cell it floats in and the one above must be free. Flying
 * does NOT let you occupy solid blocks - it only removes gravity - and a position write into
 * stone leaves the body wedged with every later placement out of range.
 */
export function hoverIsClear(bot, p) {
    const at = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
    const head = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z)));
    // A missing block is an unloaded chunk, not free space - refuse rather than fly into it.
    if (!at || !head) return false;
    return at.boundingBox === 'empty' && head.boundingBox === 'empty';
}

/**
 * Unwedge: rise straight up from where the bot IS, not from where it wants to go.
 *
 * Every candidate in `hoverCandidates` is positioned relative to the TARGET, which is useless
 * when the problem is that the body is stuck in geometry here. Flight removes gravity, not
 * collision, so a wedged bot collision-resolves back on every leg and the log fills with
 * `flew short by 12.2, eye 12.5` at an unchanging position.
 *
 * Straight up is the escape with the best odds inside a part-built structure - open sky is what
 * is above an unfinished build - and it is cheap enough to try before anything else.
 *
 * @returns {Promise<number>} how far the bot actually rose
 */
export async function freeSelf(bot, climb = 6) {
    const start = bot.entity.position.clone();
    // UP FIRST, then SIDEWAYS. Straight up is the best single guess inside an unfinished build,
    // but it is useless under a roof - measured as `wedged, rose 0.0` ten times running with the
    // bot in a one-wide pocket at y=75: solid above, solid west and south, and OPEN TO THE EAST
    // the whole time. Trying only one axis turned a bot that had an exit into a bot that did
    // not. Escapes are tried nearest-first so the cheapest way out wins.
    // START AT 1, not 2. The pocket that trapped bob at y=75 was open on its EAST FACE - the
    // immediately adjacent cell - and a loop beginning at distance 2 steps straight over the only
    // exit and probes the wall behind it. Measured as `wedged, rose 0.0` ten times running for a
    // bot that had a way out the whole time.
    const dirs = [];
    for (let d = 1; d <= climb; d += (d === 1 ? 1 : 2)) {
        dirs.push({ x: 0, y: d, z: 0 });
        dirs.push({ x: d, y: 0, z: 0 }, { x: -d, y: 0, z: 0 },
                  { x: 0, y: 0, z: d }, { x: 0, y: 0, z: -d });
        dirs.push({ x: 0, y: -d, z: 0 });   // down last: it is usually the floor
    }
    for (const d of dirs) {
        const p = { x: start.x + d.x, y: start.y + d.y, z: start.z + d.z };
        if (!hoverIsClear(bot, p)) continue;
        await flyDirect(bot, new Vec3(p.x, p.y, p.z), { timeoutMs: 1000 });
        if (bot.entity.position.distanceTo(start) > 1.0) break;
    }
    return bot.entity.position.distanceTo(start);
}

/**
 * Fly into working range of a cell. The flight equivalent of `goNear`.
 * @returns {Promise<boolean>} true when the cell is within interaction range
 */
export async function flyNear(bot, P, reach = FLY_REACH, opts = {}) {
    if (!canFly(bot)) return false;
    if (eyeDistanceTo(bot, P) <= reach) return true;
    // MULTIPLE STANDOFFS. A 2-block standoff is right in open air and wrong inside a finished
    // building, where it lands in the wall behind the cell - and once the shell is up that is
    // most of the remaining work. 1.3 keeps the body inside the room it is working in and is
    // still outside the 1.1 "too close to place" rule. Measured 2026-08-31 during pass2: bob
    // pinned inside the structure at y=74 for ten minutes for four blocks, because every hover
    // candidate at 2.0 was blocked and the walking fallback cannot navigate a finished interior.
    const standoffs = opts.standoff ? [opts.standoff] : [2.0, 1.3];
    const standoff = standoffs[0];
    const tries = [];
    for (const so of standoffs.slice(1)) {
        if (opts.faceVec) tries.push(placementPose(P, opts.faceVec, so).feet);
        tries.push(...hoverCandidates(P, bot.entity.position, so));
    }
    // The face-aligned pose FIRST when the caller told us which face it means to click - it is
    // the only one that guarantees the look ray meets the face, and it handles top and bottom
    // faces, which the side-picking fallback cannot express at all.
    // The face-aligned pose is the best ray, but only when the body can actually be there. For a
    // downward face it sits a whole body-height BELOW the block, which underground is never
    // free - so let hoverIsClear filter it rather than spending the first attempt on it.
    const primary = [];
    if (opts.faceVec) primary.push(placementPose(P, opts.faceVec, standoff).feet);
    primary.push(...hoverCandidates(P, bot.entity.position, standoff));
    tries.unshift(...primary);
    // Last: anywhere nearby that is actually free. Computed only once the fixed geometry has
    // been exhausted, since it is a 7x5x7 block scan.
    tries.push(...nearbyClearHovers(bot, P).slice(0, 6));
    // SAY WHY IT REFUSED. A silent false here is indistinguishable from flight never being
    // attempted, and the caller's fallback is the ground navigator - which then thrashes and
    // reports "out of reach (no walkable route)", pointing at walking for a flight failure.
    // TOTAL BUDGET, not just a per-leg one. There are up to fourteen candidates and each can
    // spend a 4s direct leg plus three detour legs, so an unreachable cell could burn two
    // minutes before failing - and unreachable cells are exactly what dominate a late build.
    // Measured 2026-08-31: 147 cells in ten minutes, of which nine failures accounted for most
    // of the wall clock. Blocked candidates are free to reject, so only flights are charged.
    const budgetUntil = Date.now() + (opts.budgetMs ?? 6000);
    const rejected = [];
    const lineCache = new Map();
    let freed = false;   // only one unwedge attempt per call
    for (const p of tries) {
        // An interrupt is a stop, not a reason to try the next candidate: every subsequent attempt
        // would return instantly and the loop would spin.
        if (bot.interrupt_code) { rejected.push('interrupted'); break; }
        if (!hoverIsClear(bot, p)) { rejected.push(`blocked@${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`); continue; }
        if (Date.now() > budgetUntil) { rejected.push('budget spent'); break; }
        // A BLOCKED STRAIGHT LINE IS NOT WORTH A DIRECT FLIGHT. The direct attempt is a straight
        // leg plus an over-the-top detour, up to its whole timeout each, and inside a standing
        // building the line almost always crosses masonry: measured 2026-09-26 on the cathedral's
        // leftover cells, 86 flyNear failures to 46 route successes in 25 minutes, the budget spent
        // bumping walls before the planner ever ran. The planner below finds any over-the-top way
        // too, in ~23ms, so a blocked line goes straight to it. (Skipped only while the body is
        // somewhere it can be - a wedged start reads every line as blocked, and then the direct
        // attempt is what triggers freeSelf.)
        if (flyable(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z), lineCache)
            && !clearLine(bot, bot.entity.position.clone(), new Vec3(p.x, p.y, p.z), lineCache)) {
            rejected.push(`line blocked@${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
            continue;
        }
        const was = bot.entity.position.clone();
        // route: false - this is the CHEAP pass over up to fourteen candidates. Planning here would
        // pay for the search fourteen times to answer one question; the single planned attempt
        // happens once, after this loop.
        const short = await flyTo(bot, p, { ...opts, route: false, timeoutMs: Math.min(opts.timeoutMs ?? 4000, Math.max(600, budgetUntil - Date.now())) });
        const d = eyeDistanceTo(bot, P);
        if (d <= reach + 1.5) return true;
        rejected.push(`flew short by ${short.toFixed(1)}, eye ${d.toFixed(1)}`);
        // Did that leg move us at all? If not we are wedged, and no further candidate can help
        // until the body is free - so spend one attempt on getting free rather than fourteen on
        // targets we cannot reach from inside a wall.
        if (bot.entity.position.distanceTo(was) < 0.2 && !freed) {
            freed = true;
            const rose = await freeSelf(bot);
            rejected.push(`wedged, rose ${rose.toFixed(1)}`);
        }
    }
    if (eyeDistanceTo(bot, P) <= reach + 1.5) return true;

    // ONE planned route, after everything cheap has failed. This is the case that dominates the
    // end of a build: the cell is inside a shell the bot has just finished closing, and no
    // straight line or climb can reach it - measured 2026-09-22 as 5,238 consecutive flyNear
    // failures and `0 placed` while bob sat at its station above the tower. A* over cells the body
    // fits in either finds the way in or says there is none, and "there is none" is a useful
    // answer: it is what tells the caller to defer the cell rather than retry it forever.
    // EVERY clear candidate is a goal. Planning to the first alone failed whenever that one sat in a
    // pocket the others did not (see FLYNEAR_ROUTE_MAX_NODES).
    const routable = tries.filter(p => hoverIsClear(bot, p));
    if (routable.length) {
        // Two attempts, and the second REPLANS rather than repeating. A leg that made no progress
        // means the world is not what the plan assumed - usually the body started wedged, and
        // `freeSelf` above has since moved it - so the useful retry is a new plan from where the
        // bot actually is, not the same waypoints again. (A retry that can fail identically must
        // not be taken.)
        for (let attempt = 0; attempt < 2 && !bot.interrupt_code; attempt++) {
            const plan = planFlight(bot, routable, { maxNodes: FLYNEAR_ROUTE_MAX_NODES });
            if (!plan) { rejected.push('no route (sealed or out of range)'); break; }
            const short = await flyRoute(bot, plan, { timeoutMs: 2500 });
            const d = eyeDistanceTo(bot, P);
            if (d <= reach + 1.5) {
                console.log(`[${bot.username ?? '?'}] flyNear (${P.x}, ${P.y}, ${P.z}) reached by route `
                    + `(${plan.length} legs${attempt ? ', replanned' : ''}) after ${rejected.length} direct attempts failed`);
                return true;
            }
            rejected.push(`route of ${plan.length} legs left ${short.toFixed(1)}, eye ${d.toFixed(1)}`);
            if (attempt === 0) await freeSelf(bot, 3);
        }
    }
    console.log(`[${bot.username ?? '?'}] flyNear (${P.x}, ${P.y}, ${P.z}) failed: ${rejected.join(' | ') || 'no candidates'}`);
    return false;
}
