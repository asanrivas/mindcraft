/**
 * Night-safety decisions. No server, no bot:
 *   bun tests/night.test.mjs
 *
 * Written after the bot, newly mortal on Normal difficulty, was killed twice in one in-game
 * night - it had no concept of dusk at all.
 */
import { isNight, canSleepAt, isDuskApproaching, isBedName, bedInInventory,
         pickShelterSpot, decideNightAction, DUSK, MOBS_SPAWN, DAWN }
    from '../src/agent/library/night.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

// --- THE REGRESSION: 'bedrock'.includes('bed') is true ----------------------------------------
// Third appearance of this bug class in this repo, after "sandstone".includes("sand") and
// water_cauldron. The old goToBed walked to bedrock and tried to sleep in it.
check('isBedName(red_bed)', isBedName('red_bed'), true);
check('isBedName(light_gray_bed)', isBedName('light_gray_bed'), true);
check('isBedName(BEDROCK)', isBedName('bedrock'), false);
check('isBedName(bedrock_wall)', isBedName('bedrock_wall'), false);
check('isBedName(null)', isBedName(null), false);
check('bedInInventory finds it', bedInInventory([{name:'stone'},{name:'blue_bed'}]).name, 'blue_bed');
check('bedInInventory ignores bedrock', bedInInventory([{name:'bedrock'}]), null);
check('bedInInventory empty', bedInInventory([]), null);

// --- the clock ---------------------------------------------------------------------------------
check('noon is not night', isNight(6000), false);
check('12999 is not yet night', isNight(MOBS_SPAWN - 1), false);
check('13000 is night', isNight(MOBS_SPAWN), true);
check('22999 is night', isNight(DAWN - 1), true);
check('dawn is not night', isNight(DAWN), false);

check('cannot sleep at noon', canSleepAt(6000), false);
check('can sleep at dusk', canSleepAt(DUSK), true);
check('can sleep just before dawn', canSleepAt(DAWN - 1), true);
// Thunderstorms let you sleep at any hour - and are exactly when you most want to.
check('thunder lets you sleep at noon', canSleepAt(6000, true), true);

// The lead time is the whole margin the bot gets to walk to a bed before mobs appear.
check('dusk approaching at 12000', isDuskApproaching(12000), true);
check('not approaching at 10000', isDuskApproaching(10000), false);

// --- the decision table ------------------------------------------------------------------------
const base = { timeOfDay: 13000, thundering: false, inWater: false, hostileNear: false,
               bedNearby: false, bedInInv: false, dimension: 'overworld', isSleeping: false };

check('daytime does nothing', decideNightAction({ ...base, timeOfDay: 6000 }), 'none');
check('already asleep does nothing', decideNightAction({ ...base, isSleeping: true }), 'none');
// Water is the drowning mode's territory - never contest the jump key with SwimAssist.
check('in water defers', decideNightAction({ ...base, inWater: true }), 'none');
// Do not fight self_defense for the controls; wait for it to finish.
check('hostile nearby waits', decideNightAction({ ...base, hostileNear: true }), 'wait');
check('bed nearby -> sleep', decideNightAction({ ...base, bedNearby: true }), 'sleep');
check('bed in bag -> place it', decideNightAction({ ...base, bedInInv: true }), 'place_bed');
check('no bed at all -> shelter', decideNightAction({ ...base }), 'shelter');
// Beds detonate in the nether/end. Never sleep there, whatever else is true.
check('nether never sleeps', decideNightAction({ ...base, bedNearby: true, dimension: 'the_nether' }), 'shelter');
check('end never sleeps', decideNightAction({ ...base, bedNearby: true, dimension: 'the_end' }), 'shelter');
// A bed you cannot use yet is not a plan.
check('bed nearby but too early -> shelter',
      decideNightAction({ ...base, timeOfDay: 12100, bedNearby: true }), 'shelter');

// --- shelter siting -----------------------------------------------------------------------------
const flat = (x, y, z) => (y >= 64 ? 'air' : 'dirt');
{
    const spot = pickShelterSpot(flat, { x: 0, y: 64, z: 0 });
    check('flat ground is diggable', spot !== null, true);
    check('prefers standing where it is', spot && spot.x === 0 && spot.z === 0, true);
}
{
    // Never dig into water or lava.
    const overWater = (x, y, z) => (y === 63 ? 'water' : (y >= 64 ? 'air' : 'dirt'));
    check('refuses to dig into water', pickShelterSpot(overWater, { x: 0, y: 64, z: 0 }, 0), null);
    const overLava = (x, y, z) => (y === 62 ? 'lava' : (y >= 64 ? 'air' : 'dirt'));
    check('refuses to dig over lava', pickShelterSpot(overLava, { x: 0, y: 64, z: 0 }, 0), null);
}
{
    // A sand roof pours into the hole the moment you seal under it.
    const sandRoof = (x, y, z) => (y === 67 ? 'sand' : (y >= 64 ? 'air' : 'dirt'));
    check('refuses a sand ceiling', pickShelterSpot(sandRoof, { x: 0, y: 64, z: 0 }, 0), null);
}
{
    // Unloaded chunks are never "safe" - same invariant as the swim and world-guard code.
    check('refuses unloaded chunks', pickShelterSpot(() => null, { x: 0, y: 64, z: 0 }, 0), null);
}
{
    // Blocked underfoot at the origin, but a neighbour works: it should step aside.
    const patchy = (x, y, z) => {
        if (x === 0 && z === 0 && y === 63) return 'lava';
        return y >= 64 ? 'air' : 'dirt';
    };
    const spot = pickShelterSpot(patchy, { x: 0, y: 64, z: 0 }, 2);
    check('steps aside from a bad cell', spot !== null && !(spot.x === 0 && spot.z === 0), true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: night safety decisions correct');
