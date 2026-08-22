import { Vec3 } from 'vec3';
import { ARROW, CROSSBOW_ARROW, FULL_CHARGE_MS, CROSSBOW_CHARGE_MS, solvePitch, leadPoint, friendlyInCorridor } from './archery.js';
import { isFriendly } from '../../utils/mcdata.js';

/**
 * Bow and crossbow handling.
 *
 * The load-bearing fact, read from mineflayer's inventory plugin: item use is ONE channel.
 * `bot.activateItem(offHand)` starts using whatever is in that hand, and `bot.deactivateItem()`
 * sends a single "released use item" packet that releases WHICHEVER item is in use - a bow
 * release and a shield lower are the same packet.
 *
 * `bot.itemUseOwner` is this module's lock over that channel. **It is currently honoured only
 * here.** `skills.js` (eating, buckets) still calls `bot.activateItem()` directly, so an eat
 * during a draw can still steal the channel and its cleanup can release our arrow. Making the
 * lock real means routing every activateItem/deactivateItem call in the tree through it; until
 * that happens this provides bow-vs-bow and bow-vs-shield exclusion only. Do not read the lock
 * as a guarantee. Same class of bug as the jump-key contention in docs/SWIMMING.md.
 *
 * Crossbow semantics differ from bow and it is easy to get backwards:
 *   bow:      activate = start drawing, deactivate = FIRE.
 *   crossbow: activate + hold + deactivate = LOAD (arrow stored in the item);
 *             a second activate = FIRE immediately.
 */

const ARROW_ITEMS = ['arrow', 'spectral_arrow', 'tipped_arrow'];

export function bowInfo(bot) {
    // bot.inventory.items() covers slots 9-44, which ALREADY includes the hotbar and therefore
    // bot.heldItem. Concatenating them double-counted the held stack, so a bot holding arrows
    // reported twice the ammunition it had - and the VERIFIED line then reported a fictional
    // arrow count.
    const all = bot.inventory.items();
    return {
        bow: all.find(i => i.name === 'bow') || null,
        crossbow: all.find(i => i.name === 'crossbow') || null,
        arrows: all.filter(i => ARROW_ITEMS.includes(i.name)).reduce((n, i) => n + i.count, 0),
    };
}

/** Is a crossbow already loaded? NBT read; on this mismatched protocol treat unknown as unloaded. */
export function crossbowLoaded(item) {
    try {
        const comp = item?.components?.find?.(c => c.type === 'charged_projectiles');
        if (comp) return (comp.data?.projectiles?.length ?? 0) > 0;
        const nbt = item?.nbt?.value;
        if (nbt?.ChargedProjectiles) return (nbt.ChargedProjectiles.value?.value?.length ?? 0) > 0;
    } catch { /* fall through */ }
    return false;
}

/** Acquire the single item-use channel, or say who has it. */
function takeUseLock(bot, owner) {
    if (bot.itemUseOwner && bot.itemUseOwner !== owner) return bot.itemUseOwner;
    bot.itemUseOwner = owner;
    return null;
}
function releaseUseLock(bot, owner) {
    if (bot.itemUseOwner === owner) bot.itemUseOwner = null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Aim at a world point with ballistic pitch. The position-packet throttle coalesces look
 * packets at 50ms, so the caller must leave >=100ms between the final aim and the release, or
 * the server fires along the PREVIOUS acknowledged look.
 */
async function aimBallistic(bot, targetPos, constants) {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const dx = targetPos.x - eye.x, dz = targetPos.z - eye.z;
    const dist = Math.hypot(dx, dz);
    const dy = targetPos.y - eye.y;
    const sol = solvePitch({ dist, dy, speed: constants.speed, gravity: constants.gravity, drag: constants.drag });
    if (!sol) return null;
    const yaw = Math.atan2(-dx, -dz);
    await bot.look(yaw, sol.pitch, true);
    return { yaw, ...sol, dist };
}

/** Refuse any shot whose corridor contains a player or friendly entity. */
function corridorBlocked(bot, target) {
    const eye = bot.entity.position;
    const tdx = target.position.x - eye.x, tdz = target.position.z - eye.z;
    const targetDist = Math.hypot(tdx, tdz);
    const targetYaw = Math.atan2(-tdx, -tdz);
    const friendlies = [];
    for (const e of Object.values(bot.entities)) {
        if (!e || e === bot.entity || e === target) continue;
        if (e.type !== 'player' && !isFriendly(e)) continue;
        const dx = e.position.x - eye.x, dz = e.position.z - eye.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 48) continue;
        friendlies.push({ yaw: Math.atan2(-dx, -dz), dist });
    }
    return friendlyInCorridor(targetDist, targetYaw, friendlies);
}

