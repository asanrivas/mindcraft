/**
 * The food decisions, as pure functions. No server, no bot:
 *   bun tests/food.test.mjs
 *
 * WHY THESE ARE UNIT TESTS. Every state worth checking is one a live run reaches only by
 * accident: a bag holding nothing but rotten flesh, a cow that fled 30 blocks mid-chase, a
 * field of age-0 wheat, a llama standing closer than the cow. A live pass exercises whichever
 * one the world happened to be in, and the food mode interrupts EVERY action in the agent - so
 * a wrong "acquire food now" cancels what a person asked for. The refusals carry the weight.
 *
 * Two real bugs are inverted into tests here:
 *   - `attackEntity(kill=true)` (skills.js:585-592) waits on
 *     `world.getNearbyEntities(bot, 24).includes(entity)` and then logs `Successfully killed`.
 *     A pig that RAN AWAY reads as dinner. -> `killConfirmed` / `huntVerdict`.
 *   - `"sandstone".includes("sand")`, the desert bug, in its food costume:
 *     `"poisonous_potato".includes("potato")` and `"cooked_beef".includes("beef")`.
 *     -> the exact-match cases scattered through every section.
 */
import {
    isMatureCrop, seedItemFor, summarizeFoodSupply, foodSupplyLine, rankHuntTargets,
    killConfirmed, huntVerdict, cookPlan, decideFoodAction,
    DEFAULT_BANNED, LOW_POINTS,
} from '../src/agent/library/farming.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};
const checkDeep = (label, got, want) => check(label, JSON.stringify(got), JSON.stringify(want));

// --- isMatureCrop ----------------------------------------------------------------------------
check('wheat at age 7 is ready', isMatureCrop('wheat', { age: 7 }), true);
check('wheat at age 6 is not', isMatureCrop('wheat', { age: 6 }), false);
// The famous asymmetry. A single MAX_AGE of 7 harvests beetroot never; a single 3 harvests
// wheat four ages early, which destroys the plant for a third of the yield.
check('beetroots ripen at 3', isMatureCrop('beetroots', { age: 3 }), true);
check('beetroots at 7 is not even a real state', isMatureCrop('beetroots', { age: 7 }), false);
check('carrots at 7', isMatureCrop('carrots', { age: 7 }), true);
check('potatoes at 7', isMatureCrop('potatoes', { age: 7 }), true);
// prismarine-block is not consistent about int properties arriving as numbers or strings.
check('a stringified age still reads', isMatureCrop('wheat', { age: '7' }), true);
check('age 0 is a just-planted crop, never mature', isMatureCrop('wheat', { age: 0 }), false);
check('age "0" too', isMatureCrop('wheat', { age: '0' }), false);

// Not crops. `tall_grass` and `nether_wart` both carry an `age`; `attached_melon_stem` is what a
// substring rule would call a stem worth breaking.
check('tall_grass is not a crop', isMatureCrop('tall_grass', { age: 7 }), false);
check('nether_wart is not in the table', isMatureCrop('nether_wart', { age: 3 }), false);
check('attached_melon_stem is not wheat', isMatureCrop('attached_melon_stem', { age: 7 }), false);
check('missing properties', isMatureCrop('wheat', undefined), false);
check('empty properties', isMatureCrop('wheat', {}), false);
check('null age', isMatureCrop('wheat', { age: null }), false);
check('garbage age', isMatureCrop('wheat', { age: 'ripe' }), false);
check('no block name', isMatureCrop(undefined, { age: 7 }), false);
// Own-property check, not a bare lookup: every object "has" a constructor.
check('constructor is not a crop', isMatureCrop('constructor', { age: 7 }), false);

// --- seedItemFor -----------------------------------------------------------------------------
check('wheat replants with seeds', seedItemFor('wheat'), 'wheat_seeds');
// The other asymmetry: carrots and potatoes replant with the FOOD item - there is no
// "carrot_seeds" - so a `${name}_seeds` rule would fail on half the table.
check('carrots replant with a carrot', seedItemFor('carrots'), 'carrot');
check('potatoes replant with a potato', seedItemFor('potatoes'), 'potato');
check('beetroots replant with seeds', seedItemFor('beetroots'), 'beetroot_seeds');
check('melon_stem has no seed here', seedItemFor('melon_stem'), null);
check('undefined', seedItemFor(undefined), null);

