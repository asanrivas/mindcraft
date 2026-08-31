/**
 * Food self-sufficiency, as pure decisions. No bot, no Vec3, no timers, no clock, no I/O.
 *
 * Everything in here is a function of arguments the caller has already measured, for the same
 * reason `nav.waterExitVerdict` and `skills.followVerdict` are: the interesting states -
 * starving with a bag of raw chicken, a cow that fled 30 blocks, a field of age-0 wheat - are
 * states a live run only reaches by accident, and the REFUSALS are the part that matters. A
 * food mode interrupts every action in the agent (CLAUDE.md, "Modes System"), so a wrong
 * "acquire food now" cancels whatever a person asked for.
 *
 * The three hard-won rules this file is built to obey:
 *
 * 1. NEVER substring-match a block or item name. `"sandstone".includes("sand")` is true and
 *    sandstone does not fall; that exact bug made `self_preservation` fire every tick in a
 *    desert. Here the same shape would be `"poisonous_potato".includes("potato")` - which would
 *    put a poisonous potato in the cook plan and in the food supply - and
 *    `"cooked_beef".includes("beef")`, which would ask the furnace to cook a cooked steak
 *    forever. Every membership test below is an exact lookup in a Set or an own-property check
 *    on a frozen table. `mc.isSmeltable` (mcdata.js:282) does substring-match, deliberately, for
 *    ores and logs - that is exactly why `cookPlan` does NOT use it.
 *
 * 2. "It left the range" is not "it died". See `killConfirmed`.
 *
 * 3. A conditional `!stats` line must be able to render NOTHING. See `foodSupplyLine`.
 */

/** `age` at which a crop is ready. Beetroot is the famous asymmetry: 3, not 7. */
export const CROP_MAX_AGE = Object.freeze({
    wheat: 7,
    carrots: 7,
    potatoes: 7,
    beetroots: 3,
});

/**
 * What to replant a harvested crop with. Note carrots/potatoes replant with the FOOD item
 * (there is no "carrot_seeds"), which is the other asymmetry a substring rule would fumble.
 */
export const SEED_FOR = Object.freeze({
    wheat: 'wheat_seeds',
    carrots: 'carrot',
    potatoes: 'potato',
    beetroots: 'beetroot_seeds',
});

/**
 * Raw items worth putting in a furnace FOR FOOD. Deliberately a short whitelist and not
 * `mc.isSmeltable`, which also returns true for cobblestone, sand, clay and every log/ore -
 * because it substring-matches "raw" and "log". Cooking cobblestone is a valid smelt and a
 * useless meal, and it would burn the fuel the actual dinner needs.
 *
 * `potato` is here rather than in the edible table on purpose: a raw potato is 1 food point and
 * a baked one is 5, so as SUPPLY it counts as something to cook, not something to eat.
 */
