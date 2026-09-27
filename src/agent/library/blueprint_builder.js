import { Vec3 } from 'vec3';
import * as mc from '../../utils/mcdata.js';
import * as nav from './nav.js';
import { pillarUp } from './skills.js';
import { isFallingBlockName } from './tools.js';
import * as blockIO from './block_io.js';
import * as buildGuard from './build_guard.js';
import * as flight from './flight.js';
import fs from 'fs';
import { BuildTelemetry } from './build_telemetry.js';

/**
 * Native in-game blueprint builder: the bot flies (creative) to each block position and
 * places the block itself with the correct look angle and click face - no server /setblock.
 *
 * Angle model ("auto angle"): the server derives a placed block's orientation from the
 * placing player's yaw/pitch and the clicked face+cursor, so we invert that mapping:
 *   - stairs/doors/beds/fence gates: blockstate facing == player's look direction
 *   - chests/furnaces/barrels/looms/lecterns: facing == OPPOSITE of look (front toward player)
 *   - wall signs/buttons/wall torches: orientation comes from the clicked face, so the
 *     reference block is the support block behind (P - facingVec) and the face is facingVec
 *   - axis blocks (logs/pillars): axis == normal of the clicked face, so pick the reference
 *     block along the desired axis
 *   - standing signs/banners: rotation quantised from yaw; look opposite the sign's front
 *   - half=top stairs/trapdoors: click the upper half of a side face (cursor option), or the
 *     underside of the block above
 * Look is set explicitly before the place packet, and the placement goes through
 * `block_io.placeVerified` (which snaps the look itself and never turns smoothly), so nothing
 * downstream can overwrite our computed angle.
 */

const FACE = {
    north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0),
    up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0),
};
const SIDE_FACES = ['north', 'south', 'west', 'east'];

// facing == player look direction when placed
const LOOK_ALIGNED = /(_stairs|_door|_bed|fence_gate|campfire|decorated_pot)$/;
// facing == opposite of player look (block front toward player)
const LOOK_OPPOSED = /^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|barrel|loom|lectern|chiseled_bookshelf)$/;
// facing == the player's look rotated a quarter turn CLOCKWISE. Anvils are the only block here that
// does this, and they were in LOOK_OPPOSED, which is 90 degrees wrong rather than 180 - so the one
// anvil in the wizard tower could never have landed right, whatever the aim. Vanilla:
// `AnvilBlock.getStateForPlacement` -> `context.getHorizontalDirection().getClockWise()`.
const LOOK_CLOCKWISE = /^(anvil|chipped_anvil|damaged_anvil)$/;
// support-attached: reference block is behind, orientation from clicked face
const WALL_ATTACHED = /(_wall_sign|_wall_hanging_sign|wall_torch|_wall_banner|_wall_head|_wall_skull|_wall_fan|_button|lever|ladder|tripwire_hook|grindstone)$/;
// `facing` IS the clicked face, on any of the SIX directions - these grow out of whatever surface
// they were clicked onto, ceilings and floors included. They are NOT wall-attached: they carry no
// `face` property and no `hanging`, so the two branches that handle those both miss them. That is
// how 15 amethyst buds the blueprint wants hanging DOWNWARD from a ceiling were placed pointing up
// off the block below: nothing offered the ceiling face, so the generic order clicked the floor.
const FACE_DERIVED_FACING = /(_amethyst_bud|amethyst_cluster|lightning_rod|end_rod)$/;

// Natural ground, for the preflight's "is this lot already built on" probe. Wild vegetation counts
// as natural: a pumpkin is not a building, and treating one as evidence of a build rejected the
// flattest site in a 113-candidate sweep during the cathedral survey.
const NATURAL_SURFACE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol',
    'mycelium', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'red_sand',
    'gravel', 'sandstone', 'red_sandstone', 'clay', 'moss_block', 'mud', 'packed_mud', 'snow_block',
    'snow', 'calcite', 'ice', 'packed_ice', 'terracotta', 'white_terracotta', 'orange_terracotta',
    'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
    'pumpkin', 'melon', 'cactus', 'sugar_cane', 'dead_bush']);

const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass',
    'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'seagrass', 'tall_seagrass', 'water']);
const NATURAL_TERRAIN = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol',
    'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'red_sand', 'gravel',
    'sandstone', 'clay', 'moss_block', 'mud', 'short_grass', 'grass', 'tall_grass', 'fern',
    'large_fern', 'dead_bush', 'snow', 'poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'azure_bluet']);

/**
 * A potted plant is TWO operations, not one - there is no `potted_cherry_sapling` item.
 *
 * Every `potted_*` block is placed by putting down a `flower_pot` and then USING the plant on
 * it; the pot's block state changes and the plant item is consumed. Checked against
 * minecraft-data 1.21.11: all 37 `potted_*` blocks exist, and **not one of them is also an
 * item**, so this is not an edge case - the whole class was unbuildable.
 *
 * The symptom was not a clean "no such item" either. `mc.makeItem('potted_cherry_sapling')`
 * yields something prismarine-item cannot serialise, and the failure surfaced from deep inside
 * the equip as `undefined is not an object (evaluating 'item.components.length')`, which reads
 * like a mineflayer bug rather than a blueprint the builder cannot express.
 *
 * Two names do not survive the mechanical strip - the block says "bush" and the item does not:
 *   potted_azalea_bush           -> azalea
 *   potted_flowering_azalea_bush -> flowering_azalea
 * Every other one is the bare name. Pure and exported so the mapping is checked against real
 * item data in tests rather than trusted.
 *
 * @param {string} blockName e.g. "potted_cherry_sapling"
 * @returns {string|null} the item to use on the pot, or null if this is not a potted block
 */
export function pottedPlantItem(blockName) {
    if (typeof blockName !== 'string' || !blockName.startsWith('potted_')) return null;
    const bare = blockName.slice('potted_'.length);
    if (!bare) return null;
    const RENAMED = { azalea_bush: 'azalea', flowering_azalea_bush: 'flowering_azalea' };
    return RENAMED[bare] ?? bare;
}

function itemNameFor(blockName) {
    // The pot goes down first; pottedPlantItem() supplies what is then used on it.
    if (blockName.startsWith('potted_')) return 'flower_pot';
    // Planted crops are placed from their SEED/fruit item, which is named differently from the
    // block. Same class as the potted plants: 13 of these in survival_base.json, each failing as
    // "no item sweet_berry_bush" because no such item exists.
    if (blockName === 'sweet_berry_bush') return 'sweet_berries';
    return blockName
        .replace(/_wall_hanging_sign$/, '_hanging_sign')
        .replace(/_wall_sign$/, '_sign')
        .replace(/^wall_torch$/, 'torch')
        .replace(/^redstone_wall_torch$/, 'redstone_torch')
        .replace(/^soul_wall_torch$/, 'soul_torch')
        .replace(/_wall_banner$/, '_banner')
        .replace(/_wall_fan$/, '_fan')
        .replace(/_wall_head$/, '_head')
        .replace(/_wall_skull$/, '_skull');
}


/**
 * Put a plant into a flower pot that is already in the world.
 *
 * `activateBlock` is a right-click with the held item, which is exactly how a player does it -
 * there is no place packet that can express "potted cherry sapling" in one go. Verified by
 * reading the block back, like everything else here: the activate can be accepted and still
 * leave an empty pot (wrong item, pot already occupied), and an empty pot passes any check that
 * only asks "is something there".
 *
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function plantIntoPot(bot, P, plantItem, wantName) {
    const already = bot.blockAt(P);
    if (already?.name === wantName) return { ok: true, why: 'already planted' };
    if (!(await equip(bot, plantItem))) return { ok: false, why: `no item ${plantItem}` };
    const pot = bot.blockAt(P);
    if (!pot || pot.name !== 'flower_pot') return { ok: false, why: `no pot at ${P} (${pot?.name})` };
    try {
        await bot.activateBlock(pot);
    } catch (e) {
        // Same rule as placement: the call may throw after the server accepted it, so ask the
        // world below rather than believing the message.
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
        if (bot.blockAt(P)?.name === wantName) return { ok: true, why: 'planted' };
        await new Promise(r => setTimeout(r, 25));
    }
    return { ok: false, why: `pot would not take ${plantItem}` };
}

// Should this placement entry be skipped because a sibling entry places it implicitly?
function isImplicitHalf(p) {
    const props = p.properties || {};
    if (props.part === 'head') return true;          // bed item places both halves
    if (props.half === 'upper') return true;         // door / tall plant upper half
    if (props.type === 'double' && p.name.endsWith('_slab')) return false; // needs 2 placements; place once, flag
    return false;
}

function rotationToFacingVec(rot) {
    const theta = (Number(rot) * 22.5) * Math.PI / 180;
    return new Vec3(-Math.sin(theta), 0, Math.cos(theta)); // rotation 0 = south
}

// The horizontal direction the bot must LOOK so the block lands with the desired facing.
export function lookVecFor(p) {
    const props = p.properties || {};
    if (props.rotation !== undefined) return rotationToFacingVec(props.rotation).scaled(-1);
    const f = props.facing;
    if (!f || !FACE[f] || f === 'up' || f === 'down') return null;
    if (LOOK_ALIGNED.test(p.name)) return FACE[f];
    if (LOOK_OPPOSED.test(p.name)) return FACE[f].scaled(-1);
    // facing = clockwise(look), so look = anticlockwise(facing).
    if (LOOK_CLOCKWISE.test(p.name)) {
        const anti = { north: 'west', west: 'south', south: 'east', east: 'north' }[f];
        return anti ? FACE[anti] : null;
    }
    if (p.name.endsWith('_trapdoor')) return FACE[f].scaled(-1); // floor/ceiling fallback path
    return null;
}

function isPassable(block) {
    return block && (block.boundingBox === 'empty') && block.name !== 'lava';
}
function isSolidRef(block) {
    return block && block.boundingBox === 'block';
}

// GROUND-BASED movement. Client-driven creative flight is dead on this server: measured
// 1,870 forcedMove corrections in one run - the server rejects every flown movement packet
// and pins the player, after which all placements fail from range. Walking is the one
// movement mode with a 1,000-block proven record here (see NAVIGATION_REBUILD.md), so the
// builder walks: to each column via the A* navigator, standing on the structure's own
// lower layers as they rise. Cells out of reach fail into the retry pass and usually
// become reachable as later layers add floor to stand on.
// How far outside the blueprint's own footprint the bot may wander before a leg is treated as
// lost. The navigator's stall ladder ends in `pinned: nothing worked - recentring`, which walks
// somewhere else and tries again - correct for crossing open country, wrong inside a build,
// where every cell it wants is behind it. Measured 2026-08-30 on a footprint spanning x
// 4700-4731: bob reached x=4761 and the placement rate fell from 8.6 to 2.5 blocks/min, because
// every subsequent cell then failed `out of reach (no walkable route)` from sixty blocks away.
const SITE_LEASH = 24;

// How many faces to try before accepting the server's refusal. Three, not all six: each attempt
// costs a placement round trip plus the rate limiter's gap, and the measured wins come from the
// first alternate - a cell no face can fill is usually genuinely unfillable.
const MAX_FACE_TRIES = 3;

// How many times a cell that holds the RIGHT block facing the WRONG way may be dug out and
// re-placed before the builder leaves it alone. The repair is destructive - it removes a block
// that is at least the right kind, and a failed re-place leaves a hole where a merely
// wrongly-oriented block stood - so it must not be unbounded. Two is enough for the case this
// exists for (a legacy placement from before the snapLook fix, which re-places correctly first
// try); a cell that is still wrong after two is wrong for a reason re-placing cannot reach.
const FACING_MAX_REPAIRS = 2;

// How many consecutive flights may reach nothing before the builder moves the bot instead of
// trying another cell. Eight is about twenty seconds of failures - long enough that a genuinely
// hard cell is not rewarded with a pointless trip across the site, short enough that a bot in the
// wrong part of the building is not left there for eight minutes, which is what was measured.
const FLIGHT_RECENTRE = 8;


// How many times the builder may sweep its own failures before accepting them. The measured fixed
// point on the wizard tower is 10 productive passes (pass 11 gains nothing); 14 leaves headroom for
// a blueprint that stacks deeper without letting a genuinely stuck build run all night - and a
// round that places nothing ends the loop long before this, so it only binds on pathological input.
//
// PER PHASE, not in total. Enabling temporary supports starts a second phase with its own fixed
// point, and a shared count let the first phase spend the budget: the cathedral (2026-09-26) reached
// ordinary placement's fixed point at round 10, supports then placed 566, 86, 34, 34 in rounds
// 11-14 - still paying - and the cap ended the build at 99.0% with 340 cells left.
export const MAX_RETRY_ROUNDS = 14;

// Is the bot so far outside the site that the next leg is hopeless? `box` is the blueprint's
// world-space XZ bounds. Pure so the arithmetic is testable without a bot.
/**
 * Somewhere the bot can actually get to, and be useful from once it does.
 *
 * The obvious rally point is the "station" - open sky above the middle of the build - and it is the
 * wrong one. It sits above the WHOLE structure, so reaching it from anywhere inside or beside the
 * tower is a fifty-block vertical climb through the building. Measured 2026-09-23: four recentres,
 * one arrived, three fell 43.9, 48.9 and 51.2 blocks short, and the break-out that followed each
 * one reported `not enclosed` - the bot was never sealed, it just could not fly to a point above
 * the roof.
 *
 * Out to the SIDE is cheap and is where the work is: of the 922 cells left on this tower, 877 are
 * reachable from outside the footprint and only 45 require being inside it. So leave at the
 * altitude you are already at, by the nearest edge.
 *
 * Pure so the arithmetic is testable without a bot.
 */
export function parkSpot(pos, box, margin = 8) {
    // The nearest edge in X or Z, whichever is closer - a shorter hop is a likelier one.
    const dWest = pos.x - box.minX, dEast = box.maxX - pos.x;
    const dNorth = pos.z - box.minZ, dSouth = box.maxZ - pos.z;
    const best = Math.min(dWest, dEast, dNorth, dSouth);
    if (best === dWest)  return { x: box.minX - margin + 0.5, y: pos.y, z: pos.z };
    if (best === dEast)  return { x: box.maxX + margin + 0.5, y: pos.y, z: pos.z };
    if (best === dNorth) return { x: pos.x, y: pos.y, z: box.minZ - margin + 0.5 };
    return { x: pos.x, y: pos.y, z: box.maxZ + margin + 0.5 };
}

export function offSite(pos, box, leash = SITE_LEASH) {
    const dx = Math.max(box.minX - pos.x, 0, pos.x - box.maxX);
    const dz = Math.max(box.minZ - pos.z, 0, pos.z - box.maxZ);
    return Math.hypot(dx, dz) > leash;
}

/**
 * Which way OUT is cheapest - and it is usually not up.
 *
 * An earlier version of this climbed straight up, and climbing is the wrong direction when the
 * work is below. Measured
 * 2026-09-23: three lifts through the tower's floors moved bob from y=67 to y=106, converging on a
 * station at y=139 that sits above the whole building, while every cell of pass 1 sat at y=63. He
 * ended higher, further from his work, with `placed` still 0. From inside a tower the nearest
 * outside is one WALL away, not four floors up.
 *
 * So: consider all five directions the body can leave through, and take the one with the fewest
 * blocks to break. `isOpen(cell)` decides what counts as out - a cell the body fits in that is not
 * boxed in under a roof. Pure over its predicates, like the rest of this file.
 *
 * Returns { dir, dig[], brokeBlueprint } or null when no direction is affordable.
 */
export function planBreakOut({ from, isSolid, isOpen, isBlueprint = () => false,
                               maxDig = 8, maxBlueprint = 4, maxReach = 24 }) {
    const DIRS = [
        { dir: 'east',  dx: 1,  dy: 0, dz: 0 },
        { dir: 'west',  dx: -1, dy: 0, dz: 0 },
        { dir: 'south', dx: 0,  dy: 0, dz: 1 },
        { dir: 'north', dx: 0,  dy: 0, dz: -1 },
        { dir: 'up',    dx: 0,  dy: 1, dz: 0 },
    ];
    let best = null;
    for (const d of DIRS) {
        const dig = [];
        let broke = 0, ok = false;
        // HOW FAR TO LOOK and HOW MUCH TO BREAK are different budgets, and conflating them was a
        // real refusal: at (4603, 92, 4611) the nearest edge was twelve blocks east, the search
        // stopped at eleven, and the break-out reported `no direction reaches open air` for a wall
        // it never looked at. Most of the distance across a building is ROOM, which costs nothing
        // to cross - only the solid cells are dug, and `maxDig`/`maxBlueprint` still bound those.
        for (let step = 1; step <= maxReach; step++) {
            const c = { x: from.x + d.dx * step, y: from.y + d.dy * step, z: from.z + d.dz * step };
            // TWO CELLS TALL, OR THE BODY DOES NOT FIT. A one-high tunnel is a hole the bot can
            // put its feet in and nothing else. Measured 2026-09-23 at (4595, 66, 4598): the
            // break-out took one block north, reported `broke out north, moved 1.8 blocks` - and
            // bob was wedged in the hole, coming back to the same cell every few minutes while
            // the planner correctly answered `not enclosed`, because there WAS a way out and the
            // body could not use it. Horizontal travel needs the cell and the one above it; a
            // vertical exit is a single column and already has its headroom checked by isOpen.
            const column = d.dy ? [c] : [c, { x: c.x, y: c.y + 1, z: c.z }];
            const blocking = column.filter(isSolid);
            if (!blocking.length) {
                // Air is only an EXIT if it is open; air inside the next room along is just the
                // next room, and stopping there is how the climbing version kept landing the body
                // one storey up with nothing solved.
                if (isOpen(c)) { ok = true; break; }
                continue;
            }
            if (dig.length + blocking.length > maxDig) break;
            const cost = blocking.filter(isBlueprint).length;
            if (broke + cost > maxBlueprint) break;
            broke += cost;
            dig.push(...blocking);
        }
        if (!ok) continue;
        // Fewest blocks broken wins; ties go to the one that costs the build least.
        if (!best || dig.length < best.dig.length
            || (dig.length === best.dig.length && broke < best.brokeBlueprint)) {
            best = { dir: d.dir, dig, brokeBlueprint: broke };
        }
    }
    return best;
}

/**
 * How many consecutive rescues may fail before the build stops and says where the bot is.
 *
 * Lost once already: it was defined beside the climbing escape and went out with it, after which
 * every rescue threw `RESCUE_GIVE_UP is not defined` instead of escalating - so a bot that could
 * not be freed looped on the same cell rather than stopping with a reason. `bun -e "await
 * import(...)"` does not catch that; only running the path, or a linter, does.
 */
const RESCUE_GIVE_UP = 5;

/**
 * How much of the BUILD a single break-out may spend. Everything it breaks is queued for
 * re-placement, so the cost is temporary - but a bot that tunnels six blocks through its own
 * tower to get out is telling you the geometry is wrong, not that the budget is too small.
 */
const ESCAPE_MAX_BUILD_BLOCKS = 6;

