import { Vec3 } from 'vec3';
import * as io from './container_io.js';
import * as nav from './nav.js';

/**
 * Container interaction that cannot hang and cannot lie.
 *
 * The old chest code lived inline in skills.js and failed in three ways that all looked the
 * same from chat - "the bot froze" - and one of them killed the process:
 *
 *   1. `bot.openContainer` is `activateBlock()` + `await once(bot, 'windowOpen')` with NO
 *      TIMEOUT (mineflayer/lib/plugins/inventory.js:385). If the server never sends
 *      `open_window` the promise NEVER settles. Logged live:
 *        "ChestView at (4727,68,4764) caused code execution timeout and process kill"
 *        "Chest viewing at (4557,68,4862) times out after 20s - pathfinding fails to reach it."
 *      Everything below that opens a window does so through `openContainerSafe`, which races
 *      the open against a deadline and force-closes the half-open window on loss.
 *
 *   2. The server sends no window for reasons the old code never checked, each of which
 *      produced that same permanent hang:
 *        - the bot was never actually within reach (see 3);
 *        - the block above a chest is a solid cube, so vanilla refuses to open it;
 *        - a cat is sitting on it (same vanilla rule);
 *        - the "container" is a `decorated_pot` or `chiseled_bookshelf`, which have NO GUI at
 *          all and were in the old STORAGE_CONTAINERS list, so `!chestDepositAll` could pick
 *          one as the nearest container and wedge forever.
 *      `openObstruction()` is the pure predicate for those; it FAILS OPEN, so an unknown block
 *      or a missing entity list degrades to "try it and let the timeout catch it".
 *
 *   3. The approach was never verified. Every old chest function called
 *      `goToPosition(...)` - which drives mineflayer-pathfinder, whose EXECUTOR does not work
 *      on this server (see CLAUDE.md: `onGround` reads false while standing) - and then called
 *      `openContainer` unconditionally, discarding the return value. A failed walk therefore
 *      became an infinite hang rather than "I could not get to the chest". Approach now runs
 *      through nav.js (the executor that does work here) and the distance is MEASURED before
 *      a window is requested. Same rule as everything else in this codebase: trust measured
 *      state over reported state.
 *
 * And one honesty bug: `takeFromChest` counted what it ASKED for, not what moved -
 * `totalTaken += toTakeFromSlot` right after `withdraw`, with no check - so a bot with a full
 * inventory reported "Successfully took 64 diamond" having taken none. Every transfer here is
 * measured by counting the inventory before and after.
 *
 * Nothing in here can leave a window open: `withContainer` closes in a `finally`, and a leaked
 * window from anywhere else is closed pre-flight - a stale `bot.currentWindow` is itself a
 * cause of the next open never firing.
 */

const log = (bot, message) => {
    bot.output += message + '\n';
    console.log(`[${bot.username ?? '?'}] ${message}`);
};

// ---------------------------------------------------------------------------
// Timeouts. These are correctness constants, not tuning knobs: each one is the
// difference between a bounded failure and a hung agent process.
// ---------------------------------------------------------------------------
export const OPEN_TIMEOUT_MS = 4000;   // a live server answers open_window in a tick or two
export const CLICK_TIMEOUT_MS = 6000;  // one deposit()/withdraw() call, which is several clicks
export const CLOSE_TIMEOUT_MS = 1500;
export const MAX_REACH = 3.5;          // conservative; vanilla allows ~4.5 to the block face
export const APPROACH_DIST = 1.8;

// ---------------------------------------------------------------------------
// What is actually a container
// ---------------------------------------------------------------------------

/** Containers that open a real inventory window, with their nominal slot count. */
const WINDOW_CONTAINERS = new Map([
    ['chest', 27], ['trapped_chest', 27], ['ender_chest', 27], ['barrel', 27],
    ['shulker_box', 27],
    ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
        'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
        .map(c => [`${c}_shulker_box`, 27]),
    ['hopper', 5], ['dispenser', 9], ['dropper', 9], ['crafter', 9],
]);

/**
 * Blocks that hold items but open NO window. Interacting with them does something else
 * entirely (a decorated pot swallows one item; a bookshelf takes a book), so `openContainer`
 * waits for a `windowOpen` that is never coming. They were in the old list.
 */
