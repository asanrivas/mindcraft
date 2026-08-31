/**
 * The boat decision layer — pure, no server, no bot:
 *   bun tests/boat.test.mjs
 *
 * docs/gaps/boats.exec.md gates almost everything on a live Stage 0 probe that has not run yet
 * (does this server move a boat from `player_input` alone, or does it expect a streamed
 * `vehicle_move`?). This file covers ONLY the part of the plan that does not depend on that
 * answer: whether to board, which boat, and where to get back out. Refusals carry more weight
 * than the acceptance case, same convention as `tests/water_exit.test.mjs` and
 * `tests/bridge.test.mjs` — a false "yes" here either strands a boat in open water or sends the
 * bot into a pond it cannot leave, which CLAUDE.md is explicit is the same class of failure as
 * mining a canal trying to get out of one.
 */
import {
    isBoatEntity, boardVerdict, shouldBoat, pickDismountPoint, openWaterRun,
    formatBoatOutcome, MIN_BOAT_LEG,
} from '../src/agent/library/boat.js';

let failures = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); failures++; }
    else console.log(`ok   ${label}`);
};
function throws(label, fn) {
    try { fn(); console.error(`FAIL ${label}: expected a throw`); failures++; }
    catch (e) { console.log(`ok   ${label} (threw: ${e.message})`); }
}

// =================================================================================================
// isBoatEntity — exact membership, never substring. The sandstone lesson: "boat_spawn_egg"
// contains "boat" and must still read false.
// =================================================================================================
check('oak_boat is a boat', isBoatEntity('oak_boat'), true);
check('bamboo_raft is a boat', isBoatEntity('bamboo_raft'), true);
check('oak_chest_boat is a boat', isBoatEntity('oak_chest_boat'), true);
check('bamboo_chest_raft is a boat', isBoatEntity('bamboo_chest_raft'), true);
check('"boat" alone is not a real entity name', isBoatEntity('boat'), false);
check('saddle is not a boat', isBoatEntity('saddle'), false);
check('boat_spawn_egg is not a boat (the anchoring test)', isBoatEntity('boat_spawn_egg'), false);
check('null name is not a boat', isBoatEntity(null), false);
check('undefined name is not a boat', isBoatEntity(undefined), false);

// =================================================================================================
// boardVerdict
// =================================================================================================
const emptyBoat = { entityName: 'oak_boat', passengers: [], selfId: 'andy', fluidBelow: 'water' };
check('empty boat on water: board', boardVerdict(emptyBoat).board, true);

check('not a boat at all', boardVerdict({ ...emptyBoat, entityName: 'minecart' }).board, false);
check('...names itself', boardVerdict({ ...emptyBoat, entityName: 'minecart' }).reason, 'not_a_boat');

check('occupied by someone else', boardVerdict({ ...emptyBoat, passengers: ['bob'] }).board, false);
check('...names itself', boardVerdict({ ...emptyBoat, passengers: ['bob'] }).reason, 'occupied');

check('already mounted by us is a no-op, not a hard refusal-with-error-reason',
    boardVerdict({ ...emptyBoat, passengers: ['andy'] }).reason, 'already_mounted');
check('already_mounted does not board again',
    boardVerdict({ ...emptyBoat, passengers: ['andy'] }).board, false);

check('boat sitting over lava', boardVerdict({ ...emptyBoat, fluidBelow: 'lava' }).board, false);
check('...names itself', boardVerdict({ ...emptyBoat, fluidBelow: 'lava' }).reason, 'lava');
// Lava wins even over an otherwise-perfect empty boat.
check('lava outranks an empty boat',
    boardVerdict({ entityName: 'oak_boat', passengers: [], selfId: 'andy', fluidBelow: 'lava' }).board, false);

