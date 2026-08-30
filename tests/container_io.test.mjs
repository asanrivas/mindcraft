/**
 * The pure half of our own container protocol:
 *   bun tests/container_io.test.mjs
 *
 * The clicking cannot be tested without a server, but the arithmetic that decides WHICH clicks
 * to send can - and every item-loss bug so far came from that arithmetic being derived from a
 * stale or wrong view rather than from a click going astray.
 */
import { planMove, roomFor, pickPartialTarget, countIn, emptyIn, slotsIn,
         containerRange, bagRange } from '../src/agent/library/container_io.js';

let failures = 0;
const check = (label, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) { console.error(`FAIL ${label}: got ${a}, expected ${b}`); failures++; }
};

const it = (name, count, slot, stackSize = 64) => ({ slot, item: { name, count, stackSize } });
const gap = (slot) => ({ slot, item: null });

// --- roomFor ----------------------------------------------------------------------------------
check('empty range: full stacks of room', roomFor([gap(0), gap(1)], 'dirt'), 128);
check('partial stack counts toward room', roomFor([it('dirt', 60, 0)], 'dirt'), 4);
check('a different item is not room', roomFor([it('stone', 60, 0)], 'dirt'), 0);
check('mixed', roomFor([it('dirt', 60, 0), gap(1), it('stone', 64, 2)], 'dirt'), 68);
check('non-64 stack size respected', roomFor([gap(0)], 'ender_pearl', 16), 16);

// --- planMove: the whole/partial split ---------------------------------------------------------
// A shift-click moves a WHOLE stack and moves only what fits, so it is correct whenever the
// entire stack is wanted. Only a smaller-than-stack request needs the cursor dance.
{
    const src = [it('dirt', 64, 0), it('dirt', 64, 1)];
    check('take all: two whole steps',
        planMove({ sourceEntries: src, name: 'dirt', want: -1, room: 999 }).steps,
        [{ slot: 0, count: 64, whole: true }, { slot: 1, count: 64, whole: true }]);
    check('take 64: one whole step',
        planMove({ sourceEntries: src, name: 'dirt', want: 64, room: 999 }).steps,
        [{ slot: 0, count: 64, whole: true }]);
    check('take 10: one PARTIAL step',
        planMove({ sourceEntries: src, name: 'dirt', want: 10, room: 999 }).steps,
        [{ slot: 0, count: 10, whole: false }]);
    check('take 100: whole then partial',
        planMove({ sourceEntries: src, name: 'dirt', want: 100, room: 999 }).steps,
        [{ slot: 0, count: 64, whole: true }, { slot: 1, count: 36, whole: false }]);
}

// --- planMove bounded by the DESTINATION, not by the request ------------------------------------
// This is the bug that emptied a chest into nowhere: asking for more than the far side can hold
// and then reporting the amount asked for rather than the amount that fits.
{
    const src = [it('dirt', 64, 0), it('dirt', 64, 1)];
    const p = planMove({ sourceEntries: src, name: 'dirt', want: -1, room: 70 });
    check('room caps the total', p.total, 70);
    check('shortfall is reported', p.shortfall, 58);
    check('last step is partial', p.steps.at(-1), { slot: 1, count: 6, whole: false });
}
check('no room at all is flagged, not attempted',
    planMove({ sourceEntries: [it('dirt', 64, 0)], name: 'dirt', want: -1, room: 0 }).noRoom, true);
check('no room and nothing asked is NOT flagged',
    planMove({ sourceEntries: [it('dirt', 64, 0)], name: 'dirt', want: 0, room: 0 }).noRoom, false);
check('item absent: nothing planned',
    planMove({ sourceEntries: [it('stone', 64, 0)], name: 'dirt', want: -1, room: 99 }).steps, []);

// --- pickPartialTarget: prefer topping up a stack, else an empty slot --------------------------
{
    const win = { slots: [null, { name: 'dirt', count: 60, stackSize: 64 }, { name: 'stone', count: 64 }],
                  inventoryStart: 0, inventoryEnd: 3 };
    check('tops up the partial stack rather than opening a new one',
        pickPartialTarget(win, bagRange(win), { name: 'dirt' }), 1);
    check('falls back to the empty slot',
        pickPartialTarget(win, bagRange(win), { name: 'coal' }), 0);
    const full = { slots: [{ name: 'stone', count: 64, stackSize: 64 }], inventoryStart: 0, inventoryEnd: 1 };
    check('nowhere to put it returns null',
        pickPartialTarget(full, bagRange(full), { name: 'coal' }), null);
}

// --- reading the window, container half vs bag half ---------------------------------------------
// Getting this boundary wrong is how a double chest's second half looks like lost items.
{
    const win = { inventoryStart: 2, inventoryEnd: 5,
        slots: [{ name: 'dirt', count: 10 }, null, { name: 'dirt', count: 3 }, null, { name: 'coal', count: 1 }] };
    check('container half counted alone', countIn(win, containerRange(win), 'dirt'), 10);
    check('bag half counted alone', countIn(win, bagRange(win), 'dirt'), 3);
    check('empty slots in the bag half', emptyIn(win, bagRange(win)), 1);
    check('slot indices are absolute, not per-range',
        slotsIn(win, bagRange(win)).map(e => e.slot), [2, 3, 4]);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('container_io: all checks passed');
