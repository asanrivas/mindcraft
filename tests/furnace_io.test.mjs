/**
 * The furnace arithmetic and refusals, as pure functions. No server, no bot:
 *   bun tests/furnace_io.test.mjs
 *
 * `smeltItem` rode mineflayer's furnace API - `bot.openFurnace`, `putFuel`, `putInput`,
 * `takeOutput` - which is the SAME defect class `container_io.js` was written to replace for
 * chests, because those helpers are thin wrappers over the very code that failed there:
 * `bot.openBlock` awaits `windowOpen` with no deadline, `putInput`/`putFuel` are `bot.transfer`
 * (cursor-based, asserts, strands items on the cursor for the server to drop), `takeOutput` is
 * `bot.putAway`, and `bot.inventory` is frozen for the whole time the window is open.
 *
 * The cases below are the ones a live run reaches only by accident - a furnace already busy
 * with someone else's ore, half the fuel needed, a request for 200 into a slot that holds 64 -
 * and every one of them used to be either a silent wrong answer or an unbounded wait.
 */
import {
    fuelPlan, batchSizes, smeltVerdict, collectVerdict, explainSmelt,
    INPUT_SLOT, FUEL_SLOT, OUTPUT_SLOT, FURNACE_NAMES, IDLE_LIMIT_MS, SESSION_MS,
    pickFuelName, isWoodFuel, PRIMARY_FUELS, BULK_FUELS,
} from '../src/agent/library/furnace_io.js';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}: got ${g}, expected ${w}`); failures++; }
};

// --- the window layout is protocol, not preference ------------------------------------------
check('slot layout', [INPUT_SLOT, FUEL_SLOT, OUTPUT_SLOT], [0, 1, 2]);
// EXACT names. `"blast_furnace".includes("furnace")` is true and so is `"furnace_minecart"`;
// this repo has been bitten three times by substring matching on block names.
check('furnace family is an exact set',
    [...FURNACE_NAMES].sort(), ['blast_furnace', 'furnace', 'smoker']);
check('a furnace minecart is not a furnace', FURNACE_NAMES.has('furnace_minecart'), false);

// --- fuel ------------------------------------------------------------------------------------
// Coal smelts 8. Eight items is one coal; nine is two - the ceil is the whole point.
check('8 smelts on coal is 1 coal', fuelPlan({ smelts: 8, perUnit: 8, have: 64 }).units, 1);
check('9 smelts on coal is 2 coal', fuelPlan({ smelts: 9, perUnit: 8, have: 64 }).units, 2);
// A plank burns 1.5 items, which does not divide evenly - the fractional case is why this is
// not integer division.
check('planks burn fractionally', fuelPlan({ smelts: 4, perUnit: 1.5, have: 64 }).units, 3);
// One smelt still needs one unit of fuel, never zero.
check('one smelt still costs fuel', fuelPlan({ smelts: 1, perUnit: 8, have: 64 }).units, 1);
// Not enough fuel must SAY not enough, and say how much short - the old code refused with a
// count computed the same way but there was no way to test it.
check('short of fuel is named', fuelPlan({ smelts: 64, perUnit: 8, have: 3 }).reason, 'not_enough_fuel');
check('short of fuel reports the gap', fuelPlan({ smelts: 64, perUnit: 8, have: 3 }).shortfall, 5);
// An unknown burn time must not become Infinity units of fuel.
check('unknown fuel refuses', fuelPlan({ smelts: 8, perUnit: undefined, have: 64 }).reason, 'unknown_fuel');
check('zero burn time refuses', fuelPlan({ smelts: 8, perUnit: 0, have: 64 }).reason, 'unknown_fuel');
check('unknown fuel asks for nothing', fuelPlan({ smelts: 8, perUnit: NaN, have: 64 }).units, 0);

// --- which fuel -------------------------------------------------------------------------------
// `mc.getSmeltingFuel` cannot be used with a window open (it reads the frozen `bot.inventory`)
// and it substring-matches 'log'/'planks' - which here is not untidy but WRONG.
check('nether planks are not fuel', isWoodFuel('crimson_planks'), false);
check('nether stems are not fuel', isWoodFuel('warped_stem'), false);
check('stripped nether wood is not fuel', isWoodFuel('stripped_crimson_hyphae'), false);
check('oak planks are fuel', isWoodFuel('oak_planks'), true);
check('bamboo planks are fuel', isWoodFuel('bamboo_planks'), true);
check('a stripped log is fuel', isWoodFuel('stripped_birch_log'), true);
check('oak wood is fuel', isWoodFuel('oak_wood'), true);
// Suffix, not substring: a bookshelf is not a plank and a logbook is not a log.
check('the suffix is anchored', isWoodFuel('planks_of_nothing'), false);
check('a non-string is not fuel', isWoodFuel(undefined), false);

// Coal beats planks even when the planks come first in the bag - a live run only ever
// exercises whichever the bot happens to be carrying.
check('coal beats planks',
    pickFuelName([{ name: 'oak_planks', count: 64 }, { name: 'coal', count: 2 }]).name, 'coal');
// A coal BLOCK is kept last on purpose: burning 80 smelts of fuel for one steak is a waste.
check('coal blocks are the last resort',
    pickFuelName([{ name: 'coal_block', count: 4 }, { name: 'oak_planks', count: 8 }]).name, 'oak_planks');
check('a coal block is still fuel when it is all there is',
    pickFuelName([{ name: 'coal_block', count: 4 }]).name, 'coal_block');
check('a bag with no fuel picks nothing',
    pickFuelName([{ name: 'dirt', count: 64 }, { name: 'crimson_planks', count: 64 }]), null);
// A zero count is not a holding.
check('a zero-count stack is not fuel', pickFuelName([{ name: 'coal', count: 0 }]), null);
check('an empty bag picks nothing', pickFuelName([]), null);
check('undefined entries do not throw', pickFuelName(undefined), null);
check('the preference lists are frozen',
    [Object.isFrozen(PRIMARY_FUELS), Object.isFrozen(BULK_FUELS)], [true, true]);

// --- batching ---------------------------------------------------------------------------------
// A furnace input slot holds one stack. `putInput(type, null, 200)` could never work, and
// mineflayer answers that by throwing partway through with items on the cursor.
check('200 is three inserts', batchSizes(200), [64, 64, 64, 8]);
check('64 is one insert', batchSizes(64), [64]);
check('1 is one insert', batchSizes(1), [1]);
check('0 is no inserts', batchSizes(0), []);
check('a negative total is no inserts', batchSizes(-5), []);
check('a small stack size is respected', batchSizes(40, 16), [16, 16, 8]);

// --- may we use this furnace at all -----------------------------------------------------------
check('the ordinary case',
    smeltVerdict({ itemName: 'raw_iron', want: 5, held: 10, hasFuelInSlot: true }),
    { ok: true, count: 5, reason: 'ok' });
// A furnace someone else is using. EXACT name comparison: `cooked_beef` contains `beef` and
// `raw_iron` contains `iron`, so a substring test would top up a furnace with the wrong item.
check('busy with another item refuses',
    smeltVerdict({ itemName: 'raw_iron', want: 5, held: 10, occupantName: 'raw_gold', occupantCount: 3 }).reason,
    'busy_with_other');
check('beef does not match cooked_beef',
    smeltVerdict({ itemName: 'beef', want: 1, held: 5, occupantName: 'cooked_beef', occupantCount: 1 }).reason,
    'busy_with_other');
// Topping up a furnace already smelting the SAME thing is fine - that is not a conflict.
check('same item already in the furnace is not a refusal',
    smeltVerdict({ itemName: 'raw_iron', want: 5, held: 10, occupantName: 'raw_iron', occupantCount: 3,
                   hasFuelInSlot: true }).ok, true);
// An EMPTY occupant slot must not read as occupied.
check('an empty input slot is not busy',
    smeltVerdict({ itemName: 'raw_iron', want: 1, held: 1, occupantName: null, occupantCount: 0,
                   hasFuelInSlot: true }).ok, true);
check('a zero-count occupant is not busy',
    smeltVerdict({ itemName: 'raw_iron', want: 1, held: 1, occupantName: 'raw_gold', occupantCount: 0,
                   hasFuelInSlot: true }).ok, true);
check('nothing held refuses', smeltVerdict({ itemName: 'beef', want: 1, held: 0 }).reason, 'none_held');
check('not enough held refuses', smeltVerdict({ itemName: 'beef', want: 9, held: 3 }).reason, 'not_enough_input');
check('no item refuses', smeltVerdict({ itemName: null, want: 1, held: 9 }).reason, 'no_item');
check('a zero request refuses', smeltVerdict({ itemName: 'beef', want: 0, held: 9 }).reason, 'nothing_asked');
// Fuel already burning in the slot means we need none of our own - refusing there would stop
// the bot using a furnace a person had just loaded.
check('fuel already in the slot needs none of ours',
    smeltVerdict({ itemName: 'beef', want: 1, held: 5, hasFuelInSlot: true, fuelAvailable: false }).ok, true);
check('no fuel anywhere refuses',
    smeltVerdict({ itemName: 'beef', want: 1, held: 5, hasFuelInSlot: false, fuelAvailable: false }).reason, 'no_fuel');

// --- when to stop waiting -----------------------------------------------------------------------
check('still waiting', collectVerdict({ collected: 0, want: 4, idleMs: 500, elapsedMs: 500 }), 'waiting');
check('got what we asked for', collectVerdict({ collected: 4, want: 4, idleMs: 0, elapsedMs: 10 }), 'done');
check('more than asked is still done', collectVerdict({ collected: 5, want: 4, idleMs: 0 }), 'done');
// Each clock bounds a DIFFERENT failure: idle is a furnace that stopped producing, the session
// is one that never will, the interrupt is a person wanting the bot back.
check('an idle furnace stalls',
    collectVerdict({ collected: 1, want: 4, idleMs: IDLE_LIMIT_MS, elapsedMs: IDLE_LIMIT_MS }), 'stalled');
check('a long session times out',
    collectVerdict({ collected: 1, want: 4, idleMs: 0, elapsedMs: SESSION_MS }), 'timeout');
check('an interrupt stops it',
    collectVerdict({ collected: 1, want: 4, idleMs: 0, elapsedMs: 10, interrupted: true }), 'interrupted');
// Finishing on the same tick a clock expires is FINISHED. The items are in the bag either way,
// and reporting a timeout would send the bot back to a furnace it has already emptied.
check('done outranks the deadline',
    collectVerdict({ collected: 4, want: 4, idleMs: 999999, elapsedMs: SESSION_MS, interrupted: true }), 'done');

// --- every refusal names itself -----------------------------------------------------------------
// A silent refusal is indistinguishable from the branch never running.
for (const reason of ['no_item', 'nothing_asked', 'busy_with_other', 'none_held', 'not_enough_input',
                      'no_fuel', 'not_enough_fuel', 'unknown_fuel', 'unreachable', 'no_response',
                      'stalled', 'timeout', 'interrupted']) {
    const line = explainSmelt(reason, { itemName: 'raw_iron', want: 5, occupantName: 'raw_gold', shortfall: 2 });
    if (typeof line !== 'string' || line.length < 8) {
        console.error(`FAIL explainSmelt(${reason}) gave no usable sentence: ${JSON.stringify(line)}`);
        failures++;
    }
}
check('the busy line names the occupant',
    /raw_gold/.test(explainSmelt('busy_with_other', { occupantName: 'raw_gold' })), true);
check('an unknown reason still says something',
    explainSmelt('something_new').includes('something_new'), true);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('furnace_io: arithmetic and refusals correct');