const NO_WINDOW_STORAGE = new Set(['decorated_pot', 'chiseled_bookshelf']);

/** Names accepted anywhere a container is searched for. */
export const CONTAINER_NAMES = [...WINDOW_CONTAINERS.keys()];

export function isOpenableContainer(name) {
    return WINDOW_CONTAINERS.has(name);
}

export function nominalSlots(name) {
    return WINDOW_CONTAINERS.get(name) ?? 0;
}

/** Only chests obey the "nothing solid above, no cat on top" rule. Barrels and shulkers do not. */
export function needsHeadroom(name) {
    return name === 'chest' || name === 'trapped_chest' || name === 'ender_chest';
}

/**
 * Why the server will refuse to open this container - the pure predicate.
 *
 * Returns a human-readable reason, or null to proceed. FAILS OPEN on purpose: `undefined`
 * inputs (an unloaded chunk, a block type we have no data for) return null so the caller
 * still tries and the timeout bounds the damage. A check that guessed "blocked" from missing
 * data would disable the whole command in exactly the situations we cannot diagnose.
 */
export function openObstruction({ containerName, aboveName, aboveIsOpaque, catOnTop }) {
    if (NO_WINDOW_STORAGE.has(containerName))
        return `a ${containerName} has no inventory screen - it cannot be opened like a chest`;
    if (containerName != null && !isOpenableContainer(containerName))
        return `${containerName} is not a storage container`;
    if (!needsHeadroom(containerName)) return null;
    if (catOnTop) return `a cat is sitting on it`;
    if (aboveIsOpaque === true) return `${aboveName ?? 'a solid block'} is sitting directly on top of it`;
    return null;
}

/**
 * Can this container take `want` of `itemName`, and how many?
 *
 * The pre-check exists because mineflayer's `deposit()` on a full chest throws only after
 * waiting out a slot update that never arrives. Cheaper and far more informative to look.
 */
export function capacityFor({ contents = [], totalSlots, itemName, stackSize = 64 }) {
    const emptySlots = Math.max(0, totalSlots - contents.length);
    let partialRoom = 0;
    for (const it of contents) {
        if (it.name !== itemName) continue;
        const size = it.stackSize ?? stackSize;
        if (it.count < size) partialRoom += size - it.count;
    }
    const freeUnits = emptySlots * stackSize + partialRoom;
    return { emptySlots, partialRoom, freeUnits, canAccept: freeUnits > 0 };
}

/**
 * Which container slots to pull from, bounded by what the inventory can actually hold.
 *
 * The old code took `min(want, available)` and ignored inventory space entirely, so a full bag
 * produced a withdraw that silently moved nothing and a message that said it had worked.
 */
export function planWithdraw({ contents = [], itemName, want, freeInvSlots = 36, invPartialRoom = 0, stackSize = 64 }) {
    const matching = contents.filter(i => i.name === itemName);
    const available = matching.reduce((s, i) => s + i.count, 0);
    const asked = want === -1 || want == null ? available : Math.min(want, available);
    const invRoom = freeInvSlots * stackSize + invPartialRoom;
    const total = Math.min(asked, invRoom);

    const picks = [];
    let left = total;
    for (const it of matching) {
        if (left <= 0) break;
        const take = Math.min(left, it.count);
        picks.push({ slot: it.slot, type: it.type, name: it.name, count: take });
        left -= take;
    }
    return { picks, total, available, asked, shortfall: asked - total, invFull: invRoom <= 0 && asked > 0 };
}

// ---------------------------------------------------------------------------
// Bounded primitives
// ---------------------------------------------------------------------------

class Timeout extends Error {
    constructor(label, ms) { super(`${label} timed out after ${ms}ms`); this.name = 'Timeout'; this.label = label; }
}

/**
 * Race a promise against a deadline. The loser is abandoned, not cancelled - mineflayer has no
 * cancellation - so every caller of this must assume the underlying operation may still be in
 * flight and re-establish state (which, here, means closing the window and re-counting).
 */
export function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Timeout(label, ms)), ms); }),
    ]);
}

