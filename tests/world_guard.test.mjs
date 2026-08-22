/**
 * Guards against destructive world edits. No server, no bot:
 *   bun tests/world_guard.test.mjs
 *
 * Every case below is a replay of something that actually happened on 2026-08-22, when two
 * unguarded edits cost the bot its bed, its respawn point, its inventory and two lives:
 *
 *   !serverSetblock("snow_block", -2572, 63, 5269)   -> overwrote its own bed
 *   !serverFill snow_block -2573 63 5268 -> -2571 65 5270   -> solid fill over its own body
 */
import { checkEdit, isProtectedName, isTrappingBlock, regionVolume, inRegion, isShellCell, cellFate }
    from '../src/agent/library/world_guard.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

// --- classifiers --------------------------------------------------------------------------
for (const [n, want] of [
    ['red_bed', true], ['white_bed', true], ['chest', true], ['furnace', true],
    ['crafting_table', true], ['ender_chest', true], ['spawner', true], ['beacon', true],
    ['oak_door', true], ['oak_sign', true], ['blue_shulker_box', true],
    // not protected: ordinary terrain must stay freely editable or the guard is an obstacle
    ['stone', false], ['snow_block', false], ['dirt', false], ['air', false],
    ['bedrock', false], ['water', false], [null, false], ['', false],
]) check(`isProtectedName(${n})`, isProtectedName(n), want);

for (const [n, want] of [
    ['stone', true], ['snow_block', true], ['sand', true],
    ['air', false], ['cave_air', false], ['water', false], ['flowing_water', false],
]) check(`isTrappingBlock(${n})`, isTrappingBlock(n), want);

// --- geometry -----------------------------------------------------------------------------
check('regionVolume 1x1x1', regionVolume({x:0,y:0,z:0}, {x:0,y:0,z:0}), 1);
check('regionVolume 3x3x3', regionVolume({x:0,y:0,z:0}, {x:2,y:2,z:2}), 27);
check('regionVolume unordered corners', regionVolume({x:2,y:2,z:2}, {x:0,y:0,z:0}), 27);
check('inRegion inside', inRegion({x:1,y:1,z:1}, {x:0,y:0,z:0}, {x:2,y:2,z:2}), true);
check('inRegion edge', inRegion({x:0,y:0,z:0}, {x:0,y:0,z:0}, {x:2,y:2,z:2}), true);
check('inRegion outside', inRegion({x:3,y:1,z:1}, {x:0,y:0,z:0}, {x:2,y:2,z:2}), false);

const emptyWorld = () => 'stone';

// --- THE BED CASE: the setblock that started the death spiral --------------------------------
{
    const world = (x, y, z) => (x === -2572 && y === 63 && z === 5269) ? 'red_bed' : 'air';
    const r = checkEdit({
        a: { x: -2572, y: 63, z: 5269 }, b: { x: -2572, y: 63, z: 5269 },
        blockType: 'snow_block', getName: world,
    });
    check('bed overwrite refused', r.ok, false);
    check('bed overwrite names the block', r.protectedHits[0].name, 'red_bed');
    check('bed overwrite reason mentions it', /red_bed/.test(r.reason), true);
}
{
    // Same bed, but destroyed as collateral inside a bigger fill - the more insidious version.
    const world = (x, y, z) => (x === -2572 && y === 63 && z === 5269) ? 'red_bed' : 'air';
    const r = checkEdit({
        a: { x: -2575, y: 63, z: 5267 }, b: { x: -2571, y: 65, z: 5271 },
        blockType: 'air', getName: world,
    });
    check('bed inside a big fill refused', r.ok, false);
}

