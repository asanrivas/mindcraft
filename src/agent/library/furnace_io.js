/**
 * Our own furnace protocol. Does NOT use `furnace.putInput`, `putFuel`, `takeInput`,
 * `takeFuel` or `takeOutput`.
 *
 * WHY WE OWN THIS
 * ---------------
 * This is the same defect class `container_io.js` was written to replace for chests, and it is
 * the same three defects, because the furnace helpers are thin wrappers over the very code that
 * failed there:
 *
 *   1. **The open has no deadline.** `bot.openFurnace` is `bot.openBlock`, which is
 *      `activateBlock()` + a bare `await once(bot, 'windowOpen')`
 *      (mineflayer/lib/plugins/inventory.js:385-390). Every reason the server declines to send a
 *      window is therefore an infinite hang, and an action that never returns pins
 *      `currentActionLabel` forever - after which no action in the agent can ever start again.
 *      That is the chest bug verbatim; see chest.js's header for the two log lines it produced.
 *
 *   2. **`putInput`/`putFuel` are `bot.transfer`, and `takeOutput` is `bot.putAway`**
 *      (mineflayer/lib/plugins/furnace.js:76-112). Both are cursor-based, both end in
 *      `waitForWindowUpdate`, whose await never settles for a click the server agreed with
 *      (the client predicts locally and the server answers only when the prediction is WRONG),
 *      and `transfer` asserts on the cursor - so a desync throws with items STILL HELD, which
 *      the server drops on the floor when the window closes.
 *
 *   3. **`bot.inventory` is frozen while the window is open.** mineflayer only copies the player
 *      slots back in `closeWindow` -> `copyInventory` (inventory.js:412). So every count taken
 *      from `bot.inventory` during a smelt is a pre-transfer number: `smeltItem` counted what it
 *      ASKED the furnace for, which is the same honesty bug as `takeFromChest` reporting
 *      "Successfully took 64 diamond" having taken none.
 *
 * WHAT WE DO INSTEAD - the container_io rules, unchanged
 * -----------------------------------------------------
 * - **Never await the click.** `io.fireClick` writes the packet, lets the local prediction
 *   stand, and settles one tick.
 * - **Every number is read from `window.slots`**, which is live: locally predicted and
 *   server-corrected. `bot.inventory` is never consulted while a window is open.
 * - **Shift-click (mode 1) is the workhorse** for taking things OUT: one click, whole stack,
 *   the cursor never touched, so there is nothing to strand and nothing to drop.
 * - **Putting things IN must use the cursor**, because a furnace input and a furnace fuel slot
 *   are two specific destinations and a shift-click cannot choose between them. So it is done
 *   the way `container_io.movePartial` does it - pick up, place, and put the remainder back -
 *   which ends with an empty cursor BY CONSTRUCTION, and it is verified before the close.
 * - **Bound everything**, and **close in a `finally`**: a window that arrives after we stopped
 *   waiting stays as `bot.currentWindow`, and a stale `currentWindow` makes the NEXT open never
 *   fire. One bad furnace would otherwise break every container operation for the session.
 *
 * The pure arithmetic is at the top and is unit-tested without a server
 * (`tests/furnace_io.test.mjs`), for the same reason `container_io`'s is: the interesting cases
 * - a furnace already busy with someone else's ore, half the fuel needed, an input of 200 into
 * a 64-slot - are states a live run reaches only by accident.
 */

import * as io from './container_io.js';
import { withTimeout, safeClose } from './chest.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Constants. Correctness constants, not tuning knobs - each is the difference between a
// bounded failure and a hung agent process.
// ---------------------------------------------------------------------------

/** Furnace window layout. Fixed by the protocol; `furnace.inputItem()` is literally `slots[0]`. */
export const INPUT_SLOT = 0;
export const FUEL_SLOT = 1;
export const OUTPUT_SLOT = 2;

export const OPEN_TIMEOUT_MS = 4000;    // a live server answers open_window in a tick or two
export const CLICK_SETTLE_MS = 60;      // one server tick plus slack, same as container_io
/** How long to wait for a slot to reflect a click before calling it a no-op. */
export const SLOT_SETTLE_MS = 600;
/** Nothing has come out of the furnace for this long -> stop waiting. Vanilla is 10s a smelt. */
export const IDLE_LIMIT_MS = 15000;
/** Absolute ceiling on one smelt session, however much was asked for. */
export const SESSION_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