/** Break straight up out of a sealed pocket. Returns true only if the bot actually got out. */
async function digOut(bot, ctx) {
    const feet = bot.entity.position.floored();
    const at = (c) => bot.blockAt(new Vec3(c.x, c.y, c.z));
    const local = (c) => `${c.x - ctx.origin.x},${c.y - ctx.origin.y},${c.z - ctx.origin.z}`;
    // Where the body currently is, at eye level - breaking out sideways from the FEET cell would
    // aim at the floor course, which is both thicker and more of the build.
    const from = { x: feet.x, y: feet.y, z: feet.z };
    const plan = planBreakOut({
        from,
        isSolid: (c) => isSolidRef(at(c)),
        // OUT means OUTSIDE THE BUILDING, and nothing else will do.
        //
        // Two proxies were tried and both were wrong in the same direction - they called a place
        // inside the tower "out", so the break-out declined and the bot stayed where it was:
        //   - "not under a roof, looking 6 blocks up": any room taller than six reads as sky.
        //     Measured 2026-09-23 at (4592, 66, 4599) - sealed on the ground floor, a recentre
        //     that could not cross thirteen blocks, and `not enclosed`.
        //   - "...looking 32 blocks up": an ATRIUM is open to the sky for its whole height and is
        //     still indoors. Measured minutes later at (4595, 66, 4598), same verdict, same bot,
        //     same wall in the way.
        // The footprint is the building. A cell beyond its XZ bounds, or above its top, is
        // outside it; a cell within them is not, however much air is overhead. That is exact
        // rather than a proxy, and it is what `parkSpot` already aims at.
        isOpen: (c) => flight.hoverIsClear(bot, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 })
                    && (c.x < ctx.box.minX || c.x > ctx.box.maxX
                        || c.z < ctx.box.minZ || c.z > ctx.box.maxZ
                        || c.y > ctx.box.topY),
        isBlueprint: (c) => !!ctx.occupied?.has(local(c)),
        maxBlueprint: ESCAPE_MAX_BUILD_BLOCKS,
        // Look far enough to reach an outside wall from the middle of a 45x35 footprint, but
        // break very little on the way: the interior is mostly air, which costs nothing to cross.
        maxReach: 26,
        maxDig: 10,
    });
    if (!plan) {
        console.log(`[builder] cannot break out at ${feet}: no direction within `
            + `${ESCAPE_MAX_BUILD_BLOCKS} build block(s) reaches open air`);
        return false;
    }
    if (!plan.dig.length) {
        console.log(`[builder] not enclosed at ${feet} - open air is already adjacent, so the problem is not a seal`);
        return false;
    }
    console.log(`[builder] enclosed at ${feet} - breaking ${plan.dig.length} block(s) ${plan.dir}`);
    for (const c of plan.dig) {
        const b = at(c);
        if (!b || b.boundingBox !== 'block') continue;
        if (ctx.occupied?.has(local(c))) {
            // Owed back to the build; the retry rounds re-place it. Without this record a hole in
            // the finished tower would be the price of the escape, and nothing would know.
            (ctx.brokenForEscape ||= []).push(
                { x: c.x - ctx.origin.x, y: c.y - ctx.origin.y, z: c.z - ctx.origin.z, name: b.name });
            console.log(`[builder] break-out takes one build block: ${b.name} at (${c.x}, ${c.y}, ${c.z}) - queued for re-placement`);
        }
        try { await bot.dig(b, true); } catch (e) { return false; }
    }
    // Confirm by MOVING, not by having dug: a hole the body cannot pass through is not an exit.
    const exit = plan.dig[plan.dig.length - 1];
    const step = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1], up: [0, 0] }[plan.dir];
    const target = { x: exit.x + step[0] + 0.5, y: plan.dir === 'up' ? exit.y + 1 : exit.y, z: exit.z + step[1] + 0.5 };
    const before = bot.entity.position.clone();
    await flight.flyTo(bot, target, { timeoutMs: 5000, maxRange: 32 });
    const moved = bot.entity.position.distanceTo(before);
    if (moved <= 1.0) { console.log(`[builder] break-out FAILED: body moved only ${moved.toFixed(1)}`); return false; }
    console.log(`[builder] broke out ${plan.dir}, moved ${moved.toFixed(1)} blocks`);
    ctx.lastRescueShort = null;   // a new position deserves a fresh wedge baseline
    return true;
}

async function goNear(bot, P, reach = 3.0, ctx = null, faceVec = null) {
    const eyeDist = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(P.offset(0.5, 0.5, 0.5));
    if (eyeDist() <= reach + 1.2) return true;
    // FLY FIRST when we can. It costs nothing, changes no terrain, and reaches the work
    // directly - where the walking path has to pillar a dirt column and dig it back out, which
    // is where the original run lost 3,138 of 3,648 blocks. Re-measured 2026-08-31: 0 forcedMove
    // corrections and 4/4 placements from the air (tools/fly_probe.mjs), against the stale note
    // that said flight was rejected outright. The walking path below stays as the fallback, and
    // is the ONLY path in survival.
    // Remember where we were: whether the bot MOVED during a failed flight is the difference
    // between two situations that look identical in the log.
    const beforeFlight = bot.entity.position.clone();
    if (ctx?.flying && await flight.flyNear(bot, P, reach, { faceVec })) return true;
    const flewAtAll = bot.entity.position.distanceTo(beforeFlight);
    // Reel the bot back to the site BEFORE asking for another leg. Without this the recentring
    // walks compound: each failed leg leaves it further out, and it never returns on its own.
    if (ctx?.box && offSite(bot.entity.position, ctx.box)) {
        ctx.leashed = (ctx.leashed || 0) + 1;
        console.log(`[builder] leash: ${bot.entity.position.floored()} is outside the site - walking back`);
        await nav.navigateTo(bot, { x: ctx.box.centreX, y: P.y, z: ctx.box.centreZ },
            { arriveDist: 4, arriveY: 6, maxReplans: 4 });
    }
    // DO NOT WALK WHEN FLIGHT HAS ALREADY FAILED - unless flight could not move us AT ALL.
    //
    // Normally, if flight (which searches a 7x5x7 neighbourhood) cannot put the eye in range,
    // the ground navigator cannot help either; it just spends a leg timeout recentring inside a
    // room it is already in. Measured at ten minutes for four blocks, and the single biggest
    // cost in the run. So a free-but-unreachable cell fails fast and the retry pass gets it.
    //
    // But flight removes gravity, NOT collision. A bot WEDGED in the structure cannot fly out
    // either - every leg collision-resolves straight back, which reads as `flew short by 12.2,
    // eye 12.5` over and over while the bot sits at one position to twelve decimal places. That
    // is what a person watching sees as "he's stuck again", and skipping the walk here removed
    // the only escape there is: the stall ladder's dig, and `build_guard`'s relent valve, live
    // on the walking path. Zero movement is therefore the one case that MUST still walk.
    if (ctx?.flying && flewAtAll > 0.5) {
        // MOVING IS NOT THE SAME AS BEING IN THE RIGHT PLACE. The wedge branch below only fires
        // when the body cannot move AT ALL, so a bot that is merely in the wrong PART of the
        // building - free to drift a couple of blocks, but with no route to any of its work -
        // never got recentred. Measured 2026-09-23, three times: bob at y=104 with every target
        // at y=63, `flew short by 53.8 ... wedged, rose 1.9 ... no route (sealed or out of
        // range)` on cell after cell, and `placed` stuck at 0 for eight minutes each time.
        //
        // Nothing about the world changes while it fails the same way, so the cure is the one
        // this repo already states for retries: after a run of failures, stop repeating and
        // change the INPUT - here, the bot's own position. The station is open air above the
        // footprint, which is the one place reliably connected to everywhere else.
        ctx.dryFlights = (ctx.dryFlights || 0) + 1;
        if (ctx.dryFlights >= FLIGHT_RECENTRE && ctx.box?.topY && !bot.interrupt_code) {
            ctx.dryFlights = 0;
            const before = bot.entity.position.clone();
            await flight.freeSelf(bot);
            const park = parkSpot(bot.entity.position, ctx.box);
            const short = await flight.flyTo(bot, park, { timeoutMs: 6000, maxRange: 128 });
            ctx.recentres = (ctx.recentres || 0) + 1;
            console.log(`[builder] ${FLIGHT_RECENTRE} flights in a row reached nothing from `
                + `${before.floored()} - moved out to (${park.x.toFixed(0)}, ${park.y.toFixed(0)}, ${park.z.toFixed(0)}) `
                + `(${short < 5 ? 'arrived' : `${short.toFixed(1)} short`})`);
            // FLYING OUT OF A SEALED VOLUME IS NOT POSSIBLE - only digging is. Measured
            // 2026-09-23: the first recentre this mechanism ever performed reported `71.0 short`
            // from (4593, 66, 4599), inside the ground floor, whose interior the reachability
            // analysis puts at 2% connected to open air. A recentre that cannot route is not a
            // failure to try harder, it is evidence of a seal - so escalate to the one tool that
            // answers it rather than repeating the flight.
            if (short > 10) await digOut(bot, ctx);
        }
        return false;
    }
    ctx && (ctx.dryFlights = 0);
    // WEDGED: the flight could not move the body at all. Do not simply give up and leave the bot
    // where it is - that is how wedged states ACCUMULATE, because the next cell starts from
    // inside the same wall and fails the same way. Measured twice tonight: bob motionless to
    // twelve decimal places at y=75 and again at y=85, both times inside its own structure, with
    // the walking ladder logging `pinned ... recentring` hundreds of times and `digAhead: build`
    // refusing (correctly) to demolish the build to free it.
    // Flying to open sky above the footprint always works, because the one thing reliably clear
    // around an unfinished building is the air above it - and it resets the bot to a position
    // every later cell can be reached from.
    if (ctx?.flying && ctx.box?.topY) {
        // AN INTERRUPT IS A STOP, NOT A REASON TO RESCUE. Every flight primitive returns instantly
        // while `bot.interrupt_code` is set, so rescuing under an interrupt logs an identical
        // failure and hands straight back to a caller that tries the next cell - measured
        // 2026-09-22 as `wedged - returned to station above the build (74.8 short)` eight times a
        // second, with an unchanging shortfall. The event loop starves and the server drops the
        // client (CLAUDE.md: "await is not a yield"). The build must end, not spin.
        if (bot.interrupt_code) return false;
        // Get the body free BEFORE asking for a long leg: a direct flight out of a pocket is
        // blocked by the same wall that wedged us, so the station hop would fail too.
        await flight.freeSelf(bot);
        // NOT `noDetour`. This is the one call in the builder that most needs a route - the bot is
        // inside a structure it has been sealing all run - and `noDetour: true` makes flyTo return
        // the straight-line result without ever climbing OR planning. It was the last caller still
        // opting out of routing after routing became the default, which is why the rescue kept
        // reporting the same shortfall: 74.8 short, eight times a second, having flown nothing.
        // maxRange covers a station hop from a far corner of a 45x70x35 footprint.
        const beforeRescue = bot.entity.position.clone();
        // OUT TO THE SIDE, NOT UP. This used to aim at open sky above the middle of the build,
        // which is above the WHOLE structure - a fifty-block climb through the building from
        // anywhere inside it. Measured 2026-09-23 over four attempts: one arrived, three fell
        // 43.9, 48.9 and 51.2 short. `parkSpot` leaves by the nearest edge at the altitude the
        // bot is already at, which is a ~12-block hop, and lands it where 877 of the 922
        // remaining cells are reachable rather than where none of them are.
        const park = parkSpot(bot.entity.position, ctx.box);
        let rescued = await flight.flyTo(bot, park, { timeoutMs: 5000, maxRange: 128 });
        // Still inside: take the NEAREST way out instead (see planEscape). Once out, the distance
        // that counts is to open ground, so it is measured against where the escape ended.
        if (rescued >= 5 && !bot.interrupt_code) {
            const way = flight.planEscape(bot, ctx.box);
            if (way) {
                const left = await flight.flyRoute(bot, way, { timeoutMs: 3000 });
                if (left < 2) { rescued = 0; console.log(`[builder] wedged - took the nearest way out (${way.length} legs)`); }
            } else {
                console.log('[builder] wedged - no way out found within the escape search');
            }
        }
        ctx.rescues = (ctx.rescues || 0) + 1;
        // REPORT WHAT HAPPENED, NOT WHAT WAS ATTEMPTED. This line used to read `returned to
        // station above the build (84.3 short)` whether the bot had moved or not - a verb
        // claiming success beside a number reporting failure, which is how a bot sealed in a
        // rock pocket stayed there for fifty minutes with the builder logging progress.
        const moved = bot.entity.position.distanceTo(beforeRescue);
        // MEASURE PROGRESS TOWARD THE STATION, NOT MOVEMENT. The first version of this check
        // tested `moved > 1.0` and called that a successful rescue - which is the same mistake in
        // a new place: a bot oscillating inside its own structure MOVES. Measured live at
        // 2026-09-22 17:21-17:25, four consecutive rescues logged `flew 2.0 / 1.6 / 1.2 / 1.6 back
        // toward the station` while the shortfall sat at 30.1, 32.1, 32.2, 32.1 - never shrinking,
        // the counter reset every time, and the escalation that exists for exactly this case could
        // not fire. The bot wiggled in place for four minutes and the log called it four rescues.
        const prevShort = ctx.lastRescueShort ?? Infinity;
        ctx.lastRescueShort = rescued;
        const closer = rescued < 5 || rescued < prevShort - 1.0;
        if (closer) {
            ctx.rescuesFailed = 0;
            // ARRIVING ENDS THE EPISODE. `lastRescueShort` is a baseline for "is this wedge
            // getting better", and it is only meaningful WITHIN one episode. Left set after a
            // successful return to the station it becomes ~0, against which every later wedge -
            // however much ground it recovers - compares as no progress. Clearing it means the
            // next episode's first attempt is judged on its own terms, which is the only honest
            // thing to do when there is no baseline yet.
            if (rescued < 5) ctx.lastRescueShort = null;
            console.log(`[builder] wedged - flew ${moved.toFixed(1)}, now ${rescued.toFixed(1)} from open ground (was ${prevShort === Infinity ? 'n/a' : prevShort.toFixed(1)})`);
            return false;
        }
        ctx.rescuesFailed = (ctx.rescuesFailed || 0) + 1;
        console.log(`[builder] wedged - RESCUE MADE NO PROGRESS (body moved ${moved.toFixed(2)}, still ${rescued.toFixed(1)} from open ground, was ${prevShort === Infinity ? 'n/a' : prevShort.toFixed(1)}) - failure ${ctx.rescuesFailed}`);
        // Flight removes gravity, not collision, so a bot in a sealed pocket cannot fly out of it
        // however many times it is asked. Breaking upward is the only escape, and it is tried once
        // the second rescue confirms this is not a one-off collision.
        if (ctx.rescuesFailed >= 2 && await digOut(bot, ctx)) { ctx.rescuesFailed = 0; ctx.lastRescueShort = null; return false; }
        // Nothing worked. Do not let the build grind on against a bot that cannot move: say where
        // it is, and stop. Same rule as the progress watchdog - the (n+1)th identical attempt
        // cannot learn what the last n did not.
        if (ctx.rescuesFailed >= RESCUE_GIVE_UP && !ctx.stuck) {
            const at = bot.entity.position.floored();
            ctx.stuck = `bot cannot move: stuck at (${at.x}, ${at.y}, ${at.z}), ${ctx.rescuesFailed} rescues moved it ${moved.toFixed(2)} blocks and breaking out failed`;
        }
        return false;
    }
    await nav.navigateTo(bot, { x: P.x, y: P.y, z: P.z },
        { arriveDist: reach, arriveY: 3, maxReplans: 3 });
    return eyeDist() <= 4.6;
}

// ---- scaffolding: vertical access for work above walking reach ----
// The navigator only paths over existing blocks, so anything above ~2 blocks is
// unreachable until something exists to stand on (measured: 3,138 of 3,648 blocks failed
// exactly this way). Classic player solution: pillar-jump a dirt column next to the work,
// build what is in reach, then dig back down through the pillar before moving on - so the
// scaffold never outlives its use.
async function pillarDown(bot, ctx) {
    while (ctx.pillar.length) {
        const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!under || under.name !== 'dirt') { ctx.pillar.length = 0; break; }
        try { await bot.dig(under, true); } catch (e) { ctx.pillar.length = 0; break; }
        await new Promise(r => setTimeout(r, 350)); // fall into the gap
        ctx.pillar.pop();
    }
}

/**
 * Keep the pillar supplied. In CREATIVE the stock is one-way: `pillarUp` spends dirt, `pillarDown`
 * digs it back, and a creative dig yields NO drops - so every pillar permanently consumes blocks
 * and the 64 stocked at build start are gone after enough of them. Measured 2026-09-22 mid-build:
 * `clear bob dirt 0` -> "No items were found", while scaffolding (never wired into the pillar) was
 * still at 64, and the bot sat in a jump/pillar refusal loop logging
 * `tower: REFUSED (nothing stackable to pillar with)` at two cells per five minutes.
 *
 * Stocking once at startup was right when a build was short. Top up instead, and only when low, so
 * this costs one inventory read per scaffold attempt rather than a write.
 */
async function restockPillar(bot) {
    const have = bot.inventory.items().filter(it => it.name === 'dirt')
        .reduce((n, it) => n + it.count, 0);
    if (have >= 8) return have;
    try {
        await bot.creative.setInventorySlot(44, mc.makeItem('dirt', 64));
        console.log(`[builder] restocked pillar dirt (had ${have})`);
        return 64;
    } catch (e) {
        console.log(`[builder] could not restock dirt: ${e.message}`);
        return have;
    }
}

async function scaffoldTo(bot, P, ctx) {
    await restockPillar(bot);
    // heartbeat before the slow part: one scaffold (nav + pillar) can take minutes, and a
    // silent stretch that long reads as "dead" to the watchdog
    if (ctx.agent) writeStatus(ctx.agent, { phase: 'scaffold', target: `${P.x},${P.y},${P.z}` });
    // choose a support column adjacent to P that the blueprint never occupies
    const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dz] of candidates) {
        const cx = P.x + dx, cz = P.z + dz;
        // must be blueprint-free all the way up, and open in the world
        let clash = false;
        for (let y = P.y - 12; y <= P.y + 1; y++) {
            if (ctx.occupied.has(`${cx - ctx.origin.x},${y - ctx.origin.y},${cz - ctx.origin.z}`)) { clash = true; break; }
        }
        if (clash) continue;
        // find ground in this column
        let groundTop = null;
        for (let y = P.y; y > P.y - 16; y--) {
            const b = bot.blockAt(new Vec3(cx, y, cz));
            if (b && b.boundingBox === 'block') { groundTop = y; break; }
        }
        if (groundTop === null) continue;
        // arriveDist was 0.6 with 2 replans: navigating to an EXACT cell beside a wall
        // through bumpy terrain failed so often that scaffolding - and with it every
        // block above walking reach - silently starved. Loosen, then verify by position.
        await nav.navigateTo(bot, { x: cx, y: groundTop + 1, z: cz }, { arriveDist: 1.3, arriveY: 3, maxReplans: 4 });
        const feet = bot.entity.position;
        if (Math.hypot(feet.x - (cx + 0.5), feet.z - (cz + 0.5)) > 1.8) continue;
        const targetFeet = P.y - 1;
        const need = targetFeet - Math.floor(bot.entity.position.y);
        if (need <= 0) { ctx.scaffoldOk = (ctx.scaffoldOk || 0) + 1; return true; }
        const before = Math.floor(bot.entity.position.y);
        const gained = await pillarUp(bot, need);
        for (let i = 0; i < Math.round(gained); i++) ctx.pillar.push({ x: feet.floored().x, y: before + i, z: feet.floored().z });
        const ok = bot.entity.position.y >= targetFeet - 0.6;
        if (ok) ctx.scaffoldOk = (ctx.scaffoldOk || 0) + 1;
        else ctx.scaffoldShort = (ctx.scaffoldShort || 0) + 1;
        return ok;
    }
    ctx.scaffoldNoCol = (ctx.scaffoldNoCol || 0) + 1;
    return false;
}

// Placement fails server-side if the bot's body occupies OR nearly touches the destination
// cell (skills.placeBlock's 1.1-block rule, learned the hard way) - step aside.
/** Does the 0.6x1.8 body at `pos` overlap the unit cell P? What the server's placement check asks. */
export function bodyOverlapsCell(pos, P) {
    return pos.x + 0.3 > P.x && pos.x - 0.3 < P.x + 1
        && pos.y + 1.8 > P.y && pos.y < P.y + 1
        && pos.z + 0.3 > P.z && pos.z - 0.3 < P.z + 1;
}