// Every refusal must name itself - a silent false is indistinguishable from the branch never
// running, in a loop that might poll this every tick.
for (const [label, over] of [
    ['not a boat', { entityName: 'pig' }],
    ['occupied', { passengers: ['bob'] }],
    ['already mounted', { passengers: ['andy'] }],
    ['lava', { fluidBelow: 'lava' }],
]) {
    const r = boardVerdict({ ...emptyBoat, ...over });
    if (!r.reason || typeof r.reason !== 'string') { console.error(`FAIL ${label}: no reason given`); failures++; }
}

// =================================================================================================
// shouldBoat — the when-to-boat decision
// =================================================================================================
const longCrossing = {
    waterRun: 200, landReachable: false, exitReachable: true, lavaOnRoute: false,
    haveBoat: true, canCraft: false,
};

// --- the positive control: a decision function that never says yes is useless ------------------
check('long open crossing with a boat available: boats', shouldBoat(longCrossing).mode, 'boat');
check('...and the boolean agrees', shouldBoat(longCrossing).boat, true);

// --- refusals, weighted more heavily than the acceptance ----------------------------------------
// A short leg must never boat, whatever else is true.
check('a leg under MIN_BOAT_LEG swims instead',
    shouldBoat({ ...longCrossing, waterRun: MIN_BOAT_LEG - 1 }).mode, 'swim');
check('a leg in the old MAX_SWIM_LEG..MIN_BOAT_LEG band still swims (24 < run < 40)',
    shouldBoat({ ...longCrossing, waterRun: 30 }).mode, 'swim');
check('boundary: exactly MIN_BOAT_LEG boats', shouldBoat({ ...longCrossing, waterRun: MIN_BOAT_LEG }).mode, 'boat');
check('boundary: one under MIN_BOAT_LEG does not', shouldBoat({ ...longCrossing, waterRun: MIN_BOAT_LEG - 1 }).mode !== 'boat', true);

// A land-reachable destination must NOT boat, even if the water crossing is long - a boat trip
// that should have been a walk is a regression, not a neutral choice.
check('land-reachable destination walks, whatever the water says',
    shouldBoat({ ...longCrossing, landReachable: true }).mode, 'walk');
check('...even over an enormous river', shouldBoat({ ...longCrossing, landReachable: true, waterRun: 5000 }).mode, 'walk');

// No boat and nothing to build one from hands off to the existing ladder.
check('no boat, no planks: swim_or_escape',
    shouldBoat({ ...longCrossing, haveBoat: false, canCraft: false }).mode, 'swim_or_escape');
check('no boat but craftable is fine', shouldBoat({ ...longCrossing, haveBoat: false, canCraft: true }).mode, 'boat');

// Lava anywhere on the route refuses outright.
check('lava on the route refuses', shouldBoat({ ...longCrossing, lavaOnRoute: true }).mode, 'refuse');
check('...even with a boat in hand and a long clean-looking run',
    shouldBoat({ ...longCrossing, lavaOnRoute: true, waterRun: 500 }).mode, 'refuse');

// THE load-bearing refusal: no confirmed exit on the far shore, at ANY length - "water is only
// cheap if you can get out of it".
check('no exit on the far shore refuses even on a long, otherwise-perfect crossing',
    shouldBoat({ ...longCrossing, exitReachable: false }).mode, 'refuse');
check('...names the real reason',
    shouldBoat({ ...longCrossing, exitReachable: false }).reason.includes('exit'), true);
check('a short leg with no exit is refused, not merely told to swim (that would be worse: a pond)',
    shouldBoat({ ...longCrossing, exitReachable: false, waterRun: 10 }).mode, 'refuse');

// --- precedence: walk beats every water consideration; lava/no-exit beat leg length ------------
check('walk wins even when the route also has lava and no exit',
    shouldBoat({ ...longCrossing, landReachable: true, lavaOnRoute: true, exitReachable: false }).mode, 'walk');
check('lava is checked before leg length',
    shouldBoat({ ...longCrossing, lavaOnRoute: true, waterRun: 5 }).mode, 'refuse');