export const RAW_COOKABLE = Object.freeze(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato']);

/**
 * Cooking order. Raw chicken first because auto-eat is forbidden from eating it
 * (`bannedFood`, agent.js:364 - salmonella), so until it is cooked it is dead weight in the bag;
 * everything else after it in declaration order, so a plan is deterministic and testable.
 */
export const COOK_ORDER = Object.freeze(['chicken', ...RAW_COOKABLE.filter(n => n !== 'chicken')]);

/**
 * Mirrors `this.bot.autoEat.options.bannedFood` (agent.js:361-366). If auto-eat will not eat it,
 * it is not supply - a bag of rotten flesh must still read as "no food", or the mode stands
 * down while the bot starves. Keep this list in step with agent.js; it has grown once already.
 */
export const DEFAULT_BANNED = Object.freeze(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']);

/** Hunger points restored, vanilla. Raw meats are absent BY DESIGN - see RAW_COOKABLE. */
export const FOOD_POINTS = Object.freeze({
    apple: 4,
    baked_potato: 5,
    beetroot: 1,
    beetroot_soup: 6,
    bread: 5,
    carrot: 3,
    chorus_fruit: 4,
    cooked_beef: 8,
    cooked_chicken: 6,
    cooked_cod: 5,
    cooked_mutton: 6,
    cooked_porkchop: 8,
    cooked_rabbit: 5,
    cooked_salmon: 6,
    cookie: 2,
    dried_kelp: 1,
    enchanted_golden_apple: 4,
    glow_berries: 2,
    golden_apple: 4,
    golden_carrot: 6,
    honey_bottle: 6,
    melon_slice: 2,
    mushroom_stew: 6,
    poisonous_potato: 2,
    pufferfish: 1,
    pumpkin_pie: 8,
    rabbit_stew: 10,
    rotten_flesh: 4,
    spider_eye: 2,
    suspicious_stew: 6,
    sweet_berries: 2,
    tropical_fish: 1,
});

/**
 * How much a kill is worth as FOOD. A llama is `mc.isHuntable` (mcdata.js:117) but drops no
 * meat at all, so it must never win a ranking - it is a wasted 45-second chase. Kept at 0
 * rather than filtered out so a caller with nothing else in sight can still see it and decide.
 */
export const HUNT_VALUE = Object.freeze({
    cow: 3,
    mooshroom: 3,
    pig: 3,
    sheep: 3,
    chicken: 2,
    rabbit: 2,
    llama: 0,
});

/** Below this many edible food points the bag counts as low. ~2.5 cooked steaks. */
export const LOW_POINTS = 20;
/** auto-eat's `startAt` (agent.js:362): at or above this hunger it will not eat. */
export const AUTO_EAT_AT = 14;
/** Melee reach. Beyond this an attack swing is a no-op and the answer is to walk. */
export const ATTACK_REACH = 3.0;

const RAW_SET = new Set(RAW_COOKABLE);
const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Is this crop block ready to harvest?
 *
 * Exact name lookup, never a substring: `attached_melon_stem`, `torchflower_crop` and
 * `nether_wart` all end in states that a loose rule would call wheat. Anything not in
 * CROP_MAX_AGE is not a crop we harvest, full stop.
 *
 * `properties` is whatever `block.getProperties()` returned. prismarine-block is not consistent
 * about whether an int property arrives as a number or a decimal string, so the age is compared
 * numerically - but only after proving it IS a number, since `Number(undefined)` is NaN and
 * `Number(null)` is 0, and 0 is a real age (a just-planted crop must never read as mature).
 */
export function isMatureCrop(blockName, properties) {
    if (!has(CROP_MAX_AGE, blockName)) return false;
    if (!properties || typeof properties !== 'object') return false;
    const raw = properties.age;
    if (raw == null || raw === '') return false;
    const age = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(age)) return false;
    return age === CROP_MAX_AGE[blockName];
}

/** What to replant `blockName` with, or null if we do not replant it. */
export function seedItemFor(blockName) {
    return has(SEED_FOR, blockName) ? SEED_FOR[blockName] : null;
}

/**
 * What the bag is actually worth as food.
 *
 * `invCounts` is `world.getInventoryCounts(bot)` - `{ name: count }`. Three rules:
 *
 * - A BANNED item contributes nothing. Auto-eat will not eat it, so 64 rotten flesh is not
 *   "stocked"; treating it as supply is how a bot starves with a full inventory.
 * - RAW meat is `rawCookable`, never `edible`, even though vanilla lets you eat it. Eating raw
 *   beef wastes two thirds of the meal, and raw chicken is banned outright - so the correct
 *   response to a bag of raw meat is a furnace, not a bite.
 * - Raw chicken is in BOTH lists' logic: banned to eat, still worth cooking. That is why the
 *   raw test runs before the banned test.
 */
export function summarizeFoodSupply(invCounts, banned = DEFAULT_BANNED) {
    const bannedSet = new Set(Array.isArray(banned) ? banned : []);
    const edible = [];
    const rawCookable = [];
    let ediblePoints = 0;

    for (const name of Object.keys(invCounts ?? {})) {
        const count = invCounts[name];
        if (!Number.isFinite(count) || count <= 0) continue;
        if (RAW_SET.has(name)) {
            rawCookable.push({ name, count });
            continue;
        }
        if (bannedSet.has(name)) continue;
        if (!has(FOOD_POINTS, name)) continue;
        const points = FOOD_POINTS[name] * count;
        edible.push({ name, count, points });
        ediblePoints += points;
    }

    // Deterministic order so the !stats line and the tests do not depend on inventory order.
    edible.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    rawCookable.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
        ediblePoints,
        edible: edible.map(e => ({ name: e.name, count: e.count })),
        rawCookable,
        rawCookableCount: rawCookable.reduce((n, e) => n + e.count, 0),
        low: ediblePoints < LOW_POINTS,
    };
}

