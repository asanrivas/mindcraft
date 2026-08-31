import { isLavaName, isSwimmable, isWaterName } from './tools.js';

/**
 * Boats — the PURE decision layer only (docs/gaps/boats.exec.md, Task 1).
 *
 * Stage 0 of that plan is an undecided LIVE probe: does this server move a boat from
 * `player_input` alone, or does it expect the client to stream `vehicle_move`? Nothing in this
 * file depends on that answer. It only decides WHETHER to board a boat, WHICH boat, and WHERE to
 * get back out — the same three questions `nav.js`'s `jumpVerdict`/`bridgeVerdict` answer for
 * jumping and bridging. No bot, no network, no filesystem, no clock: every input is an explicit
 * argument, so every case here is a table row, not a live measurement.
 *
 * The single most important judgement in this file is the one CLAUDE.md states plainly under
 * Swimming: "water is only cheap if you can get out of it". A pond is a route the bot can enter
 * and cannot leave, and mining out of one just widens it. `shouldBoat` therefore refuses a
 * crossing with no confirmed exit on the far shore in the SAME breath as it refuses a leg that
 * is short enough to swim or a destination reachable without touching water at all — it is not
 * a bolt-on check, it is one of the load-bearing refusals.
 */

// Frozen name set, exact membership only — never substring-match a block/entity name. The
// canonical example of why is `tools.js`'s `isFallingBlockName`: "sandstone".includes("sand")
// is true and sandstone does not fall. Here the equivalent trap is real: `"boat_spawn_egg"`
// contains "boat" and is not a boat.
const BOAT_WOODS = [
    'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak',
];
const BOAT_NAMES = new Set([
    ...BOAT_WOODS.map((w) => `${w}_boat`),
    ...BOAT_WOODS.map((w) => `${w}_chest_boat`),
    'bamboo_raft',
    'bamboo_chest_raft',
]);

export function isBoatEntity(name) {
    return !!name && BOAT_NAMES.has(name);
}

/**
 * Break-even point for launching a boat at all, from CLAUDE.md's measured baselines: walking
 * ~25 blocks/min, swimming a measured 1.96 b/s (~118/min), a vanilla boat ~8 b/s. Boarding,
 * placing and retrieving cost real time (the plan puts it at ~15s of overhead) that a short
 * crossing never earns back against the swim baseline it is competing with — 15s overhead /
 * 0.39s saved per block (boat vs. swim) is ~40 blocks. Taken verbatim from
 * docs/gaps/boats.exec.md §8 task 5; not re-derived here.
 */
export const MIN_BOAT_LEG = 40;

/**
 * May we board THIS boat right now?
 *
 * `entityName` is the boat entity's own name (run through `isBoatEntity`, not assumed) —
 * catches the case of trying to board something that only looks like a boat in a stale
 * entity list. `passengers` is the list of entity/session ids already seated in it, `selfId`
 * is ours, and `fluidBelow` is the name of the fluid block under the boat, if any.
 *
 * Order matters, same as `nav.js`'s verdict functions: the cheapest/most certain refusal wins,
 * so a caller logging the reason names the real problem rather than whichever check happened
 * to run last.
 */
export function boardVerdict({ entityName, passengers = [], selfId, fluidBelow } = {}) {
    if (!isBoatEntity(entityName)) return { board: false, reason: 'not_a_boat' };
    // Lava and water share one physics branch and can both read true at a boundary; every
    // swim/water entry point in this codebase refuses lava outright, and boarding is no
    // different — mounting over lava is one attach packet away from losing the bot and its
    // whole inventory the instant the mount fails or the boat tips.
    if (isLavaName(fluidBelow)) return { board: false, reason: 'lava' };
    // Check "it's already us" BEFORE the general occupancy check, or a bot re-issuing a mount
    // on the boat it is already sitting in reads as a hard refusal instead of a no-op.
    if (selfId != null && passengers.includes(selfId))
        return { board: false, reason: 'already_mounted' };
    if (passengers.length > 0) return { board: false, reason: 'occupied' };
    return { board: true, reason: 'empty boat, clear to board' };
}