/**
 * How much fuel to insert for `smelts` operations.
 *
 * `perUnit` is `mc.getFuelSmeltOutput(name)` - 8 for coal, 1.5 for a plank, and so on. It is
 * NOT assumed to divide evenly, hence the ceil; and it is guarded against 0/NaN, because an
 * unknown fuel would otherwise ask for Infinity units and the shortfall message would read
 * "you need Infinity coal".
 */
export function fuelPlan({ smelts, perUnit, have }) {
    const per = Number.isFinite(perUnit) && perUnit > 0 ? perUnit : 0;
    if (per === 0) return { units: 0, enough: false, shortfall: 0, reason: 'unknown_fuel' };
    const units = Math.max(1, Math.ceil(smelts / per));
    const held = Number.isFinite(have) ? have : 0;
    return {
        units: Math.min(units, held),
        enough: held >= units,
        shortfall: Math.max(0, units - held),
        reason: held >= units ? 'ok' : 'not_enough_fuel',
    };
}

/**
 * Split a total into furnace-input-sized batches.
 *
 * The old code called `putInput(type, null, num)` with whatever the model asked for. A furnace
 * input slot holds ONE STACK, so a request for 200 raw iron could never be satisfied in one
 * insert - and mineflayer's `transfer` answers that by throwing partway through with items on
 * the cursor, which is the item-loss path. Smelting 200 is three inserts, not one failure.
 */
export function batchSizes(total, stackSize = 64) {
    const out = [];
    let left = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
    const size = Number.isFinite(stackSize) && stackSize > 0 ? stackSize : 64;
    while (left > 0) { const take = Math.min(left, size); out.push(take); left -= take; }
    return out;
}

/**
 * May we use this furnace for `itemName` at all, and how much?
 *
 * Names every refusal. A silent refusal is indistinguishable from the branch never running,
 * and this one previously produced "The furnace is currently smelting X" for the busy case and
 * nothing whatsoever for the rest.
 *
 * `occupantName` is compared EXACTLY - never a substring. `cooked_beef` contains `beef` and
 * `raw_iron` contains `iron`; a loose test would have the bot top up a furnace with an item it
 * cannot smelt together with what is already in there.
 *
 * @returns {{ok:boolean, count:number, reason:string}}
 */
export function smeltVerdict({ itemName, want, held, occupantName, occupantCount = 0,
                              hasFuelInSlot = false, fuelAvailable = true }) {
    const asked = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
    if (!itemName) return { ok: false, count: 0, reason: 'no_item' };
    if (asked <= 0) return { ok: false, count: 0, reason: 'nothing_asked' };
    if (occupantName != null && occupantCount > 0 && occupantName !== itemName)
        return { ok: false, count: 0, reason: 'busy_with_other' };
    const have = Number.isFinite(held) ? held : 0;
    if (have <= 0) return { ok: false, count: 0, reason: 'none_held' };
    if (have < asked) return { ok: false, count: 0, reason: 'not_enough_input' };
    if (!hasFuelInSlot && !fuelAvailable) return { ok: false, count: 0, reason: 'no_fuel' };
    return { ok: true, count: asked, reason: 'ok' };
}

/**
 * Fuel, in preference order, chosen from what is actually in the bag.
 *
 * `mc.getSmeltingFuel` cannot be used while a furnace window is open: it reads
 * `bot.inventory.items()`, which mineflayer freezes for the whole time a window is up. It also
 * substring-matches `log`/`planks`, which is the rule this repo has been bitten by three times
 * - and here it is not merely untidy, it is WRONG: `crimson_planks` and `warped_planks` contain
 * "planks" and are not fuel at all (nether wood does not burn), so a bot carrying nothing else
 * would load the furnace, wait out the idle timeout and report a stall it could not explain.
 *
 * Suffix matching, the way `night.isBedName` does it, plus an explicit nether exclusion.
 */
