/**
 * The container decisions, as pure functions. No server, no bot:
 *   bun tests/chest.test.mjs
 *
 * The regressions these exist for all presented as "the bot froze", and one of them killed the
 * process. `bot.openContainer` is `activateBlock()` + `await once(bot, 'windowOpen')` with NO
 * timeout, so every reason the server declines to send a window is an infinite hang:
 *
 *   logs/service.log: "ChestView at (4727,68,4764) caused code execution timeout and process kill"
 *   logs/service.log: "Chest viewing at (4557,68,4862) times out after 20s - pathfinding fails to reach it."
 *
 * A live check can only ever exercise whichever situation the world happens to be in, and the
 * cases that must NOT refuse matter more than the ones that must: a check that guessed
 * "blocked" from missing data would disable !chestPut in exactly the situations we cannot
 * diagnose. Hence the fail-open assertions below.
 */
import {
    openObstruction, capacityFor, planWithdraw, inspectObstruction,
    isOpenableContainer, needsHeadroom, nominalSlots, withTimeout, CONTAINER_NAMES,
} from '../src/agent/library/chest.js';
import { Vec3 } from 'vec3';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}: got ${g}, expected ${w}`); failures++; }
};
const blocks = (label, args) => {
    const r = openObstruction(args);
    if (r === null) { console.error(`FAIL ${label}: expected a refusal, got null`); failures++; }
};
const allows = (label, args) => {
    const r = openObstruction(args);
    if (r !== null) { console.error(`FAIL ${label}: expected null, got ${JSON.stringify(r)}`); failures++; }
};

// --- the taxonomy ----------------------------------------------------------------------------
// decorated_pot and chiseled_bookshelf hold items but open NO window. They were in the old
// STORAGE_CONTAINERS list, so `!chestDepositAll` could pick one as "the nearest container" and
// wait for a windowOpen that was never coming.
check('decorated_pot is not openable', isOpenableContainer('decorated_pot'), false);
check('chiseled_bookshelf is not openable', isOpenableContainer('chiseled_bookshelf'), false);
check('neither appears in the search list',
    CONTAINER_NAMES.filter(n => n === 'decorated_pot' || n === 'chiseled_bookshelf'), []);
blocks('opening a decorated_pot is refused with a reason', { containerName: 'decorated_pot' });
blocks('opening a chiseled_bookshelf is refused', { containerName: 'chiseled_bookshelf' });
blocks('a non-container is refused', { containerName: 'stone' });

check('chest is openable', isOpenableContainer('chest'), true);
check('barrel is openable', isOpenableContainer('barrel'), true);
check('every shulker colour is openable',
    ['red_shulker_box', 'light_gray_shulker_box', 'shulker_box'].every(isOpenableContainer), true);
check('hopper has 5 slots', nominalSlots('hopper'), 5);
check('chest has 27 slots', nominalSlots('chest'), 27);

// --- vanilla's "nothing on top" rule, which only chests obey ----------------------------------
check('chest needs headroom', needsHeadroom('chest'), true);
check('trapped_chest needs headroom', needsHeadroom('trapped_chest'), true);
// A barrel opens under a solid block; treating it like a chest would refuse a chest that works.
check('barrel does not need headroom', needsHeadroom('barrel'), false);
check('shulker_box does not need headroom', needsHeadroom('shulker_box'), false);

blocks('solid block on a chest', { containerName: 'chest', aboveName: 'stone', aboveIsOpaque: true });
blocks('cat on a chest', { containerName: 'chest', catOnTop: true });
allows('slab on a chest is fine', { containerName: 'chest', aboveName: 'stone_slab', aboveIsOpaque: false });
allows('air on a chest is fine', { containerName: 'chest', aboveName: 'air', aboveIsOpaque: false });
allows('solid block on a BARREL is fine', { containerName: 'barrel', aboveName: 'stone', aboveIsOpaque: true });
allows('cat on a barrel is fine', { containerName: 'barrel', catOnTop: true });

// --- fail open: unknown data must never refuse -------------------------------------------------
// An unloaded chunk returns undefined for the block above, exactly as a transparent one would.
// Refusing there would disable the command in the situations we can least diagnose.
allows('unknown block above', { containerName: 'chest', aboveName: undefined, aboveIsOpaque: undefined });
allows('no entity list', { containerName: 'chest', aboveIsOpaque: false, catOnTop: undefined });
allows('unknown container name', { containerName: undefined });

// --- capacity: why deposit() is never called on a full chest -----------------------------------
// mineflayer's deposit() on a full chest throws only after waiting out a slot update that never
// arrives. Looking first is both cheaper and the only way to say WHY.
const full27 = Array.from({ length: 27 }, (_, i) => ({ name: 'stone', count: 64, stackSize: 64, slot: i }));
check('full chest of a different item accepts nothing',
    capacityFor({ contents: full27, totalSlots: 27, itemName: 'diamond' }).canAccept, false);
// ...but a full chest with a PARTIAL stack of the same item still has room, and the old
// pre-check knew this. Keep it: refusing here strands items in the bag.
const full27partial = [...full27.slice(0, 26), { name: 'diamond', count: 10, stackSize: 64, slot: 26 }];
check('full chest with a partial stack of the same item accepts',
    capacityFor({ contents: full27partial, totalSlots: 27, itemName: 'diamond' }).canAccept, true);
check('...and reports exactly the room in that stack',
    capacityFor({ contents: full27partial, totalSlots: 27, itemName: 'diamond' }).freeUnits, 54);
check('empty chest room', capacityFor({ contents: [], totalSlots: 27, itemName: 'stone' }).freeUnits, 27 * 64);
check('double chest room', capacityFor({ contents: [], totalSlots: 54, itemName: 'stone' }).freeUnits, 54 * 64);
check('a hopper is small, not full',
    capacityFor({ contents: [], totalSlots: 5, itemName: 'stone' }).freeUnits, 5 * 64);

// --- withdraw must be bounded by INVENTORY room ------------------------------------------------
// The old takeFromChest did `totalTaken += toTakeFromSlot` right after withdraw, with no check,
// so a bot with a full bag reported "Successfully took 64 diamond" having taken none.
const chestHas = [
    { name: 'diamond', count: 64, stackSize: 64, slot: 0, type: 1 },
    { name: 'diamond', count: 20, stackSize: 64, slot: 1, type: 1 },
    { name: 'stone', count: 64, stackSize: 64, slot: 2, type: 2 },
];
check('takes across slots', planWithdraw({ contents: chestHas, itemName: 'diamond', want: 80, freeInvSlots: 36 }).total, 80);
check('...from two slots', planWithdraw({ contents: chestHas, itemName: 'diamond', want: 80, freeInvSlots: 36 }).picks.length, 2);
check('want -1 takes everything present',
    planWithdraw({ contents: chestHas, itemName: 'diamond', want: -1, freeInvSlots: 36 }).total, 84);
check('cannot take more than exists',
    planWithdraw({ contents: chestHas, itemName: 'diamond', want: 999, freeInvSlots: 36 }).total, 84);

const fullBag = planWithdraw({ contents: chestHas, itemName: 'diamond', want: 64, freeInvSlots: 0, invPartialRoom: 0 });
check('full inventory takes nothing', fullBag.total, 0);
check('...and says so', fullBag.invFull, true);
check('...and reports the shortfall honestly', fullBag.shortfall, 64);

const oneSlot = planWithdraw({ contents: chestHas, itemName: 'diamond', want: 84, freeInvSlots: 1 });
check('one free slot caps at one stack', oneSlot.total, 64);
check('...and admits the rest did not fit', oneSlot.shortfall, 20);
// A partial stack already in the bag is real room, and ignoring it strands the tail of a haul.
check('partial stack in the bag counts as room',
    planWithdraw({ contents: chestHas, itemName: 'diamond', want: 84, freeInvSlots: 1, invPartialRoom: 20 }).total, 84);
check('absent item plans nothing',
    planWithdraw({ contents: chestHas, itemName: 'emerald', want: 10, freeInvSlots: 36 }).total, 0);

// --- position shape: Vec3 and plain {x,y,z} must behave identically ---------------------------
// A prismarine Block.position is a Vec3, but findContainers also returns a plain {x, y, z} for
// reporting. Only `.offset()` distinguishes them - and the block-above and cat checks sit behind
// fail-open try/catch, so a plain object used to make them throw and degrade SILENTLY to
// "nothing is blocking this chest". The refusal simply disappeared; the hang did not.
const fakeBot = (aboveName) => ({
    entities: {},
    blockAt: (v) => {
        // A plain object reaching offset() would have thrown before this ever ran.
        if (!(v instanceof Vec3)) throw new Error('blockAt got a non-Vec3');
        return v.y === 65 ? { name: aboveName, boundingBox: 'block', transparent: false } : null;
    },
});
const chestBlock = (pos) => ({ name: 'chest', position: pos });

check('Vec3 position sees the solid block above',
    inspectObstruction(fakeBot('stone'), chestBlock(new Vec3(10, 64, 10))) !== null, true);
check('plain {x,y,z} sees it too - this is the trap that was fixed',
    inspectObstruction(fakeBot('stone'), chestBlock({ x: 10, y: 64, z: 10 })) !== null, true);
check('both shapes agree when nothing is above',
    inspectObstruction(fakeBot('air'), chestBlock({ x: 10, y: 99, z: 10 })),
    inspectObstruction(fakeBot('air'), chestBlock(new Vec3(10, 99, 10))));

// A cat is located by flooring its float position into the block above, so the same
// normalisation has to hold for the entity scan.
const catBot = (shape) => ({
    entities: { 1: { name: 'cat', position: new Vec3(10.4, 65.0, 10.7) } },
    blockAt: () => null,
});
check('cat on a chest is seen through a Vec3 position',
    inspectObstruction(catBot(), chestBlock(new Vec3(10, 64, 10))) !== null, true);
check('cat on a chest is seen through a plain position',
    inspectObstruction(catBot(), chestBlock({ x: 10, y: 64, z: 10 })) !== null, true);

// --- the deadline itself -----------------------------------------------------------------------
// Everything above only matters because the open really can never settle. withTimeout is the
// backstop for the reasons we did NOT think of.
const t0 = Date.now();
const hang = new Promise(() => {});   // never settles - exactly what openContainer did
try {
    await withTimeout(hang, 40, 'openContainer');
    console.error('FAIL a never-settling promise must reject'); failures++;
} catch (e) {
    check('the hang is rejected as a Timeout', e.name, 'Timeout');
    if (Date.now() - t0 > 1000) { console.error('FAIL timeout did not fire promptly'); failures++; }
}
check('a fast promise passes through', await withTimeout(Promise.resolve('window'), 500, 'open'), 'window');

console.log(failures === 0 ? 'chest: all checks passed' : `chest: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