// --- summarizeFoodSupply ---------------------------------------------------------------------
check('bread counts', summarizeFoodSupply({ bread: 4 }).ediblePoints, 20);
check('empty bag has no points', summarizeFoodSupply({}).ediblePoints, 0);
check('...and is low', summarizeFoodSupply({}).low, true);
check('4 bread is not low', summarizeFoodSupply({ bread: 4 }).low, false);

// EVERY banned item contributes zero. Auto-eat will not eat these (agent.js:364), so counting
// them as supply is how a bot stands down from acquiring food while it starves.
for (const item of DEFAULT_BANNED) {
    check(`banned: ${item} is not supply`, summarizeFoodSupply({ [item]: 64 }).ediblePoints, 0);
    check(`banned: ${item} still reads low`, summarizeFoodSupply({ [item]: 64 }).low, true);
}

// Raw meat is fuel for a furnace, not a meal.
const raw = summarizeFoodSupply({ beef: 6 });
check('raw beef earns no edible points', raw.ediblePoints, 0);
checkDeep('raw beef is cookable', raw.rawCookable, [{ name: 'beef', count: 6 }]);
checkDeep('...and is not edible', raw.edible, []);
// Raw chicken is banned to EAT and still worth COOKING - the one item in both stories.
const chick = summarizeFoodSupply({ chicken: 3 });
checkDeep('raw chicken is cookable despite the ban', chick.rawCookable, [{ name: 'chicken', count: 3 }]);
check('raw chicken is not edible supply', chick.ediblePoints, 0);
// Cooked chicken is a different item entirely - the substring trap, inverted.
check('cooked_chicken IS supply', summarizeFoodSupply({ cooked_chicken: 4 }).ediblePoints, 24);
check('cooked_beef is not raw beef', summarizeFoodSupply({ cooked_beef: 1 }).rawCookable.length, 0);
// ...and so is a poisonous potato, which a `.includes('potato')` rule would cook AND eat.
check('poisonous_potato is not a potato', summarizeFoodSupply({ poisonous_potato: 9 }).rawCookableCount, 0);
check('poisonous_potato is not supply', summarizeFoodSupply({ poisonous_potato: 9 }).ediblePoints, 0);

check('non-food is ignored', summarizeFoodSupply({ cobblestone: 640, iron_pickaxe: 1 }).ediblePoints, 0);
check('zero counts are ignored', summarizeFoodSupply({ bread: 0 }).edible.length, 0);
check('mixed bag totals', summarizeFoodSupply({ bread: 2, cooked_beef: 1, rotten_flesh: 20, beef: 2 }).ediblePoints, 18);
check('...and lists the raw', summarizeFoodSupply({ bread: 2, cooked_beef: 1, rotten_flesh: 20, beef: 2 }).rawCookableCount, 2);
// An explicit empty ban list must not silently re-enable rotten flesh anywhere else; it is the
// caller's call, and it is what makes the default list testable as a default.
check('an empty ban list is honoured', summarizeFoodSupply({ rotten_flesh: 5 }, []).ediblePoints, 20);

// --- foodSupplyLine: the must-NOT-render case first -------------------------------------------
// The prompt is rebuilt every turn. A line that always renders is a permanent tax on a 9B
// model's attention, which is why `In water:` and `Brain: BACKUP` render conditionally too.
check('stocked and not hungry renders NOTHING',
    foodSupplyLine(summarizeFoodSupply({ cooked_beef: 8 }), 20), null);
check('stocked at exactly the auto-eat threshold still renders nothing',
    foodSupplyLine(summarizeFoodSupply({ bread: 4 }), 14), null);
check('no supply object at all', foodSupplyLine(null, 20), null);

const lowLine = foodSupplyLine(summarizeFoodSupply({ beef: 4 }), 12);
check('low supply renders', typeof lowLine, 'string');
check('...names the missing food', lowLine?.includes('NO edible food'), true);
check('...and counts the raw', lowLine?.includes('4x beef'), true);
check('...and the hunger', lowLine?.includes('12/20'), true);
// Stocked but hungry is still worth a line: it explains why the bot is about to stop and eat.
const hungryLine = foodSupplyLine(summarizeFoodSupply({ bread: 6 }), 5);
check('hungry but stocked renders', typeof hungryLine, 'string');
check('...with the count', hungryLine?.includes('6x bread'), true);