async function stepOff(bot, P) {
    const feet = bot.entity.position.floored();
    const center = P.offset(0.5, 0.5, 0.5);
    const tooClose = bot.entity.position.distanceTo(center) < 1.1
        || bot.entity.position.offset(0, 1, 0).distanceTo(center) < 1.1;
    const overlaps = bodyOverlapsCell(bot.entity.position, P);
    if (!feet.equals(P) && !feet.offset(0, 1, 0).equals(P) && !tooClose && !overlaps) return;
    // FLYING WITH NOTHING TO STAND ON: the walking search below needs solid ground under the
    // spot, and in the air there is none - so it returned having moved nothing, and the next
    // placement went into the bot's own body. Measured 2026-09-27 on the cathedral's spire-top
    // bars: support chains climbing a column failed at link 2 or 3 with `refused by server`,
    // 13 of 13, the bot hovering in the column it was filling. Fly two blocks sideways instead.
    if (flight.canFly(bot) && bot.entity.onGround === false) {
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]) {
            const spot = { x: P.x + dx + 0.5, y: Math.floor(bot.entity.position.y), z: P.z + dz + 0.5 };
            if (!flight.hoverIsClear(bot, spot)) continue;
            await flight.flyTo(bot, spot, { timeoutMs: 1500, noDetour: true });
            if (!bodyOverlapsCell(bot.entity.position, P)) return;
        }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const t = feet.offset(dx, 0, dz);
        const b = bot.blockAt(t), head = bot.blockAt(t.offset(0, 1, 0)), below = bot.blockAt(t.offset(0, -1, 0));
        if (b?.boundingBox === 'empty' && head?.boundingBox === 'empty' && below?.boundingBox === 'block') {
            await nav.navigateTo(bot, { x: t.x, y: t.y, z: t.z }, { arriveDist: 0.5, maxReplans: 1 });
            return;
        }
    }
}

// Chunks stream in slower than creative flight moves, so a blockAt right after arriving
// reads null. Poll instead of failing - null here means "not received yet", not "no block".
async function waitForBlock(bot, P, ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        const b = bot.blockAt(P);
        if (b) return b;
        await new Promise(r => setTimeout(r, 250));
    }
    return null;
}

// Rotates when a slot's busy-flag leaks: mineflayer's setInventorySlot can permanently
// brick a slot for the life of the process after an overlapping/cancelled write (see
// CLAUDE.md creative notes - it once bricked all 37 slots). Observed live as a mid-run
// cliff: ~80% success until one interrupted equip, then every "no item X" after.
// Slots 36-43 rotate; 44 is reserved for scaffold dirt.
// Slots we may stage a build material in. The hotbar first (36-43) because that is where a
// write is cheapest to observe, then the main inventory (10-35) - which is fair game because
// `equip` follows every write with `bot.equip(item, 'hand')`, so the staging slot never has to
// be a hotbar slot. 26 extra slots is the difference between a bricked hotbar ending the run
// and it costing eight retries. Reserved and excluded: 9 (scaffolding), 44 (scaffold dirt).
const SLOT_POOL = [
    36, 37, 38, 39, 40, 41, 42, 43,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
];
let slotIndex = 0;
let equipSlot = SLOT_POOL[0];
// Slots whose writes have stopped landing. mineflayer leaks a per-slot busy flag on an
// overlapped or cancelled `setInventorySlot`, and a bricked slot NEVER recovers for the life of
// the process - so rotating back onto one is guaranteed to fail again. Measured 2026-08-31 as
// the documented mid-run cliff: `no item stripped_dark_oak_wood` went 12 -> 59 between two
// checkpoints, cycling through slots 37, 38, 40, 41, 42, 43 and failing on every one.
const deadSlots = new Set();
// Serialise every creative slot write. Two overlapping writes are exactly what bricks a slot,
// and `equip` is now reached from three places (placeOne, plantIntoPot, restoreBroken).
let writeChain = Promise.resolve();
function serialise(fn) {
    const next = writeChain.then(fn, fn);
    writeChain = next.then(() => {}, () => {});
    return next;
}
function nextSlot() {
    for (let i = 0; i < SLOT_POOL.length; i++) {
        slotIndex = (slotIndex + 1) % SLOT_POOL.length;
        equipSlot = SLOT_POOL[slotIndex];
        if (!deadSlots.has(equipSlot)) return equipSlot;
    }
    return null;   // every staging slot is bricked
}

async function equip(bot, itemName) {
    if (bot.heldItem?.name === itemName) return true;
    let item = bot.inventory.findInventoryItem(itemName);
    for (let attempt = 0; attempt < 4 && !item; attempt++) {
        if (deadSlots.has(equipSlot) && nextSlot() === null) {
            console.log(`[builder] equip: all ${SLOT_POOL.length} staging slots are bricked - cannot equip anything`);
            return false;
        }
        const slot = equipSlot;
        try {
            await serialise(() => bot.creative.setInventorySlot(slot, mc.makeItem(itemName, 1)));
        } catch (e) {
            if (/cancelled|again/i.test(e.message)) {
                await new Promise(r => setTimeout(r, 400));
                if (attempt >= 1) { deadSlots.add(slot); nextSlot(); }
                continue;
            }
            console.log(`[builder] equip ${itemName} failed: ${e.message}`);
            return false;
        }
        // POLL, do not sample once. The write is acknowledged before the inventory copy is
        // updated, so an immediate read reports "never appeared" for an item that arrives a tick
        // later - the same mistake the placement path made with the block_place ack.
        const deadline = Date.now() + 400;
        while (Date.now() < deadline && !item) {
            item = bot.inventory.findInventoryItem(itemName);
            if (item) break;
            await new Promise(r => setTimeout(r, 20));
        }
        // A slot that accepted a write and produced nothing is bricked, whatever it claimed.
        if (!item) { deadSlots.add(slot); nextSlot(); }
    }
    if (!item) { console.log(`[builder] equip ${itemName}: item never appeared (${deadSlots.size} slot(s) now dead)`); return false; }
    try {
        // real equip so the SERVER's held-item state is synced - a raw hotbar write can
        // leave the server seeing an empty hand
        await bot.equip(item, 'hand');
        return true;
    } catch (e) {
        console.log(`[builder] equip ${itemName} failed: ${e.message}`);
        return false;
    }
}

// Choose (referenceBlock, faceVector, faceName, halfOpt) for a placement.
/**
 * Every face we could click to fill this cell, best first.
 *
 * This used to return only the best one, and `placeOne` gave up if the server refused it. That
 * throws away the thing a player does without thinking: if the block will not go on from here,
 * try another side. It matters because "refused by server" is now the DOMINANT failure in a
 * blueprint run, and at least one whole class of it is a wrong face rather than an impossible
 * placement - measured 2026-08-30 with `tools/place_probe.mjs --support spruce_trapdoor[half=top]`:
 * a flower_pot clicked onto the trapdoor's face is refused 3/3 (acked in 19-57ms, so the server
 * definitely decided), while the same pot on stone plants 3/3. The blueprint stands three of its
 * pots on exactly that trapdoor.
 *
 * Order is unchanged - the first candidate is what the old function returned - so a placement
 * that worked before still goes on the same way, first try.
 */
export function chooseFaces(bot, P, p) {
    const props = p.properties || {};
    const out = [];
    const add = (c) => { if (c && !out.some(o => o.faceName === c.faceName)) out.push(c); };

    if (WALL_ATTACHED.test(p.name) && props.face !== 'floor' && props.face !== 'ceiling') {
        const f = props.facing;
        if (f && FACE[f]) {
            const ref = bot.blockAt(P.minus(FACE[f]));
            if (isSolidRef(ref)) add({ ref, faceVec: FACE[f], faceName: f, half: null });
        }
    }
    if (props.face === 'floor') {
        const ref = bot.blockAt(P.offset(0, -1, 0));
        if (isSolidRef(ref)) add({ ref, faceVec: FACE.up, faceName: 'up', half: null });
    }
    if (props.face === 'ceiling' || props.hanging === 'true') {
        const ref = bot.blockAt(P.offset(0, 1, 0));
        if (isSolidRef(ref)) add({ ref, faceVec: FACE.down, faceName: 'down', half: null });
    }

    // trapdoors: prefer side-attach to the support behind (deterministic facing)
    if (p.name.endsWith('_trapdoor') && props.facing) {
        const ref = bot.blockAt(P.minus(FACE[props.facing]));
        if (isSolidRef(ref)) {
            add({ ref, faceVec: FACE[props.facing], faceName: props.facing,
                  half: props.half === 'top' ? 'top' : 'bottom' });
        }
    }

    // `facing` == the clicked face, in any of six directions (amethyst buds, lightning rods).
    if (FACE_DERIVED_FACING.test(p.name) && props.facing && FACE[props.facing]) {
        const fv = FACE[props.facing];
        const ref = bot.blockAt(P.minus(fv));
        if (isSolidRef(ref)) add({ ref, faceVec: fv, faceName: props.facing, half: null });
    }

    // axis blocks: clicked-face normal defines the axis
    if (props.axis) {
        const axisFaces = { x: ['east', 'west'], y: ['up', 'down'], z: ['south', 'north'] }[props.axis] || [];
        for (const fname of axisFaces) {
            const ref = bot.blockAt(P.minus(FACE[fname]));
            if (isSolidRef(ref)) add({ ref, faceVec: FACE[fname], faceName: fname, half: null });
        }
    }

    const wantTop = props.half === 'top' || props.type === 'top';
    const order = wantTop
        ? ['down', ...SIDE_FACES, 'up']   // 'down' face of block above -> half=top
        : ['up', ...SIDE_FACES, 'down'];
    for (const fname of order) {
        const ref = bot.blockAt(P.minus(FACE[fname]));
        if (isSolidRef(ref)) {
            let half = null;
            if (SIDE_FACES.includes(fname) && (props.half || props.type === 'top' || props.type === 'bottom'))
                half = wantTop ? 'top' : 'bottom';
            add({ ref, faceVec: FACE[fname], faceName: fname, half });
        }
    }

    // ---- A FACE THAT DETERMINES THE ORIENTATION IS NOT INTERCHANGEABLE ----
    //
    // Everything above this point treats the face list as "ways to get the block in", best first,
    // and `placeOneCore` walks it on a refusal. For most blocks that is right. For a block whose
    // blockstate is read OFF the clicked face it is wrong: a second candidate is not another way to
    // satisfy the blueprint, it is a way to place the wrong thing. Measured on the 2026-09-23
    // wizard tower, of 339 wrong-facing cells, 66 were exactly this - 45 logs and chains lying on
    // the wrong axis, 21 buds and rods pointing the wrong way - and every one of them had been
    // placed from a face that could never have produced the wanted state.
    //
    // So filter, and be willing to return NOTHING. An empty list is not a dead end here: it fails
    // the cell into the retry pass with `no solid neighbor`, which is the honest description, and
    // later layers routinely supply the missing neighbour. A wrong-axis log placed today, by
    // contrast, used to be permanent - the name matched, so every later pass skipped it.
    const faceAxis = { up: 'y', down: 'y', north: 'z', south: 'z', east: 'x', west: 'x' };
    if (props.axis) return out.filter(c => faceAxis[c.faceName] === props.axis);
    if (props.facing && FACE[props.facing]
        && (FACE_DERIVED_FACING.test(p.name)
            || (WALL_ATTACHED.test(p.name) && props.face !== 'floor' && props.face !== 'ceiling')))
        return out.filter(c => c.faceName === props.facing);

    return out;
}


/**
 * Put back a block we removed for a placement that then failed.
 *
 * Best effort and deliberately quiet: this is the SECOND line of defence, behind checking
 * feasibility before digging at all. It exists because the server can still refuse a placement
 * we had every reason to expect to work, and an open cell at foundation depth beside water is
 * how one refused placement turned into a flooded build.
 */
async function restoreBroken(bot, P, broke, choice) {
    if (!broke || !choice) return;
    const now = bot.blockAt(P);
    if (now && now.name !== 'air' && now.name !== 'cave_air') return;   // something is there already
    try {
        if (!(await equip(bot, itemNameFor(broke)))) return;
        const r = await blockIO.placeVerified(bot, choice.ref, choice.faceVec, { expectName: broke });
        console.log(`[builder] restored ${broke} at (${P.x}, ${P.y}, ${P.z}): ${r.ok ? 'ok' : r.why}`);
    } catch (e) { /* the hole stands; the feasibility check is what must stop this happening */ }
}

// ---------------------------------------------------------------------------
// Temporary supports: how a floating cell gets something to click against
// ---------------------------------------------------------------------------
//
// THE MEASURED PROBLEM. The wizard tower stopped three times at the same wall. Final run:
// 1,887 of 1,969 failures (96%) were `no solid neighbor (self=air below=air/empty ...)`, and the
// watchdog stopped the build at 46% verified (3,815/8,285). 31% of the cells in layers 6-14 have
// no blueprint cell below them - spires, arches, an overhanging roof - so no ordering of the
// blueprint can ever give them a face to click. `orderForBuild` cut the cells that START a region
// with nothing beside or below to under 3%, which is as far as ordering alone can go; what is
// left is geometry that is genuinely unsupported until the temporary block a human would place,
// use, and knock away again exists.
//
// WHY DIRT AND NOT SCAFFOLDING. Scaffolding is the obvious material and it does not work on this
// server: measured `tower 1/6` (tools/scaffold_probe.mjs) - one block places on any solid
// support, stacking a second on top is REFUSED, acked in 16-59ms so it is a decision and not a
// timeout, identically through our packet path and mineflayer's. Dirt stacks, `scaffoldTo`
// already proves it every run, and in creative it costs nothing now that `restockPillar` tops it
// up. So dirt.
//
// WHAT MUST NOT HAPPEN. A support placed in a cell the blueprint wants would be dug out again
// and read as a hole; a support left standing is an unwanted block in a finished build; and a
// block that only stands UP because of its support (a torch, a sign, a lantern, sand) falls the
// moment the support goes, which would place it, verify it, and destroy it every pass forever.
// The first two are prevented by construction (`isFree` excludes `ctx.occupied`, and every
// placed support is torn down on the same code path that built it, successful or not). The third
// cannot be prevented by a name list alone, so it is MEASURED: the block is re-read after the
// support is removed, and a name that does not survive is recorded in `ctx.supportUnsafe` and
// never supported again this run.

const SUPPORT_ITEM = 'dirt';
// How far a support chain may reach for something solid. Each cell costs a flight leg, a
// placement and a dig, so this is a budget and not a capability limit: at 4 the chain can bridge
// a gap that a cell has to an existing structure in any direction, which covers the overhangs and
// spire tips this blueprint actually has. A cell further than this from anything solid is better
// served by the next pass, once its neighbours exist.
const SUPPORT_MAX_LEN = 4;

// Blocks that would not survive losing the support they were placed against. Not a substring
// match on a material (see `isFallingBlockName` for why that class of shortcut is banned here) -
// each alternative is a whole suffix or a whole name.
const SUPPORT_UNSAFE = /(^|_)(torch|lantern|sign|banner|ladder|lever|button|rail|carpet|bed|door|vine|head|skull|painting|fan|tripwire|chain|candle|snow|pot|plate|sapling|amethyst_cluster|bud)$/;

/** Would this block stand on its own once its temporary support is gone? */
export function supportIsSafe(name) {
    return !SUPPORT_UNSAFE.test(name) && !isFallingBlockName(name);
}

/**
 * A chain of temporary blocks from something already solid to a cell with nothing to click.
 *
 * Pure over two predicates so the interesting cases are assertions rather than a live build:
 * `isFree(cell)` - may we put a temporary block here (empty, and NOT a cell the blueprint wants);
 * `isSolid(cell)` - is there something here to place the first link against.
 *
 * Returns the chain ANCHOR FIRST, so placing it in order means every link has the previous one to
 * click against, and the last link is adjacent to the target. Returns null when nothing solid is
 * within `maxLen` - the honest answer, and the one that sends the cell to the retry pass.
 */
/**
 * Where a support may END for this block: the neighbour cells `chooseFaces` would let it be
 * clicked from, as offsets from the cell. null = any side.
 *
 * Without this the chain ended wherever was nearest - below, first - and for a block whose clicked
 * face decides its orientation that support was useless: chooseFaces filters it out and the retry
 * fails `no solid neighbor` exactly as before. Measured on the cathedral 2026-09-26: 412 supports
 * built, 3 placements rescued, with 143 of the 178 missing oak logs axis=z roof beams whose only
 * useful support is at a z end.
 */
export function supportDirs(p) {
    const props = p.properties || {};
    if (props.axis) return { x: [[1, 0, 0], [-1, 0, 0]], y: [[0, -1, 0], [0, 1, 0]], z: [[0, 0, 1], [0, 0, -1]] }[props.axis] || null;
    if (props.facing && FACE[props.facing]
        && (FACE_DERIVED_FACING.test(p.name)
            || (WALL_ATTACHED.test(p.name) && props.face !== 'floor' && props.face !== 'ceiling'))) {
        const f = FACE[props.facing];
        return [[-f.x, -f.y, -f.z]];   // the block clicked is at P - FACE[facing]
    }
    return null;
}

export function planSupportChain(target, { isFree, isSolid, maxLen = SUPPORT_MAX_LEN, ends = null }) {
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const STEPS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const tKey = key(target);
    const seen = new Set([tKey]);
    const parent = new Map();               // cell -> the cell one step CLOSER to the target
    let frontier = [];
    // The link next to the target must be one the target can be clicked FROM (see supportDirs).
    for (const [dx, dy, dz] of ends ?? STEPS) {
        const c = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
        if (seen.has(key(c))) continue;
        seen.add(key(c));
        parent.set(key(c), target);
        frontier.push(c);
    }
    for (let depth = 1; depth <= maxLen && frontier.length; depth++) {
        const next = [];
        for (const c of frontier) {
            if (!isFree(c)) continue;
            // Anything solid beside this cell makes it the far end of the chain. Breadth-first,
            // so the first one found is also the shortest - fewest placements, fewest digs.
            if (STEPS.some(([dx, dy, dz]) => isSolid({ x: c.x + dx, y: c.y + dy, z: c.z + dz }))) {
                const chain = [];
                for (let cur = c; key(cur) !== tKey; cur = parent.get(key(cur))) chain.push(cur);
                return chain;
            }
            for (const [dx, dy, dz] of STEPS) {
                const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
                if (seen.has(key(n))) continue;
                seen.add(key(n));
                parent.set(key(n), c);
                next.push(n);
            }
        }
        frontier = next;
    }
    return null;
}

/** Place the chain planSupportChain found. Returns the cells placed, or null if it could not. */
async function buildSupport(bot, P, ctx, p = null) {
    const at = (c) => bot.blockAt(new Vec3(c.x, c.y, c.z));
    const local = (c) => `${c.x - ctx.origin.x},${c.y - ctx.origin.y},${c.z - ctx.origin.z}`;
    const chain = planSupportChain(P, {
        // Water is replaceable but not free: dirt pulled back out of a lake lets the lake in, and
        // that is how one hole at foundation depth flooded a whole build (see placeOne).
        isFree: (c) => {
            if (ctx.occupied?.has(local(c))) return false;
            const b = at(c);
            return !!b && REPLACEABLE.has(b.name) && b.name !== 'water';
        },
        isSolid: (c) => isSolidRef(at(c)),
        ends: p ? supportDirs(p) : null,
        maxLen: ctx.supportMaxLen ?? SUPPORT_MAX_LEN,
    });
    if (!chain) return null;

    const placed = [];
    let step = null;   // which step of the failing link gave up - see ctx.supportWhy below
    for (const c of chain) {
        const C = new Vec3(c.x, c.y, c.z);
        const f = chooseFaces(bot, C, { name: SUPPORT_ITEM })[0];
        if (!f) { step = 'no face'; break; }
        if (!(await goNear(bot, C, 3.0, ctx, f.faceVec))) { step = 'out of reach'; break; }
        await stepOff(bot, C);
        if (!(await equip(bot, SUPPORT_ITEM))) { step = `could not equip ${SUPPORT_ITEM}`; break; }
        const r = await blockIO.placeVerified(bot, f.ref, f.faceVec, { expectName: SUPPORT_ITEM });
        if (!r.ok) { step = r.why; break; }
        placed.push(C);
        // Recorded the moment it lands, not when teardown fails. An interrupt between here and
        // the teardown would otherwise leave dirt in the build that nothing knows about - and
        // "nothing knows about it" is how an unwanted block survives a verification pass that
        // only ever looks at blueprint cells.
        (ctx.supportDebt ||= []).push(C);
    }
    if (placed.length === chain.length) return placed;
    // A half-built chain supports nothing and is litter. Take back what went up - and SAY it was
    // the building that failed, not the search. Both used to return a bare null, reported as
    // `nothing solid within 4`, which on 2026-09-26 sent the diagnosis after chain LENGTH when a
    // probe showed 34 of the cathedral's 70 stuck window grilles had a chain of 4 or fewer.
    await tearDownSupport(bot, placed, ctx);
    ctx.supportWhy = `support chain of ${chain.length} failed at link ${placed.length + 1}: ${step ?? '?'}`;
    return null;
}