const NETHER_WOOD = new Set([
    'crimson_planks', 'warped_planks', 'crimson_stem', 'warped_stem',
    'crimson_hyphae', 'warped_hyphae', 'stripped_crimson_stem', 'stripped_warped_stem',
    'stripped_crimson_hyphae', 'stripped_warped_hyphae', 'crimson_slab', 'warped_slab',
]);

export function isWoodFuel(name) {
    if (typeof name !== 'string' || NETHER_WOOD.has(name)) return false;
    return name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_planks');
}

/** Concentrated fuels, best first. A blaze rod burns 12, coal and charcoal 8. */
export const PRIMARY_FUELS = Object.freeze(['coal', 'charcoal', 'blaze_rod']);
/** Kept LAST on purpose: burning a coal block or a lava bucket for one steak is a waste. */
export const BULK_FUELS = Object.freeze(['coal_block', 'lava_bucket']);

/**
 * Pick a fuel from `entries` (`[{name, count}]`), or null.
 *
 * Pure so the ordering is testable: the case that matters is a bag holding BOTH coal and
 * planks, where a live run only ever exercises whichever the bot happens to be carrying.
 */
export function pickFuelName(entries) {
    const have = (entries ?? []).filter(e => e && typeof e.name === 'string' && (e.count ?? 0) > 0);
    for (const want of PRIMARY_FUELS) {
        const hit = have.find(e => e.name === want);
        if (hit) return hit;
    }
    const wood = have.find(e => isWoodFuel(e.name));
    if (wood) return wood;
    for (const want of BULK_FUELS) {
        const hit = have.find(e => e.name === want);
        if (hit) return hit;
    }
    return null;
}

/**
 * What the collection loop should do this iteration.
 *
 * Bounded on THREE separate clocks, because each one bounds a different failure: `idleMs` is a
 * furnace that has stopped producing (out of fuel, or the input was never accepted), the
 * session deadline is a furnace that produces forever (someone else feeding it), and the
 * interrupt is a person or a safety mode wanting the bot back.
 *
 * `collected >= want` is checked first so a smelt that finishes on the same tick the deadline
 * expires reports `done` - the items are in the bag either way, and reporting a timeout there
 * would send the bot back to a furnace it has already emptied.
 *
 * @returns {'done'|'interrupted'|'stalled'|'timeout'|'waiting'}
 */
export function collectVerdict({ collected, want, idleMs, idleLimitMs = IDLE_LIMIT_MS,
                                 elapsedMs = 0, sessionMs = SESSION_MS, interrupted = false }) {
    const got = Number.isFinite(collected) ? collected : 0;
    const target = Number.isFinite(want) ? want : 0;
    if (target > 0 && got >= target) return 'done';
    if (interrupted) return 'interrupted';
    if (Number.isFinite(idleMs) && idleMs >= idleLimitMs) return 'stalled';
    if (elapsedMs >= sessionMs) return 'timeout';
    return 'waiting';
}

/** One line a person can act on, per refusal. */
export function explainSmelt(reason, { itemName = 'it', want = 0, occupantName = null, shortfall = 0 } = {}) {
    switch (reason) {
        case 'no_item':          return 'No item named to smelt.';
        case 'nothing_asked':    return `Asked to smelt 0 ${itemName}.`;
        case 'busy_with_other':  return `The furnace is already smelting ${occupantName} - clear it first (!clearFurnace).`;
        case 'none_held':        return `I have no ${itemName} to smelt.`;
        case 'not_enough_input': return `I do not have ${want} ${itemName} to smelt.`;
        case 'no_fuel':          return `I have no fuel to smelt ${itemName} - I need coal, charcoal, or wood.`;
        case 'not_enough_fuel':  return `I need ${shortfall} more fuel to smelt ${want} ${itemName}.`;
        case 'unknown_fuel':     return `I do not know how long that fuel burns, so I will not use it.`;
        case 'unreachable':      return `I could not get to the furnace.`;
        case 'no_response':      return `The furnace would not open.`;
        case 'stalled':          return `The furnace stopped producing.`;
        case 'timeout':          return `The furnace took too long.`;
        case 'interrupted':      return `Smelting interrupted.`;
        default:                 return `Smelting failed: ${reason}.`;
    }
}

