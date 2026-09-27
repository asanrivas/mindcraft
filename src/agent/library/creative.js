/**
 * Creative-mode inventory: give the bot any item without the server's /give command.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every "get the bot some blocks" path in this repo went through `/give` over chat
 * (`!serverGive`), which needs operator permission, costs a chat round-trip per stack, and can
 * only be verified by recounting the inventory afterwards. A creative-mode client does not do
 * that - it writes the slot directly with `set_creative_slot`. mineflayer ships that as a core
 * plugin (`bot.creative`, lib/plugins/creative.js), auto-loaded, no opt-in.
 *
 * THE ONE REAL RISK, AND HOW IT IS HANDLED
 * ----------------------------------------
 * `set_creative_slot` carries a NUMERIC item id, resolved from our minecraft-data tables. This
 * server is 26.1 (protocol 775) while minecraft-data caps at 1.21.11 (protocol 774) - see
 * CLAUDE.md. If 26.1 inserted an item anywhere in the registry, every id above the insertion
 * point shifts, and the packet silently produces the WRONG ITEM: the server accepts it, so
 * there is no error to catch.
 *
 * From 1.21.3 on, `noAckOnCreateSetSlotPacket` is set, so mineflayer applies the slot locally
 * and only waits ~400ms for a rejection. That means `bot.inventory` reflects what we ASKED FOR,
 * not what the server stored - reading it back is not verification, it is an echo.
 *
 * So `verifySlot` below re-reads the slot AFTER a correction has had time to arrive, which
 * catches an outright REJECTION. It cannot catch a SUBSTITUTION: if the server happily stores
 * the wrong item, it sends no correction, and our local echo resolves the id back through our
 * own registry to the name we asked for. Both errors cancel and the check reads green.
 *
 * Substitution can only be caught from outside the process, by resolving the item NAME
 * server-side - `!creativeIdSweep` plus `clear <player> <item> 0`. See docs/CREATIVE_MODE.md.
 */

import prismarine_items from 'prismarine-item';

/** Player inventory window slots. 0=crafting output, 1-4 craft grid, 5-8 armor, 9-35 main, 36-44 hotbar. */
export const SLOT_MAIN_START = 9;
export const SLOT_MAIN_END = 35;
export const SLOT_HOTBAR_START = 36;
export const SLOT_HOTBAR_END = 44;

/** How long to let a server correction arrive before we believe our own optimistic write. */
const SETTLE_MS = 500;

/**
 * Per-write ack wait handed to mineflayer. MUST BE > 0 - this is a mineflayer bug, not a tuning knob.
 *
 * `bot.creative.setInventorySlot` marks a slot busy (`creativeSlotsUpdates[slot] = true`) before
 * writing, and clears that flag only on the timeout path at the end:
 *
 *     bot._setSlot(slot, item)
 *     if (waitTimeout === 0) return          // <- returns WITHOUT clearing the flag
 *     ... setTimeout(... creativeSlotsUpdates[slot] = false ...)
 *
 * So passing 0 leaks the busy flag and every LATER write to that same slot throws
 * "Setting slot N cancelled due to calling bot.creative.setInventorySlot(N, ...) again" -
 * permanently, for the life of the process. Found the hard way: `!creativeClear` with
 * waitTimeout 0 bricked all 37 slots, after which every give failed and only a restart fixed it.
 *
 * 60ms is enough to reset the flag while keeping a 37-slot clear near two seconds.
 */
const WRITE_ACK_MS = 60;

export function gameMode(bot) {
    return bot?.game?.gameMode ?? 'unknown';
}

export function isCreative(bot) {
    return gameMode(bot) === 'creative';
}

/**
 * Resolve an item name to its numeric id, tolerating the mistakes a model actually makes:
 * a `minecraft:` prefix, stray case, and spaces where underscores belong.
 *
 * Resolved against `registry` (i.e. `bot.registry`) rather than the module-level tables in
 * mcdata.js, so this stays pure and testable with a fake registry - and so the ids come from
 * the same data the packet serializer will use.
 *
 * Returns {id, name} or {error}.
 */
export function resolveItem(registry, name) {
    if (typeof name !== 'string' || !name.trim()) return { error: 'no item name given' };
    const clean = name.trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
    const item = registry?.itemsByName?.[clean];
    if (item) return { id: item.id, name: clean };
    return { error: `unknown item "${name}"` };
}

/** Max stack for an item, defaulting to 64 when the tables do not say. */
export function stackSize(registry, itemName) {
    return registry?.itemsByName?.[itemName]?.stackSize || 64;
}

/**
 * Slots that currently hold nothing, in fill order: main inventory first, hotbar last.
 *
 * Hotbar last on purpose - it is where tools and weapons live, and silently overwriting a
 * pickaxe with cobblestone is the kind of "help" that loses a mining trip.
 */
