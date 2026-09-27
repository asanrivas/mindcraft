/**
 * Put back what the navigator had to break.
 *
 * `nav.digAhead` mines a player-made block only when the plan has no other way through, or the
 * bot is sealed in a one-cell pocket (see build_guard.isPlayerMadeName). That is the right call
 * and it still leaves a hole in somebody's fence. Reported as "andy breaks my building/fence
 * sometimes. he doesnt have effort to repair back".
 *
 * WHEN - ONLY FROM WHERE THE BOT ALREADY STANDS
 * ---------------------------------------------
 * A hole is repaired once the bot is PAST it: REACH_MIN..REACH_MAX from the cell, the band in
 * which `skills.placeBlock` neither steps away from the cell (< 1.1) nor walks to reach it
 * (> 4.5). So a repair never moves the bot, never competes with `followPath` for the route, and
 * never undoes the journey it was part of. A hole left out of reach stays pending, and the next
 * journey that passes within reach of it fixes it.
 *
 * NEVER ON A FIXED BEAT
 * ---------------------
 * At most MAX_ATTEMPTS placements per hole, and a hole older than PENDING_TTL_MS is dropped. Both
 * say so in the log by name. "No item to put it back" is not an attempt: the drop is usually
 * picked up a moment later by walking through the cell, so it waits (logged once) until the
 * INPUT changes rather than retrying against an unchanged inventory.
 */
import { Vec3 } from 'vec3';

// Distances are to the cell's corner, the same measure `skills.placeBlock` uses for its own
// too-close and too-far checks. 2.3 rather than 2 so the head-height check (feet + 1) cannot
// land inside 1.1 either.
export const REACH_MIN = 2.3;
export const REACH_MAX = 4.3;
export const MAX_ATTEMPTS = 2;
export const PENDING_TTL_MS = 10 * 60 * 1000;
const PLACE_TIMEOUT_MS = 8000;