/**
 * The bot's own items, read through the OPEN WINDOW - never through `bot.inventory`.
 *
 * `bot.inventory` is a separate Window object (id 0) and mineflayer only refreshes it from the
 * container window in `closeWindow` -> `copyInventory`
 * (mineflayer/lib/plugins/inventory.js:412-417). **While a chest is open it therefore cannot
 * change.** Every count in this file used to read it, which meant every deposit and every
 * withdraw measured a number that was frozen before the operation started: `moved` came out 0
 * however much actually moved.
 *
 * That is not a cosmetic reporting bug. `transferBetweenChests` builds its carry list from
 * `moved`, so a perfectly good withdraw produced an empty list, the transfer aborted with
 * "my inventory is full" - and the items it had genuinely pulled were left in the bag while
 * the source chest really was emptied. Measured: 4 of 5 stacks out of the chest, 0 into the
 * destination, and a message blaming a full inventory that had 30 free slots.
 *
 * The window's own view IS live: `slots[inventoryStart..inventoryEnd]` is the player's
 * inventory as the server currently sees it, and `items()` / `emptySlotCount()` read exactly
 * that range. Falls back to `bot.inventory` only when no window is open, which is the one
 * moment `bot.inventory` is trustworthy.
 */
const bagItems = (bot, win) => (win ? win.items() : bot.inventory.items());
const bagEmptySlots = (bot, win) => (win ? win.emptySlotCount() : bot.inventory.emptySlotCount());
const countItem = (bot, name, win = null) =>
    bagItems(bot, win).filter(i => i.name === name).reduce((s, i) => s + i.count, 0);

/**
 * Wait for the bag to stop changing, then report the count.
 *
 * `withTimeout` abandons its loser rather than cancelling it - mineflayer has no cancellation -
 * so on the timeout path the clicks are still in flight and the acks are still arriving. Reading
 * the count the instant the deadline fires measures the middle of the operation and reports
 * "nothing moved" for a transfer that is most of the way done. Two consecutive equal readings
 * separated by a tick is enough; the cap keeps a genuinely dead server bounded.
 */
async function settledCount(bot, name, win, ms = 1000) {
    const deadline = Date.now() + ms;
    let last = countItem(bot, name, win);
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const now = countItem(bot, name, win);
        if (now === last) return now;
        last = now;
    }
    return last;
}

/** Close whatever is open, tolerating every way that can fail. Never throws. */
export async function safeClose(bot, window = null) {
    const win = window ?? bot.currentWindow;
    if (!win) return;
    // NEVER CLOSE HOLDING SOMETHING. The server drops whatever is on the cursor when a window
    // closes, so a transfer that died mid-click used to scatter its items on the floor - the
    // source chest emptied, the destination untouched, and an item entity on the ground.
    try { if (win.selectedItem) await io.clearCursor(bot, win); } catch { /* best effort */ }
    try {
        await withTimeout(Promise.resolve(win.close ? win.close() : bot.closeWindow(win)), CLOSE_TIMEOUT_MS, 'close');
    } catch {
        try { bot.closeWindow(win); } catch { /* already gone */ }
    }
    // A stale currentWindow makes the NEXT open never fire, which is how one bad chest
    // poisoned every later deposit in the same session.
    if (bot.currentWindow === win) bot.currentWindow = null;
}

/** A leaked window from any other code path is closed before we try to open ours. */
async function clearLeakedWindow(bot) {
    if (bot.currentWindow) {
        console.log(`[chest] closing a leaked window (${bot.currentWindow.type ?? '?'}) before opening`);
        await safeClose(bot);
    }
}

/**
 * Accept either shape of position.
 *
 * A prismarine `Block.position` is a real Vec3, but `findContainers` also hands back a plain
 * `{x, y, z}` for reporting - that is what `!chestList` prints and what idle_behavior keys its
 * scanned-chest set on. The two are interchangeable everywhere except `.offset()`, so a caller
 * passing the report shape used to lose the block-above and cat checks silently: they sit
 * behind fail-open try/catch, so the throw degraded to "nothing is blocking it" rather than an
 * error anyone would see. Normalising is cheaper than remembering which shape you hold.
 */
