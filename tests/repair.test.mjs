/**
 * Putting back what the navigator had to break.
 *
 *   bun tests/repair.test.mjs
 *
 * Reported as "andy breaks my building/fence sometimes. he doesnt have effort to repair back".
 * `digAhead` now breaks a player-made block only when the plan has no other way through
 * (player_build.test.mjs) - and when it does, repair.js puts it back once the bot is past it.
 *
 * What must hold:
 *   - a repair is only offered from a spot the bot can place from WITHOUT MOVING, so it never
 *     competes with the route it interrupted;
 *   - nothing retries on a fixed beat: no item -> wait for one (logged once), a failed try ->
 *     only again from somewhere else, and at most MAX_ATTEMPTS;
 *   - success is read from the WORLD, never from the placer's return value.
 */
import fs from 'fs';
import { Vec3 } from 'vec3';
import {
    noteBreach, nextRepair, repairOne, repairInReach, hasPendingRepairs, itemForBlock, withState,
    REACH_MIN, REACH_MAX, MAX_ATTEMPTS, PENDING_TTL_MS, _clearRepairs,
} from '../src/agent/library/repair.js';

// Captured before anything can mute console.log: a check made inside `quietly` must still print.
const origLog = console.log;
let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; origLog(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else origLog(`ok   ${name}`);
}

// --- pure helpers --------------------------------------------------------------------------------
check('a fence is placed from a fence', itemForBlock('oak_fence'), 'oak_fence');
check('a wall torch is placed from a torch', itemForBlock('wall_torch'), 'torch');
check('a wall sign is placed from a sign', itemForBlock('spruce_wall_sign'), 'spruce_sign');
check('state renders for /setblock', withState('oak_stairs', { facing: 'north', half: 'bottom' }),
    'oak_stairs[facing=north,half=bottom]');
check('no state renders as the bare name', withState('oak_fence', {}), 'oak_fence');