// --- THE ENTOMBMENT CASE: solid fill over the bot's own body ---------------------------------
{
    const r = checkEdit({
        a: { x: -2573, y: 63, z: 5268 }, b: { x: -2571, y: 65, z: 5270 },
        blockType: 'snow_block', getName: emptyWorld,
        botPos: { x: -2572.2, y: 63.0, z: 5268.3 },
    });
    check('self-entombment refused', r.ok, false);
    check('entombs flagged', r.entombs, true);
}
{
    // Head-only overlap still buries you.
    const r = checkEdit({
        a: { x: 0, y: 65, z: 0 }, b: { x: 2, y: 65, z: 2 },
        blockType: 'stone', getName: emptyWorld,
        botPos: { x: 1.5, y: 64.0, z: 1.5 },   // feet 64, head 65
    });
    check('head-cell entombment refused', r.ok, false);
}
{
    // Hollowing AROUND yourself is fine - air does not trap.
    const r = checkEdit({
        a: { x: 0, y: 64, z: 0 }, b: { x: 2, y: 66, z: 2 },
        blockType: 'air', getName: emptyWorld,
        botPos: { x: 1.5, y: 64.0, z: 1.5 },
    });
    check('air fill around self allowed', r.ok, true);
}
{
    // Water does not trap either - the bot swims.
    const r = checkEdit({
        a: { x: 0, y: 64, z: 0 }, b: { x: 2, y: 66, z: 2 },
        blockType: 'water', getName: emptyWorld,
        botPos: { x: 1.5, y: 64.0, z: 1.5 },
    });
    check('water fill around self allowed', r.ok, true);
}
{
    // Building a wall somewhere else is emphatically allowed.
    const r = checkEdit({
        a: { x: 50, y: 64, z: 50 }, b: { x: 60, y: 70, z: 60 },
        blockType: 'stone', getName: emptyWorld,
        botPos: { x: 1.5, y: 64.0, z: 1.5 },
    });
    check('unrelated fill allowed', r.ok, true);
}

// --- THE SPAWN CASE: silent until the next death ---------------------------------------------
{
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 68, z: 20 },
        blockType: 'stone', getName: emptyWorld,
        spawnPos: { x: 15, y: 64, z: 15 },
    });
    check('spawn overwrite refused', r.ok, false);
    check('spawn flagged', r.hitsSpawn, true);
    check('spawn reason explains the cost', /world spawn/.test(r.reason), true);
}
{
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 68, z: 20 },
        blockType: 'stone', getName: emptyWorld,
        spawnPos: { x: 100, y: 64, z: 100 },
    });
    check('distant spawn unaffected', r.ok, true);
}

// --- oversized regions are reported, never silently "checked" ---------------------------------
{
    let reads = 0;
    const counting = () => { reads++; return 'stone'; };
    const r = checkEdit({
        a: { x: 0, y: 0, z: 0 }, b: { x: 199, y: 199, z: 199 },
        blockType: 'stone', getName: counting, maxScan: 4096,
    });
    check('oversized region not scanned', reads, 0);
    check('oversized flagged', r.oversized, true);
    check('oversized not silently refused', r.ok, true);
}

// --- UNLOADED CHUNKS: unknown must never read as safe -------------------------------------------
// Live catch: with the bot 200 blocks away the chunk was unloaded, blockAt returned null, and a
// setblock destroyed a bed the guard had refused from close range minutes earlier.
{
    const r = checkEdit({
        a: { x: 4527, y: 68, z: 4855 }, b: { x: 4527, y: 68, z: 4855 },
        blockType: 'snow_block', getName: () => null,
    });
    check('unloaded chunk refused', r.ok, false);
    check('unloaded counted', r.unknownCells, 1);
    check('unloaded reason is explicit', /cannot check that area/.test(r.reason), true);
}
{
    // A known protected hit still wins the message - it is the more specific answer.
    const world = (x) => (x === 5) ? 'red_bed' : null;
    const r = checkEdit({
        a: { x: 4, y: 0, z: 0 }, b: { x: 6, y: 0, z: 0 },
        blockType: 'stone', getName: world,
    });
    check('known bed beats unknown message', /red_bed/.test(r.reason), true);
}
{
    // Fully loaded ordinary terrain is untouched by this rule.
    const r = checkEdit({
        a: { x: 0, y: 0, z: 0 }, b: { x: 2, y: 0, z: 2 },
        blockType: 'stone', getName: emptyWorld,
    });
    check('loaded terrain still allowed', r.ok, true);
    check('no unknown cells', r.unknownCells, 0);
}