/**
 * One aimed shot at an entity. Handles both weapons.
 * @param {'bow'|'crossbow'|'auto'} weapon
 * @returns {Promise<{fired:boolean, reason:string, weapon?:string}>}
 */
export async function shootAt(bot, target, weapon = 'auto', opts = {}) {
    const info = bowInfo(bot);
    const useCrossbow = weapon === 'crossbow' || (weapon === 'auto' && !info.bow && info.crossbow);
    const item = useCrossbow ? info.crossbow : info.bow;
    if (!item) return { fired: false, reason: useCrossbow ? 'no_crossbow' : 'no_bow' };
    if (info.arrows <= 0 && !(useCrossbow && crossbowLoaded(item))) return { fired: false, reason: 'no_arrows' };
    if (!target?.position) return { fired: false, reason: 'no_target' };
    if (target.type === 'player') return { fired: false, reason: 'refusing_player' };
    if (corridorBlocked(bot, target)) return { fired: false, reason: 'friendly_in_corridor' };

    const lockHolder = takeUseLock(bot, 'bow');
    if (lockHolder) return { fired: false, reason: `use_channel_busy:${lockHolder}` };

    const constants = useCrossbow ? CROSSBOW_ARROW : ARROW;
    try {
        await bot.equip(item, 'hand');

        if (useCrossbow) {
            // LOAD if needed: activate, hold through the charge, deactivate stores the arrow.
            if (!crossbowLoaded(bot.heldItem)) {
                bot.activateItem();
                await sleep(opts.chargeMs ?? CROSSBOW_CHARGE_MS);
                bot.deactivateItem();
                await sleep(150);
                if (bot.interrupt_code) return { fired: false, reason: 'interrupted' };
            }
            // Aim, settle past the 50ms look throttle, then FIRE with a fresh activate.
            const aim = await aimAtEntity(bot, target, constants);
            if (!aim) return { fired: false, reason: 'out_of_range' };
            await sleep(150);
            bot.activateItem();
            await sleep(100);
            // Some servers want the release too; harmless when they don't.
            bot.deactivateItem();
            return { fired: true, reason: 'fired', weapon: 'crossbow' };
        }

        // Aim BEFORE drawing. The previous order called activateItem() first and then bailed
        // out with deactivateItem() on out-of-range or interrupt - but deactivateItem IS the
        // release packet, so after ~3 ticks of draw that "abort" actually loosed a weak,
        // unaimed arrow along a stale look while reporting `fired: false`. Establishing the
        // firing solution first means the abort paths never touch the channel.
        let aim = await aimAtEntity(bot, target, constants);
        if (!aim) return { fired: false, reason: 'out_of_range' };
        if (bot.interrupt_code) return { fired: false, reason: 'interrupted' };

        bot.activateItem();
        const chargeMs = opts.chargeMs ?? FULL_CHARGE_MS;
        const start = Date.now();
        while (Date.now() - start < chargeMs - 150) {
            // Once drawn, an early exit still has to release - so from here on, a bail is a
            // SHOT, and it is reported as one rather than as a silent miss.
            if (bot.interrupt_code) {
                bot.deactivateItem();
                return { fired: true, reason: 'released_early_interrupted', weapon: 'bow' };
            }
            const next = await aimAtEntity(bot, target, constants);
            if (!next) {
                bot.deactivateItem();
                return { fired: true, reason: 'released_early_target_moved', weapon: 'bow' };
            }
            aim = next;
            await sleep(250);
        }
        // Final settle: nothing may move the look between here and the release.
        await sleep(150);
        bot.deactivateItem();
        return { fired: true, reason: 'fired', weapon: 'bow' };
    } catch (err) {
        try { bot.deactivateItem(); } catch { /* channel already clear */ }
        return { fired: false, reason: `error:${err.message}` };
    } finally {
        releaseUseLock(bot, 'bow');
    }
}

/** Aim with lead: solve once for flight time, lead the target by it, solve again. */
async function aimAtEntity(bot, target, constants) {
    const first = await aimBallistic(bot, target.position, constants);
    if (!first) return null;
    const led = leadPoint(target.position, target.velocity, first.ticks);
    return await aimBallistic(bot, new Vec3(led.x, led.y + (target.height ?? 1.5) * 0.6, led.z), constants);
}

/** Fire at a fixed position - the probe's entry point. */
export async function shootAtPosition(bot, pos, weapon = 'bow', opts = {}) {
    const fake = { position: pos, velocity: { x: 0, y: 0, z: 0 }, height: 0, type: 'probe' };
    return await shootAt(bot, fake, weapon, opts);
}