/**
 * The when-to-boat decision: boat vs. swim vs. walk vs. hand off to the existing
 * swim-or-escape ladder.
 *
 * Every input is something a caller can measure without touching the network mid-decision:
 *   - `waterRun`     how many blocks of open water the route actually crosses (`openWaterRun`)
 *   - `landReachable` true if the destination can be reached without crossing that water at all
 *   - `exitReachable` true if a dismount point exists on the far shore (`pickDismountPoint`,
 *                      or equivalent knowledge) — this is the "can we get OUT" half of the
 *                      water-is-only-cheap-if-you-can-leave-it rule, and it is checked
 *                      independently of leg length: a short pond you cannot leave is exactly
 *                      as much of a trap as a long one.
 *   - `lavaOnRoute`   true if the scanned route crosses or borders lava anywhere
 *   - `haveBoat` / `canCraft`  whether a boat is already carried, or craftable from planks on hand
 *   - `minLeg`        override for `MIN_BOAT_LEG`, defaulting to it
 *
 * Returns `{ mode, boat, reason }` where `mode` is one of `'walk' | 'swim' | 'swim_or_escape' |
 * 'boat' | 'refuse'` and `boat` is the convenience boolean `mode === 'boat'`.
 */
export function shouldBoat({
    waterRun = 0,
    landReachable = false,
    exitReachable = true,
    lavaOnRoute = false,
    haveBoat = false,
    canCraft = false,
    minLeg = MIN_BOAT_LEG,
} = {}) {
    // A boat trip that should have been a walk is a real regression, not a neutral choice
    // (CLAUDE.md) — this wins over every water consideration, however long the water is.
    if (landReachable) return { mode: 'walk', boat: false, reason: 'destination reachable on land' };
    // Hard safety refusal: any lava on the route is disqualifying regardless of leg length or
    // boat availability. Water and lava share one physics branch and can read true together at
    // a boundary, and a boat tipping into lava is unrecoverable.
    if (lavaOnRoute) return { mode: 'refuse', boat: false, reason: 'lava on route' };
    // THE load-bearing refusal. A crossing with nowhere to get out on the far side is a pond
    // the bot can enter and cannot leave, whatever its length — never send it in on spec.
    if (!exitReachable)
        return { mode: 'refuse', boat: false, reason: 'no exit on the far shore - would strand the boat' };
    if (waterRun < minLeg)
        return { mode: 'swim', boat: false, reason: `leg is ${waterRun} blocks, under the ${minLeg}-block boat break-even` };
    if (!haveBoat && !canCraft)
        return { mode: 'swim_or_escape', boat: false, reason: 'no boat and nothing to craft one from' };
    return { mode: 'boat', boat: true, reason: `open water run of ${waterRun} blocks, boat available` };
}

// One of the 8 compass directions plus its two 45-degree neighbours, centred on the heading
// (dx, dz). Same "search the forward cone, not just the exact heading" lesson `swim.js`'s
// `bankTargetAhead` learned from a real shoreline where the bank due east was a 2-block step
// and unclimbable, while the SAME shore one block to the south was a 1-block step.
const RING8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
function forwardCone(dx, dz) {
    const sx = Math.sign(dx) || 0, sz = Math.sign(dz) || 0;
    const i = RING8.findIndex(([x, z]) => x === sx && z === sz);
    if (i < 0) return [[sx || 1, sz]];
    return [RING8[i], RING8[(i + 1) % 8], RING8[(i + 7) % 8]];
}

/**
 * Where to dismount — the boat analogue of `climbBank`'s bank-picking.
 *
 * `blockAt(x, y, z)` is an injected reader returning a block NAME string, or a falsy value for
 * unloaded/unknown — the same "fails closed" convention `jumpVerdict`'s `corridorClear` and
 * `bankTargetAhead`'s `clear()` use: an unloaded chunk must never be treated as a safe landing.
 * `boatPos` is `{x, y, z}` (floored internally), `bearing` is `{dx, dz}` — the direction of
 * travel, not necessarily normalised.
 *
 * Searches RISE FIRST, then distance, then straightness — exactly `bankTargetAhead`'s order,
 * for the same reason: prefer the lowest, closest, straightest-ahead landing over a further or
 * higher one that happens to be exactly on the bow.
 */