// --- rankHuntTargets -------------------------------------------------------------------------
const cow = { name: 'cow', distance: 20 };
const chicken = { name: 'chicken', distance: 5 };
const llama = { name: 'llama', distance: 1 };
checkDeep('a cow at 20 beats a chicken at 5',
    rankHuntTargets([chicken, cow]).map(e => e.name), ['cow', 'chicken']);
// A llama is `mc.isHuntable` and drops NO meat: chasing the nearest one is 45 seconds for zero
// food, so its value of 0 must outrank being one block away.
checkDeep('llama is last even when nearest',
    rankHuntTargets([llama, chicken, cow]).map(e => e.name), ['cow', 'chicken', 'llama']);
checkDeep('equal value sorts by distance',
    rankHuntTargets([{ name: 'cow', distance: 30 }, { name: 'pig', distance: 4 }]).map(e => e.name),
    ['pig', 'cow']);
// Babies drop nothing and are tomorrow's breeding stock. `mc.isHuntable` filters on metadata[16].
const babyMeta = []; babyMeta[16] = 1;
checkDeep('a baby cow is never a target',
    rankHuntTargets([{ name: 'cow', distance: 2, metadata: babyMeta }]), []);
checkDeep('...and the isBaby form too',
    rankHuntTargets([{ name: 'cow', distance: 2, isBaby: true }]), []);
const adultMeta = []; adultMeta[16] = 0;
check('an adult cow with metadata is kept',
    rankHuntTargets([{ name: 'cow', distance: 2, metadata: adultMeta }]).length, 1);
checkDeep('nothing nearby', rankHuntTargets([]), []);
checkDeep('undefined input', rankHuntTargets(undefined), []);
// Hostiles, pets and villagers are not dinner - and none of them substring-match their way in.
checkDeep('a zombie is not food', rankHuntTargets([{ name: 'zombie', distance: 3 }]), []);
checkDeep('a wolf is not food', rankHuntTargets([{ name: 'wolf', distance: 3 }]), []);
checkDeep('a player is not food', rankHuntTargets([{ name: 'player', distance: 3 }]), []);
checkDeep('a chicken_jockey is not a chicken',
    rankHuntTargets([{ name: 'chicken_jockey', distance: 1 }]), []);
checkDeep('a nameless entity', rankHuntTargets([{ distance: 1 }, null]), []);

// --- killConfirmed: the fled-is-not-dead refusal ----------------------------------------------
check('health 0 is dead', killConfirmed({ name: 'cow', health: 0 }), true);
check('negative health is dead', killConfirmed({ name: 'cow', health: -2 }), true);
check('an observed entityDead is dead', killConfirmed({ name: 'cow', health: 8 }, { deathSeen: true }), true);
// THE BUG, INVERTED. A healthy animal 30 blocks away is a fled animal. `attackEntity` calls this
// a kill and returns "Successfully killed"; a bot that believes it ate cannot fix being hungry.
check('healthy and 30 blocks away is NOT a kill',
    killConfirmed({ name: 'cow', health: 10 }, { lastDistance: 30 }), false);
// And the costume it wears in mineflayer: `entity_destroy` fires for a despawn/view-distance
// exit exactly as for a death (entities.js:288-296), so isValid is not evidence either way.
check('isValid false alone is NOT a kill', killConfirmed({ name: 'cow', isValid: false }), false);
check('...even right next to us',
    killConfirmed({ name: 'cow', isValid: false, health: 10 }, { lastDistance: 1 }), false);
check('losing the entity entirely is not a kill', killConfirmed(null), false);
check('an entity we know nothing about', killConfirmed({ name: 'cow' }), false);
check('healthy is not dead', killConfirmed({ name: 'cow', health: 10 }), false);

// --- huntVerdict -----------------------------------------------------------------------------
const HUNT = { targetValid: true, dist: 10, elapsedMs: 1000, deadlineMs: 45000, botInWater: false, targetInWater: false };
const verdict = (over) => huntVerdict({ ...HUNT, ...over });
check('in reach, swing', verdict({ dist: 2.5 }), 'attack');
check('at the edge of reach', verdict({ dist: 3.0 }), 'attack');
check('just out of reach, walk', verdict({ dist: 3.1 }), 'approach');
// A fled target with time on the clock is CHASED, never written off - the exact inverse of the
// "left the range == killed" bug.
check('fled 30 blocks with time left is a re-approach', verdict({ dist: 30 }), 'approach');
check('past the deadline, next animal', verdict({ elapsedMs: 45000 }), 'give_up');
check('target gone', verdict({ targetValid: false }), 'give_up');
// Water refuses OUTRIGHT and outranks everything: SwimAssist owns the jump key while wet, and
// melee cadence is wrong afloat. This must beat even a target standing in melee range.
check('bot in water refuses', verdict({ botInWater: true, dist: 1 }), 'refuse');
check('never chase a swimming cow', verdict({ targetInWater: true, dist: 1 }), 'refuse');
check('water beats an expired deadline too',
    verdict({ botInWater: true, elapsedMs: 99999, targetValid: false }), 'refuse');