/**
 * Remove the temporary blocks, target end first.
 *
 * Anything that is no longer dirt is left alone: between building the support and tearing it down
 * the builder placed a real block, and a cell that now holds something else is either that block
 * or somebody else's - never ours to dig.
 */
async function tearDownSupport(bot, placed, ctx) {
    for (const C of [...placed].reverse()) {
        const settle = () => { const i = ctx.supportDebt?.indexOf(C); if (i >= 0) ctx.supportDebt.splice(i, 1); };
        const b = bot.blockAt(C);
        // An unloaded chunk reads as null, which means "not received yet", NOT "no block" - the
        // distinction this repo keeps paying for. Leave it on the books and let the end-of-build
        // sweep look again.
        if (!b) continue;
        // Not dirt any more: between building the support and tearing it down the builder placed a
        // real block. A cell that holds something else is either that block or somebody else's -
        // never ours to dig.
        if (b.name !== SUPPORT_ITEM) { settle(); continue; }
        try {
            await goNear(bot, C, 3.0, ctx);
            await bot.dig(b, true);
        } catch (e) {
            // Left standing, and still on the books. `dig` can also throw AFTER the block went,
            // so the read below decides, not the throw.
        }
        // Confirm by reading the world, never by trusting the call - the same rule placement
        // follows two hundred lines up.
        const now = bot.blockAt(C);
        if (now && now.name !== SUPPORT_ITEM) settle();
    }
}

async function placeOneCore(bot, P, p, ctx = null) {
    // leaving high work? dismantle the scaffold under our feet first
    if (ctx?.pillar?.length &&
        bot.entity.position.offset(0, 1.62, 0).distanceTo(P.offset(0.5, 0.5, 0.5)) > 4.6) {
        await pillarDown(bot, ctx);
    }
    let existing = bot.blockAt(P);
    if (!existing) {
        await goNear(bot, P, 3.0, ctx);
        existing = await waitForBlock(bot, P);
        if (!existing) return { ok: false, why: 'chunk not loaded' };
    }
    if (existing.name === p.name) {
        // NAME IS NOT ENOUGH, and this line is why 339 of the wizard tower's cells (4.1%) could
        // never be repaired. `blueprintStatus` and the final tally both compare orientation; this
        // skip compared only the name, so a stair placed the wrong way round on 2026-09-21 - before
        // block_io.snapLook put its rotation on the wire - was reported `skipped: already correct`
        // by every retry round and every resume since. The reporting could see the defect and the
        // repair path could not reach it. Dominant bug shape again: measured something true (the
        // name matches) and concluded something false (this cell is finished).
        if (cellIsDone(p, existing)) return { ok: true, skipped: true };
        const wrongNow = orientationMismatch(p, existing);
        // Bounded, because the repair is destructive: it digs a block that is at least the right
        // KIND and might be load-bearing, and a re-place that keeps landing wrong would otherwise
        // churn the same cell every round and can leave a hole where a wrong-facing block stood.
        // Two attempts, then leave it standing and report it honestly.
        const key = `${P.x},${P.y},${P.z}`;
        const tried = ctx?.facingRepairs?.get(key) || 0;
        if (tried >= FACING_MAX_REPAIRS) {
            // Named, and logged per cell rather than left to the sampled FAIL lines: a cell that
            // has exhausted its repair budget is the one case worth a coordinate, because it is
            // the honest "the builder gave up here" signal and there are only ever a handful.
            console.log(`[builder] GAVE UP on orientation: ${p.name}@(${P.x},${P.y},${P.z}) `
                + `is ${wrongNow} after ${tried} re-placements`);
            return { ok: false, why: `wrong orientation (${p.name}: ${wrongNow}), ${tried} repairs did not fix it` };
        }
        if (ctx) (ctx.facingRepairs ||= new Map()).set(key, tried + 1);
        ctx && (ctx.facingRepairsTried = (ctx.facingRepairsTried || 0) + 1);
        // fall through: this cell is rebuilt exactly like an empty one, dig included
    }

    // ---- FEASIBILITY BEFORE DEMOLITION ----
    // This block used to dig FIRST and work out whether a placement was even possible second,
    // so a cell with nothing to click against was emptied and then reported as "no solid
    // neighbor" - the block destroyed, nothing put back, and the failure logged as if the
    // builder had merely declined.
    //
    // On open ground that is untidy. At foundation depth beside water it is unbounded: measured
    // 2026-08-31, one such hole in the y=66 layer let the lake into the footprint and the flood
    // spread under the build until bob was swimming in his own foundation, after which every
    // later symptom (pillarUp finding nothing solid, endless `pinned`) pointed at the navigator
    // instead of here. `night_safety` learned exactly this and the fix has the same shape:
    // "shelterFeasibility now runs BEFORE any ground is broken".
    //
    // chooseFaces only ever inspects P's NEIGHBOURS, never P itself, so its answer is the same
    // before and after the dig - which is what makes moving it earlier a pure reordering.
    const choices = chooseFaces(bot, P, p);
    const choice = choices[0];
    if (!choice) {
        const nb = (dx, dy, dz) => { const b = bot.blockAt(P.offset(dx, dy, dz)); return b ? `${b.name}/${b.boundingBox}` : 'NULL'; };
        return { ok: false, why: `no solid neighbor (self=${bot.blockAt(P)?.name} below=${nb(0,-1,0)} above=${nb(0,1,0)} n=${nb(0,0,-1)} s=${nb(0,0,1)} w=${nb(-1,0,0)} e=${nb(1,0,0)})` };
    }

    // What we broke, so a failed placement can put it back rather than leave a hole. Prevention
    // above is the real fix - a repair cannot run if the flood has already moved the bot - but
    // the server can still refuse a placement we had every reason to expect to work.
    let broke = null;
    if (!REPLACEABLE.has(existing.name)) {
        if (await goNear(bot, P, 3.0, ctx, choice.faceVec)) {
            broke = existing.name;
            try { await bot.dig(existing, true); } catch (e) { broke = null; /* nothing was removed */ }
        }
    }

    // ---- the angle comes from the BLUEPRINT, not from where we happen to stand ----
    // `lookVecFor(p)` already knows the exact horizontal direction the server must see us facing
    // for this cell to land the way the blueprint asks. Yaw and the click cursor are INDEPENDENT
    // fields of the place packet, so that angle can simply be sent.
    //
    // This code used to try to EARN the angle by position instead: walk to a stand point on the
    // opposite side, then look naturally at the click point and let the yaw fall out. The stand
    // point is still worth preferring - it is where a player would be, and it keeps the click ray
    // honest - but it cannot be the mechanism, because `goNear(approach)` is allowed to fail and
    // fall through to `goNear(P)`, which reaches the cell from whatever side was open. The facing
    // then came from the approach direction, unsteered and unrecorded: 339 of the wizard tower's
    // cells (4.1%) ended up pointing whichever way bob arrived from, and the skip above meant no
    // later pass could tell.
    //
    // The comment that used to live here justified position-steering with "94% blockUpdate
    // timeouts with a horizontal forced yaw", read as the server rejecting an implausible click
    // ray. That reading does not survive what this repo has since documented about this server: a
    // missing `blockUpdate` is its NORMAL answer to a correctly-predicted placement (1.17+ clients
    // predict locally and the server replies only when the prediction is WRONG), and chasing that
    // same unsatisfiable await out of `_placeBlockWithOptions` is why `block_io` writes the packet
    // itself. So those timeouts are not evidence of rejection; they are the symptom this file
    // already exists to route around. We now place through our own `block_place` with a real
    // sequence and read the world back, so a genuine refusal is visible as one - and the progress
    // line carries `yaw=` counters so a spike in refusals after this change cannot hide.
    const look = lookVecFor(p);
    // mineflayer yaw convention, the same transform snapLook uses on a direction vector.
    const aimYaw = look ? Math.atan2(-look.x, -look.z) : null;
    const props = p.properties || {};
    let approach = P;
    if (look) {
        approach = P.minus(new Vec3(Math.round(look.x * 2), 0, Math.round(look.z * 2)));
    } else if (SIDE_FACES.includes(choice.faceName)) {
        approach = P.plus(new Vec3(choice.faceVec.x * 2, 0, choice.faceVec.z * 2)); // in front of the clicked face
    }
    if (!(await goNear(bot, approach, 3.0, ctx, choice.faceVec))
        && !(await goNear(bot, P, 3.0, ctx, choice.faceVec))) {
        // above walking reach: pillar a dirt scaffold next to the work
        // The dirt pillar is the fallback for when flight is NOT available - in survival, or a
        // creative session where startFlying was refused. Under flight it is pure cost: a pillar
        // only creates a place to STAND, and a flying bot can already occupy any clear cell, so
        // if `flyNear` (which searches a 7x5x7 neighbourhood) found nowhere with the eye in
        // range, there is nowhere for a pillar to put us either. Measured: `nocol=41` scaffold
        // attempts on a flight-enabled run, each one walking and digging, with the placement
        // rate back down to 10 blocks/min.
        if (ctx?.flying) return { ok: false, why: 'out of reach (no clear hover within range)' };
        if (!(ctx && P.y > bot.entity.position.y + 1.5 && await scaffoldTo(bot, P, ctx)))
            return { ok: false, why: 'out of reach (no walkable route)' };
    }
    await stepOff(bot, P);

    const itemName = itemNameFor(p.name);
    if (!(await equip(bot, itemName))) return { ok: false, why: `no item ${itemName}` };

    try {
        // Through block_io, which writes `block_place` itself with a real sequence and waits on
        // the server's `acknowledge_player_digging`. `bot._placeBlockWithOptions` instead awaits
        // a `blockUpdate` this server does not send for a correctly-predicted placement, which
        // is every `Event blockUpdate:(x, y, z) did not fire within timeout of 500ms` in this
        // builder's logs - a 500ms stall per block, reported as a failure for blocks that landed.
        // Measured on the same server: 30-50ms and acknowledged, against 217-894ms.
        // It paces itself (MIN_PLACE_GAP_MS), so the 250ms sleep that used to sit here is gone.
        // expectName, not the default "something solid appeared": half this blueprint is
        // trapdoors, fences and signs, whose boundingBox is never 'block'.
        // opts are rebuilt per candidate face below, since `half` is face-specific.
        // For a potted plant the block that lands here is an EMPTY flower_pot; the plant goes in
        // afterwards. Expecting p.name would fail a placement that was perfectly correct.
        const plant = pottedPlantItem(p.name);
        const wantName = plant ? 'flower_pot' : p.name;
        // Try the alternate faces on a REFUSAL only. A refusal is the server saying "not from
        // there", which another side may well answer; a missing ack means the round trip itself
        // failed, and hammering more faces at a server that is not replying only makes it worse.
        let r = null;
        for (const c of choices.slice(0, MAX_FACE_TRIES)) {
            const o = { swingArm: 'right' };
            if (c.half) o.half = c.half;
            // The blueprint's own angle, sent rather than inferred from where we are standing.
            if (aimYaw !== null) {
                o.yaw = aimYaw;
                if (ctx) ctx.yawAimed = (ctx.yawAimed || 0) + 1;
            }
            r = await blockIO.placeVerified(bot, c.ref, c.faceVec, { placeOpts: o, expectName: wantName });
            if (r.ok || !/refused by server/.test(r.why)) break;
        }
        if (!r || !r.ok) throw new Error(r ? r.why : 'no face to place from');
        broke = null;   // placed successfully; nothing owed
        if (plant) {
            const potted = await plantIntoPot(bot, P, plant, p.name);
            // An empty pot where a planted one was wanted is a real mismatch, so say which half
            // failed - "no item azalea" and "the pot would not take it" need different fixes.
            if (!potted.ok) return { ok: false, why: potted.why };
        }
    } catch (e) {
        // The API can throw after a SUCCESSFUL placement, so re-read before believing it - but
        // POLL, do not sample once. `_placeBlockWithOptions` ends in mineflayer's blockUpdate
        // ack, which this server does not always send (1.17+ clients predict the click locally
        // and the server answers only when the prediction is WRONG - the same unsatisfiable
        // await container_io.js exists to route around). So the throw arrives at 500ms and the
        // block often lands after it. A single read at +200ms scored those as failures:
        // measured 2026-08-30, `FAIL cracked_stone_bricks@(4707,67,4607): Event blockUpdate
        // did not fire within timeout of 500ms` for cells that were fine.
        const deadline = Date.now() + 600;
        let now = null;
        while (Date.now() < deadline) {
            now = bot.blockAt(P);
            if (now && now.name === p.name) break;
            await new Promise(r => setTimeout(r, 25));
        }
        if (!now || now.name !== p.name) {
            await restoreBroken(bot, P, broke, choice);
            return { ok: false, why: e.message };
        }
        broke = null;
    }

    // interactive states the place packet cannot express
    if (props.open === 'true') {
        const placed = bot.blockAt(P);
        if (placed && placed.name === p.name && placed.getProperties?.().open === false) {
            try { await bot.activateBlock(placed); } catch (e) { /* cosmetic */ }
        }
    }
    // Name AND orientation. A block of the right kind facing the wrong way is a failure the retry
    // pass should see, not a success - see orientationMismatch above.
    const finalBlock = bot.blockAt(P);
    if (!finalBlock) return { ok: false, why: 'unloaded' };
    if (finalBlock.name !== p.name) return { ok: false, why: `got ${finalBlock.name}` };
    const wrong = orientationMismatch(p, finalBlock);
    // NAME THE BLOCK. The failure reasons are aggregated by string in the progress heartbeat, so
    // `wrong orientation (facing=north, want east)` tells you a quarter turn went missing and
    // nothing about WHICH class did it - and the per-cell FAIL lines are sampled, so they were not
    // there to fall back on. Whether the offender is yaw-steered or clicked-face-steered decides
    // which of two completely different mechanisms to look at, so the name has to be in the key.
    return wrong
        ? { ok: false, why: `wrong orientation (${p.name}: ${wrong})` }
        : { ok: true, why: `got ${finalBlock.name}` };
}

/**
 * Place one cell, and if it has nothing to click against, MAKE it something.
 *
 * The retry is cheap to attempt: `placeOneCore` tests for a face before it navigates, digs or
 * equips anything, so a cell that needs a support costs one map read to find that out. Everything
 * expensive happens only once a support chain actually exists.
 *
 * The support comes down on the same path it went up, whether the placement worked or not, and
 * the block is then RE-READ. That last read is the whole safety argument: a name list cannot know
 * which of this blueprint's 8,285 cells depends on its neighbour to stay up, so the builder finds
 * out by looking, says so, and never supports that name again this run.
 */
/**
 * `"oak_log[axis=z]"` -> `{ name: 'oak_log', properties: { axis: 'z' } }`. The command form of a
 * blueprint cell, so a single placement goes through exactly the path a build does.
 * Returns null on anything malformed rather than guessing.
 */
export function parseBlockSpec(text) {
    const m = /^\s*(?:minecraft:)?([a-z0-9_]+)\s*(?:\[([^\]]*)\])?\s*$/.exec(String(text ?? ''));
    if (!m) return null;
    const properties = {};
    for (const kv of (m[2] ?? '').split(',').map(t => t.trim()).filter(Boolean)) {
        const e = /^([a-z_]+)\s*=\s*([a-z0-9_]+)$/.exec(kv);
        if (!e) return null;
        properties[e[1]] = e[2];
    }
    return { name: m[1], properties };
}

/**
 * A minimal build context for ONE cell at `P` - what placeOne needs to fly, leash, and build a
 * temporary support chain. The target cell is reserved (a support must never go INTO it) along
 * with any `protect` cells, and supports are allowed from the start: a single placement has no
 * later pass to wait for, which is the only reason the builder holds them back.
 */
export function supportCtx(agent, P, protect = [], radius = 16) {
    const occupied = new Set(['0,0,0']);
    for (const c of protect) occupied.add(`${c.x - P.x},${c.y - P.y},${c.z - P.z}`);
    return {
        origin: P, agent, occupied, pillar: [], allowSupports: true,
        // One cell can afford a long chain the builder cannot spend on thousands: the cathedral's
        // spire-top bars float 14-16 links from anything solid, past the builder's SUPPORT_MAX_LEN.
        supportMaxLen: SINGLE_SUPPORT_MAX_LEN,
        box: { minX: P.x - radius, maxX: P.x + radius, minZ: P.z - radius, maxZ: P.z + radius,
               topY: P.y + 8, centreX: P.x, centreZ: P.z },
    };
}

/**
 * Place one block where there may be nothing to click against: try it plainly, and if there is
 * no face, build a temporary dirt chain from the nearest solid block to a face this block may be
 * clicked FROM (supportDirs - a log's axis end, a lever's wall), place it, and take the chain
 * down again. The same code path as the builder's retry rounds, exposed as a skill so it can be
 * used on one cell - the cathedral finished with ~70 window grilles hanging in air.
 *
 * Creative only, like the builder: items come from the creative inventory and the reach is flight.
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
const APPROACH_NEAR = 12;
export const SINGLE_SUPPORT_MAX_LEN = 24;
export const APPROACH_PLAN = { pad: 32, maxNodes: 100000, maxRange: 256 };
export async function placeWithSupport(agent, P, spec, { protect = [] } = {}) {
    const bot = agent.bot;
    if (bot.game?.gameMode !== 'creative')
        return { ok: false, message: 'placeWithSupport needs creative mode (it takes blocks from the creative inventory and flies).' };
    if (!spec?.name) return { ok: false, message: 'no block given.' };
    const existing = bot.blockAt(P);
    if (!existing) return { ok: false, message: `(${P.x}, ${P.y}, ${P.z}) is not loaded - move closer first.` };
    if (cellIsDone(spec, existing)) return { ok: true, message: `${spec.name} is already at (${P.x}, ${P.y}, ${P.z}).` };
    if (!supportIsSafe(spec.name))
        return { ok: false, message: `${spec.name} would not survive its temporary support being removed - it needs a permanent one.` };
    const ctx = supportCtx(agent, P, protect);
    // The same modes the builder pauses: a creeper fight is not a reason to abandon one block, and
    // in creative there is nothing to preserve. Measured 2026-09-27 driving the cathedral's grilles:
    // `self_defense` interrupted placements mid-chain.
    for (const m of [...PAUSABLE_MODES, ...CREATIVE_INVULNERABLE_MODES]) { try { bot.modes.pause(m); } catch (e) { /* mode absent */ } }
    ctx.flying = flight.beginFlight(bot);
    let res;
    try {
        // GET INTO RANGE FIRST. The builder's flights are local - it is always beside its work - and
        // plan at most ROUTE_MAX_RANGE (64). A command starts wherever the bot happens to be: bob
        // was on the ground 96 blocks from the first grille, and every flight answered `no route
        // (sealed or out of range)` before trying. One long approach, then the local machinery.
        //
        // And plan it WIDE. The local planner searches a box 16 past the start and goal, and a room
        // is often entered through a window further away than that: from (944, 86, 4678) it routed
        // 2 of 15 of the cathedral's last grilles, `NO ROUTE ... sealed in`, while a flood fill from
        // outside reached every one. 32 past and 100k nodes routed 15 of 15, ~0.7s each; 48/400k
        // gained nothing more. Any clear hover near the cell is a goal.
        const far = bot.entity.position.distanceTo(P.offset(0.5, 0.5, 0.5));
        if (far > APPROACH_NEAR) {
            const goals = [...flight.hoverCandidates(P, bot.entity.position, 2.0), ...flight.nearbyClearHovers(bot, P)];
            const route = flight.planFlight(bot, goals, APPROACH_PLAN);
            if (route) await flight.flyRoute(bot, route, { timeoutMs: 4000 });
            else await flight.flyTo(bot, { x: P.x + 0.5, y: P.y + 2, z: P.z + 0.5 }, { maxRange: 256, timeoutMs: 20000 });
        }
        res = await placeOne(bot, P, spec, ctx);
    } finally {
        // Litter check: anything a failed or interrupted chain left behind is taken down.
        if (ctx.supportDebt?.length) await tearDownSupport(bot, [...ctx.supportDebt].reverse(), ctx);
        flight.endFlight(bot, ctx.flying);
        try { bot.modes.unPauseAll(); } catch (e) { /* best effort */ }
    }
    const used = ctx.supportsUsed ? ` using a temporary support (${ctx.supportsBuilt} built, removed)` : '';
    return res.ok
        ? { ok: true, message: `Placed ${spec.name} at (${P.x}, ${P.y}, ${P.z})${used}.` }
        : { ok: false, message: `Could not place ${spec.name} at (${P.x}, ${P.y}, ${P.z}): ${res.why}` };
}