const toVec3 = p => (p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z));

function catSittingOn(bot, pos) {
    const top = toVec3(pos).offset(0, 1, 0);
    for (const e of Object.values(bot.entities ?? {})) {
        const n = e?.name ?? e?.displayName;
        if (n !== 'cat' && n !== 'ocelot' && n !== 'Cat' && n !== 'Ocelot') continue;
        if (!e.position) continue;
        if (Math.floor(e.position.x) === top.x && Math.floor(e.position.z) === top.z
            && Math.abs(e.position.y - top.y) < 1.2) return true;
    }
    return false;
}

/** Inspect the world for the reasons in `openObstruction`. Missing data reads as "unknown". */
export function inspectObstruction(bot, block) {
    let aboveName, aboveIsOpaque;
    try {
        const above = bot.blockAt(toVec3(block.position).offset(0, 1, 0));
        if (above) {
            aboveName = above.name;
            aboveIsOpaque = above.boundingBox === 'block' && above.transparent !== true;
        }
    } catch { /* unloaded - fail open */ }
    let catOnTop = false;
    try { catOnTop = catSittingOn(bot, block.position); } catch { /* fail open */ }
    return openObstruction({ containerName: block.name, aboveName, aboveIsOpaque, catOnTop });
}

// ---------------------------------------------------------------------------
// Finding and approaching
// ---------------------------------------------------------------------------

/** All openable containers in range, nearest first. Never returns a no-window "container". */
export function findContainers(bot, range = 32, count = 50) {
    let positions = [];
    try {
        positions = bot.findBlocks({
            matching: b => b != null && isOpenableContainer(b.name),
            maxDistance: range,
            count,
        });
    } catch (e) {
        console.log(`[chest] findBlocks failed: ${e.message}`);
        return [];
    }
    const out = [];
    const claimed = new Set();
    for (const pos of positions) {
        const block = bot.blockAt(pos);
        if (!block || !isOpenableContainer(block.name)) continue;
        if (claimed.has(key3(pos))) continue;

        // A DOUBLE CHEST IS ONE CONTAINER, NOT TWO. It is two block entities, and findBlocks
        // returns both - so a pad with one single and one double chest reported "Found 3
        // storage containers", listing the same 54-slot window twice at neighbouring
        // coordinates. The model then treats it as two places to put things, and a person
        // reading the list cannot tell which of the three is real.
        const partner = doublePartner(bot, block);
        if (partner) claimed.add(key3(partner.position));

        out.push({
            block,
            position: { x: pos.x, y: pos.y, z: pos.z },
            type: partner ? 'double chest' : block.name,
            isDouble: !!partner,
            otherHalf: partner ? { x: partner.position.x, y: partner.position.y, z: partner.position.z } : null,
            distance: Math.round(bot.entity.position.distanceTo(pos) * 10) / 10,
        });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}

const key3 = (p) => `${p.x},${p.y},${p.z}`;

/**
 * The other half of a double chest, or null for a single.
 *
 * Read from the block state rather than guessed from geometry: `type` is `single`/`left`/`right`
 * and only a matching `facing` makes a pair, so two unrelated chests set side by side are still
 * two containers. Checks all four horizontal neighbours instead of deriving the axis from
 * `facing` - the mapping from facing to left/right side is easy to get backwards and produces a
 * listing that is wrong only for half the orientations, which is worse than one that is wrong
 * always. Fails to "single" on any missing data, which merely restores the old behaviour.
 */
export function doublePartner(bot, block) {
    let props;
    try { props = block.getProperties?.(); } catch { return null; }
    if (!props || !props.type || props.type === 'single') return null;
    const wantType = props.type === 'left' ? 'right' : 'left';
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = bot.blockAt(block.position.offset(dx, 0, dz));
        if (!n || n.name !== block.name) continue;
        let np;
        try { np = n.getProperties?.(); } catch { continue; }
        if (np && np.type === wantType && np.facing === props.facing) return n;
    }
    return null;
}

export function containerAt(bot, x, y, z) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (!block) return null;
    if (NO_WINDOW_STORAGE.has(block.name)) return { block, unopenable: block.name };
    return isOpenableContainer(block.name) ? { block } : null;
}