export function freeSlots(bot) {
    const out = [];
    for (let s = SLOT_MAIN_START; s <= SLOT_MAIN_END; s++) if (!bot.inventory.slots[s]) out.push(s);
    for (let s = SLOT_HOTBAR_START; s <= SLOT_HOTBAR_END; s++) if (!bot.inventory.slots[s]) out.push(s);
    return out;
}

/**
 * What the server actually holds in a slot, read after any correction has had time to land.
 * See the header: on the no-ack path an immediate read is just our own optimistic write.
 */
export async function verifySlot(bot, slot, settleMs = SETTLE_MS) {
    await new Promise(r => setTimeout(r, settleMs));
    const it = bot.inventory.slots[slot];
    return it ? { name: it.name, count: it.count, type: it.type } : null;
}

/**
 * Put `count` of `itemName` into the bot's inventory, splitting across stacks and slots.
 *
 * @returns {Promise<{ok:boolean, placed:number, requested:number, item:string, got:string|null, slots:number[], error?:string}>}
 */
export async function giveItem(bot, itemName, count = 1) {
    const res = { ok: false, placed: 0, requested: Math.max(0, Math.floor(count)), item: itemName, got: null, slots: [] };

    if (!isCreative(bot)) { res.error = `not in creative mode (currently ${gameMode(bot)})`; return res; }
    const r = resolveItem(bot.registry, itemName);
    if (r.error) { res.error = r.error; return res; }
    res.item = r.name;
    if (res.requested <= 0) { res.error = 'count must be at least 1'; return res; }

    const Item = prismarine_items(bot.registry);
    const max = stackSize(bot.registry, r.name);

    // Top up partial stacks of this same item BEFORE claiming empty slots. Without this, asking
    // for cobblestone when you already hold 3 cobblestone reports "inventory is full" on a bot
    // whose bag is merely diverse - which is exactly how this first failed in testing.
    const targets = [];
    if (max > 1) {
        for (let s = SLOT_MAIN_START; s <= SLOT_HOTBAR_END; s++) {
            const it = bot.inventory.slots[s];
            if (it && it.name === r.name && it.count < max) targets.push({ slot: s, have: it.count });
        }
    }
    const free = freeSlots(bot);
    for (const slot of free) targets.push({ slot, have: 0 });
    if (!targets.length) { res.error = 'inventory is full'; return res; }

    let remaining = res.requested;
    for (const { slot, have } of targets) {
        if (remaining <= 0) break;
        const room = max - have;
        if (room <= 0) continue;
        // `added` is the new items; the packet must carry the whole RESULTING stack, since
        // set_creative_slot replaces a slot outright rather than adding to it. Counting the
        // written total as "placed" would silently inflate every top-up by what was already there.
        const added = Math.min(room, remaining);
        try {
            await bot.creative.setInventorySlot(slot, new Item(r.id, have + added), WRITE_ACK_MS);
            res.slots.push(slot);
            remaining -= added;
            res.placed += added;
        } catch (err) {
            res.error = `slot ${slot}: ${err?.message || err}`;
            break;
        }
    }

    // Catches a rejection (slot comes back empty or changed). It canNOT catch a substitution -
    // see probeIdMapping's comment for why that is not fixable from inside the process.
    const landed = res.slots.length ? await verifySlot(bot, res.slots[0]) : null;
    res.got = landed?.name ?? null;
    res.ok = res.placed > 0 && res.got === r.name;
    if (res.placed > 0 && res.got && res.got !== r.name) {
        // The registry-shift failure described in the header. Say it loudly: the alternative is
        // a bot that "successfully" builds a house out of the wrong block.
        res.error = `ITEM ID MISMATCH: asked for ${r.name} (id ${r.id}), server stored ${res.got}`;
    } else if (res.placed > 0 && !res.got) {
        res.error = `server rejected ${r.name} (slot came back empty)`;
    }
    return res;
}

/** Empty every inventory slot. Returns how many were cleared. */
export async function clearInventory(bot) {
    if (!isCreative(bot)) return { ok: false, cleared: 0, error: `not in creative mode (currently ${gameMode(bot)})` };
    let cleared = 0;
    for (let s = 1; s <= SLOT_HOTBAR_END; s++) {
        if (!bot.inventory.slots[s]) continue;
        try { await bot.creative.setInventorySlot(s, null, WRITE_ACK_MS); cleared++; } catch { /* keep going */ }
    }
    return { ok: true, cleared };
}

/**
 * Bulk-fill from a kit list of [itemName, count] pairs, stopping when the inventory fills.
 * Reports per-item outcomes so one bad name does not hide the rest.
 */
export async function stock(bot, entries) {
    const results = [];
    for (const [name, count] of entries) {
        const r = await giveItem(bot, name, count);
        results.push(r);
        if (r.error === 'inventory is full') break;
    }
    return results;
}

/**
 * Items spanning the whole id range, for the external substitution check.
 *
 * Spread across the spectrum on purpose: a registry insertion shifts every id ABOVE the
 * insertion point and leaves everything below it correct, so testing only common blocks (which
 * have low, stable ids) would show green while every modern item landed wrong.
 */