// ---------------------------------------------------------------------------
// Reading an open furnace window - the only source of truth while it is open
// ---------------------------------------------------------------------------

export const slotItem = (win, slot) => win?.slots?.[slot] ?? null;
export const slotName = (win, slot) => slotItem(win, slot)?.name ?? null;
export const slotCount = (win, slot) => slotItem(win, slot)?.count ?? 0;

/** How many of `name` the bot is carrying, read through the OPEN WINDOW. Never bot.inventory. */
export function bagCount(win, name) {
    return io.countIn(win, io.bagRange(win), name);
}

/** Bag slots holding `name`, most-full first so a whole-stack insert is the common case. */
export function bagSlotsOf(win, name) {
    return io.slotsIn(win, io.bagRange(win))
        .filter(e => e.item && e.item.name === name)
        .sort((a, b) => b.item.count - a.item.count);
}

/**
 * The best fuel the bot is carrying, read through the OPEN WINDOW. Aggregated BY NAME, not by
 * slot: 200 coal is four slots, and choosing one slot's 64 would ask for less fuel than the bag
 * actually holds - the same by-name aggregation `depositableItems` had to learn.
 */
export function pickFuel(win) {
    const byName = new Map();
    for (const { item } of io.slotsIn(win, io.bagRange(win))) {
        if (!item) continue;
        byName.set(item.name, (byName.get(item.name) ?? 0) + item.count);
    }
    return pickFuelName([...byName].map(([name, count]) => ({ name, count })));
}

/**
 * Wait for a slot to actually change, rather than trusting the local prediction.
 *
 * The prediction is applied synchronously inside `clickWindow`, but the server corrects it when
 * it disagrees - and a furnace refuses inputs a chest would accept (a non-smeltable in slot 0,
 * a non-fuel in slot 1). Reading once at `SETTLE_MS` therefore reports a success the server is
 * about to undo. Two reads, up to `ms` apart, is the same "trust measured state" rule the chest
 * counts and the shelter descent already use.
 */
async function awaitSlotSettle(win, slot, before, ms = SLOT_SETTLE_MS) {
    const deadline = Date.now() + ms;
    let last = slotCount(win, slot);
    while (Date.now() < deadline) {
        await sleep(60);
        const now = slotCount(win, slot);
        if (now !== before && now === last) return now;
        last = now;
    }
    return slotCount(win, slot);
}

// ---------------------------------------------------------------------------
// Clicking
// ---------------------------------------------------------------------------

/**
 * Put `count` of `name` into furnace slot `dest` (0 = input, 1 = fuel).
 *
 * Cursor-based on purpose - a shift-click cannot choose between the input and the fuel slot -
 * and therefore written to `container_io.movePartial`'s rule: pick the stack up, place what is
 * wanted, and put the remainder back, so the cursor is empty by construction. `clearCursor`
 * runs on every exit path including the throw, because **closing a window while holding
 * something makes the server DROP it**, and that is how a failed transfer scatters items on
 * the floor.
 *
 * @returns {Promise<{moved:number, reason:string}>} `moved` is the difference between two reads
 *   of the DESTINATION SLOT: measured, never requested.
 */
