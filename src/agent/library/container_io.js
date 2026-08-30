/**
 * Our own container click protocol. Does NOT use mineflayer's `deposit`/`withdraw`/`transfer`.
 *
 * WHY WE OWN THIS
 * ---------------
 * mineflayer's container IO is unusable against this server, in three independent ways. Each was
 * measured; none is a tuning problem.
 *
 * 1. **Every chest click waits forever.** `clickWindow` ends in `waitForWindowUpdate`, whose
 *    chest branch is a bare `await once(window, 'updateSlot:' + slot)` with no deadline
 *    (mineflayer/lib/plugins/inventory.js:477-480). On 1.17+ the client PREDICTS the click
 *    locally (`window.acceptClick`, same file, line ~591) and the server answers only when the
 *    prediction is WRONG. So a click that works produces no packet and the await never settles.
 *    Observed as `withdraw timed out after 6000ms` on perfectly ordinary withdrawals - our
 *    deadline firing, not the server being slow.
 *
 * 2. **`transfer` is cursor-based and asserts.** It picks a stack up onto the cursor and places
 *    it (`transferOne` -> `clickDest`), recursing, with `assert.notStrictEqual(...)` on the
 *    cursor. When the cursor desyncs it throws `null is not an object (evaluating
 *    'window.selectedItem.type')` and returns with **items still on the cursor** - which the
 *    server drops on the floor the moment the window closes. That is the item-loss path: a
 *    source chest emptied, nothing in the destination, a cobblestone entity on the ground.
 *
 * 3. **`bot.inventory` is frozen while a window is open.** mineflayer only copies the player
 *    slots back in `closeWindow` -> `copyInventory` (line 412). So `bot.inventory.items()`,
 *    `emptySlotCount()`, and anything derived from them - including mineflayer's OWN
 *    "Unable to withdraw, Bot inventory is full" guard - read pre-transfer values for the whole
 *    session.
 *
 * WHAT WE DO INSTEAD
 * ------------------
 * - **Shift-click (mode 1) is the workhorse.** It moves a whole stack across the container/bag
 *   divide in one click and never touches the cursor, so there is nothing to strand and nothing
 *   to drop. The server decides the destination slots, which is exactly what we want.
 * - **We never await the click.** The packet is written and the local prediction applied
 *   synchronously inside `clickWindow`, before the never-resolving await; so we fire it,
 *   swallow the pending promise, and settle for one server tick.
 * - **Every number is read from `window.slots`**, which is live: locally predicted and corrected
 *   by the server. `bot.inventory` is never consulted while a window is open.
 * - **A partial count uses right-clicks**, one item at a time, and always ends by putting the
 *   remainder back - so the cursor is empty when we are done, verified.
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** One server tick plus slack. Long enough for a correction packet to arrive if the prediction
 *  was wrong; short enough that a 27-slot sweep is still under three seconds. */
export const SETTLE_MS = 60;

/** A whole operation, not one click. Bounds a chest that has stopped responding entirely. */
export const OP_TIMEOUT_MS = 8000;

export const MODE_CLICK = 0;
export const MODE_SHIFT = 1;
export const BTN_LEFT = 0;
export const BTN_RIGHT = 1;

// ---------------------------------------------------------------------------
// Reading the window - the only source of truth while a container is open
// ---------------------------------------------------------------------------

/** Slot indices of the container half of the window. */
export const containerRange = (win) => ({ start: 0, end: win.inventoryStart });
/** Slot indices of the player's own inventory, as this window sees it. */
export const bagRange = (win) => ({ start: win.inventoryStart, end: win.inventoryEnd });

export function slotsIn(win, { start, end }) {
    const out = [];
    for (let i = start; i < end; i++) out.push({ slot: i, item: win.slots[i] ?? null });
    return out;
}

export function countIn(win, range, name) {
    let n = 0;
    for (const { item } of slotsIn(win, range)) if (item && item.name === name) n += item.count;
    return n;
}

export function emptyIn(win, range) {
    let n = 0;
    for (const { item } of slotsIn(win, range)) if (!item) n++;
    return n;
}