export const ID_SWEEP_SAMPLES = [
    'stripped_birch_log',           // ~150
    'mossy_stone_bricks',           // ~376
    'light_blue_glazed_terracotta', // ~601
    'dark_oak_fence_gate',          // ~827
    'black_bundle',                 // ~1052
    'blaze_spawn_egg',              // ~1203
    'composter',                    // ~1353
    'howl_pottery_sherd',           // ~1458
];

/**
 * Give one of each sweep sample so an external, server-side name lookup can confirm the ids.
 * Returns what was asked for, so the caller knows exactly what to go and check.
 */
export async function idSweep(bot, samples = ID_SWEEP_SAMPLES) {
    if (!isCreative(bot)) return { asked: [], error: `not in creative mode (currently ${gameMode(bot)})` };
    const asked = [];
    for (const name of samples) {
        const r = await giveItem(bot, name, 1);
        asked.push({ item: r.item, id: resolveItem(bot.registry, name).id ?? null, placed: r.placed, error: r.error });
        if (r.error === 'inventory is full') break;
    }
    return { asked };
}

/**
 * Ready-made kits, so "get the bot ready to build" is one command instead of twelve.
 *
 * Counts are deliberately modest - a full 2304-item load fills every slot and then
 * `!creativeGive` has nowhere to put anything, which reads as a bug rather than as a full bag.
 */
export const KITS = {
    building: [
        ['cobblestone', 512], ['oak_planks', 256], ['glass', 128], ['oak_log', 128],
        ['torch', 128], ['crafting_table', 1], ['chest', 16], ['oak_door', 8],
        ['white_bed', 1], ['ladder', 32],
    ],
    mining: [
        ['diamond_pickaxe', 1], ['diamond_shovel', 1], ['diamond_axe', 1],
        ['torch', 256], ['cobblestone', 256], ['oak_planks', 64], ['chest', 8],
    ],
    survival: [
        ['diamond_sword', 1], ['bow', 1], ['arrow', 256], ['shield', 1],
        ['cooked_beef', 64], ['diamond_helmet', 1], ['diamond_chestplate', 1],
        ['diamond_leggings', 1], ['diamond_boots', 1], ['white_bed', 1],
    ],
};

/**
 * Stock a named kit. `all` runs every kit in order and stops when the bag fills.
 * @returns {Promise<{kit:string, results:object[], error?:string}>}
 */
export async function giveKit(bot, kitName) {
    const key = String(kitName || '').trim().toLowerCase();
    if (!isCreative(bot)) return { kit: key, results: [], error: `not in creative mode (currently ${gameMode(bot)})` };

    if (key === 'all') {
        const results = [];
        for (const name of Object.keys(KITS)) {
            results.push(...await stock(bot, KITS[name]));
            if (results.some(r => r.error === 'inventory is full')) break;
        }
        return { kit: 'all', results };
    }

    const entries = KITS[key];
    if (!entries) return { kit: key, results: [], error: `unknown kit "${kitName}" - try ${Object.keys(KITS).join(', ')}, or all` };
    return { kit: key, results: await stock(bot, entries) };
}

/**
 * Ask for one of a known item and report what came back in the slot.
 *
 * IMPORTANT - WHAT THIS CAN AND CANNOT DETECT.
 *
 * It detects REJECTION: the server refused the write and the slot ends up empty or different.
 *
 * It CANNOT detect SUBSTITUTION - the registry-shift case in the file header. On the no-ack
 * path the server has no reason to correct us: it received id X, stored whatever X means in ITS
 * registry, and considers the exchange complete. Meanwhile mineflayer has optimistically stored
 * id X locally, which we resolve back through OUR registry - so we read out exactly the name we
 * asked for, whatever the server actually holds. The two errors cancel and the probe reads green.
 *
 * Detecting substitution requires resolving the item NAME on the server side, which no
 * in-process check can do. Use `!creativeIdSweep` plus an external
 * `clear <player> <item> 0` (it answers "Found N matching item(s)" by name) - see
 * docs/CREATIVE_MODE.md.
 */
export async function probeIdMapping(bot, sample = 'cobblestone') {
    if (!isCreative(bot)) return { ok: false, error: `not in creative mode (currently ${gameMode(bot)})` };
    const free = freeSlots(bot);
    if (!free.length) return { ok: false, error: 'inventory is full, cannot probe' };
    const r = resolveItem(bot.registry, sample);
    if (r.error) return { ok: false, error: r.error };

    const slot = free[0];
    const Item = prismarine_items(bot.registry);
    await bot.creative.setInventorySlot(slot, new Item(r.id, 1), WRITE_ACK_MS);
    const landed = await verifySlot(bot, slot);
    await bot.creative.setInventorySlot(slot, null, WRITE_ACK_MS).catch(() => {});
    return {
        ok: landed?.name === r.name,
        asked: r.name,
        askedId: r.id,
        got: landed?.name ?? null,
        gotId: landed?.type ?? null,
        slot,
    };
}
