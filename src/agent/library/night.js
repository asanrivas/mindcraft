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

/**
 * Should the bot get into a bed to complete a night-skip vote a HUMAN has already started?
 *
 * This is a different question from `decideNightAction`, and it has to be, because vanilla
 * skips the night only when EVERY player is in bed - and this bot counts as a player. Every
 * stand-down that correctly stops the bot SHELTERING (Peaceful, already under a roof, already
 * deep underground, gave up for tonight) wrongly stops it VOTING: an awake bot silently holds
 * a person's night hostage, and the person has no way to see why.
 *
 * So the refusals here are only the ones that are PHYSICAL - cases where getting into a bed
 * either cannot work or costs something the vote is not worth:
 *
 *  - `userActionRunning` -> 'defer', NOT 'join'. A mode may interrupt a person's action when
 *    the bot's life is at stake (drowning, self_defense); a sleep vote is a courtesy, and
 *    cancelling the marathon a person explicitly asked for in order to be polite about their
 *    bedtime is the exact damage `isUserOwned` exists to prevent. The vote is not lost: a
 *    sleeping human stays in bed, so the next tick after the action finishes still joins.
 *  - Hostile mobs are deliberately NOT an input. `goToBed` already classifies the server's
 *    'monsters nearby' refusal by name, and the caller's cooldown stops it retrying in a loop;
 *    adding a second, weaker copy of that test here would only make the bot refuse a sleep the
 *    server would have allowed.
 *
 * @param {object}  o
 * @param {boolean} o.anyHumanSleeping  a real person (never another agent) is in bed
 * @param {number}  o.timeOfDay
 * @param {boolean} [o.thundering]
 * @param {boolean} [o.isSleeping]      the bot is already in bed - the vote is already cast
 * @param {string}  [o.dimension]
 * @param {boolean} [o.inWater]
 * @param {boolean} [o.hasBed]          a bed within reach, or one in the bag to place
 * @param {boolean} [o.userActionRunning] a user-authored action is executing right now
 * @returns {'join'|'defer'|'no'}
 */
export function sleepVoteVerdict({ anyHumanSleeping, timeOfDay, thundering = false,
                                   isSleeping = false, dimension = 'overworld',
                                   inWater = false, hasBed = false,
                                   userActionRunning = false }) {
    if (isSleeping) return 'no';                          // already voting
    if (!anyHumanSleeping) return 'no';                   // nobody to join
    if (dimension !== 'overworld') return 'no';           // beds explode
    if (inWater) return 'no';                             // drowning mode's territory
    if (!canSleepAt(timeOfDay, thundering)) return 'no';  // the server would reject the sleep
    if (!hasBed) return 'no';                             // nothing to vote WITH
    if (userActionRunning) return 'defer';                // a person's own work outranks this
    return 'join';
}