async function placeOne(bot, P, p, ctx = null) {
    const first = await placeOneCore(bot, P, p, ctx);
    if (first.ok || !ctx || !/^no solid neighbor/.test(first.why || '')) return first;
    // LAST RESORT, NOT FIRST. A cell with nothing to click on pass 1 is usually waiting for a
    // neighbour that a later pass places for free - and a support spent there costs a flight leg,
    // a placement and a dig for nothing. Measured on the wizard tower: supporting eagerly builds
    // 99 chains, supporting only after retrying stops paying builds 29, for the same finished
    // tower. `buildBlueprint` sets this once a whole retry round has gained nothing.
    if (!ctx.allowSupports) return first;
    if (!supportIsSafe(p.name)) return { ok: false, why: `${first.why} [needs a permanent support]` };
    if (ctx.supportUnsafe?.has(p.name)) return { ok: false, why: `${first.why} [${p.name} does not survive a temporary support]` };

    ctx.supportWhy = null;
    const support = await buildSupport(bot, P, ctx, p);
    if (!support) return { ok: false, why: `${first.why} [${ctx.supportWhy ?? `nothing solid within ${ctx.supportMaxLen ?? SUPPORT_MAX_LEN}`}]` };
    ctx.supportsBuilt = (ctx.supportsBuilt || 0) + 1;

    let second;
    try {
        second = await placeOneCore(bot, P, p, ctx);
    } finally {
        // On the same path whether the placement worked, failed or threw. A support that outlives
        // its placement is litter in a finished build.
        await tearDownSupport(bot, support, ctx);
    }
    if (!second.ok) return second;

    const after = await waitForBlock(bot, P, 1000);
    if (!after || after.name !== p.name) {
        (ctx.supportUnsafe ||= new Set()).add(p.name);
        console.log(`[builder] ${p.name} did not survive losing its temporary support - not supporting it again`);
        return { ok: false, why: `${p.name} fell when its temporary support was removed` };
    }
    ctx.supportsUsed = (ctx.supportsUsed || 0) + 1;
    return second;
}

// Orientation props worth showing the LLM; connection/auto-computed states (shape,
// waterlogged, powered, occupied...) are noise it can neither set nor fix.
const REPORTABLE_PROPS = ['facing', 'half', 'axis', 'hanging', 'open', 'rotation'];

/**
 * Props whose value this builder actually CHOOSES, and can therefore be held to.
 *
 * `type` is deliberately absent: for a slab it carries top/bottom/DOUBLE, and a double slab is two
 * placements the builder already flags separately - comparing it would report every half-built
 * double slab as an orientation error. Everything else the server derives (shape, waterlogged,
 * powered, occupied, connections) is absent for the same reason it is absent from REPORTABLE_PROPS:
 * we do not set it, so a difference is not a defect.
 */
const VERIFIED_PROPS = ['facing', 'half', 'axis', 'rotation'];

/**
 * Does the block in the world have the orientation the blueprint asked for?
 *
 * WHY THIS EXISTS. Every verification in this file used to compare the block NAME and nothing else
 * - `placeOne`'s return, `blueprintStatus`'s match count, and the final tally - so a tower of
 * correctly-named, wrongly-facing stairs reported as a clean build. That is this repo's dominant
 * bug shape exactly: the code measured something true (the name matches) and concluded something
 * false (the blueprint is satisfied). It is what let 2026-09-21's Wizard Tower run finish with its
 * stairs, doors and chests pointing whichever way the bot happened to be looking on the PREVIOUS
 * placement (root cause: block_io.snapLook not putting its rotation on the wire; measured 4/28
 * look-steered facings correct before the fix, 33/33 after).
 *
 * Absence of a property in the BLUEPRINT means "do not care" - not every schematic records every
 * state - but a property the blueprint does specify is checked, and a block we cannot read is
 * reported as unverified rather than counted as correct.
 *
 * @returns {string|null} a human-readable mismatch, or null when the orientation is right
 */
export function orientationMismatch(p, block) {
    if (!block) return 'unreadable';
    const want = p.properties || {};
    const got = block.getProperties?.() ?? {};
    const bad = [];
    for (const k of VERIFIED_PROPS) {
        if (want[k] === undefined) continue;                  // blueprint does not say: do not care
        const g = got[k];
        if (g === undefined) { bad.push(`${k} unset, want ${want[k]}`); continue; }
        if (String(g) !== String(want[k])) bad.push(`${k}=${g}, want ${want[k]}`);
    }
    return bad.length ? bad.join(' ') : null;
}

/**
 * Is this cell FINISHED, so the builder may skip it without touching it?
 *
 * Exported and pure so the decision itself is testable, not merely the predicate it consults.
 * That distinction is not academic: `placeOneCore` used to inline this as
 *
 *     if (existing.name === p.name) return { ok: true, skipped: true };
 *
 * `orientationMismatch` was written, tested and correct while that line quietly disagreed with it,
 * and 339 wrong-facing cells were reported `skipped: already correct` by every retry round and
 * every resume for four runs. A test on the predicate alone would not have caught it - it did not.
 *
 * @param {object} p        the blueprint entry
 * @param {object} existing the block currently in the world, or null
 */
/**
 * Cells in one layer of the footprint that hold natural terrain the build has no business
 * leaving there: inside the footprint, NOT claimed by the blueprint, currently natural ground.
 *
 * Exported so the regression that produced it is an assertion and not a paragraph. The clear
 * phase used to be skipped whenever the site read as mostly built, on the reasoning that a
 * resumed build has already been cleared. "95% built" and "no terrain intrudes" are independent
 * facts, and on the wizard tower they disagreed: the tower was finished to its roof while 1304 of
 * its 1999 grass_block cells were still buried in the hillside it was sited on, three blocks
 * below grade. Everything downstream followed from that - unreachable cells, because nothing can
 * hover inside rock, and grass decaying to dirt under the leftover ground.
 *
 * @param {object} bot
 * @param {Vec3}   origin   world position of the blueprint's (0,0,0)
 * @param {object} size     {width, length} of the footprint
 * @param {Set}    occupied "x,y,z" keys the blueprint itself claims
 * @param {number} y        the layer to scan
 */
export function layerClearTargets(bot, origin, size, occupied, y) {
    const targets = [];
    for (let x = 0; x < size.width; x++) {
        for (let z = 0; z < size.length; z++) {
            if (occupied.has(`${x},${y},${z}`)) continue;
            const b = bot.blockAt(new Vec3(origin.x + x, origin.y + y, origin.z + z));
            if (b && NATURAL_TERRAIN.has(b.name)) targets.push({ x, y, z });
        }
    }
    return targets;
}

/**
 * ON A RESUME, MISSING CELLS WITH BUILT WORK ABOVE THEM GO LAST.
 *
 * A fresh build climbs from layer 0, so the cell being placed always has open sky above it. A
 * RESUMED build replays the same bottom-up order over a site whose walls and floors already stand,
 * so every straggler in the lower layers is now INSIDE the building - reached only by flying through
 * galleries two blocks high. Measured 2026-09-25: the cathedral resumed at 63%, spent 2h38m in
 * layers 0-12 placing 260 blocks (0.4/min, against 22/min in open layers), and ended wedged in a
 * gallery at (885, 75, 4693), 13 blocks from open ground - with 13,000 open-sky cells above it
 * untouched. Order, not ability: do the open work first, the enclosed leftovers last.
 *
 * `isRoofed(p)` decides per cell; the partition is stable, so the build order within each half is
 * exactly orderForBuild's. Returns how many cells were moved to the end.
 */
export const ROOF_CLEARANCE = 2;
export function roofedLast(list, isRoofed) {
    const open = [], roofed = [];
    for (const p of list) (isRoofed(p) ? roofed : open).push(p);
    list.length = 0;
    for (const p of open) list.push(p);
    for (const p of roofed) list.push(p);
    return roofed.length;
}

/** A cell is roofed when its column holds a solid block more than ROOF_CLEARANCE above it. Cached per column. */
export function makeRoofProbe(bot, origin, height) {
    const top = new Map();
    return (p) => {
        const key = `${p.x},${p.z}`;
        let t = top.get(key);
        if (t === undefined) {
            t = -Infinity;
            for (let y = height - 1; y >= 0; y--) {
                const b = bot.blockAt(new Vec3(origin.x + p.x, origin.y + y, origin.z + p.z));
                if (b && b.boundingBox === 'block') { t = y; break; }
            }
            top.set(key, t);
        }
        return t > p.y + ROOF_CLEARANCE;
    };
}

export function cellIsDone(p, existing) {
    if (!existing) return false;
    if (existing.name !== p.name) return false;
    return orientationMismatch(p, existing) === null;
}

function propSummary(p) {
    const props = p.properties || {};
    const parts = REPORTABLE_PROPS.filter(k => props[k] !== undefined).map(k => `${k}=${props[k]}`);
    return parts.length ? ` [${parts.join(',')}]` : '';
}

/**
 * PREFLIGHT: everything knowable before a single block moves.
 *
 * Three of 2026-09-22's failures were sitting in the inputs, discoverable in milliseconds, and each
 * cost hours instead:
 *
 *   - `chain` and `grass` were renamed by Mojang (to `iron_chain` and `short_grass`), so
 *     `mcData.itemsByName['chain']` is undefined, `new Item(undefined, 1)` has no `.components`,
 *     and the builder reported `equip chain failed: undefined is not an object` 45 times across two
 *     blueprints before anyone traced it back to a rename.
 *   - the origin was set a block below grade by copying a neighbouring build's y instead of
 *     measuring this site, which silently turned into two full terrain-clear layers over a 45x35
 *     footprint.
 *   - footprints were repeatedly aimed at ground that turned out to be somebody's build.
 *
 * None of that needs a bot in motion. This reports all of it up front, with the correction to hand
 * ("suggested origin y"), and deliberately does NOT abort: a blueprint with two unknown names still
 * builds 8,333 of its 8,335 blocks, and refusing the lot would be worse than saying so. The caller
 * decides; the point is that nobody discovers it at block 1,200.
 *
 * Pure over an injected probe, so it is testable with a fake world and no server:
 *   probe.hasItem(name)      -> is this placeable at all on the connected version
 *   probe.surfaceAt(x, z)    -> y of the top solid block, or null
 *   probe.naturalAt(x, z)    -> is that surface natural terrain rather than built
 *
 * @returns {{lines: string[], unknown: Map, gradeDelta: number|null, suggestedY: number|null,
 *            clearCells: number, builtColumns: number}}
 */
export function preflightBuild(placements, origin, probe, opts = {}) {
    const stride = opts.stride ?? 4;
    const lines = [];

    // 1. names the connected version cannot place
    const unknown = new Map();
    for (const p of placements) {
        const item = itemNameFor(p.name);
        if (p.name.startsWith('potted_') || probe.hasItem(item)) continue;
        unknown.set(p.name, (unknown.get(p.name) || 0) + 1);
    }
    if (unknown.size) {
        const detail = [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([n, c]) => `${n} x${c}`).join(', ');
        const total = [...unknown.values()].reduce((a, b) => a + b, 0);
        lines.push(`${total} placements name blocks this version cannot place: ${detail}`
            + ` - they will fail individually (renamed between versions?)`);
    }

    // 2. origin against the actual ground, sampled
    const xs = placements.map(p => p.x), zs = placements.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const deltas = [];
    let builtColumns = 0, sampled = 0;
    for (let x = minX; x <= maxX; x += stride) {
        for (let z = minZ; z <= maxZ; z += stride) {
            sampled++;
            const surf = probe.surfaceAt(origin.x + x, origin.z + z);
            if (surf === null || surf === undefined) continue;
            deltas.push(surf - origin.y);
            if (probe.naturalAt && !probe.naturalAt(origin.x + x, origin.z + z)) builtColumns++;
        }
    }
    let gradeDelta = null, suggestedY = null, clearCells = 0;
    if (deltas.length) {
        deltas.sort((a, b) => a - b);
        gradeDelta = deltas[deltas.length >> 1];          // median, so one butte does not decide it
        suggestedY = origin.y + gradeDelta;
        const footprint = (maxX - minX + 1) * (maxZ - minZ + 1);
        if (gradeDelta > 0) {
            clearCells = footprint * gradeDelta;
            lines.push(`origin y=${origin.y} is ${gradeDelta} below grade (median surface `
                + `${suggestedY}) - about ${clearCells} cells of terrain to clear first. `
                + `Suggested origin y: ${suggestedY}`);
        } else if (gradeDelta < 0) {
            lines.push(`origin y=${origin.y} is ${-gradeDelta} above grade (median surface `
                + `${suggestedY}) - the base will float or need fill. Suggested origin y: ${suggestedY}`);
        }
        const spread = deltas[deltas.length - 1] - deltas[0];
        if (spread > 6) lines.push(`the ground varies by ${spread} blocks across the footprint - `
            + `expect terracing, this builder does not level`);
    } else {
        lines.push('could not read the ground anywhere in the footprint - is the site loaded?');
    }

    // 3. is the footprint WET. Measured 2026-09-22 the expensive way: an origin set two blocks
    // below the water table turned the terrain clear into an excavation that opened a flooded
    // pocket, and the bot spent 157 seconds submerged at y=61 with `mode:drowning` firing and
    // `Climbed 0 blocks toward the surface`. This builder does not drain, and a foundation in
    // water is not a foundation.
    //
    // The base plane alone is not enough, and the cathedral proved it on 2026-09-24: its origin
    // sat at y=63, three blocks ABOVE grade, so the plane was dry and this check said nothing -
    // while the foundation then filled cobblestone down through a pond at y=61, the bot followed
    // it under, and the drowning interrupt that followed killed the process. So trace exactly
    // what `placeFoundation` will fill: down from the base until the first solid block, at most
    // FOUNDATION_DEPTH deep. With no `solidAt` on the probe, only the plane is checked, as before.
    //
    // The same trace answers a second question the water check alone missed: is there GROUND in
    // reach at all. `placeFoundation` fills at most FOUNDATION_DEPTH, then silently skips the
    // column, so a base cell whose ground is deeper than that is never underpinned and can never be
    // placed - nor anything stacked on it. Measured on the cathedral, 2026-09-25: 617 of 3,055
    // ground-layer cells stood over a lake 9 to 26 blocks deep; the build stopped at 5.9% on a run
    // of 200 `no solid neighbor (... below=water ...)`. Water or air makes no difference to that -
    // a dry cliff edge deeper than the reach fails identically - so it is counted on its own.
    let wetColumns = 0, unsupportedColumns = 0;
    if (probe.waterAt || probe.solidAt) {
        for (let x = minX; x <= maxX; x += stride) {
            for (let z = minZ; z <= maxZ; z += stride) {
                const wx = origin.x + x, wz = origin.z + z;
                let wet = !!probe.waterAt?.(wx, origin.y, wz);
                let grounded = !probe.solidAt;        // no solidAt: cannot tell, so do not count it
                for (let d = 1; probe.solidAt && d <= FOUNDATION_DEPTH; d++) {
                    const solid = probe.solidAt(wx, origin.y - d, wz);
                    if (solid === null || solid === undefined) { grounded = true; break; }  // unread: no evidence
                    if (solid) { grounded = true; break; }
                    if (probe.waterAt?.(wx, origin.y - d, wz)) wet = true;
                }
                if (wet) wetColumns++;
                if (!grounded) unsupportedColumns++;
            }
        }
        if (wetColumns) lines.push(`${wetColumns} of ${sampled} sampled columns hold WATER at the base `
            + `plane or in the foundation beneath it - this builder does not drain`);
        if (unsupportedColumns) lines.push(`${unsupportedColumns} of ${sampled} sampled columns have no `
            + `ground within ${FOUNDATION_DEPTH} blocks of the base - the foundation cannot reach it, so `
            + `that part of the build will float and fail`);
    }

    // 4. is the lot somebody's build
    if (builtColumns) {
        lines.push(`${builtColumns} of ${sampled} sampled columns stand on BUILT blocks, not `
            + `natural terrain - this footprint overlaps something`);
    }
    if (!lines.length) lines.push('clear: names, grade and footprint all check out');
    return { lines, unknown, gradeDelta, suggestedY, clearCells, builtColumns, wetColumns, unsupportedColumns, sampled };
}

// How deep `placeFoundation` fills below the base. The preflight's water trace follows the same
// limit, so it looks at exactly the cells the foundation will be asked to fill.
const FOUNDATION_DEPTH = 8;

/** Wet columns a fresh site may have before the build is refused: a puddle is filled, a pond is not. */
export function wetLimit(sampled) {
    return Math.max(2, Math.ceil(sampled * 0.02));
}

/**
 * WHERE TO BUILD - decided once, before a block moves, and only for a site nothing has started.
 *
 * The preflight has always known the answer and then built somewhere else. On 2026-09-24 the
 * cathedral was started at y=63 because that is where bob was standing when asked; the preflight
 * said `origin y=63 is 3 above grade (median surface 60) - the base will float or need fill.
 * Suggested origin y: 60`, logged it, and proceeded. The fill it then needed ran down through a
 * pond, and the build died there. The user's verdict on the wizard tower, which spent three days
 * repairing what it should never have got wrong, was that a bot should not make mistakes from the
 * start and spend its time fixing them. This is the start.
 *
 * Two rules, both for a FRESH site only:
 *   - off grade: build at the grade instead, and say so. Only y moves; x and z are where the build
 *     was asked for.
 *   - wet: refuse, naming the count. This builder does not drain.
 * A site that is already under way is never moved or refused - that would strand the work done.
 *
 * Pure: `preflightAt(origin)` supplies the measurement, so every branch is testable without a world.
 *
 * @returns {{action: 'build'|'refuse', origin: {x,y,z}, notes: string[], why?: string, pf: object}}
 */
export function decideSite({ requested, fresh, preflightAt }) {
    let origin = { x: requested.x, y: requested.y, z: requested.z };
    let pf = preflightAt(origin);
    const notes = [];
    if (!fresh) return { action: 'build', origin, notes, pf };

    if (pf.gradeDelta && pf.suggestedY !== null && pf.suggestedY !== undefined) {
        notes.push(`origin y=${requested.y} was ${Math.abs(pf.gradeDelta)} `
            + `${pf.gradeDelta > 0 ? 'below' : 'above'} grade - building at the grade, y=${pf.suggestedY}`);
        origin = { x: requested.x, y: pf.suggestedY, z: requested.z };
        pf = preflightAt(origin);
    }
    if ((pf.unsupportedColumns || 0) >= wetLimit(pf.sampled)) {
        return {
            action: 'refuse', origin, notes, pf,
            why: `${pf.unsupportedColumns} of ${pf.sampled} sampled columns have no ground within `
                + `${FOUNDATION_DEPTH} blocks of the base, so that part of the build would float and could `
                + `never be placed. Pick flatter ground and ask again.`,
        };
    }
    if (pf.wetColumns >= wetLimit(pf.sampled)) {
        return {
            action: 'refuse', origin, notes, pf,
            why: `${pf.wetColumns} of ${pf.sampled} sampled columns have water where the base or its `
                + `foundation would go. This builder does not drain, and filling a foundation through `
                + `water is how the last attempt died. Pick dry ground and ask again.`,
        };
    }
    return { action: 'build', origin, notes, pf };
}