// The same set `skills.placeBlock` treats as free to place into.
const EMPTY = new Set(['air', 'cave_air', 'water', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']);

/** username -> Map<cellKey, hole>. Per bot: a module is shared by every bot in one process. */
const pending = new Map();

function holes(bot) {
    const who = bot?.username ?? '?';
    let m = pending.get(who);
    if (!m) { m = new Map(); pending.set(who, m); }
    return m;
}

/** The item that places `name`. Wall-mounted variants are placed from the ordinary item. */
export function itemForBlock(name) {
    if (name === 'wall_torch') return 'torch';
    if (name === 'soul_wall_torch') return 'soul_torch';
    if (name.endsWith('_wall_sign')) return name.slice(0, -'_wall_sign'.length) + '_sign';
    if (name.endsWith('_wall_banner')) return name.slice(0, -'_wall_banner'.length) + '_banner';
    return name;
}

/** `oak_stairs` + {facing:'north', half:'bottom'} -> `oak_stairs[facing=north,half=bottom]` for /setblock. */
export function withState(name, props) {
    const kv = Object.entries(props ?? {}).map(([k, v]) => `${k}=${v}`);
    return kv.length ? `${name}[${kv.join(',')}]` : name;
}

/**
 * Record a block the navigator just broke. Call it only AFTER the dig succeeded, with the block
 * as it was BEFORE - `b` read before digging, never re-read.
 */
export function noteBreach(bot, pos, block) {
    if (!block?.name) return;
    let { x, y, z } = pos;
    const props = typeof block.getProperties === 'function' ? (block.getProperties() ?? {}) : {};
    // A door is two cells and one item. Record the lower half only, or it is placed twice.
    if (block.name.endsWith('_door') && props.half === 'upper') y -= 1;
    holes(bot).set(`${x},${y},${z}`, { x, y, z, name: block.name, props, at: Date.now(), attempts: 0, warnedNoItem: false });
    console.log(`[${bot?.username ?? '?'}] repair: will put back ${block.name} at (${x}, ${y}, ${z}) once past it`);
}

export function hasPendingRepairs(bot) {
    return (pending.get(bot?.username ?? '?')?.size ?? 0) > 0;
}

function canSupply(bot, item) {
    if (bot.modes?.isOn?.('cheat')) return true;
    if (bot.game?.gameMode === 'creative' && !bot.restrict_to_inventory) return true;
    return bot.inventory.items().some((i) => i.name === item);
}

/**
 * The first hole the bot can repair RIGHT NOW without moving, or null. Synchronous and cheap, so
 * `followPath` can ask every iteration and only stops walking when there is real work.
 * Also retires holes that no longer need anything, naming why.
 */
export function nextRepair(bot) {
    const list = pending.get(bot?.username ?? '?');
    if (!list || list.size === 0) return null;
    // SwimAssist owns the controls while the bot is wet; nothing here may compete with it.
    if (bot.entity?.isInWater) return null;
    const who = bot.username ?? '?';
    const p = bot.entity.position;
    for (const [k, h] of list) {
        const now = bot.blockAt(new Vec3(h.x, h.y, h.z));
        if (!now) continue;   // unloaded: cannot tell, keep it
        if (now.name === h.name) { list.delete(k); continue; }   // somebody already put it back
        if (!EMPTY.has(now.name)) {
            console.log(`[${who}] repair: not putting back ${h.name} at (${h.x}, ${h.y}, ${h.z}) - ${now.name} is there now`);
            list.delete(k);
            continue;
        }
        if (Date.now() - h.at > PENDING_TTL_MS) {
            console.log(`[${who}] repair: GAVE UP on ${h.name} at (${h.x}, ${h.y}, ${h.z}) - `
                + `never came back within reach in ${PENDING_TTL_MS / 60000} min; the hole is still there`);
            list.delete(k);
            continue;
        }
        const d = p.distanceTo(new Vec3(h.x, h.y, h.z));
        if (d < REACH_MIN || d > REACH_MAX) continue;
        // A failed try is retried only from somewhere else. From the same spot nothing about
        // the placement has changed, and the second try would just be the first one again.
        if (h.lastTriedFrom && p.distanceTo(h.lastTriedFrom) < 1) continue;
        const item = itemForBlock(h.name);
        if (!canSupply(bot, item)) {
            if (!h.warnedNoItem) {
                console.log(`[${who}] repair: no ${item} to put back at (${h.x}, ${h.y}, ${h.z}) yet - waiting for one`);
                h.warnedNoItem = true;
            }
            continue;
        }
        return h;
    }
    return null;
}

/**
 * Put one hole back. Does not move the bot (see REACH_*), and does not touch control states -
 * the caller owns those. `place` is injected by the tests; live callers use skills.placeBlock.
 * @returns {Promise<boolean>} true when the world now holds the original block.
 */
export async function repairOne(bot, h, place = null) {
    const list = holes(bot);
    const key = `${h.x},${h.y},${h.z}`;
    const who = bot.username ?? '?';
    h.attempts++;
    h.lastTriedFrom = bot.entity.position.clone();
    // skills imports nav imports us: load it lazily, and only when a real placement is needed.
    place ??= (await import('./skills.js')).placeBlock;
    // With cheats, /setblock restores the exact state - facing, half, shape. Without, the block
    // takes its state from how it is placed, so a stair can come back facing the other way.
    // Doors and beds are excluded: placeBlock appends its own [half=upper]/[part=head].
    const cheat = !!bot.modes?.isOn?.('cheat');
    const twoCell = h.name.endsWith('_door') || h.name.endsWith('_bed');
    const placeName = cheat && !twoCell ? withState(h.name, h.props) : itemForBlock(h.name);

    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), PLACE_TIMEOUT_MS); });
    let result;
    try {
        result = await Promise.race([place(bot, placeName, h.x, h.y, h.z, 'bottom'), timeout]);
    } catch (err) {
        result = err;
    } finally {
        clearTimeout(timer);
    }

    // The world, not the API: placeBlock can report failure after a success and vice versa.
    const now = bot.blockAt(new Vec3(h.x, h.y, h.z));
    if (now?.name === h.name) {
        console.log(`[${who}] repair: put back ${h.name} at (${h.x}, ${h.y}, ${h.z})`);
        list.delete(key);
        return true;
    }
    const why = result === 'timeout' ? `timed out after ${PLACE_TIMEOUT_MS}ms`
        : result instanceof Error ? result.message : `found ${now?.name ?? 'nothing'} there after placing`;
    if (h.attempts >= MAX_ATTEMPTS) {
        console.log(`[${who}] repair: GAVE UP on ${h.name} at (${h.x}, ${h.y}, ${h.z}) after ${h.attempts} tries - ${why}`);
        list.delete(key);
    } else {
        console.log(`[${who}] repair: ${h.name} at (${h.x}, ${h.y}, ${h.z}) failed (${why}); one more try when next in reach`);
    }
    return false;
}

/** Repair everything currently in reach. Used where nothing else is driving the bot. */
export async function repairInReach(bot) {
    let fixed = 0;
    const tried = new Set();
    for (let h = nextRepair(bot); h && !tried.has(h); h = nextRepair(bot)) {
        tried.add(h);   // one try per hole per call: a failure must wait for a change, not a loop
        if (await repairOne(bot, h)) fixed++;
    }
    return fixed;
}

/** Test seam: forget every pending hole. */
export function _clearRepairs() { pending.clear(); }