/**
 * How many more of `name` this range can accept: empty slots plus room in partial stacks.
 *
 * Pure, so the arithmetic is testable without a server - the live half is only the slot read.
 */
export function roomFor(entries, name, stackSize = 64) {
    let empties = 0, partial = 0;
    for (const { item } of entries) {
        if (!item) { empties++; continue; }
        if (item.name !== name) continue;
        const size = item.stackSize ?? stackSize;
        if (item.count < size) partial += size - item.count;
    }
    return empties * stackSize + partial;
}

/**
 * The plan for moving `want` of `name` out of `from` into a range with `room` free units.
 *
 * Returns the per-source-slot steps, each tagged `whole` (one shift-click) or `partial` (pick
 * up, drop N, put the rest back). Pure: this is where the arithmetic lives, so the live code is
 * only clicks and reads.
 */
export function planMove({ sourceEntries, name, want, room, stackSize = 64 }) {
    const matches = sourceEntries.filter(e => e.item && e.item.name === name);
    const available = matches.reduce((s, e) => s + e.item.count, 0);
    const asked = (want === -1 || want == null) ? available : Math.min(want, available);
    const total = Math.min(asked, room);

    const steps = [];
    let left = total;
    for (const e of matches) {
        if (left <= 0) break;
        const take = Math.min(left, e.item.count);
        // A shift-click moves the whole stack, and moves only what fits - so it is correct
        // whenever we want the entire stack, even if the destination can take only part of it.
        steps.push({ slot: e.slot, count: take, whole: take === e.item.count });
        left -= take;
    }
    return { steps, total, available, asked, shortfall: asked - total, noRoom: room <= 0 && asked > 0 };
}

// ---------------------------------------------------------------------------
// Clicking
// ---------------------------------------------------------------------------

/**
 * Fire one click and let the local prediction stand.
 *
 * We deliberately do NOT await `bot.clickWindow`. By the time it reaches its unresolvable
 * `await once(window, 'updateSlot:N')`, it has already applied `window.acceptClick` and written
 * the `window_click` packet - everything the click actually consists of. Awaiting it only buys a
 * hang. The pending promise is swallowed so it cannot surface as an unhandled rejection.
 */
export async function fireClick(bot, slot, button, mode, settleMs = SETTLE_MS) {
    let thrown = null;
    Promise.resolve(bot.clickWindow(slot, button, mode)).catch(e => { thrown = e; });
    await sleep(settleMs);
    return thrown;
}

/**
 * Leave nothing on the cursor. **Closing a window with a held item makes the server DROP it**,
 * which is how a failed transfer put items on the floor rather than back in the chest.
 *
 * Tries the slot it came from, then any empty slot in either half, then - as a last resort -
 * throws it on the ground deliberately, because a visible dropped item is recoverable and a
 * silently vanished one is not.
 */
export async function clearCursor(bot, win, preferSlot = null) {
    if (!win.selectedItem) return { cleared: true, where: 'nothing held' };
    const candidates = [];
    if (preferSlot != null) candidates.push(preferSlot);
    for (const r of [bagRange(win), containerRange(win)])
        for (const { slot, item } of slotsIn(win, r)) if (!item) candidates.push(slot);

    for (const slot of candidates) {
        await fireClick(bot, slot, BTN_LEFT, MODE_CLICK);
        if (!win.selectedItem) return { cleared: true, where: `slot ${slot}` };
    }
    await fireClick(bot, -999, BTN_LEFT, MODE_CLICK);   // -999 is "throw it"
    return { cleared: !win.selectedItem, where: 'dropped on the ground' };
}

/**
 * Move `want` of `name` between the two halves of an open window.
 *
 * @param direction 'out' pulls container -> bag, 'in' pushes bag -> container.
 * @returns {{moved:number, asked:number, available:number, reason:string}}
 *
 * `moved` is the difference between two reads of the DESTINATION range, so it is measured, never
 * requested - and it is measured from the window, the only view that updates while a container
 * is open.
 */