// --- a fake bot ----------------------------------------------------------------------------------
// The world is a Map of cell -> name; anything unset is air. Quiet logs: the suite prints checks.
function makeBot({ at = [0, 64, 0], items = [], name = 'andy', wet = false } = {}) {
    const cells = new Map();
    return {
        username: name,
        cells,
        entity: { position: new Vec3(...at), isInWater: wet },
        modes: { isOn: () => false },
        game: { gameMode: 'survival' },
        inventory: { items: () => items.map((n) => ({ name: n })) },
        blockAt(v) {
            const k = `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
            return { name: cells.get(k) ?? 'air', position: v };
        },
    };
}
const fence = { name: 'oak_fence', getProperties: () => ({ east: 'true', west: 'true' }) };
const quietly = async (fn) => {
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.log = origLog; }
    return lines;
};
const at = (bot, x, y, z) => { bot.entity.position = new Vec3(x, y, z); };

// --- recording ------------------------------------------------------------------------------------
_clearRepairs();
let bot = makeBot({ items: ['oak_fence'] });
await quietly(() => noteBreach(bot, new Vec3(10, 64, 0), fence));
check('a breach is recorded', hasPendingRepairs(bot), true);
check('...for that bot only', hasPendingRepairs(makeBot({ name: 'bob' })), false);

// A door is two cells and one item: breaking the top half records the bottom.
const door = makeBot({ name: 'doorbot' });
await quietly(() => noteBreach(door, new Vec3(3, 65, 3),
    { name: 'oak_door', getProperties: () => ({ half: 'upper', facing: 'north' }) }));
at(door, 3, 64, 0);   // 3 blocks from (3,64,3)
door.inventory.items = () => [{ name: 'oak_door' }];
check('an upper door half is recorded as the lower cell', nextRepair(door)?.y, 64);

// --- the reach band: never from where the bot would have to move ----------------------------------
at(bot, 10, 64, 0);
check('standing in the hole: no repair (placeBlock would step away)', nextRepair(bot), null);
at(bot, 11.5, 64, 0);
check(`closer than REACH_MIN (${REACH_MIN}): no repair`, nextRepair(bot), null);
at(bot, 20, 64, 0);
check(`further than REACH_MAX (${REACH_MAX}): no repair (placeBlock would walk)`, nextRepair(bot), null);
check('...and the hole stays pending for a later journey', hasPendingRepairs(bot), true);
at(bot, 13, 64, 0);
check('past it and in reach: offered', nextRepair(bot)?.name, 'oak_fence');

// --- never while wet: SwimAssist owns the controls -----------------------------------------------
bot.entity.isInWater = true;
check('in water: not offered', nextRepair(bot), null);
bot.entity.isInWater = false;

// --- no item: wait for one, and say so ONCE ------------------------------------------------------
const empty = makeBot({ name: 'empty' });
await quietly(() => noteBreach(empty, new Vec3(10, 64, 0), fence));
at(empty, 13, 64, 0);
const noItemLines = await quietly(() => { nextRepair(empty); nextRepair(empty); nextRepair(empty); });
check('no item: not offered', nextRepair(empty), null);
check('no item: logged exactly once across repeated checks',
    noItemLines.filter((l) => l.includes('no oak_fence')).length, 1);
check('no item: still pending, not given up', hasPendingRepairs(empty), true);
empty.inventory.items = () => [{ name: 'oak_fence' }];
check('the item turns up: now offered', nextRepair(empty)?.name, 'oak_fence');

// --- success is read from the world ---------------------------------------------------------------
const placeOk = (b) => async (_bot, name, x, y, z) => { b.cells.set(`${x},${y},${z}`, name); return true; };
const placeLies = async () => true;          // claims success, places nothing
const placeThrowsAfter = (b) => async (_bot, name, x, y, z) => { b.cells.set(`${x},${y},${z}`, name); throw new Error('ack'); };

let lines = await quietly(async () => check('a real placement is a repair',
    await repairOne(bot, nextRepair(bot), placeOk(bot)), true));
check('...the fence is back in the world', bot.cells.get('10,64,0'), 'oak_fence');
check('...and nothing is pending', hasPendingRepairs(bot), false);
check('...and it says so', lines.some((l) => l.includes('put back oak_fence')), true);

const thrower = makeBot({ name: 'thrower', items: ['oak_fence'] });
await quietly(() => noteBreach(thrower, new Vec3(10, 64, 0), fence));
at(thrower, 13, 64, 0);
await quietly(async () => check('a throw AFTER a successful placement still counts',
    await repairOne(thrower, nextRepair(thrower), placeThrowsAfter(thrower)), true));

// --- failure: never twice from the same spot, never more than MAX_ATTEMPTS ------------------------
const liar = makeBot({ name: 'liar', items: ['oak_fence'] });
await quietly(() => noteBreach(liar, new Vec3(10, 64, 0), fence));
at(liar, 13, 64, 0);
await quietly(async () => check('"true" from the placer with nothing in the world is NOT a repair',
    await repairOne(liar, nextRepair(liar), placeLies), false));
check('one failure: still pending', hasPendingRepairs(liar), true);
check('...but not offered again from the same spot', nextRepair(liar), null);
at(liar, 13, 64, 2);   // moved - an input changed
check('...offered again once the bot has moved', nextRepair(liar)?.name, 'oak_fence');
lines = await quietly(() => repairOne(liar, nextRepair(liar), placeLies));
check(`after ${MAX_ATTEMPTS} failures it gives up`, hasPendingRepairs(liar), false);
check('...naming what it left behind', lines.some((l) => l.includes('GAVE UP') && l.includes('oak_fence')), true);

// --- holes that no longer need anything -----------------------------------------------------------
const fixedBy = makeBot({ name: 'fixed', items: ['oak_fence'] });
await quietly(() => noteBreach(fixedBy, new Vec3(10, 64, 0), fence));
fixedBy.cells.set('10,64,0', 'oak_fence');   // a player put it back first
at(fixedBy, 13, 64, 0);
check('already put back by someone else: dropped quietly', (nextRepair(fixedBy), hasPendingRepairs(fixedBy)), false);

const replaced = makeBot({ name: 'replaced', items: ['oak_fence'] });
await quietly(() => noteBreach(replaced, new Vec3(10, 64, 0), fence));
replaced.cells.set('10,64,0', 'oak_fence_gate');   // somebody built something else there
at(replaced, 13, 64, 0);
lines = await quietly(() => nextRepair(replaced));
check('something else built there: never overwritten', hasPendingRepairs(replaced), false);
check('...and says what is there now', lines.some((l) => l.includes('oak_fence_gate is there now')), true);

const stale = makeBot({ name: 'stale', items: ['oak_fence'] });
await quietly(() => noteBreach(stale, new Vec3(10, 64, 0), fence));
const realNow = Date.now;
Date.now = () => realNow() + PENDING_TTL_MS + 1000;
lines = await quietly(() => nextRepair(stale));
Date.now = realNow;
check('a hole never revisited is given up after the TTL', hasPendingRepairs(stale), false);
check('...by name, saying the hole is still there', lines.some((l) => l.includes('GAVE UP') && l.includes('still there')), true);

// --- repairInReach: one try per hole per call, never a loop --------------------------------------
const two = makeBot({ name: 'two', items: ['oak_fence'] });
await quietly(() => { noteBreach(two, new Vec3(10, 64, 0), fence); noteBreach(two, new Vec3(10, 64, 1), fence); });
at(two, 13, 64, 0);
let calls = 0;
const counting = async (...a) => { calls++; return placeOk(two)(...a); };
// repairInReach loads the real placer; drive the same loop through the seam instead.
for (let h = nextRepair(two); h; h = nextRepair(two)) await quietly(() => repairOne(two, h, counting));
check('both holes in reach are repaired', hasPendingRepairs(two), false);
check('...with one placement each', calls, 2);
check('repairInReach with nothing pending does nothing', await repairInReach(makeBot({ name: 'idle' })), 0);

// --- the wiring in nav.js ---------------------------------------------------------------------------
// Source checks, as in build_guard.test.mjs: these are the properties that make the module above
// safe to call from inside the walk loop, and none of them is visible without a live bot.
const nav = fs.readFileSync(new URL('../src/agent/library/nav.js', import.meta.url), 'utf8');
const dig = nav.slice(nav.indexOf('async function digAhead'), nav.indexOf('function wouldFlood'));
check('the breach is decided from the block BEFORE digging',
    dig.indexOf('const guarded') > -1 && dig.indexOf('const guarded') < dig.indexOf('await digWithTool'), true);
check('...and recorded only after the dig SUCCEEDED',
    /if \(await digWithTool\(bot, b\)\) \{\s*if \(guarded\) repair\.noteBreach/.test(dig), true);
const walk = nav.slice(nav.indexOf('export async function followPath'), nav.indexOf('export function waterExitVerdict'));
const hook = walk.slice(walk.indexOf('repair.nextRepair(bot)'), walk.indexOf('repair.nextRepair(bot)') + 900);
check('the walk loop restores forward in a finally', /finally \{[^}]*setControlState\('forward', fwd\)/.test(hook), true);
check('...and resets BOTH stall clocks, so a repair never reads as pinned',
    /stallSince = Date\.now\(\)/.test(hook) && /lastProgress = Date\.now\(\)/.test(hook), true);
check('...and never touches jump (AutoJump owns it)', /jump/.test(hook.replace(/AutoJump owns it/g, '')), false);

console.log(failures === 0 ? 'repair: all checks passed' : `repair: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