/**
 * The `!stats` line - **or null**.
 *
 * Null when there is nothing to say, which is the established pattern for every conditional
 * line in this prompt (`In water:` only while wet, `Brain: BACKUP` only while failed over).
 * The prompt is rebuilt on every single turn, so a line that always renders is a permanent tax
 * on a 9B model's attention for information that is almost always "fine".
 *
 * "Nothing to say" is BOTH stocked AND not hungry enough for auto-eat to be about to fire: a
 * bot at 6/20 hunger with three loaves is a fact worth stating even though the bag is fine,
 * because it explains why the bot is about to stop and eat.
 */
export function foodSupplyLine(supply, food) {
    if (!supply) return null;
    const hunger = Number.isFinite(food) ? food : null;
    if (!supply.low && (hunger === null || hunger >= AUTO_EAT_AT)) return null;

    const parts = [];
    if (hunger !== null) parts.push(`hunger ${hunger}/20`);
    parts.push(supply.edible.length
        ? `edible ${supply.edible.map(e => `${e.count}x ${e.name}`).join(', ')} (${supply.ediblePoints} pts)`
        : 'NO edible food');
    if (supply.rawCookable.length) {
        parts.push(`raw to cook ${supply.rawCookable.map(e => `${e.count}x ${e.name}`).join(', ')}`);
    }
    return `Food: ${parts.join(', ')}`;
}

/**
 * Order candidate animals best-first.
 *
 * `entities` are plain descriptors - `{ name, distance, metadata }` or `{ name, distance,
 * isBaby }` - so this stays pure and the baby filter is testable without a server. Babies are
 * excluded, matching `mc.isHuntable` (mcdata.js:120, `!mob.metadata[16]`): a baby drops nothing
 * and killing it removes tomorrow's breeding stock.
 *
 * Sort is value desc, then distance asc, so a cow 20 blocks away beats a chicken at 5 - the
 * chase is the cheap part, the meat is the point - while the llama's 0 keeps it last.
 */
export function rankHuntTargets(entities) {
    const out = [];
    for (const e of entities ?? []) {
        if (!e || typeof e.name !== 'string') continue;
        if (!has(HUNT_VALUE, e.name)) continue;          // exact name; never substring
        const baby = e.isBaby ?? (Array.isArray(e.metadata) ? e.metadata[16] : undefined);
        if (baby) continue;
        out.push(e);
    }
    return out.sort((a, b) => {
        const dv = HUNT_VALUE[b.name] - HUNT_VALUE[a.name];
        if (dv !== 0) return dv;
        const da = Number.isFinite(a.distance) ? a.distance : Infinity;
        const db = Number.isFinite(b.distance) ? b.distance : Infinity;
        return da - db;
    });
}

/**
 * Did we actually kill it? **Only positive evidence of death counts.**
 *
 * This is the whole reason the file exists. `attackEntity(kill=true)` (skills.js:585-592) waits
 * with `while (world.getNearbyEntities(bot, 24).includes(entity))` and then logs
 * `Successfully killed` - so an animal that simply RAN AWAY is reported as food obtained, and a
 * hunt for dinner returns with an empty bag and a success message. A bot that believes it ate
 * cannot fix being hungry.
 *
 * The plan for this module proposed `entity.isValid === false` as a death signal. It is not:
 * mineflayer clears that flag in its `entity_destroy` handler
 * (`node_modules/mineflayer/lib/plugins/entities.js:288-296`), and the server sends
 * `entity_destroy` when an entity leaves the client's view distance exactly as it does when one
 * dies. `isValid === false` is therefore *identical* for "died at my feet" and "fled over the
 * hill" - it is the same bug in a different costume, so it is deliberately NOT accepted here.
 *
 * What does count:
 *  - `health <= 0` on the entity we were tracking, or
 *  - `deathSeen`: the caller observed mineflayer's `entityDead` (entity_status 3) for THIS
 *    entity id, which the server only sends for a death, and only within view.
 *
 * A null entity is not a confirmation either - it means we lost track, which is the fled case
 * again. Distance is never an input, in either direction.
 */