check('missing timing does not fabricate a give_up', huntVerdict({ targetValid: true, dist: 9 }), 'approach');

// --- cookPlan --------------------------------------------------------------------------------
// Chicken first: auto-eat is banned from eating it raw, so until it is cooked it is dead weight.
checkDeep('chicken is cooked first',
    cookPlan({ beef: 2, chicken: 3 }), [{ item: 'chicken', count: 3 }, { item: 'beef', count: 2 }]);
checkDeep('beef alone', cookPlan({ beef: 5 }), [{ item: 'beef', count: 5 }]);
// Smeltable is NOT food. `mc.isSmeltable` says yes to all three of these (it substring-matches
// "raw" and "log"), and a furnace full of cobblestone burns the fuel dinner needed.
checkDeep('a bag of rocks cooks nothing',
    cookPlan({ cobblestone: 64, sand: 12, oak_log: 9, raw_iron: 30 }), []);
checkDeep('an already-cooked bag cooks nothing',
    cookPlan({ cooked_beef: 12, baked_potato: 4, bread: 8 }), []);
checkDeep('a poisonous potato is never cooked', cookPlan({ poisonous_potato: 6 }), []);
checkDeep('empty', cookPlan({}), []);
checkDeep('undefined', cookPlan(undefined), []);
checkDeep('zero counts', cookPlan({ beef: 0 }), []);

// --- decideFoodAction: the must-NOT-fire cases first -------------------------------------------
const STARVING = {
    food: 3, ediblePoints: 0, rawCookableCount: 0, matureCropCount: 0, huntableCount: 4,
    inWater: false, peaceful: false, cooldownActive: false,
};
const decide = (over) => decideFoodAction({ ...STARVING, ...over });
// Peaceful freezes hunger entirely, so the whole mode is a tax on whatever a person asked for -
// the same stand-down `night_safety` had to learn. (NOTE: this server is currently on EASY;
// this branch exists so the mode is still correct the day the difficulty changes.)
check('peaceful stands down', decide({ peaceful: true }), 'none');
check('...even with everything else screaming',
    decide({ peaceful: true, rawCookableCount: 9, matureCropCount: 9 }), 'none');
check('in water stands down', decide({ inWater: true }), 'none');
check('...even with raw meat in the bag', decide({ inWater: true, rawCookableCount: 9 }), 'none');
check('a failed attempt backs off', decide({ cooldownActive: true }), 'none');
check('stocked does nothing', decide({ ediblePoints: LOW_POINTS, food: 3 }), 'none');
check('stocked and full does nothing', decide({ ediblePoints: 40, food: 20 }), 'none');

// Cheapest first: cooking needs no travel at all.
check('raw meat in the bag means cook', decide({ rawCookableCount: 6 }), 'cook');
check('cook wins over harvest', decide({ rawCookableCount: 6, matureCropCount: 9 }), 'cook');
check('cook wins over hunt even while starving', decide({ rawCookableCount: 1, huntableCount: 9 }), 'cook');
check('mature crops mean harvest', decide({ matureCropCount: 4 }), 'harvest');
check('harvest wins over hunt', decide({ matureCropCount: 4, huntableCount: 9 }), 'harvest');

// Hunting is a 45-second chase, so it is reserved for actual starvation with nothing else.
check('starving with animals in sight, hunt', decide({}), 'hunt');
check('hungry but not starving does not hunt', decide({ food: 10 }), 'none');
check('some edible left does not hunt', decide({ ediblePoints: 5 }), 'none');
// An empty desert must produce silence, not a thrash - the mode interrupts everything it fires on.
check('nothing to hunt, say nothing', decide({ huntableCount: 0 }), 'none');
check('missing fields default to doing nothing', decideFoodAction({}), 'none');
check('a completely empty state', decideFoodAction(), 'none');

console.log(failures === 0 ? 'food: all checks passed' : `food: ${failures} FAILED`);
process.exit(failures);
