import { isFallingBlockName } from './tools.js';

/**
 * Night-safety predicates. Pure - no bot, no mineflayer - so the decisions can be unit-tested
 * without a server. The block reads that the shelter search needs are injected.
 *
 * Written after the bot, newly mortal on Normal difficulty, was killed twice in one in-game
 * night: it had no concept of dusk, so it kept building at nightfall, and its only response to
 * a zombie was reactive melee. A human sleeps through the night (which skips mob-time
 * entirely), or digs in.
 */

// Vanilla clock. A bed accepts you slightly before mobs appear, which is the whole margin the
// bot gets to walk to it.
export const DUSK = 12542;        // first tick a bed can be used in clear weather
export const MOBS_SPAWN = 13000;
export const DAWN = 23000;        // beds eject sleepers shortly after this

export function isNight(timeOfDay) {
    return timeOfDay >= MOBS_SPAWN && timeOfDay < DAWN;
}

/** Thunderstorms let you sleep at any hour. */
export function canSleepAt(timeOfDay, thundering = false) {
    if (thundering) return true;
    return timeOfDay >= DUSK && timeOfDay < DAWN;
}

/**
 * Is dusk close enough to stop what we are doing and get safe?
 * Gives roughly 30 seconds of real time to reach a bed before mobs start spawning.
 */
export function isDuskApproaching(timeOfDay, leadTicks = 600) {
    return timeOfDay >= (DUSK - leadTicks) && timeOfDay < DAWN;
}

/**
 * EXACT suffix match. `name.includes('bed')` also matches **bedrock**, which is the
 * substring-matching mistake this repo has now been bitten by three times
 * ("sandstone".includes("sand"), `water_cauldron`, and this one). A bot that walks to bedrock
 * and tries to sleep in it fails in a way that is very hard to read from the logs.
 */
export function isBedName(name) {
    return !!name && name.endsWith('_bed');
}

export function bedInInventory(items) {
    if (!items) return null;
    return items.find(i => isBedName(i.name)) || null;
}

/** Blocks a shelter floor may not be dug into. */
const UNSAFE_FLOOR = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bedrock']);

/**
 * Pick a spot to dig in for the night.
 *
 * @param {(x:number,y:number,z:number)=>string|null} getName injected block reader
 * @param {{x,y,z}} origin bot feet, floored
 * @returns {{x,y,z}|null} the cell to dig DOWN from, or null if nowhere is safe
 */
export function pickShelterSpot(getName, origin, radius = 2) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            candidates.push({ x: origin.x + dx, y: origin.y, z: origin.z + dz, d: Math.hypot(dx, dz) });
        }
    }
    candidates.sort((p, q) => p.d - q.d);

    for (const c of candidates) {
        const at = getName(c.x, c.y, c.z);
        const below = getName(c.x, c.y - 1, c.z);
        const below2 = getName(c.x, c.y - 2, c.z);
        const sealCell = getName(c.x, c.y + 2, c.z);
        const aboveSeal = getName(c.x, c.y + 3, c.z);

        // Unknown means unloaded chunk - never treat that as safe (same rule as the swim and
        // world-guard code).
        if ([at, below, below2, sealCell, aboveSeal].some(n => n === null)) continue;
        if (UNSAFE_FLOOR.has(below) || UNSAFE_FLOOR.has(below2)) continue;
        if (UNSAFE_FLOOR.has(at)) continue;
        // A sand or gravel roof pours into the hole the moment we seal under it.
        if (isFallingBlockName(aboveSeal)) continue;
        return { x: c.x, y: c.y, z: c.z };
    }
    return null;
}

/**
 * What should the night routine do right now? Pure so the whole decision table is testable.
 * @returns {'sleep'|'place_bed'|'shelter'|'wait'|'none'}
 */
export function decideNightAction({ timeOfDay, thundering = false, inWater = false,
                                    hostileNear = false, bedNearby = false, bedInInv = false,
                                    dimension = 'overworld', isSleeping = false }) {
    if (isSleeping) return 'none';
    if (!isDuskApproaching(timeOfDay, 600) && !thundering) return 'none';
    if (inWater) return 'none';                 // drowning mode's territory
    if (hostileNear) return 'wait';             // let self_defense finish; retry after
    // Beds detonate outside the overworld. Never sleep there - dig in instead.
    if (dimension !== 'overworld') return 'shelter';
    if (bedNearby && canSleepAt(timeOfDay, thundering)) return 'sleep';
    if (bedInInv && canSleepAt(timeOfDay, thundering)) return 'place_bed';
    return 'shelter';
}