export function pickDismountPoint(blockAt, boatPos, bearing, opts = {}) {
    const o = { reach: 3, maxRise: 1, ...opts };
    const { dx, dz } = bearing || {};
    if (!dx && !dz) return { dismount: false, reason: 'no bearing to search along' };

    const bx = Math.floor(boatPos.x), by = Math.floor(boatPos.y), bz = Math.floor(boatPos.z);
    let sawLava = false;

    for (let dy = 0; dy <= o.maxRise; dy++) {
        for (let n = 1; n <= o.reach; n++) {
            for (const [ax, az] of forwardCone(dx, dz)) {
                const x = bx + ax * n, y = by + dy, z = bz + az * n;
                const floor = blockAt(x, y - 1, z);
                const cell = blockAt(x, y, z);
                const head = blockAt(x, y + 1, z);
                if (isLavaName(floor) || isLavaName(cell) || isLavaName(head)) { sawLava = true; continue; }
                if (!floor || isWaterName(floor)) continue;            // nothing solid to stand on
                if (isWaterName(cell) || isSwimmable(cell)) continue;  // still wet - not a shore
                if (isWaterName(head)) continue;
                return { dismount: true, x, y, z, reason: `dry cell at (${x},${y},${z}), rise ${dy}` };
            }
        }
    }
    if (sawLava) return { dismount: false, reason: 'lava at the only reachable shore' };
    return { dismount: false, reason: 'no shore in reach' };
}

/**
 * How far the water actually extends along a heading, and whether lava sits anywhere in it.
 *
 * `blockAt(x, y, z)` is the same injected-reader shape as `pickDismountPoint`.
 * `nav.js`'s `scanAhead` caps its look-ahead at 10 blocks (a land-travel horizon) — far too
 * short to tell a 40-block strait from a 400-block ocean, so this is deliberately its own scan
 * rather than a reuse. `y` is the water-surface layer to scan (feet height); `(dx, dz)` is
 * quantised to the nearest of 8 compass directions, like every other block-indexed probe here.
 */
export function openWaterRun(blockAt, x, z, y, dx, dz, maxLook = 96) {
    const sx = Math.sign(dx) || 0, sz = Math.sign(dz) || 0;
    if (!sx && !sz) return { run: 0, lava: false, lavaAt: null, hitLand: true, reason: 'no heading' };

    const x0 = Math.floor(x), z0 = Math.floor(z);
    let run = 0, lava = false, lavaAt = null;
    for (let n = 1; n <= maxLook; n++) {
        const cx = x0 + sx * n, cz = z0 + sz * n;
        const name = blockAt(cx, y, cz);
        if (isLavaName(name)) { lava = true; lavaAt = n; break; }
        // An unloaded/unknown cell ends the CONFIRMED run rather than being counted as water -
        // never overestimate how far a boat trip can go into ground we have not actually seen.
        if (!isWaterName(name) && !isSwimmable(name))
            return { run, lava, lavaAt, hitLand: true, endX: cx, endZ: cz };
        run = n;
    }
    return { run, lava, lavaAt, hitLand: false, endX: x0 + sx * run, endZ: z0 + sz * run };
}

/**
 * Never abandon the boat item. Formats the terminal outcome of a boat trip, and — the point of
 * this function — REFUSES to format one that is silent about where the boat ended up.
 * `container_io.js`'s invariant is the model: an item is either in a chest or in transit, never
 * abandoned; here a boat is either back in the inventory, deliberately left at a known spot
 * (`kept_at`, the shape `MemoryBank` would record), or its loss is a hard, named failure — never
 * a quietly-returned success string.
 *
 * `o.boat` must be one of:
 *   - the literal string `'retrieved'`
 *   - `{ kind: 'kept_at', x, z }` — a deliberate, located choice to leave it behind
 *   - `{ kind: 'lost', reason }` — THROWS, with the reason, because an unaccounted-for boat is
 *     an error condition, not a variant of success
 *
 * Anything else (missing `boat` entirely, a malformed shape) throws a generic complaint —
 * outcome objects must not go silent about the one resource this whole file exists to protect.
 */
export function formatBoatOutcome(o = {}) {
    const b = o.boat;
    if (b === 'retrieved')
        return `VERIFIED BOAT: retrieved${o.summary ? ` - ${o.summary}` : ''}`;
    if (b && typeof b === 'object' && b.kind === 'kept_at' && Number.isFinite(b.x) && Number.isFinite(b.z))
        return `VERIFIED BOAT: left at (${b.x}, ${b.z})${o.summary ? ` - ${o.summary}` : ''}`;
    if (b && typeof b === 'object' && b.kind === 'lost')
        throw new Error(`boat unaccounted for: ${b.reason || 'no reason given'}`);
    throw new Error('boat outcome is silent about the boat - must report retrieved, kept_at, or lost');
}