/**
 * Has this blueprint already been started on a footprint that overlaps the requested one?
 *
 * Two overlapping copies of one build are always a mistake, and it happened: the cathedral was
 * begun at (892,64,4653), cancelled by a teleport two minutes later with terrain already dug,
 * then begun again at (880,63,4637) - twenty blocks away, footprints overlapping, because the
 * model picked the coordinates from wherever bob was standing each time. The overlap test is exact
 * rather than a radius: two copies overlap iff their footprints intersect.
 *
 * @param {object} sites     the ledger, {blueprintPath: {x, y, z, ts}}
 * @param {string} blueprint path as given to buildBlueprint
 * @param {object} requested {x, y, z}
 * @param {object} size      {width, length} of the footprint
 * @returns {{x, y, z}|null} the recorded origin to build at, or null for a new site
 */
export function recordedSiteFor(sites, blueprint, requested, size) {
    const rec = sites?.[blueprint];
    if (!rec) return null;
    const overlaps = Math.abs(rec.x - requested.x) < size.width && Math.abs(rec.z - requested.z) < size.length;
    return overlaps ? { x: rec.x, y: rec.y, z: rec.z } : null;
}

function sitesFile(agent) { return `bots/${agent.name}/build_sites.json`; }
function readSites(agent) {
    try { return JSON.parse(fs.readFileSync(sitesFile(agent), 'utf8')); } catch (e) { return {}; }
}
function recordSite(agent, blueprint, origin) {
    const sites = readSites(agent);
    sites[blueprint] = { x: origin.x, y: origin.y, z: origin.z, ts: Date.now() };
    try { fs.writeFileSync(sitesFile(agent), JSON.stringify(sites, null, 2)); } catch (e) { /* best effort */ }
}

/**
 * How much of this build already stands at `origin`, sampled. Unloaded cells are skipped, never
 * counted as missing: absence of evidence is not evidence of an empty site.
 */
export function presentFraction(bot, buildable, origin) {
    let alreadyThere = 0, sampled = 0;
    for (let i = 0; i < buildable.length; i += Math.max(1, Math.floor(buildable.length / 400))) {
        const q = buildable[i];
        const b = bot.blockAt(new Vec3(origin.x + q.x, origin.y + q.y, origin.z + q.z));
        if (!b) continue;
        sampled++;
        if (b.name === q.name) alreadyThere++;
    }
    return { alreadyThere, sampled };
}

/**
 * Cells that could not be placed YET, because nothing was there to click against - parked, and
 * released the moment a neighbour is actually placed.
 *
 * `orderForBuild` already grows each layer from what exists, but only on paper: it treats the layer
 * below as support, and for the ground layer that is the real ground, which it cannot see. Measured
 * on the cathedral, 2026-09-25: 617 of 3,055 ground-layer cells stood over a lake 9 to 26 blocks
 * deep, beyond anything the foundation can fill. The plan emitted them in adjacency order from an
 * arbitrary seed; at runtime the seed had nothing under it and failed, and so did every cell
 * planned to grow from it - 802x `no solid neighbor (... below=water ...)`, the watchdog read 200 of
 * them in a row as a stuck bot, and the build stopped at 5.9%.
 *
 * None of those cells was stuck. Each was waiting for a neighbour, and cobblestone floats: a deck
 * grown sideways from the shore crosses the lake one block against the next, with the bot above the
 * water the whole time. So a `no solid neighbor` cell is parked here, NOT recorded as a failure and
 * NOT counted by the watchdog (it cost nothing - the face check runs before any flight); placing
 * any of its six neighbours moves it to `ready`, which the pass drains before continuing its plan.
 * Whatever is still parked when the pass ends becomes an ordinary failure for the retry rounds.
 *
 * Blueprint-local coordinates, no world access: testable without a bot.
 */
export class Frontier {
    constructor() { this.waiting = new Map(); this.ready = []; this.released = 0; }
    static key(p) { return `${p.x},${p.y},${p.z}`; }
    park(p, why) { this.waiting.set(Frontier.key(p), { ...p, why }); }
    /** `p` was just placed: release every parked neighbour of it, nearest-first by construction. */
    placed(p) {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
            const k = `${p.x + dx},${p.y + dy},${p.z + dz}`;
            const w = this.waiting.get(k);
            if (!w) continue;
            this.waiting.delete(k);
            this.ready.push(w);
            this.released++;
        }
    }
    next() { return this.ready.shift(); }
    /** Everything still parked, as failures - the pass is over and nothing reached them. */
    drain() { const left = [...this.waiting.values()]; this.waiting.clear(); return left; }
}

// The failure that means "not yet", as opposed to "cannot": there was no face to click. Matched at
// the start only, because placeOne appends detail after it.
const NOT_YET = /^no solid neighbor/;
/** Is this failure "not yet" (park it) rather than "cannot" (count it)? */
export function isNotYet(why) { return NOT_YET.test(why || ''); }

/**
 * PROGRESS WATCHDOG: stop a build that is not building.
 *
 * "Never retry a failure on a fixed beat" is already a rule in CLAUDE.md, and the builder had no
 * counter enforcing it. So on 2026-09-21 it attempted the same unreachable cells 5,238 times with
 * `0 placed` for twenty-three hours, and on 2026-09-22 a spin inside the flight primitives produced
 * 1,524 failures in seventy seconds. Both stop dead against one rule: if nothing has been placed in
 * the last `limit` attempts, the world is not changing and the next attempt cannot know something
 * the last `limit` did not.
 *
 * Reports the DOMINANT reason, because "the build stopped" without it just moves the investigation
 * somewhere else.
 *
 * @returns {{stop: boolean, why: string}|null}
 */
/**
 * Strip the VARYING parts out of a failure reason so identical failures aggregate.
 *
 * `refused by server (ack 42ms)` and `refused by server (ack 41ms)` are one cause, and keying the
 * tally on the raw string split it into a bucket per millisecond: measured 2026-09-22 as
 * `20x"refused by server (ack 42ms)" 14x"refused by server (ack 41ms)" 12x"refused by server (ack
 * 40ms)"`, which reports the top THREE timings of one cause instead of the top three causes. The
 * same keying feeds the progress watchdog's "dominant reason", so a build stopped for one reason
 * would have named a fragment of it.
 */
export function normaliseWhy(why) {
    return (why || 'unknown')
        .replace(/\b\d+(\.\d+)?ms\b/g, 'Nms')
        .replace(/\(-?\d+, ?-?\d+, ?-?\d+\)/g, '(x,y,z)')
        .replace(/\b\d+(\.\d+)?\b/g, 'N')
        .slice(0, 60);
}

export function progressVerdict({ sinceLastPlaced, failuresByWhy, limit = 200 }) {
    if (sinceLastPlaced < limit) return null;
    let top = 'unknown', n = 0;
    for (const [why, count] of failuresByWhy ?? []) if (count > n) { n = count; top = why; }
    return {
        stop: true,
        why: `${sinceLastPlaced} consecutive attempts placed nothing - dominant reason: "${top}" (${n}x)`,
    };
}

/**
 * Build order: slice like a 3D printer, but INFILL BEFORE PERIMETER.
 *
 * Two problems are solved by ordering alone, and neither needs a single extra packet.
 *
 * 1. ACCESSIBILITY. The nozzle of a printer lives outside the model; ours lives inside it. Sorting
 *    by `y, x, z` sweeps each layer as a raster, so walls and interior fittings at the same height
 *    go up interleaved by coordinate and the enclosure forms around the bot as it works. It then
 *    has to fly back INTO a sealed room, which is the failure this repo spent 23 hours on: 5,238
 *    `flyNear ... failed` lines and `140-216x out of reach (no clear hover within range)` per pass,
 *    while the planner could always find a path and the body could not fly it. Building a cell
 *    before the cells that enclose it avoids the problem instead of getting better at it. So within
 *    each layer: cells whose four horizontal neighbours are all blueprint cells (infill - floors,
 *    interior fittings) go before cells that are not (the perimeter that seals them in).
 *
 * 2. ZIGZAG. A raster crosses the whole footprint on every row - 25 blocks of travel per row on
 *    survival_base, 69 on the cathedral - and every crossing is a flight leg that can wedge. A
 *    greedy nearest-neighbour chain walks the layer as a continuous path instead. Measured on the
 *    real blueprints, see tests/build_order.test.mjs.
 *
 * Layers stay in ascending y, because a support has to exist before the thing it supports, and the
 * existing `needsSupport` pass split stays exactly as it was - this reorders WITHIN each pass.
 *
 * Pure: takes and returns plain placement objects, so the ordering is testable without a bot.
 *
 * @param {Array} cells      placements to order
 * @param {Set<string>} all  "x,y,z" of EVERY blueprint cell, for the infill test
 */
export function orderForBuild(cells, all) {
    const layers = new Map();
    for (const p of cells) {
        if (!layers.has(p.y)) layers.set(p.y, []);
        layers.get(p.y).push(p);
    }
    const isInfill = (p) => all.has(`${p.x + 1},${p.y},${p.z}`) && all.has(`${p.x - 1},${p.y},${p.z}`)
        && all.has(`${p.x},${p.y},${p.z + 1}`) && all.has(`${p.x},${p.y},${p.z - 1}`);

    const out = [];
    let cursor = null;
    for (const y of [...layers.keys()].sort((a, b) => a - b)) {
        const layer = layers.get(y);
        for (const group of [layer.filter(isInfill), layer.filter(p => !isInfill(p))]) {
            if (!group.length) continue;
            out.push(...grow(group, cursor, all, y));
            cursor = out[out.length - 1];
        }
    }
    return out;
}

/**
 * Emit a layer's cells so that each one has something to CLICK, preferring the nearest.
 *
 * Travel order and dependency order are different problems, and the first version of this solved
 * only the first. A pure nearest-neighbour chain walks a cluster beautifully and then rings out to
 * the next cluster, whose first cell has no placed neighbour at all - and a block with no solid
 * face to click against cannot be placed. Measured 2026-09-22 on the wizard tower: the failure
 * tally went from ~9% to `161x"no solid neighbor (self=air below=air/empty)"`, 45% of all failures,
 * as the build rose off the ground plane and cells stopped having support underneath.
 *
 * So: grow from what exists. A cell is READY when the layer below holds a blueprint cell under it
 * (that is the face it will be placed against) or when a neighbour in this layer has already been
 * emitted. Ready cells are taken nearest-first, so the travel win survives; emitting one makes its
 * four neighbours ready, which is how a region unfolds from its supported edge. When nothing is
 * ready and cells remain - a genuinely floating island - the nearest is taken anyway and the
 * builder's retry pass deals with it, because refusing to emit it would drop it from the build.
 */
function grow(group, from, all, y) {
    const key = (p) => `${p.x},${p.z}`;
    const pending = new Map(group.map(p => [key(p), p]));
    const supported = (p) => all.has(`${p.x},${y - 1},${p.z}`);
    const ready = new Map();
    for (const p of group) if (supported(p)) ready.set(key(p), p);

    const out = [];
    let cur = from;
    const nearest = (pool) => {
        let best = null, bestD = Infinity;
        for (const p of pool.values()) {
            const d = cur ? Math.abs(p.x - cur.x) + Math.abs(p.z - cur.z) : 0;
            if (d < bestD || (d === bestD && best && (p.x < best.x || (p.x === best.x && p.z < best.z)))) {
                best = p; bestD = d;
            }
        }
        return best;
    };
    while (pending.size) {
        const pick = nearest(ready.size ? ready : pending);
        if (!pick) break;
        pending.delete(key(pick));
        ready.delete(key(pick));
        out.push(pick);
        cur = pick;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = `${pick.x + dx},${pick.z + dz}`;
            const n = pending.get(k);
            if (n) ready.set(k, n);
        }
    }
    return out;
}

/**
 * Greedy nearest-neighbour chain over one group, starting nearest `from`.
 *
 * Ring search rather than a scan of every remaining cell: layers are dense, so the nearest unbuilt
 * cell is almost always within a block or two, and a full scan would be O(n^2) on a 560-cell
 * cathedral layer. Ties break on x then z so the order is DETERMINISTIC - a build order that
 * changes between runs cannot be compared between runs.
 */
export function chain(group, from) {
    const remaining = new Map(group.map(p => [`${p.x},${p.z}`, p]));
    const out = [];
    let cur = from && remaining.size
        ? [...remaining.values()].reduce((best, p) =>
            (Math.abs(p.x - from.x) + Math.abs(p.z - from.z)) < (Math.abs(best.x - from.x) + Math.abs(best.z - from.z))
                ? p : best)
        : group[0];
    while (remaining.size) {
        remaining.delete(`${cur.x},${cur.z}`);
        out.push(cur);
        if (!remaining.size) break;
        let next = null;
        for (let r = 1; r <= 64 && !next; r++) {
            const ring = [];
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // perimeter of the ring only
                    const hit = remaining.get(`${cur.x + dx},${cur.z + dz}`);
                    if (hit) ring.push(hit);
                }
            }
            if (ring.length) ring.sort((a, b) => a.x - b.x || a.z - b.z);
            next = ring[0] ?? null;
        }
        cur = next ?? remaining.values().next().value;   // disjoint island: take any and carry on
    }
    return out;
}

/**
 * Diff the world against a placements JSON: the LLM-friendly view of a build.
 * Instead of a voxel dump (which a small model cannot reason over), returns a short
 * imperative fix-list of the nearest mismatches, plus an honest total. Same output
 * philosophy as construction_tasks.js explainLevelDifference.
 */
export function blueprintStatus(agent, filePath, origin, limit = 10) {
    const bot = agent.bot;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const all = (raw.placements || raw).filter(p => !isImplicitHalf(p));

    let match = 0, unloaded = 0;
    const mismatches = [];
    const here = bot.entity.position;
    for (const p of all) {
        const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
        const b = bot.blockAt(P);
        if (!b) { unloaded++; continue; }
        if (b.name === p.name) {
            const wrong = orientationMismatch(p, b);
            if (!wrong) { match++; continue; }
            mismatches.push({ p, P, existing: `${b.name} (${wrong})`, d: here.distanceTo(P) });
            continue;
        }
        mismatches.push({ p, P, existing: b.name, d: here.distanceTo(P) });
    }
    mismatches.sort((a, b) => a.d - b.d);

    const checked = all.length - unloaded;
    const pct = checked > 0 ? ((match / checked) * 100).toFixed(1) : '0.0';
    let out = `BUILD STATUS (${filePath} at ${origin.x},${origin.y},${origin.z}):\n`;
    out += `${match}/${checked} checked blocks correct (${pct}%).`;
    if (unloaded) out += ` ${unloaded} cells unloaded - move closer to check those.`;
    if (mismatches.length === 0) {
        out += unloaded ? '' : '\nBuild is COMPLETE.';
        return out;
    }
    out += `\n${mismatches.length} blocks need fixing. Nearest ${Math.min(limit, mismatches.length)}:`;
    for (const m of mismatches.slice(0, limit)) {
        const what = `${m.p.name}${propSummary(m.p)}`;
        if (m.existing === 'air' || REPLACEABLE.has(m.existing)) {
            out += `\n- Place ${what} at (${m.P.x}, ${m.P.y}, ${m.P.z})`;
        } else {
            out += `\n- Replace the ${m.existing} with ${what} at (${m.P.x}, ${m.P.y}, ${m.P.z})`;
        }
    }
    return out;
}

const PAUSABLE_MODES = ['unstuck', 'cowardice', 'self_defense', 'night_safety', 'hunting',
    'item_collecting', 'torch_placing', 'elbow_room', 'idle_staring'];
// Genuine safety modes, NOT in PAUSABLE_MODES because in survival they must keep firing. In
// creative the bot is invulnerable to what they protect against, so their only effect is to
// interrupt the build. Paused only when the game mode is creative.
export const CREATIVE_INVULNERABLE_MODES = ['self_preservation', 'drowning'];

// Heartbeat so an external watchdog can tell "build in progress" from "build died with the
// process" (the service gets restarted out from under us) and re-issue the command.
// The trend file is rotated at this size: ~150 bytes a sample, two a minute, so about three weeks.
const METRICS_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Publish the build's state. Every call site already reports its phase through here, so enriching
 * this one function instruments the clear, the foundation, both passes and every retry round.
 *
 * Writes the full telemetry snapshot to BUILD_STATUS.json - at most once a second (it used to be
 * once per CELL), always immediately on a phase change or when forced - and appends a trend sample
 * to BUILD_METRICS.jsonl every SAMPLE_EVERY_MS. The file keeps the old top-level keys (phase,
 * placed, failed, done, total) so anything already watching it keeps working.
 */
function writeStatus(agent, data = {}, { force = false } = {}) {
    const tel = agent.buildTelemetry;
    const now = Date.now();
    if (tel) {
        if (data.phase) tel.setPhase(data.phase, now);
        if (data.phase === 'clear') { tel.clear.layer = data.layer; tel.clear.visited = (data.row ?? -1) + 1; }
        if (data.phase === 'foundation' && data.placed !== undefined) tel.foundation.placed = data.placed;
        if (data.verifiedPct !== undefined) tel.verified = { pct: data.verifiedPct, match: data.match, total: data.total };
    }
    const phaseChanged = tel && tel.writtenPhase !== tel.phase;
    if (!force && !phaseChanged && now - (agent.buildStatusWrittenAt || 0) < 1000) return;
    agent.buildStatusWrittenAt = now;
    let payload;
    if (tel) {
        payload = tel.snapshot(now);
        delete payload.history;                 // the trend lives in BUILD_METRICS.jsonl
        tel.writtenPhase = tel.phase;
    } else {
        payload = { ts: now, ...data };
    }
    try {
        fs.writeFileSync(`bots/${agent.name}/BUILD_STATUS.json`, JSON.stringify(payload));
    } catch (e) { /* status is best-effort */ }
    const sample = tel?.maybeSample(now);
    if (sample) {
        const file = `bots/${agent.name}/BUILD_METRICS.jsonl`;
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > METRICS_MAX_BYTES) fs.renameSync(file, `${file}.1`);
            fs.appendFileSync(file, JSON.stringify(sample) + '\n');
        } catch (e) { /* best-effort */ }
    }
}

/**
 * Stop this phase if anything has asked the bot to stop. Thrown, not returned, so it leaves the
 * build the same way the passes do and the ActionManager sees the action END.
 *
 * WHY EVERY PER-CELL LOOP NEEDS THIS. When a mode interrupts, the ActionManager does not wait
 * forever: it asks, polls for ten seconds, and then KILLS THE PROCESS (`Agent process exited with
 * code 1`). A loop that notices the interrupt one cell at a time - `goNear` returns false, so
 * `continue` - keeps walking the rest of its cells, each failing instantly inside the flight
 * primitives, and on a big footprint that outlasts the ten seconds. Measured 2026-09-24 on the
 * cathedral (69x110): `mode:drowning` fired at 18:42:54 during the foundation phase, the log
 * filled with `flyNear (...) failed: interrupted` dozens of times a second alongside `waiting for
 * code to finish executing...`, and at 18:43:04 the agent process was killed. Seven hours of idle
 * followed. The passes had this check all along ("Without this the loop walks thousands of
 * remaining cells after a `!stop`") and the two phases before them did not.
 */
function yieldIfInterrupted(bot) {
    if (bot.interrupt_code) throw new Error('interrupted');
}

/**
 * Clear natural terrain out of the lowest layers of the footprint, nearest-first per layer.
 * Exported so an interrupted run can be asserted to stop, rather than trusted to.
 */