// --- FILL MODES: hollow paints the SHELL with blockType, not air ------------------------------
// Substituting 'air' for the whole region disabled the entombment check on exactly the fills
// that can bury the bot - the accident this guard exists to prevent.
check('shell cell detected', isShellCell({x:0,y:0,z:0}, {x:0,y:0,z:0}, {x:4,y:4,z:4}), true);
check('interior cell not shell', isShellCell({x:2,y:2,z:2}, {x:0,y:0,z:0}, {x:4,y:4,z:4}), false);
check('hollow shell gets blockType', cellFate({x:0,y:0,z:0}, {x:0,y:0,z:0}, {x:4,y:4,z:4}, 'hollow'), 'blockType');
check('hollow interior gets air', cellFate({x:2,y:2,z:2}, {x:0,y:0,z:0}, {x:4,y:4,z:4}, 'hollow'), 'air');
check('outline interior untouched', cellFate({x:2,y:2,z:2}, {x:0,y:0,z:0}, {x:4,y:4,z:4}, 'outline'), 'untouched');
check('replace everything gets blockType', cellFate({x:2,y:2,z:2}, {x:0,y:0,z:0}, {x:4,y:4,z:4}, 'replace'), 'blockType');

{
    // Bot standing ON the shell of its own hollow fill: encased in stone. Must refuse.
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 70, z: 20 },
        blockType: 'stone', getName: emptyWorld, mode: 'hollow',
        botPos: { x: 10.5, y: 64.0, z: 15.5 },      // x === x1 -> shell
    });
    check('hollow shell entombment refused', r.ok, false);
    check('hollow shell entombs flagged', r.entombs, true);
}
{
    // Bot in the INTERIOR of a hollow fill: interior becomes air. Perfectly safe, must allow.
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 70, z: 20 },
        blockType: 'stone', getName: emptyWorld, mode: 'hollow',
        botPos: { x: 15.5, y: 66.0, z: 15.5 },
    });
    check('hollow interior allowed', r.ok, true);
}
{
    // outline leaves the interior alone, so a bot in the middle must NOT be refused.
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 70, z: 20 },
        blockType: 'stone', getName: emptyWorld, mode: 'outline',
        botPos: { x: 15.5, y: 66.0, z: 15.5 },
    });
    check('outline interior allowed', r.ok, true);
}
{
    // ...and a protected block in an outline's untouched interior is not destroyed either.
    const world = (x, y, z) => (x === 15 && y === 66 && z === 15) ? 'chest' : 'stone';
    const r = checkEdit({
        a: { x: 10, y: 64, z: 10 }, b: { x: 20, y: 70, z: 20 },
        blockType: 'stone', getName: world, mode: 'outline',
    });
    check('outline spares interior chest', r.ok, true);
}

// --- the hit cap must break ALL loops, not just the innermost ----------------------------------
{
    const allBeds = () => 'red_bed';
    const r = checkEdit({
        a: { x: 0, y: 0, z: 0 }, b: { x: 29, y: 29, z: 29 },
        blockType: 'stone', getName: allBeds,
    });
    check('hit list capped at 8', r.protectedHits.length, 8);
    check('truncation flagged', r.truncated, true);
    check('refusal string stays short', r.reason.length < 600, true);
}

// --- oversized regions must WARN, not pass silently --------------------------------------------
{
    const r = checkEdit({
        a: { x: 0, y: 0, z: 0 }, b: { x: 199, y: 199, z: 199 },
        blockType: 'stone', getName: emptyWorld, maxScan: 4096,
    });
    check('oversized carries a warning', typeof r.warning === 'string' && r.warning.length > 0, true);
    check('warning says it was NOT checked', /NOT checked/.test(r.warning), true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: world edit guards correct');