// Every refusal names itself.
for (const [label, over] of [
    ['refuse-lava', { lavaOnRoute: true }],
    ['refuse-no-exit', { exitReachable: false }],
    ['swim-short', { waterRun: 5 }],
    ['swim_or_escape', { haveBoat: false, canCraft: false }],
    ['walk', { landReachable: true }],
]) {
    const r = shouldBoat({ ...longCrossing, ...over });
    if (!r.reason || typeof r.reason !== 'string') { console.error(`FAIL ${label}: no reason given`); failures++; }
}

check('MIN_BOAT_LEG is exactly 40 per the plan\'s break-even arithmetic', MIN_BOAT_LEG, 40);

// =================================================================================================
// pickDismountPoint — injected fake block reader, like swimCostFor's pre-classified inputs
// =================================================================================================
// Tiny world builder: a Map of "x,y,z" -> name string. Anything not listed reads undefined
// (unloaded), which must never be treated as a safe landing.
function worldOf(entries) {
    const m = new Map(entries.map(([x, y, z, name]) => [`${x},${y},${z}`, name]));
    return (x, y, z) => m.get(`${x},${y},${z}`);
}

{
    // A one-block-rise dry shore two blocks ahead along +x, water everywhere else nearby.
    const blockAt = worldOf([
        [2, 9, 0, 'sand'], [2, 10, 0, 'air'], [2, 11, 0, 'air'],   // dry, rise 0, at n=2
        [1, 9, 0, 'water'], [1, 10, 0, 'water'], [1, 11, 0, 'air'],
    ]);
    const r = pickDismountPoint(blockAt, { x: 0, y: 10, z: 0 }, { dx: 1, dz: 0 });
    check('finds the dry cell ahead', r.dismount, true);
    check('...at the right coordinates', [r.x, r.y, r.z], [2, 10, 0]);
}

{
    // Nothing dry within reach: every candidate cell is still water.
    const blockAt = worldOf([
        [1, 9, 0, 'water'], [1, 10, 0, 'water'], [1, 11, 0, 'air'],
        [2, 9, 0, 'water'], [2, 10, 0, 'water'], [2, 11, 0, 'air'],
        [3, 9, 0, 'water'], [3, 10, 0, 'water'], [3, 11, 0, 'air'],
    ]);
    const r = pickDismountPoint(blockAt, { x: 0, y: 10, z: 0 }, { dx: 1, dz: 0 });
    check('no shore in reach refuses', r.dismount, false);
    check('...names itself', r.reason, 'no shore in reach');
}

{
    // Every candidate shore is lava, not water - must refuse, and say so specifically. maxRise:0
    // keeps this to the immediate shoreline; the "air above the lava floor" cells would
    // otherwise double as a legitimate rise-1 landing one block up, which is a different test.
    const blockAt = worldOf([
        [1, 9, 0, 'lava'], [1, 10, 0, 'air'], [1, 11, 0, 'air'],
        [2, 9, 0, 'lava'], [2, 10, 0, 'air'], [2, 11, 0, 'air'],
        [3, 9, 0, 'lava'], [3, 10, 0, 'air'], [3, 11, 0, 'air'],
    ]);
    const r = pickDismountPoint(blockAt, { x: 0, y: 10, z: 0 }, { dx: 1, dz: 0 }, { maxRise: 0 });
    check('lava shore refuses', r.dismount, false);
    check('...names itself as lava, not generic', r.reason.includes('lava'), true);
}

{
    // Prefers the LOWEST dry cell over a same-distance one requiring a rise, and unloaded chunks
    // (undefined) never count as a landing.
    const blockAt = worldOf([
        // n=1: unloaded (nothing here) - must be skipped, not treated as dry air.
        // n=1 at rise 1: a real dry cell, but rise-1.
        [1, 10, 0, 'sand'], [1, 11, 0, 'air'], [1, 12, 0, 'air'],
        // n=2 at rise 0: a real dry cell, closer to the boat's own level.
        [2, 9, 0, 'sand'], [2, 10, 0, 'air'], [2, 11, 0, 'air'],
    ]);
    const r = pickDismountPoint(blockAt, { x: 0, y: 10, z: 0 }, { dx: 1, dz: 0 }, { maxRise: 1 });
    check('rise is searched before distance - a same-or-lower cell wins even if farther',
        [r.dismount, r.y], [true, 10]);
}