export async function clearTerrainLayers(agent, bot, origin, size, ctx, total, { skip = null } = {}) {
    for (let y = 0; y < Math.min(6, size.height); y++) {
        yieldIfInterrupted(bot);
        console.log(`[builder] clearing terrain layer ${y}`);
        // SCAN FIRST, THEN DIG IN A CONTINUOUS PATH. The raster this replaced walked x-then-z over
        // every cell and dug the ones holding terrain - but terrain is SCATTERED, so consecutive
        // digs were arbitrarily far apart and the bot flew across the footprint between single
        // blocks. Same fix as `orderForBuild` applies to placements: collect the targets, then
        // visit them nearest-first. Scanning is `blockAt` only, so it costs nothing next to one
        // wasted flight.
        let targets = layerClearTargets(bot, origin, size, ctx.occupied, y);
        // `skip`: on a resume, terrain UNDER built work is left alone - the same enclosure that makes
        // roofed placements slow (see roofedLast) made this phase take 39 minutes on 2026-09-25 for
        // a handful of stray dirt blocks inside the cathedral's walls.
        if (skip) {
            const kept = targets.filter(t => !skip(t));
            if (kept.length < targets.length)
                console.log(`[builder] layer ${y}: leaving ${targets.length - kept.length} terrain cell(s) under built work alone`);
            targets = kept;
        }
        if (!targets.length) continue;
        const here = bot.entity.position;
        const ordered = chain(targets, { x: here.x - origin.x, z: here.z - origin.z });
        console.log(`[builder] layer ${y}: ${ordered.length} cells to clear, ordered nearest-first`);
        if (agent.buildTelemetry) agent.buildTelemetry.clear.targets = ordered.length;
        for (let i = 0; i < ordered.length; i++) {
            // Before any await and before any status write: an interrupted bot touches nothing.
            yieldIfInterrupted(bot);
            const t = ordered[i];
            // heartbeat per DIG, not per row: a dig-dense stretch outlasts every staleness
            // threshold, and a "stale" live build gets killed by its own watchdog
            writeStatus(agent, { phase: 'clear', layer: y, row: i, total, digging: true });
            const P = new Vec3(origin.x + t.x, origin.y + t.y, origin.z + t.z);
            const b = bot.blockAt(P);
            if (!b || !NATURAL_TERRAIN.has(b.name)) continue;   // a neighbour's dig took it
            if (!(await goNear(bot, P, 3.0, ctx))) continue;    // unreachable bump; skip
            await new Promise(r => setTimeout(r, 120));         // stay under the packet limiter
            try { await bot.dig(b, true); } catch (e) { /* skip stubborn */ }
            // A dig places nothing, but it is work: without this the clear read as 0 attempts a minute,
            // indistinguishable from a hang, for as long as it ran.
            agent.buildTelemetry?.recordAttempt(Date.now(), { placed: false });
        }
    }
}

/**
 * Underpin every ground-layer cell down to real ground (max 8 deep) so the base never floats -
 * natural terrain is never flat enough for a large footprint. Returns how many blocks it placed.
 */
export async function placeFoundation(agent, bot, origin, groundCells, ctx, total) {
    let foundationPlaced = 0, tooDeep = 0, unread = 0;
    for (const p of groundCells) {
        yieldIfInterrupted(bot);
        const top = new Vec3(origin.x + p.x, origin.y - 1, origin.z + p.z);
        let groundY = null, sawUnread = false;
        for (let depth = 0; depth < FOUNDATION_DEPTH; depth++) {
            const b = bot.blockAt(top.offset(0, -depth, 0));
            if (!b) { sawUnread = true; break; }
            if (b.boundingBox === 'block') { groundY = top.y - depth; break; }
        }
        // A skipped column is a base cell that can never be placed, and everything above it. That
        // used to be a bare `continue`, so `foundation: 2607 support blocks placed` was true while
        // 617 columns over a lake were left unsupported and unmentioned - and the passes then
        // failed on them one at a time until the watchdog stopped the build.
        if (groundY === null) {
            if (sawUnread) unread++; else tooDeep++;
            // live, not only at the end: a foundation that has already met 400 unreachable columns
            // should say so while it is still running, not after
            if (agent.buildTelemetry) Object.assign(agent.buildTelemetry.foundation, { tooDeep, unread });
            continue;
        }
        if (groundY === top.y) continue;
        for (let y = groundY + 1; y <= top.y; y++) {
            yieldIfInterrupted(bot);
            let res;
            try {
                res = await placeOne(bot, new Vec3(top.x, y, top.z), { name: 'cobblestone', properties: {} }, ctx);
            } catch (e) {
                // One bad column must not abort the whole run - this exact leak silently killed
                // runs for hours (the pass loops caught it, this one didn't). BUT AN INTERRUPT IS
                // NOT A BAD COLUMN. Swallowing it here is how a drowning interrupt turned into a
                // killed process: the catch kept the loop alive past the ActionManager's
                // ten-second grace. So an interrupt goes up; everything else is logged and skipped.
                yieldIfInterrupted(bot);
                console.log(`[builder] foundation threw at ${top.x},${y},${top.z}: ${e.message}`);
                agent.buildTelemetry?.recordAttempt(Date.now(), { placed: false });
                continue;
            }
            if (res.ok && !res.skipped) foundationPlaced++;
            // Every attempt, not every 25th placement: the old cadence left a slow stretch of the
            // foundation writing nothing at all, which reads from outside exactly like a hang.
            // writeStatus throttles itself to once a second, so this costs nothing.
            agent.buildTelemetry?.recordAttempt(Date.now(), { placed: res.ok && !res.skipped });
            writeStatus(agent, { phase: 'foundation', placed: foundationPlaced, total });
        }
    }
    if (agent.buildTelemetry) Object.assign(agent.buildTelemetry.foundation, { placed: foundationPlaced, tooDeep, unread });
    if (tooDeep) console.log(`[builder] foundation: ${tooDeep} of ${groundCells.length} columns have no ground `
        + `within ${FOUNDATION_DEPTH} blocks - their base cells, and everything built on them, cannot be placed`);
    if (unread) console.log(`[builder] foundation: ${unread} columns were unreadable (chunk not loaded) and were skipped`);
    return foundationPlaced;
}