export function killConfirmed(entity, s = {}) {
    if (s && s.deathSeen === true) return true;
    if (!entity) return false;
    if (typeof entity.health === 'number' && entity.health <= 0) return true;
    return false;
}

/**
 * What to do about the current hunt target, every iteration.
 *
 * `s`: `{ targetValid, dist, elapsedMs, deadlineMs, botInWater, targetInWater }`.
 * Returns 'refuse' | 'give_up' | 'attack' | 'approach'.
 *
 * - **Water refuses first, and beats everything.** SwimAssist owns the jump key while the bot is
 *   wet (CLAUDE.md, Swimming: "Nothing else may touch it"), and both mining and melee cadence
 *   are wrong afloat. A target that is itself in water is refused for the same reason plus one
 *   more: chasing a swimming cow puts the BOT in the lake, and getting out is this codebase's
 *   single largest source of stuck bots.
 * - A target that is gone, or a deadline that has passed, is `give_up` - move to the next animal.
 * - **Distance alone is never `give_up`.** A fled animal with time left is re-approached; that
 *   asymmetry is the inverse of the `attackEntity` bug.
 */
export function huntVerdict(s = {}) {
    if (s.botInWater) return 'refuse';
    if (s.targetInWater) return 'refuse';
    if (!s.targetValid) return 'give_up';
    if (Number.isFinite(s.elapsedMs) && Number.isFinite(s.deadlineMs) && s.elapsedMs >= s.deadlineMs) return 'give_up';
    if (Number.isFinite(s.dist) && s.dist <= ATTACK_REACH) return 'attack';
    return 'approach';
}

/**
 * What to put in the furnace, in order. Whitelist only - see RAW_COOKABLE for why this does not
 * call `mc.isSmeltable` (a bag of cobblestone must produce an EMPTY plan and zero furnace opens,
 * not a stone-smelting session while the bot starves).
 */
export function cookPlan(invCounts) {
    const plan = [];
    for (const item of COOK_ORDER) {
        const count = invCounts?.[item];
        if (Number.isFinite(count) && count > 0) plan.push({ item, count });
    }
    return plan;
}

/**
 * The mode's whole decision, as one pure function.
 *
 * `s`: `{ food, ediblePoints, rawCookableCount, matureCropCount, huntableCount, inWater,
 *        peaceful, cooldownActive }`. Returns 'none' | 'cook' | 'harvest' | 'hunt'.
 *
 * The stand-downs come first and every one of them is load-bearing:
 *  - **peaceful**: hunger does not drain at all, so acquiring food buys nothing and the mode is
 *    a pure tax on whatever a person asked for - the same reasoning that made `night_safety`
 *    stand down. (Read it via `difficulty.isPeaceful`; `bot.game.difficulty` is a lie here.)
 *  - **inWater**: never contest the jump key, and never start a land errand from a lake.
 *  - **cooldownActive**: a failed acquisition must back off, not retry on a beat -
 *    `night_safety` printed the same failure every 20s all night before it learned this.
 *  - **stocked**: judged on SUPPLY, not on hunger. A hungry bot with three loaves needs no
 *    acquisition; auto-eat will handle the meal.
 *
 * Then cheapest-first: cooking needs no travel, harvesting is a short walk to a known plot, and
 * hunting is a 45-second chase - so hunting is reserved for actual starvation with nothing else
 * available. `huntableCount === 0` falls through to 'none' rather than to a search, so an empty
 * desert produces silence instead of a thrash.
 */
export function decideFoodAction(s = {}) {
    if (s.peaceful) return 'none';
    if (s.inWater) return 'none';
    if (s.cooldownActive) return 'none';

    const points = Number.isFinite(s.ediblePoints) ? s.ediblePoints : 0;
    if (points >= LOW_POINTS) return 'none';

    if ((s.rawCookableCount ?? 0) > 0) return 'cook';
    if ((s.matureCropCount ?? 0) > 0) return 'harvest';

    const food = Number.isFinite(s.food) ? s.food : 20;
    if (food <= 6 && points === 0 && (s.huntableCount ?? 0) > 0) return 'hunt';
    return 'none';
}