export async function putIntoSlot(bot, win, { name, count, dest }) {
    const occupant = slotItem(win, dest);
    if (occupant && occupant.name !== name)
        return { moved: 0, reason: 'slot_occupied' };

    const stackSize = occupant?.stackSize
        ?? bagSlotsOf(win, name)[0]?.item?.stackSize ?? 64;
    const room = Math.max(0, stackSize - (occupant?.count ?? 0));
    if (room <= 0) return { moved: 0, reason: 'slot_full' };

    const before = slotCount(win, dest);
    let want = Math.min(count, room);
    let moved = 0;

    try {
        for (const entry of bagSlotsOf(win, name)) {
            if (want <= 0) break;
            if (bot.interrupt_code) return { moved: slotCount(win, dest) - before, reason: 'interrupted' };

            // Re-read: an earlier click may have consumed or moved this slot, and acting on a
            // stale view picks up the wrong stack.
            const here = win.slots[entry.slot];
            if (!here || here.name !== name) continue;

            await io.fireClick(bot, entry.slot, io.BTN_LEFT, io.MODE_CLICK, CLICK_SETTLE_MS);
            const held = win.selectedItem;
            if (!held) continue;                      // the pick-up did not take; try the next slot

            if (held.count <= want) {
                // The whole held stack fits: one left-click places all of it.
                await io.fireClick(bot, dest, io.BTN_LEFT, io.MODE_CLICK, CLICK_SETTLE_MS);
            } else {
                // A right click with a full cursor places exactly ONE item, which is the only
                // way to express an arbitrary amount. 0ms settle: these are local predictions on
                // the same window and pacing each one costs `want` ticks for no benefit.
                for (let i = 0; i < want; i++) {
                    if (bot.interrupt_code || !win.selectedItem) break;
                    await io.fireClick(bot, dest, io.BTN_RIGHT, io.MODE_CLICK, 0);
                }
                await sleep(CLICK_SETTLE_MS);
            }

            // Put whatever is left back where it came from, before anything else can go wrong.
            await io.clearCursor(bot, win, entry.slot);
            const now = await awaitSlotSettle(win, dest, before + moved);
            const gained = now - (before + moved);
            if (gained <= 0) break;                   // the server refused it; do not spin
            moved += gained;
            want -= gained;
        }
    } finally {
        const cursor = await io.clearCursor(bot, win);
        if (cursor.where === 'dropped on the ground')
            console.log(`[furnace] had to drop a held ${name} on the ground`);
    }

    const total = slotCount(win, dest) - before;
    if (total <= 0) return { moved: 0, reason: 'refused' };
    return { moved: total, reason: total >= count ? 'ok' : 'partial' };
}

/**
 * Empty one furnace slot into the bag with a single shift-click.
 *
 * Shift-click never touches the cursor, so there is nothing to strand and nothing to drop, and
 * the server chooses the destination slots - which is exactly what we want.
 *
 * @returns {Promise<{moved:number, name:string|null, reason:string}>} measured from the BAG.
 */
export async function takeSlot(bot, win, slot) {
    const item = slotItem(win, slot);
    if (!item) return { moved: 0, name: null, reason: 'empty' };
    const name = item.name;
    const before = bagCount(win, name);

    await io.fireClick(bot, slot, io.BTN_LEFT, io.MODE_SHIFT, CLICK_SETTLE_MS);
    // The bag is the measurement, not the furnace slot: a shift-click into a FULL inventory
    // leaves the item where it is, and reading the furnace slot alone cannot tell that apart
    // from a successful move.
    const deadline = Date.now() + SLOT_SETTLE_MS;
    let moved = bagCount(win, name) - before;
    while (moved <= 0 && Date.now() < deadline) {
        await sleep(60);
        moved = bagCount(win, name) - before;
    }
    if (moved <= 0)
        return { moved: 0, name, reason: io.emptyIn(win, io.bagRange(win)) === 0 ? 'inventory_full' : 'no_movement' };
    return { moved, name, reason: 'ok' };
}

/** Empty output, then input, then fuel. Output first: it is the part a caller came for. */
export async function drainFurnace(bot, win) {
    const took = [];
    for (const slot of [OUTPUT_SLOT, INPUT_SLOT, FUEL_SLOT]) {
        if (bot.interrupt_code) break;
        const r = await takeSlot(bot, win, slot);
        if (r.moved > 0) took.push({ name: r.name, count: r.moved });
    }
    return took;
}

// ---------------------------------------------------------------------------
// Opening - bounded, and closed in a finally
// ---------------------------------------------------------------------------

/** Furnace-family blocks that open a furnace window. Exact names - never a substring test. */
export const FURNACE_NAMES = new Set(['furnace', 'blast_furnace', 'smoker']);

/** A leaked window from any other code path is closed before we try to open ours. */
async function clearLeakedWindow(bot) {
    if (bot.currentWindow) {
        console.log(`[furnace] closing a leaked window (${bot.currentWindow.type ?? '?'}) before opening`);
        await safeClose(bot);
    }
}

/**
 * Open a furnace, or fail in bounded time with a reason. Never hangs, never throws.
 *
 * `bot.openFurnace` is still the opener - it is what attaches the `slots[0..2]` accessors and
 * the burn/progress tracking - but it is RACED against a deadline, and the half-open window is
 * force-closed on a loss. Only the helpers it hangs off the window (`putInput`, `takeOutput`,
 * ...) are unusable; the open itself is fine once it is bounded.
 */