export async function moveItems(bot, win, { name, want = -1, direction, stackSize = 64 }) {
    const src = direction === 'out' ? containerRange(win) : bagRange(win);
    const dst = direction === 'out' ? bagRange(win) : containerRange(win);

    const sample = slotsIn(win, src).find(e => e.item && e.item.name === name);
    if (!sample) return { moved: 0, asked: 0, available: 0, reason: 'not_present' };
    const size = sample.item.stackSize ?? stackSize;

    const room = roomFor(slotsIn(win, dst), name, size);
    const plan = planMove({ sourceEntries: slotsIn(win, src), name, want, room, stackSize: size });
    if (plan.noRoom) return { moved: 0, asked: plan.asked, available: plan.available, reason: direction === 'out' ? 'inventory_full' : 'full' };

    const before = countIn(win, dst, name);
    const deadline = Date.now() + OP_TIMEOUT_MS;
    let stalls = 0;
    let reason = 'ok';

    for (const step of plan.steps) {
        if (bot.interrupt_code) { reason = 'interrupted'; break; }
        if (Date.now() > deadline) { reason = 'timeout'; break; }
        // Re-read: the slot may have been consumed by an earlier shift-click landing differently
        // than predicted, and acting on the plan's stale view moves the wrong thing.
        const here = win.slots[step.slot];
        if (!here || here.name !== name) continue;

        const seen = countIn(win, dst, name);
        if (step.whole || step.count >= here.count) {
            await fireClick(bot, step.slot, BTN_LEFT, MODE_SHIFT);
        } else {
            await movePartial(bot, win, step.slot, step.count, dst);
        }
        if (countIn(win, dst, name) === seen) {
            // Two clicks in a row that changed nothing means the server is not accepting them;
            // one is ordinary (a stack that went somewhere unpredicted).
            if (++stalls >= 2) { reason = 'no_movement'; break; }
        } else stalls = 0;
    }

    // Never close holding something. Do it here, not in the caller, so every exit path is covered.
    const cursor = await clearCursor(bot, win);
    if (!cursor.cleared) reason = 'cursor_stuck';

    const moved = countIn(win, dst, name) - before;
    if (moved === 0 && reason === 'ok')
        reason = emptyIn(win, dst) === 0 ? (direction === 'out' ? 'inventory_full' : 'full') : 'no_movement';
    return { moved, asked: plan.asked, available: plan.available, reason, shortfall: plan.shortfall,
             droppedCursor: cursor.where === 'dropped on the ground' };
}

/**
 * Move exactly `count` items out of one slot, when that is less than the whole stack.
 *
 * Pick the stack up, right-click `count` times into the destination (one item per click), then
 * left-click the source to put the remainder back. Ends with an empty cursor by construction,
 * which is the property that matters - a shift-click cannot express a partial amount, and every
 * cursor-based scheme that does not end this way is the mineflayer bug again.
 */
async function movePartial(bot, win, slot, count, dst) {
    await fireClick(bot, slot, BTN_LEFT, MODE_CLICK);
    if (!win.selectedItem) return;

    for (let i = 0; i < count; i++) {
        if (bot.interrupt_code || !win.selectedItem) break;
        const target = pickPartialTarget(win, dst, win.selectedItem);
        if (target == null) break;
        // A right click with a full cursor places ONE item, which is the only way to express an
        // arbitrary amount. 0ms settle: these are local predictions on the same window and
        // pacing each one costs `count` ticks for no benefit.
        await fireClick(bot, target, BTN_RIGHT, MODE_CLICK, 0);
    }
    await sleep(SETTLE_MS);
    await clearCursor(bot, win, slot);
}

/** A destination slot a single right-click can add to: same item and not full, or empty. */
export function pickPartialTarget(win, dst, held) {
    let empty = null;
    for (const { slot, item } of slotsIn(win, dst)) {
        if (!item) { if (empty == null) empty = slot; continue; }
        if (item.name === held.name && item.count < (item.stackSize ?? 64)) return slot;
    }
    return empty;
}