const centerOf = pos => toVec3(pos).offset(0.5, 0.5, 0.5);

/**
 * Walk to within reach and PROVE it. Returns {ok, distance}.
 *
 * nav.js first because mineflayer-pathfinder's executor does not move this bot; `opts.fallback`
 * (skills.goToPosition) is tried only if nav genuinely could not close the gap, and the result
 * of both is judged the same way - by measuring, not by what either of them returned.
 */
export async function approachContainer(bot, pos, opts = {}) {
    const center = centerOf(pos);
    const near = () => bot.entity.position.distanceTo(center);
    if (near() <= MAX_REACH) return { ok: true, distance: near() };

    try {
        await nav.navigateTo(bot, { x: pos.x, y: pos.y, z: pos.z },
            { arriveDist: APPROACH_DIST, arriveY: 2, ...(opts.navOpts ?? {}) });
    } catch (e) {
        console.log(`[chest] nav.navigateTo threw: ${e.message}`);
    }
    if (near() <= MAX_REACH) return { ok: true, distance: near() };

    if (typeof opts.fallback === 'function' && !bot.interrupt_code) {
        try { await opts.fallback(bot, pos.x, pos.y, pos.z, APPROACH_DIST); }
        catch (e) { console.log(`[chest] fallback approach threw: ${e.message}`); }
    }
    const d = near();
    return { ok: d <= MAX_REACH, distance: d };
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open a container, or fail in bounded time with a reason. Never hangs, never throws.
 *
 * Retries once on a timeout with the block re-read from the world: the usual cause of a lost
 * first open is that the bot arrived a tick before the chunk state settled, and a stale Block
 * object then activates a position the server no longer agrees about.
 */
export async function openContainerSafe(bot, block, opts = {}) {
    const attempts = opts.attempts ?? 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (bot.interrupt_code) return { ok: false, reason: 'interrupted', detail: 'interrupted' };

        const fresh = bot.blockAt(block.position) ?? block;
        if (!isOpenableContainer(fresh.name)) {
            return { ok: false, reason: 'gone',
                detail: `there is ${fresh.name === 'air' ? 'nothing' : `a ${fresh.name}`} at (${fresh.position.x}, ${fresh.position.y}, ${fresh.position.z}) now` };
        }
        const blocked = inspectObstruction(bot, fresh);
        if (blocked) return { ok: false, reason: 'blocked', detail: blocked };

        const d = bot.entity.position.distanceTo(centerOf(fresh.position));
        if (d > MAX_REACH) {
            return { ok: false, reason: 'out_of_reach',
                detail: `I am ${d.toFixed(1)} blocks from it and cannot reach that far` };
        }

        await clearLeakedWindow(bot);
        try { await bot.lookAt(centerOf(fresh.position), true); } catch { /* look is best effort */ }

        try {
            const window = await withTimeout(bot.openContainer(fresh), OPEN_TIMEOUT_MS, 'openContainer');
            const totalSlots = Math.max(0, window.slots.length - 36);
            return {
                ok: true, window, block: fresh,
                totalSlots,
                isDouble: totalSlots === 54,
                type: totalSlots === 54 ? 'double chest' : fresh.name,
            };
        } catch (e) {
            // The open may still land after we stopped waiting; close whatever appeared.
            await safeClose(bot);
            if (attempt === attempts) {
                return { ok: false, reason: e.name === 'Timeout' ? 'no_response' : 'error',
                    detail: e.name === 'Timeout'
                        ? `the server never opened the ${fresh.name} (waited ${OPEN_TIMEOUT_MS}ms)`
                        : e.message };
            }
            console.log(`[chest] open attempt ${attempt} failed (${e.message}), retrying`);
        }
    }
    return { ok: false, reason: 'error', detail: 'could not open' };
}

/**
 * THE way to touch a container. Walks there, opens it, runs `fn(ctx)`, and closes the window in
 * a `finally` no matter what `fn` does. Returns {ok, value} or {ok:false, reason, detail}.
 */