export async function openFurnaceSafe(bot, block, opts = {}) {
    const attempts = opts.attempts ?? 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (bot.interrupt_code) return { ok: false, reason: 'interrupted', detail: 'interrupted' };
        const fresh = bot.blockAt(block.position) ?? block;
        if (!FURNACE_NAMES.has(fresh.name))
            return { ok: false, reason: 'gone', detail: `there is a ${fresh.name} there now, not a furnace` };

        await clearLeakedWindow(bot);
        try { await bot.lookAt(fresh.position.offset(0.5, 0.5, 0.5), true); } catch { /* best effort */ }

        try {
            const window = await withTimeout(bot.openFurnace(fresh), OPEN_TIMEOUT_MS, 'openFurnace');
            return { ok: true, window, block: fresh };
        } catch (e) {
            await safeClose(bot);   // the open may still land after we stopped waiting
            if (attempt === attempts) {
                return {
                    ok: false,
                    reason: e.name === 'Timeout' ? 'no_response' : 'error',
                    detail: e.name === 'Timeout'
                        ? `the server never opened the ${fresh.name} (waited ${OPEN_TIMEOUT_MS}ms)`
                        : e.message,
                };
            }
            console.log(`[furnace] open attempt ${attempt} failed (${e.message}), retrying`);
        }
    }
    return { ok: false, reason: 'error', detail: 'could not open' };
}

/**
 * THE way to touch a furnace. Opens it, runs `fn(ctx)`, and closes the window in a `finally` no
 * matter what `fn` does - including throwing, which is the path that used to leave a window
 * open and poison every later container operation in the session.
 */
export async function withFurnace(bot, block, fn, opts = {}) {
    const opened = await openFurnaceSafe(bot, block, opts);
    if (!opened.ok) return opened;
    const win = opened.window;
    const ctx = {
        win,
        block: opened.block,
        input: () => slotItem(win, INPUT_SLOT),
        fuel: () => slotItem(win, FUEL_SLOT),
        output: () => slotItem(win, OUTPUT_SLOT),
        bagCount: (name) => bagCount(win, name),
        put: (name, count, dest) => putIntoSlot(bot, win, { name, count, dest }),
        take: (slot) => takeSlot(bot, win, slot),
        drain: () => drainFurnace(bot, win),
    };
    try {
        const value = await fn(ctx);
        return { ok: true, value };
    } catch (e) {
        return { ok: false, reason: 'error', detail: e.message };
    } finally {
        await safeClose(bot, win);
    }
}

/**
 * Sit at an open furnace collecting output until `want` have been taken, or one of the three
 * clocks in `collectVerdict` runs out.
 *
 * Counted from the BAG, through the window - the output slot itself is not a count of what we
 * have, only of what is waiting. `bot.inventory` is frozen here and would report the same
 * number all session.
 *
 * @returns {Promise<{collected:number, outputName:string|null, reason:string}>}
 */
export async function collectOutput(bot, win, { want, idleLimitMs = IDLE_LIMIT_MS,
                                                sessionMs = SESSION_MS, pollMs = 1000 } = {}) {
    const t0 = Date.now();
    let lastProgress = Date.now();
    let collected = 0;
    let outputName = null;

    while (true) {
        const verdict = collectVerdict({
            collected, want,
            idleMs: Date.now() - lastProgress, idleLimitMs,
            elapsedMs: Date.now() - t0, sessionMs,
            interrupted: !!bot.interrupt_code,
        });
        if (verdict !== 'waiting') return { collected, outputName, reason: verdict };

        if (slotItem(win, OUTPUT_SLOT)) {
            const r = await takeSlot(bot, win, OUTPUT_SLOT);
            if (r.moved > 0) {
                collected += r.moved;
                outputName = r.name;
                lastProgress = Date.now();
                continue;   // re-check immediately; a full stack may be waiting
            }
            if (r.reason === 'inventory_full')
                return { collected, outputName, reason: 'inventory_full' };
        }
        await sleep(pollMs);
    }
}