check('no bearing at all refuses', pickDismountPoint(() => 'sand', { x: 0, y: 10, z: 0 }, { dx: 0, dz: 0 }).dismount, false);

// =================================================================================================
// openWaterRun — how far the water extends, injected reader
// =================================================================================================
{
    // 50 blocks of water then land.
    const entries = [];
    for (let n = 1; n <= 50; n++) entries.push([n, 62, 0, 'water']);
    entries.push([51, 62, 0, 'sand']);
    const blockAt = worldOf(entries);
    const r = openWaterRun(blockAt, 0, 0, 62, 1, 0, 96);
    check('measures the run length', r.run, 50);
    check('reports hitting land', r.hitLand, true);
    check('no lava seen', r.lava, false);
}

{
    // Water, then lava at block 10 - must stop and flag it, not just count past it.
    const entries = [];
    for (let n = 1; n <= 9; n++) entries.push([n, 62, 0, 'water']);
    entries.push([10, 62, 0, 'lava']);
    const blockAt = worldOf(entries);
    const r = openWaterRun(blockAt, 0, 0, 62, 1, 0, 96);
    check('run stops before the lava', r.run, 9);
    check('lava flagged', r.lava, true);
    check('lava distance recorded', r.lavaAt, 10);
}

{
    // Open ocean: water all the way out to the look cap, never resolving to land.
    const entries = [];
    for (let n = 1; n <= 96; n++) entries.push([n, 62, 0, 'water']);
    const blockAt = worldOf(entries);
    const r = openWaterRun(blockAt, 0, 0, 62, 1, 0, 96);
    check('caps at maxLook without claiming to have found land', r.hitLand, false);
    check('run equals the cap', r.run, 96);
}

check('an unloaded first cell ends the run immediately rather than counting as water',
    openWaterRun(() => undefined, 0, 0, 62, 1, 0, 96).run, 0);
check('no heading given', openWaterRun(() => 'water', 0, 0, 62, 0, 0, 96).hitLand, true);

// =================================================================================================
// formatBoatOutcome — never abandon the boat item
// =================================================================================================
check('retrieved formats as a success line',
    formatBoatOutcome({ boat: 'retrieved' }).includes('retrieved'), true);
check('kept_at formats with coordinates',
    formatBoatOutcome({ boat: { kind: 'kept_at', x: 12, z: -8 } }).includes('12') &&
    formatBoatOutcome({ boat: { kind: 'kept_at', x: 12, z: -8 } }).includes('-8'), true);

// THE outcome this function exists to police: a boat left unaccounted for must be an error, not
// a silently-returned success string.
throws('lost boat throws rather than returning a success string',
    () => formatBoatOutcome({ boat: { kind: 'lost', reason: 'entity despawned mid-crossing' } }));
{
    let threwWithReason = false;
    try { formatBoatOutcome({ boat: { kind: 'lost', reason: 'sank in a rapid' } }); }
    catch (e) { threwWithReason = e.message.includes('sank in a rapid'); }
    check('lost boat throw carries the reason', threwWithReason, true);
}
throws('an outcome with no boat field at all throws', () => formatBoatOutcome({ summary: 'arrived' }));
throws('an outcome that is just missing throws', () => formatBoatOutcome({}));
throws('a malformed kept_at (no coordinates) throws rather than guessing',
    () => formatBoatOutcome({ boat: { kind: 'kept_at' } }));

console.log(failures === 0 ? 'boat: all checks passed' : `boat: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