export async function buildBlueprint(agent, filePath, origin) {
    const bot = agent.bot;
    if (bot.game.gameMode !== 'creative')
        return 'Blueprint building needs creative mode (for flight and instant block breaking). Ask an operator for /gamemode creative.';

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const all = raw.placements || raw;
    const meta = raw.meta || {};

    // pass 1: free-standing blocks bottom-up; pass 2: support-dependent blocks
    const needsSupport = (p) => WALL_ATTACHED.test(p.name) || (p.properties || {}).hanging === 'true'
        || p.name.endsWith('_carpet') || /(_torch|lantern)$/.test(p.name);
    const buildable = all.filter(p => !isImplicitHalf(p));
    // Every blueprint cell, for the infill test - including the ones filtered out of these passes,
    // because a wall that seals a room counts as enclosing it whether or not we place it in pass1.
    const allCells = new Set(buildable.map(p => `${p.x},${p.y},${p.z}`));
    const pass1 = orderForBuild(buildable.filter(p => !needsSupport(p)), allCells);
    const pass2 = orderForBuild(buildable.filter(needsSupport), allCells);

    for (const m of PAUSABLE_MODES) { try { bot.modes.pause(m); } catch (e) { /* mode absent */ } }
    // `self_preservation` is deliberately NOT in PAUSABLE_MODES - it is a genuine safety mode and
    // must keep firing in survival. In CREATIVE it cannot help: the bot is invulnerable, so the
    // mode has nothing to preserve it from and its only remaining effect is to interrupt.
    //
    // And an interrupt here is not a pause, it is the end of the build. Measured 2026-09-01 on
    // the Wizard Tower: one `self_preservation` trigger threw `Error: interrupted` out of the
    // foundation pass, the model was handed "(AUTO MESSAGE) your previous action was interrupted",
    // answered "Bob here! ... What's next?", and the bot stood idle for NINETY-FIVE MINUTES having
    // placed zero blocks. resume:true does not save this, because the action ended by throwing
    // rather than completing.
    //
    // `drowning` is the same case, and was missed: a creative player takes no drowning damage,
    // so the mode can only interrupt. It did, on 2026-09-24 - the cathedral's foundation pass fills
    // cobblestone down through standing water to real ground, the bot followed it under, and after
    // 10.2s submerged `mode:drowning` interrupted the build. That interrupt, meeting a phase that
    // did not yield, killed the agent process; seven hours of idle followed. Paused here for the
    // same reason as self_preservation, and restored by the same `unPauseAll` at the end.
    if (bot.game?.gameMode === 'creative') {
        for (const m of CREATIVE_INVULNERABLE_MODES) {
            try { bot.modes.pause(m); console.log(`[builder] paused ${m} (creative: nothing to preserve)`); }
            catch (e) { /* mode absent */ }
        }
    }

    // A blueprint already started on an overlapping footprint is RESUMED there, whatever origin was
    // asked for this time. Before ctx, because everything below is derived from `origin`.
    const footprint = (() => {
        const xs = all.map(p => p.x), zs = all.map(p => p.z);
        return { width: Math.max(...xs) - Math.min(...xs) + 1, length: Math.max(...zs) - Math.min(...zs) + 1 };
    })();
    const recorded = recordedSiteFor(readSites(agent), filePath, origin, footprint);
    if (recorded && (recorded.x !== origin.x || recorded.y !== origin.y || recorded.z !== origin.z)) {
        console.log(`[builder] ${filePath} was already started at (${recorded.x}, ${recorded.y}, `
            + `${recorded.z}), overlapping the requested (${origin.x}, ${origin.y}, ${origin.z}) - resuming there`);
    }
    if (recorded) origin = new Vec3(recorded.x, recorded.y, recorded.z);

    // One telemetry object per build, replacing the last one - the UI keeps showing a finished or
    // stopped build until the next one starts, which is when its result is still worth reading.
    const tel = agent.buildTelemetry = new BuildTelemetry({ file: filePath, origin, total: buildable.length, now: Date.now() });
    tel.maxLayer = Math.max(...buildable.map(p => p.y));

    // scaffold context: which cells the blueprint owns (never pillar there), and the live
    // dirt pillar under the bot (always dismantled before moving on)
    const ctx = {
        origin,
        agent,
        occupied: new Set(all.map(p => `${p.x},${p.y},${p.z}`)),
        pillar: [],
        // world-space XZ bounds of the footprint, for the leash in goNear
        box: (() => {
            const xs = all.map(p => origin.x + p.x), zs = all.map(p => origin.z + p.z);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minZ = Math.min(...zs), maxZ = Math.max(...zs);
            const topY = origin.y + Math.max(...all.map(p => p.y)) + 5;
            return { minX, maxX, minZ, maxZ, topY,
                     centreX: Math.round((minX + maxX) / 2), centreZ: Math.round((minZ + maxZ) / 2) };
        })(),
    };
    tel.ctxRef = ctx;
    writeStatus(agent, { phase: 'preflight' }, { force: true });
    // Consumables the build needs but the blueprint never names, parked where equips of build
    // blocks cannot evict them. `equip()` rotates hotbar slots 36-43, so 44 is the one spare
    // hotbar slot; 9 is a plain main-inventory slot (0-8 are crafting/armour, 36-44 the hotbar,
    // 45 the off-hand), which nothing in this builder touches.
    //
    // dirt      - the scaffold pillar `scaffoldTo` climbs and `pillarDown` removes.
    // scaffolding - stocked automatically so it is on hand without a /give, but NOT wired into
    //   the pillar, and deliberately absent from skills.STACKABLE so pillarUp cannot reach for
    //   it. MEASURED on this server (tools/scaffold_probe.mjs), because it is the obvious
    //   upgrade and it does not work here:
    //     tower 1/6 | climb 1.00 | chain-break YES | reach 1
    //   One block places fine on any solid support, and breaking the bottom of a column clears
    //   the whole thing in a single dig - which is exactly what pillarDown's per-block loop
    //   wants. But STACKING is refused: clicking a scaffolding block while holding scaffolding
    //   is rejected by the server (ack in 16-59ms, so it is a decision and not a timeout),
    //   identically through our own packet path AND mineflayer's, so it is a server rule and
    //   not our code. /setblock holds the same stack happily, so the position is legal - it is
    //   the PLACEMENT that is refused, because scaffolding is self-replaceable and the click
    //   resolves onto the block you aimed at rather than the cell beside it.
    //   Building a real tower therefore needs the vanilla technique - rise inside the column
    //   placing into your OWN cell - which is precisely what `bodyClearsCell` and `stepOff`
    //   exist to prevent for solid blocks. Until that technique exists, dirt stays the pillar.
    try { await bot.creative.setInventorySlot(44, mc.makeItem('dirt', 64)); } catch (e) { /* pillarUp will report */ }
    try {
        await bot.creative.setInventorySlot(9, mc.makeItem('scaffolding', 64));
        console.log('[builder] stocked 64 scaffolding (slot 9)');
    } catch (e) { console.log(`[builder] could not stock scaffolding: ${e.message}`); }

    // Flight is the whole reason this command requires creative mode - see the guard at the top
    // of buildBlueprint. `ctx.flying` records that WE started it, because stopFlying without a
    // matching startFlying nulls bot.physics.gravity and breaks walking for the rest of the
    // session (creative.js captures normalGravity lazily).
    // TRAVEL TO THE SITE FIRST, if we are not on it. `buildBlueprint` assumes it starts near its
    // own footprint: SITE_LEASH is 24 blocks, and `goNear`'s off-site recovery walks the bot back
    // TOWARD the footprint, so starting a build from far away has the builder fighting its own
    // leash - bridging over terrain it never needed to cross, at one cell per leg. Measured three
    // times on 2026-09-22: issued from 78 blocks out it pinned and bridged instead of building;
    // issued from 70 blocks out at y=59 it inched along `pinned` for a minute with no status
    // written at all. Travel is the navigator's job (CLAUDE.md: !travel / !navTo for journeys, the
    // builder for the site), so hand it there before anything else rather than requiring whoever
    // sends the command to remember.
    {
        const away = offSite(bot.entity.position, ctx.box);
        if (away) {
            const dest = { x: ctx.box.centreX, y: origin.y + 2, z: ctx.box.centreZ };
            writeStatus(agent, { phase: 'travel' }, { force: true });
            console.log(`[builder] off site - walking to the footprint centre `
                + `(${dest.x}, ${dest.y}, ${dest.z}) before starting`);
            try {
                await nav.navigateTo(bot, dest, { arriveDist: SITE_LEASH - 4, arriveY: 6, maxReplans: 6 });
            } catch (e) { console.log(`[builder] travel to the site failed: ${e.message}`); }
            const still = offSite(bot.entity.position, ctx.box);
            console.log(still
                ? `[builder] STILL off site at ${bot.entity.position.floored()} - building from here `
                  + `will fight the leash; expect "out of reach" until it closes the distance`
                : `[builder] on site at ${bot.entity.position.floored()}`);
        }
    }

    // PREFLIGHT, before a single block moves - and on a FRESH site, ACT on it (decideSite). Names
    // it cannot place are still only reported: a blueprint with two unknown names builds the
    // other 8,333 blocks.
    try {
        const probe = {
            hasItem: (name) => { try { return !!mc.getItemId(name); } catch (e) { return false; } },
            surfaceAt: (x, z) => { const y = nav.surfaceY(bot, x, z, origin.y + 40, origin.y - 20); return y === null ? null : y - 1; },
            waterAt: (x, y, z) => {
                const b = bot.blockAt(new Vec3(x, y, z));
                return !!b && (b.name === 'water' || b.name === 'bubble_column');
            },
            naturalAt: (x, z) => {
                const y = nav.surfaceY(bot, x, z, origin.y + 40, origin.y - 20);
                if (y === null) return true;                       // unknown is not evidence of a build
                const b = bot.blockAt(new Vec3(x, y - 1, z));
                return !b || NATURAL_SURFACE.has(b.name);
            },
            // the same test placeFoundation uses to decide where real ground starts
            solidAt: (x, y, z) => {
                const b = bot.blockAt(new Vec3(x, y, z));
                return b ? b.boundingBox === 'block' : null;   // null: unloaded, no evidence either way
            },
        };
        // Fresh = nothing of this blueprint stands here yet, on real evidence. Too few readable
        // cells is NOT fresh: moving or refusing a build needs a positive reading, not a guess.
        const here = presentFraction(bot, buildable, origin);
        const fresh = !recorded && here.sampled >= 20 && here.alreadyThere / here.sampled < 0.05;
        const decision = decideSite({
            requested: origin, fresh,
            preflightAt: (o) => preflightBuild(buildable, o, probe),
        });
        for (const line of decision.pf.lines) console.log(`[builder] preflight: ${line}`);
        tel.site.preflight = decision.pf.lines.slice();
        tel.site.notes = decision.notes.slice();
        for (const note of decision.notes) console.log(`[builder] site: ${note}`);
        if (decision.action === 'refuse') {
            console.log(`[builder] REFUSING to start: ${decision.why}`);
            tel.ended = `refused: ${decision.why}`;
            writeStatus(agent, { phase: 'refused' }, { force: true });
            // Nothing has begun yet - no flight, no ledger entry - so only the pauses need undoing.
            try { bot.modes.unPauseAll(); } catch (e) { /* best effort */ }
            return `NOT STARTED: ${filePath} at (${decision.origin.x}, ${decision.origin.y}, `
                + `${decision.origin.z}). ${decision.why}`;
        }
        if (decision.origin.y !== origin.y) {
            const dy = decision.origin.y - origin.y;
            origin = new Vec3(decision.origin.x, decision.origin.y, decision.origin.z);
            ctx.origin = origin;
            ctx.box.topY += dy;
            ctx.siteNotes = decision.notes;
            tel.origin = { x: origin.x, y: origin.y, z: origin.z };
        }
    } catch (e) { console.log(`[builder] preflight failed to run: ${e.message}`); }
    // From here on the build has a site. Recorded so a later request for this blueprint on an
    // overlapping footprint resumes HERE instead of starting a second copy beside it.
    recordSite(agent, filePath, origin);

    ctx.flying = flight.beginFlight(bot);
    console.log(ctx.flying
        ? '[builder] flight ENABLED - reaching high work directly instead of pillaring'
        : '[builder] flight unavailable (not creative) - walking and pillaring');

    let placed = 0, skipped = 0;
    // Watchdog state lives with the counters it guards, so the final report can say the build was
    // STOPPED rather than merely finishing early - a silent stop just moves the investigation.
    let sinceLastPlaced = 0, stoppedEarly = null;
    const byWhyLive = new Map();
    const failures = [];
    const started = Date.now();
    tel.failuresRef = failures;
    // Why the build ended, if it is not by reaching the verification below. A crash and an
    // interrupt otherwise look identical from outside: a status file that stops changing.
    let threw = null;
    try {
        // Tell the NAVIGATOR the build exists. scaffoldTo already consults ctx.occupied, but the
        // stall ladder inside nav.js does not - so without this the bot bridges dirt into the
        // floor it is laying and mines its own walls to walk through them. See build_guard.js.
        //
        // INSIDE the try, and it must stay there. The guard is module-level state and the
        // `finally` below is the only thing that stands it down; registered above the try, an
        // await that never settles (an interrupt, a wedged packet) leaks a guard that prices
        // real terrain at buildDigCost for the rest of the process - the same shape as
        // SwimAssist leaking liquidAcceleration and AutoJump's leaked `active` flag.
        const guarded = buildGuard.protectBuild(all.map(q => ({
            x: origin.x + q.x, y: origin.y + q.y, z: origin.z + q.z,
        })));
        console.log(`[builder] protecting ${guarded} cells from the navigator's dig/bridge recovery`);

        // walk to the site first so chunks stream in, then WAIT for them - a blockAt
        // against a not-yet-received column reads null
        await nav.navigateTo(bot, { x: origin.x + 16, y: origin.y, z: origin.z + 16 },
            { arriveDist: 12, arriveY: 8, maxReplans: 8 });
        const probe = await waitForBlock(bot, new Vec3(origin.x + 16, origin.y - 1, origin.z + 16), 20000);
        if (!probe) throw new Error('chunks at the build site never loaded');

        // HOW MUCH OF THIS BUILD ALREADY EXISTS? Sampled once, and it decides whether the
        // terrain clear runs at all. On a RESUMED build the clear pass is pure waste: it walks
        // every cell of the lower six layers looking for natural terrain that was dug out hours
        // ago, and on a site that is now a building it cannot even path - measured 2026-08-31,
        // 21 of 192 rows in ten minutes with the bot pinned inside its own walls. Every restart
        // paid that toll before placing a single block, and this build has been restarted a lot.
        const { alreadyThere, sampled } = presentFraction(bot, buildable, origin);
        const presentPct = sampled ? (alreadyThere / sampled) * 100 : 0;
        const resuming = sampled >= 20 && presentPct >= 25;
        console.log(`[builder] site is ${presentPct.toFixed(0)}% built (${alreadyThere}/${sampled} sampled)`
            + `${resuming ? ' - RESUMING' : ''}`);

        // ---- CLEAR NATURAL TERRAIN POKING INTO THE LOWER FLOORS, RESUME OR NOT ----
        //
        // This used to be gated on `!resuming`, which is the dominant bug shape again: "the site
        // looks 95% built" is true, and "therefore no terrain intrudes" does not follow from it.
        // The two are independent - a tall tower can be finished to its roof while its bottom
        // layers are still buried in the hillside they were sited on.
        //
        // Measured 2026-09-24 on the wizard tower, whose origin the preflight had already flagged
        // as `y=63 is 3 below grade (median surface 66) - about 4725 cells of terrain to clear`:
        // the run resumed at 95%, skipped the clear, and left 1304 of the blueprint's 1999
        // grass_block cells buried at local y=0. Read back from the live world at (4571,63,4595),
        // a grass_block cell: y=64 SOLID, y=65 air, y=66 air - and the blueprint places nothing at
        // local (1,1,1), so that solid block is leftover ground, not part of the build.
        //
        // It cost twice over. The cell is unreachable, because a flying bot cannot hover inside
        // rock ("out of reach (no clear hover within range)" was pass 1's largest failure class);
        // and grass with an opaque block directly above it decays to dirt, which is every one of
        // the 149 `grass_block -> dirt` differences the verifier reported.
        //
        // Running it unconditionally is close to free when there is nothing to do: the loop below
        // SCANS with `blockAt` (local and synchronous) and only flies to cells it actually found
        // holding terrain, so a site with a clear footprint digs nothing and pays a few thousand
        // in-memory reads.
        if (meta.size) {
            await clearTerrainLayers(agent, bot, origin, meta.size, ctx, buildable.length,
                { skip: resuming ? makeRoofProbe(bot, origin, meta.size.height) : null });
            // VERIFY THE PHASE, not just its steps. `placeOne` checks the block it placed; a phase
            // has a post-condition too, and this one's is "no natural terrain intrudes into the
            // footprint any more". Checking it turns the failure people notice by LOOKING - a bot
            // digging pits for twenty minutes, an origin a block below grade - into a line that
            // says so. Sampled, because a full re-read of six layers is 9,450 blockAt calls.
            let intruding = 0, checked = 0;
            for (let y = 0; y < Math.min(6, meta.size.height); y++) {
                for (let x = 0; x < meta.size.width; x += 3) {
                    for (let z = 0; z < meta.size.length; z += 3) {
                        if (ctx.occupied.has(`${x},${y},${z}`)) continue;
                        checked++;
                        const b = bot.blockAt(new Vec3(origin.x + x, origin.y + y, origin.z + z));
                        if (b && NATURAL_TERRAIN.has(b.name)) intruding++;
                    }
                }
            }
            console.log(intruding === 0
                ? `[builder] clear phase verified: no terrain intrudes (${checked} cells sampled)`
                : `[builder] clear phase INCOMPLETE: ${intruding} of ${checked} sampled cells still `
                  + `hold terrain - unreachable bumps, or the origin sits below grade`);
        }

        // foundation: underpin every ground-layer cell down to real ground (max 8 deep) so
        // the base never floats - natural terrain is never flat enough for a 32x31 footprint
        const foundationPlaced = await placeFoundation(agent, bot, origin, pass1.filter(q => q.y === 0), ctx, buildable.length);
        if (foundationPlaced) console.log(`[builder] foundation: ${foundationPlaced} support blocks placed`);

        // Resumed: enclosed stragglers last (see roofedLast). Only MISSING cells move - a cell that
        // is already right is skipped wherever it sits.
        if (resuming && meta.size) {
            const roofed = makeRoofProbe(bot, origin, meta.size.height);
            const deferIt = (q) => !cellIsDone(q, bot.blockAt(new Vec3(origin.x + q.x, origin.y + q.y, origin.z + q.z))) && roofed(q);
            const deferred = roofedLast(pass1, deferIt) + roofedLast(pass2, deferIt);
            console.log(`[builder] resume: ${deferred} missing cell(s) already have built work above them - they go LAST, after the open-sky work`);
        }

        // The passes themselves check the interrupt. Without this the loop walks thousands of
        // remaining cells after a `!stop`, each failing instantly inside the flight primitives.
        const interrupted = () => {
            if (!bot.interrupt_code) return false;
            console.log('[builder] interrupted - stopping the build here');
            return true;
        };
        for (const [passName, list] of [['pass1', pass1], ['pass2', pass2]]) {
            if (interrupted() || stoppedEarly) break;
            // Parked cells released by a placement go FIRST, so the deck grows outward from what was
            // just built while the bot is still beside it, instead of waiting for the plan to wander back.
            const frontier = new Frontier();
            let planned = 0;
            for (;;) {
                const p = frontier.next() ?? list[planned++];
                if (!p) break;
                if (bot.interrupt_code) throw new Error('interrupted');
                // PROGRESS WATCHDOG. Nothing about the world changes while the bot fails the same
                // way, so the (limit+1)th identical attempt cannot learn what the last limit did
                // not. Without this the builder ran 5,238 failures with `0 placed` for 23 hours.
                // A bot that cannot move will fail every remaining cell the same way. The watchdog
                // below would eventually catch it, but only after 200 attempts - and not at all
                // during a resume, where pre-existing cells keep resetting its counter. That is
                // how fifty minutes went by with `0 placed` and the log reporting progress.
                if (ctx.stuck) {
                    console.log(`[builder] STOPPING: ${ctx.stuck}`);
                    stoppedEarly = ctx.stuck;
                    break;
                }
                const verdict = progressVerdict({ sinceLastPlaced, failuresByWhy: byWhyLive });
                if (verdict) {
                    console.log(`[builder] STOPPING: ${verdict.why}`);
                    stoppedEarly = verdict.why;
                    break;
                }
                const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
                tel.layer = p.y; tel.target = { x: P.x, y: P.y, z: P.z };
                tel.pass = { name: passName, planned, length: list.length };
                let res;
                try {
                    res = await placeOne(bot, P, p, ctx);
                } catch (e) {
                    res = { ok: false, why: `threw: ${e.message}` };
                }
                tel.recordAttempt(Date.now(), { placed: res.ok && !res.skipped });
                if (res.ok) {
                    res.skipped ? skipped++ : placed++; sinceLastPlaced = 0; byWhyLive.clear();
                    if (!res.skipped) frontier.placed(p);
                } else if (isNotYet(res.why)) {
                    // not a failure yet: parked until a neighbour exists, and invisible to the
                    // watchdog, which is for a bot that is stuck rather than one that is early
                    frontier.park(p, res.why);
                    tel.counts.waiting = frontier.waiting.size;
                    continue;
                } else {
                    sinceLastPlaced++;
                    const k = normaliseWhy(res.why);
                    byWhyLive.set(k, (byWhyLive.get(k) || 0) + 1);
                    failures.push({ ...p, why: res.why });
                    if (failures.length <= 3) console.log(`[builder] FAIL ${p.name}@(${P.x},${P.y},${P.z}): ${res.why}`);
                }
                const done = placed + skipped + failures.length;
                Object.assign(tel.counts, { placed, skipped, failed: failures.length,
                    waiting: frontier.waiting.size, released: frontier.released });
                tel.sinceLastPlaced = sinceLastPlaced;
                // heartbeat EVERY block: a scaffolded placement can take a minute, and 25
                // of them outlasts the watchdog's staleness window - which then "rescues"
                // (interrupts) the live build. Same lesson as the per-dig heartbeat.
                writeStatus(agent, { phase: passName, done, total: buildable.length, placed, failed: failures.length });
                if (done % 200 === 0) {
                    const byWhy = new Map();
                    for (const f of failures) {
                        const k = (f.why || '?').slice(0, 45);
                        byWhy.set(k, (byWhy.get(k) || 0) + 1);
                    }
                    const top = [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
                        .map(([w, n]) => `${n}x"${w}"`).join(' ');
                    // Flight outcomes belong in THIS line. Keeping them only in the raw log cost an
                    // hour on 2026-09-22: a counter reading `routed=10 noroute=0` looked healthy
                    // while the loop actually burning the wall clock - the wedge rescue - never
                    // planned a route at all, because its failure path returned silently. A tally
                    // that does not cover the failing call site reports the wrong story confidently.
                    console.log(`[builder] ${done}/${buildable.length} (${placed} placed, ${skipped} pre-existing, ${failures.length} failed) [${passName}] ${top} | scaffold ok=${ctx.scaffoldOk||0} short=${ctx.scaffoldShort||0} nocol=${ctx.scaffoldNoCol||0} leash=${ctx.leashed||0} | rescues=${ctx.rescues||0} recentre=${ctx.recentres||0} support=${ctx.supportsUsed||0}/${ctx.supportsBuilt||0} yaw=${ctx.yawAimed||0} refacing=${ctx.facingRepairsTried||0} waiting=${frontier.waiting.size} released=${frontier.released} dry=${sinceLastPlaced}`);
                }
            }
            const neverReached = frontier.drain();
            if (neverReached.length) {
                console.log(`[builder] ${passName}: ${neverReached.length} cell(s) never got a neighbour to click `
                    + `against (${frontier.released} were released and retried) - handing them to the retry rounds`);
                failures.push(...neverReached);
            }
        }

        // RETRY WHILE A PASS IS STILL PAYING FOR ITSELF.
        //
        // This used to retry ONCE, and only when fewer than a quarter of the cells had failed:
        // "if MOST blocks failed the problem is systemic (bad chunks, wrong origin) and retrying
        // thousands of 20s fly-and-wait attempts would pin the agent for days". The instinct was
        // right and the test was exactly backwards. A blueprint is built from the ground up, so a
        // cell whose support has not been placed YET fails for a reason the NEXT pass removes -
        // and the more of them fail, the more the next pass has to gain. The gate therefore
        // switched the retry off precisely in the case it exists for.
        //
        // Measured on the wizard tower (8,335 cells), replaying the real order over the real
        // blueprint and placing only what has something to click when its turn comes:
        //   pass 1  +2569  30.8%      pass 4  +37   99.2%
        //   pass 2  +5214  93.4%      ...
        //   pass 3  +452   98.8%      pass 11 +0    99.7%  <- fixed point
        // Three live runs each failed the `< buildable/4` test (3,453 failures of 8,285, 42%), so
        // the retry list was EMPTY every time and the build stopped one pass in, at 28% and then
        // 46%. The 1,887 `no solid neighbor` failures were almost all pass-1 ordering artefacts
        // that a second pass would have cleared.
        //
        // The honest stopping rule is the one CLAUDE.md already states for retries: reset on a
        // change in the INPUTS, never on a clock or a count. A pass that placed blocks CHANGED the
        // inputs for every cell that touches them, so it earns another. A pass that placed nothing
        // did not, and no number of further passes can learn what it failed to. The watchdog
        // (`progressVerdict`) still bounds the inside of each pass, and MAX_RETRY_ROUNDS bounds the
        // outside, at a little over the measured fixed point.
        let round = 0, phaseRounds = 0;
        while ((failures.length || ctx.brokenForEscape?.length)
               && phaseRounds < MAX_RETRY_ROUNDS && !stoppedEarly && !interrupted()) {
            round++; phaseRounds++;
            // Anything the escape had to break to free the bot is owed back. It was verified
            // before, so nothing else would ever look at it again.
            if (ctx.brokenForEscape?.length) {
                console.log(`[builder] re-placing ${ctx.brokenForEscape.length} block(s) broken to free the bot`);
                failures.push(...ctx.brokenForEscape.splice(0));
            }
            const todo = failures.splice(0, failures.length);
            // THE SAME PARKING AS THE PASSES (see Frontier). The retry rounds lacked it, and a retry
            // round is MOSTLY "no solid neighbor" cells - they are what a pass hands on. So they
            // counted toward the watchdog here, and on 2026-09-26 the cathedral stopped at 94.8% in
            // retry round 1 on `200 consecutive attempts placed nothing - no solid neighbor` (200x),
            // in a round that had placed 227 blocks - with 1,605 such cells still to try, and no
            // way for a placement to release its neighbours until the next round.
            const frontier = new Frontier();
            let gained = 0, retried = 0, nextTodo = 0;
            for (;;) {
                const p = frontier.next() ?? todo[nextTodo++];
                if (!p) break;
                if (bot.interrupt_code) throw new Error('interrupted');
                const verdict = ctx.stuck ? { why: ctx.stuck }
                    : progressVerdict({ sinceLastPlaced, failuresByWhy: byWhyLive });
                if (verdict) {
                    console.log(`[builder] STOPPING: ${verdict.why}`);
                    stoppedEarly = verdict.why;
                    // Whatever is left of this round has not been attempted; it is still a failure.
                    failures.push(p, ...frontier.ready.splice(0), ...todo.slice(nextTodo), ...frontier.drain());
                    break;
                }
                const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
                tel.layer = p.y; tel.target = { x: P.x, y: P.y, z: P.z };
                tel.pass = { name: `retry${round}`, planned: retried, length: todo.length };
                let res;
                try {
                    res = await placeOne(bot, P, p, ctx);
                } catch (e) {
                    res = { ok: false, why: `threw: ${e.message}` };
                }
                tel.recordAttempt(Date.now(), { placed: res.ok && !res.skipped });
                if (res.ok) {
                    res.skipped ? skipped++ : placed++;
                    gained++; sinceLastPlaced = 0; byWhyLive.clear();
                    if (!res.skipped) frontier.placed(p);
                } else if (isNotYet(res.why)) {
                    // Not a failure yet and not a watchdog tick: the face check runs before any flight,
                    // so it cost nothing. Released by a neighbour's placement, or failed at round end.
                    frontier.park(p, res.why);
                } else {
                    sinceLastPlaced++;
                    const k = normaliseWhy(res.why);
                    byWhyLive.set(k, (byWhyLive.get(k) || 0) + 1);
                    failures.push({ ...p, why: res.why });
                }
                ++retried;
                Object.assign(tel.counts, { placed, skipped, failed: failures.length + Math.max(0, todo.length - nextTodo),
                    waiting: frontier.waiting.size, released: frontier.released });
                tel.sinceLastPlaced = sinceLastPlaced;
                writeStatus(agent, { phase: `retry${round}`, done: retried, total: todo.length, placed, failed: failures.length });
            }
            if (!stoppedEarly) failures.push(...frontier.drain());
            console.log(`[builder] retry round ${round}: ${gained} placed, ${failures.length} still failing`);
            if (gained > 0) continue;
            // A round that gained nothing is the fixed point of ordinary placement. THAT is the
            // moment temporary supports are worth their cost: everything cheap has been tried, and
            // what is left is geometry with nothing to click, forever. One more round with them
            // enabled, and if that gains nothing either, the build is genuinely done.
            if (!ctx.allowSupports) {
                ctx.allowSupports = true;
                phaseRounds = 0;   // a new phase, with its own budget (see MAX_RETRY_ROUNDS)
                console.log(`[builder] retrying stopped paying at ${failures.length} failures - enabling temporary supports`);
                continue;
            }
            break;
        }
    } catch (e) {
        threw = e;
        throw e;
    } finally {
        if (threw) {
            tel.ended = bot.interrupt_code || threw.message === 'interrupted'
                ? `interrupted${bot.interrupt_code ? ` by ${bot.interrupt_code}` : ''}`
                : `threw: ${threw.message}`;
            writeStatus(agent, { phase: 'ended' }, { force: true });
        }
        // A guard that outlives its build would make every later journey route around a
        // structure nobody is working on any more - and the escape valve would never fire,
        // because the bot is not enclosed, it is just walking past.
        // Anything a dig refused earlier gets one more attempt now that the build is over and
        // nothing is in the way. A support left standing is an unwanted block in a finished
        // structure, and the verified percentage cannot see it - it is not a blueprint cell.
        if (ctx.supportDebt?.length) {
            console.log(`[builder] ${ctx.supportDebt.length} temporary support block(s) still standing - sweeping`);
            await tearDownSupport(bot, [...ctx.supportDebt].reverse(), ctx);
        }
        ctx.supportsLeft = ctx.supportDebt?.length || 0;
        buildGuard.clearProtectedBuild();
        // Strictly paired with beginFlight. Never call it speculatively - see flight.js.
        flight.endFlight(bot, ctx.flying);
        try { bot.modes.unPauseAll(); } catch (e) { /* best effort */ }
        // NOTE: no stopFlying here - we never startFlying now, and calling stopFlying
        // without a prior startFlying sets bot.physics.gravity to null (creative.js
        // captures normalGravity lazily), which breaks walking physics entirely.
    }

    // verification against the world, never against our own bookkeeping
    if (stoppedEarly) tel.stopped = stoppedEarly;
    writeStatus(agent, { phase: 'verify' }, { force: true });
    let match = 0, misfacing = 0;
    for (const p of buildable) {
        const b = bot.blockAt(new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z));
        if (!b || b.name !== p.name) continue;
        if (orientationMismatch(p, b)) { misfacing++; continue; }   // right block, wrong way round
        match++;
    }
    const pct = ((match / buildable.length) * 100).toFixed(1);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    tel.ended = stoppedEarly ? `stopped: ${stoppedEarly}` : 'done';
    tel.verifiedMisfacing = misfacing;
    writeStatus(agent, { phase: stoppedEarly ? 'stopped' : 'done', verifiedPct: Number(pct), match, total: buildable.length }, { force: true });
    let out = `VERIFIED BUILD: ${match}/${buildable.length} blocks match (${pct}%) after ${mins} min. `
        + `${placed} placed, ${skipped} already correct, ${failures.length} failed.`;
    if (stoppedEarly) out += ` STOPPED EARLY: ${stoppedEarly}`;
    // Named explicitly, because a silent orientation failure is what made the whole class invisible.
    if (misfacing) out += ` ${misfacing} have the right block facing the WRONG WAY (not counted as matching).`;
    // Facing repairs, reported whether they worked or not. `tried` without a fall in `misfacing`
    // means the re-place is landing the same wrong way round, which is a different fault from
    // never having attempted it - and "never attempted it" is exactly what the old name-only skip
    // did, invisibly, for 339 cells.
    // Where it was built, if that is not where it was asked for - the one decision the requester
    // did not make, so it must not be discovered by walking to the wrong spot.
    if (ctx.siteNotes?.length) out += ` Site: ${ctx.siteNotes.join('; ')}.`;
    if (ctx.facingRepairsTried) out += ` Re-placed ${ctx.facingRepairsTried} block(s) that held the right block facing the wrong way.`;
    if (ctx.leashed) out += ` Walked back to the site ${ctx.leashed}x.`;
    // A build that had to move the bot repeatedly was fighting its own geometry, not placing
    // blocks. Named because the verified percentage cannot show it.
    if (ctx.recentres) out += ` Recentred to the station ${ctx.recentres}x after runs of fruitless flights.`;
    // Temporary supports, reported whether they helped or not: `built` without `used` means the
    // chains went up and the placement still failed, which is a different problem from not
    // finding anything solid to anchor to.
    if (ctx.supportsBuilt) out += ` Temporary supports: ${ctx.supportsUsed || 0} of ${ctx.supportsBuilt} placements rescued.`;
    if (ctx.supportsLeft) out += ` ${ctx.supportsLeft} temporary support block(s) COULD NOT BE REMOVED - dig them out by hand.`;
    if (failures.length) {
        // aggregate failure reasons so the report explains itself instead of needing a
        // log dive - the mass-failure runs each had ONE dominant cause worth naming
        const byWhy = new Map();
        for (const f of failures) {
            const key = normaliseWhy(f.why);
            byWhy.set(key, (byWhy.get(key) || 0) + 1);
        }
        const top = [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([w, n]) => `${n}x "${w}"`).join('; ');
        out += ` Failure breakdown: ${top}.`;
        const sample = failures.slice(0, 3).map(f => `${f.name}@(${f.x},${f.y},${f.z})`).join('; ');
        out += ` E.g.: ${sample}`;
    }
    return out;
}