export async function withContainer(bot, target, fn, opts = {}) {
    const block = target.block ?? target;
    const pos = block.position ?? target.position;

    const walked = await approachContainer(bot, pos, opts);
    if (!walked.ok) {
        return { ok: false, reason: 'unreachable',
            detail: `I could not get to the ${block.name ?? 'container'} at (${pos.x}, ${pos.y}, ${pos.z}) - stopped ${walked.distance.toFixed(1)} blocks away` };
    }

    const opened = await openContainerSafe(bot, block, opts);
    if (!opened.ok) return opened;

    const ctx = {
        win: opened.window,
        block: opened.block,
        pos,
        type: opened.type,
        totalSlots: opened.totalSlots,
        isDouble: opened.isDouble,
        contents: () => opened.window.containerItems(),
        usedSlots: () => opened.window.containerItems().length,
        deposit: (itemName, want) => depositVerified(bot, opened, itemName, want),
        withdraw: (itemName, want) => withdrawVerified(bot, opened, itemName, want),
    };

    try {
        const value = await fn(ctx);
        return { ok: true, value, ctx };
    } catch (e) {
        return { ok: false, reason: 'error', detail: e.message };
    } finally {
        await safeClose(bot, opened.window);
    }
}

// ---------------------------------------------------------------------------
// Verified transfers - every number reported here was measured, not requested
// ---------------------------------------------------------------------------

/**
 * Deposit, and report what actually moved.
 *
 * The clicking is `container_io`, not mineflayer: `win.deposit` waits on a slot update the
 * server never sends for a correct click, and strands items on the cursor when it gives up.
 * See the header of that file for the three separate defects and how each was measured.
 */
export async function depositVerified(bot, opened, itemName, want = -1) {
    const win = opened.window;
    const mine = io.slotsIn(win, io.bagRange(win)).filter(e => e.item && e.item.name === itemName);
    if (mine.length === 0) return { moved: 0, asked: 0, reason: 'none_held' };

    const stackSize = mine[0].item.stackSize ?? 64;
    const held = mine.reduce((n, e) => n + e.item.count, 0);
    const asked = want === -1 || want == null ? held : Math.min(want, held);

    const cap = capacityFor({ contents: win.containerItems(), totalSlots: opened.totalSlots, itemName, stackSize });
    if (!cap.canAccept) return { moved: 0, asked, reason: 'full' };

    const r = await io.moveItems(bot, win, { name: itemName, want: asked, direction: 'in', stackSize });
    if (r.droppedCursor) console.log(`[chest] deposit ${itemName}: had to drop a held stack on the ground`);
    return { moved: r.moved, asked, reason: r.moved > 0 && r.reason !== 'ok' ? 'partial' : r.reason };
}

/** Withdraw, and report what actually moved. Same engine, other direction. */
export async function withdrawVerified(bot, opened, itemName, want = -1) {
    const win = opened.window;
    const sample = win.containerItems().find(i => i.name === itemName);
    if (!sample) return { moved: 0, asked: 0, reason: 'not_present' };
    const stackSize = sample.stackSize ?? 64;

    const r = await io.moveItems(bot, win, { name: itemName, want, direction: 'out', stackSize });
    if (r.droppedCursor) console.log(`[chest] withdraw ${itemName}: had to drop a held stack on the ground`);
    return {
        moved: r.moved, asked: r.asked, shortfall: r.shortfall,
        reason: r.moved > 0 && r.reason !== 'ok' ? 'partial' : r.reason,
    };
}

/** One-line human explanation for a failed open/approach, used by every command. */
export function explainFailure(res, where = '') {
    const at = where ? ` at ${where}` : '';
    switch (res.reason) {
        case 'unreachable':   return res.detail;
        case 'out_of_reach':  return `I could not get close enough to the container${at}: ${res.detail}.`;
        case 'blocked':       return `I cannot open the container${at}: ${res.detail}.`;
        case 'gone':          return `The container${at} is not there any more - ${res.detail}.`;
        case 'no_response':   return `The container${at} would not open: ${res.detail}.`;
        case 'interrupted':   return `Container action interrupted.`;
        default:              return `Container action failed${at}: ${res.detail ?? 'unknown error'}.`;
    }
}
