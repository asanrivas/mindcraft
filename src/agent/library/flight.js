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
    if (bot.entity.position.y - beforeClimb < 0.5 && cruise - beforeClimb > 1) return direct;
    await flyDirect(bot, new Vec3(target0.x, cruise, target0.z), budget);
    return await flyDirect(bot, target0, budget);
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
                out.push({ p, eyeD });
            }
        }
    }
    out.sort((a, b) => a.eyeD - b.eyeD);
    return out.map((o) => o.p);
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
    let freed = false;   // only one unwedge attempt per call
    for (const p of tries) {
        if (!hoverIsClear(bot, p)) { rejected.push(`blocked@${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`); continue; }
        if (Date.now() > budgetUntil) { rejected.push('budget spent'); break; }
        const was = bot.entity.position.clone();
        const short = await flyTo(bot, p, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 4000, Math.max(600, budgetUntil - Date.now())) });
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
    console.log(`[${bot.username ?? '?'}] flyNear (${P.x}, ${P.y}, ${P.z}) failed: ${rejected.join(' | ') || 'no candidates'}`);
    return false;
}
