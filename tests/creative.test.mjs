/**
 * Creative inventory. No server, no bot:
 *   bun tests/creative.test.mjs
 *
 * The interesting case is not "does it put items in slots" - it is that on the no-ack path
 * (1.21.3+) mineflayer applies our optimistic write locally, so the inventory reads back what we
 * ASKED FOR even when the server stored something else. These tests pin the behaviour that
 * catches that: a server correction must surface as ITEM ID MISMATCH, not as success.
 */
import { resolveItem, stackSize, freeSlots, gameMode, isCreative, giveItem,
         clearInventory, giveKit, probeIdMapping, KITS,
         SLOT_MAIN_START, SLOT_HOTBAR_START, SLOT_HOTBAR_END } from '../src/agent/library/creative.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

const ITEMS = [
    { id: 1, name: 'cobblestone', displayName: 'Cobblestone', stackSize: 64 },
    { id: 2, name: 'diamond_sword', displayName: 'Diamond Sword', stackSize: 1 },
    { id: 3, name: 'white_bed', displayName: 'White Bed', stackSize: 1 },
    { id: 4, name: 'oak_planks', displayName: 'Oak Planks', stackSize: 64 },
    { id: 5, name: 'torch', displayName: 'Torch', stackSize: 64 },
];

// giveItem constructs a REAL prismarine-item from bot.registry - that is the whole point, since
// the numeric id it puts on the wire is what this module exists to get right. So the fake
// registry has to satisfy prismarine-item, not just our own lookups.
const REGISTRY = {
    itemsByName: Object.fromEntries(ITEMS.map(i => [i.name, i])),
    items: Object.fromEntries(ITEMS.map(i => [i.id, i])),
    itemsArray: ITEMS,
    version: { version: 775, majorVersion: '1.21' },
    supportFeature: () => false,
};

// --- name resolution: the mistakes a model actually makes -------------------------------------
check('plain name', resolveItem(REGISTRY, 'cobblestone').id, 1);
check('minecraft: prefix', resolveItem(REGISTRY, 'minecraft:cobblestone').id, 1);
check('uppercase', resolveItem(REGISTRY, 'CobbleStone').id, 1);
check('spaces become underscores', resolveItem(REGISTRY, 'diamond sword').id, 2);
check('surrounding whitespace', resolveItem(REGISTRY, '  torch  ').id, 5);
check('unknown item is an error', !!resolveItem(REGISTRY, 'unobtainium').error, true);
check('empty name is an error', !!resolveItem(REGISTRY, '').error, true);
check('null name is an error', !!resolveItem(REGISTRY, null).error, true);

check('stackSize known', stackSize(REGISTRY, 'cobblestone'), 64);
check('stackSize singleton', stackSize(REGISTRY, 'diamond_sword'), 1);
check('stackSize unknown defaults 64', stackSize(REGISTRY, 'nope'), 64);

// --- a fake bot ---------------------------------------------------------------------------------
/**
 * @param opts.mode          game mode string
 * @param opts.substitute    if set, every write stores THIS name instead - the registry-shift bug
 * @param opts.reject        if true, the server drops the write entirely
 * @param opts.occupied      slots to pre-fill
 */
function makeBot(opts = {}) {
    const slots = new Array(46).fill(null);
    for (const s of opts.occupied || []) slots[s] = { name: 'stone', count: 1, type: 99, slot: s };
    const bot = {
        game: { gameMode: opts.mode ?? 'creative' },
        registry: REGISTRY,
        inventory: { slots },
        writes: [],
        creative: {
            async setInventorySlot(slot, item) {
                bot.writes.push({ slot, id: item?.type ?? null, count: item?.count ?? 0 });
                if (item === null) { slots[slot] = null; return; }
                if (opts.reject) { slots[slot] = null; return; }
                const name = opts.substitute || Object.values(REGISTRY.itemsByName).find(i => i.id === item.type)?.name;
                slots[slot] = { name, count: item.count, type: item.type, slot };
            },
        },
    };
    return bot;
}

// --- game mode gating ----------------------------------------------------------------------------
check('creative detected', isCreative(makeBot()), true);
check('survival detected', isCreative(makeBot({ mode: 'survival' })), false);
check('gameMode reported', gameMode(makeBot({ mode: 'adventure' })), 'adventure');
check('missing game object', gameMode({}), 'unknown');

{
    const r = await giveItem(makeBot({ mode: 'survival' }), 'cobblestone', 1);
    check('survival refuses to give', r.ok, false);
    check('survival says why', /not in creative/.test(r.error), true);
}
{
    const r = await clearInventory(makeBot({ mode: 'survival' }));
    check('survival refuses to clear', r.ok, false);
}

// --- free slots: hotbar LAST, so a give never eats a pickaxe --------------------------------------
{
    const bot = makeBot();
    const free = freeSlots(bot);
    check('main inventory comes first', free[0], SLOT_MAIN_START);
    check('hotbar comes last', free[free.length - 1], SLOT_HOTBAR_END);
    check('crafting/armor slots excluded', free.includes(5), false);
    const hotbarAt = free.indexOf(SLOT_HOTBAR_START);
    check('every main slot precedes the hotbar', hotbarAt, 27);
}
{
    const bot = makeBot({ occupied: [SLOT_MAIN_START, SLOT_MAIN_START + 1] });
    check('occupied slots are skipped', freeSlots(bot).includes(SLOT_MAIN_START), false);
}

// --- giving --------------------------------------------------------------------------------------
{
    const bot = makeBot();
    const r = await giveItem(bot, 'cobblestone', 100);
    check('gives the full count', r.placed, 100);
    check('splits across stacks', r.slots.length, 2);
    check('first stack is full', bot.writes[0].count, 64);
    check('second stack is the remainder', bot.writes[1].count, 36);
    check('reports success', r.ok, true);
}
{
    // stackSize 1 must not be crammed into one slot.
    const bot = makeBot();
    const r = await giveItem(bot, 'diamond_sword', 3);
    check('singletons take one slot each', r.slots.length, 3);
    check('each holds one', bot.writes[0].count, 1);
}
{
    const bot = makeBot();
    const r = await giveItem(bot, 'unobtainium', 1);
    check('unknown item fails', r.ok, false);
    check('unknown item writes nothing', bot.writes.length, 0);
}
{
    const bot = makeBot();
    const r = await giveItem(bot, 'cobblestone', 0);
    check('zero count fails', r.ok, false);
}
{
    // Full bag: every slot occupied.
    const all = [];
    for (let s = SLOT_MAIN_START; s <= SLOT_HOTBAR_END; s++) all.push(s);
    const r = await giveItem(makeBot({ occupied: all }), 'cobblestone', 1);
    check('full inventory fails cleanly', r.error, 'inventory is full');
}

// --- topping up an existing stack ---------------------------------------------------------------
{
    // The bug that showed up first in live testing: a bot holding 36 different item types was
    // told "inventory is full" when asked for more of something it already had.
    const bot = makeBot();
    bot.inventory.slots[SLOT_MAIN_START] = { name: 'cobblestone', count: 20, type: 1, slot: SLOT_MAIN_START };
    const r = await giveItem(bot, 'cobblestone', 10);
    check('tops up rather than refusing', r.ok, true);
    check('counts only what was ADDED', r.placed, 10);
    check('writes the whole resulting stack', bot.writes[0].count, 30);
    check('resulting stack is correct', bot.inventory.slots[SLOT_MAIN_START].count, 30);
}
{
    // Overflow past the top-up must spill into a free slot, still counting only new items.
    const bot = makeBot();
    bot.inventory.slots[SLOT_MAIN_START] = { name: 'cobblestone', count: 60, type: 1, slot: SLOT_MAIN_START };
    const r = await giveItem(bot, 'cobblestone', 20);
    check('spills into a second slot', r.slots.length, 2);
    check('fills the partial stack first', bot.writes[0].count, 64);
    check('remainder goes to the new slot', bot.writes[1].count, 16);
    check('added count excludes what was there', r.placed, 20);
}
{
    // A full bag of the SAME item is genuinely full.
    const bot = makeBot();
    for (let s = SLOT_MAIN_START; s <= SLOT_HOTBAR_END; s++) {
        bot.inventory.slots[s] = { name: 'cobblestone', count: 64, type: 1, slot: s };
    }
    const r = await giveItem(bot, 'cobblestone', 10);
    check('full stacks of the same item are full', r.error, 'inventory is full');
}
{
    // Non-stackables must never be merged.
    const bot = makeBot();
    bot.inventory.slots[SLOT_MAIN_START] = { name: 'diamond_sword', count: 1, type: 2, slot: SLOT_MAIN_START };
    const r = await giveItem(bot, 'diamond_sword', 1);
    check('singletons do not merge', bot.writes[0].slot !== SLOT_MAIN_START, true);
    check('singleton give still succeeds', r.placed, 1);
}

// --- THE REGRESSION: a registry shift must never read as success ------------------------------------
{
    // 26.1 inserted an item, so our id 1 means something else there. The server accepts the
    // packet and stores the wrong block - nothing throws. Only the readback catches it.
    const bot = makeBot({ substitute: 'oak_planks' });
    const r = await giveItem(bot, 'cobblestone', 10);
    check('substitution is NOT success', r.ok, false);
    check('substitution names both sides', /ITEM ID MISMATCH/.test(r.error), true);
    check('reports what actually landed', r.got, 'oak_planks');
}
{
    const bot = makeBot({ reject: true });
    const r = await giveItem(bot, 'cobblestone', 10);
    check('a rejected write is not success', r.ok, false);
    check('rejection is explained', /rejected/.test(r.error), true);
}
{
    const bot = makeBot();
    const p = await probeIdMapping(bot, 'cobblestone');
    check('probe passes when ids agree', p.ok, true);
    check('probe cleans up after itself', bot.inventory.slots[p.slot], null);
}
{
    const p = await probeIdMapping(makeBot({ substitute: 'torch' }), 'cobblestone');
    check('probe catches a shifted id', p.ok, false);
    check('probe reports what landed', p.got, 'torch');
}

// --- clearing ---------------------------------------------------------------------------------------
{
    const bot = makeBot({ occupied: [SLOT_MAIN_START, SLOT_MAIN_START + 3, SLOT_HOTBAR_START] });
    const r = await clearInventory(bot);
    check('clears every occupied slot', r.cleared, 3);
    check('inventory ends empty', freeSlots(bot).length, (SLOT_HOTBAR_END - SLOT_MAIN_START) + 1);
}

// --- kits -------------------------------------------------------------------------------------------
{
    const r = await giveKit(makeBot(), 'nonsense');
    check('unknown kit is an error', !!r.error, true);
    check('unknown kit lists the real ones', /building/.test(r.error), true);
}
{
    const r = await giveKit(makeBot({ mode: 'survival' }), 'building');
    check('kit refuses outside creative', !!r.error, true);
}
for (const [name, entries] of Object.entries(KITS)) {
    check(`kit ${name} is non-empty`, entries.length > 0, true);
    check(`kit ${name} fits in 36 slots`, entries.length <= 36, true);
    for (const [item, count] of entries) {
        if (typeof item !== 'string' || !item) { console.error(`FAIL kit ${name}: bad item name`); failures++; }
        if (!Number.isInteger(count) || count < 1) { console.error(`FAIL kit ${name}/${item}: bad count ${count}`); failures++; }
    }
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: creative inventory correct');
