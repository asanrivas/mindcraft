/**
 * Pure-function tests for block classification. No server or bot needed:
 *   bun tests/tools.test.mjs
 *
 * These exist because both functions previously used SUBSTRING matching, and both were wrong in
 * the same way: "sandstone" contains "sand", but it neither falls under gravity nor wants a
 * shovel. That single mistake froze the agent on mode:self_preservation for 11 minutes in a
 * desert. Keep the anchored cases below - they are the regression.
 */
import { toolFor, isFallingBlockName, isTreeTrunk } from '../src/agent/library/tools.js';

const TOOL_CASES = [
    // the sandstone family is pickaxe work, NOT shovel work
    ['sandstone', 'pickaxe'],
    ['red_sandstone', 'pickaxe'],
    ['cut_sandstone', 'pickaxe'],
    ['smooth_sandstone', 'pickaxe'],
    ['chiseled_sandstone', 'pickaxe'],
    ['sandstone_stairs', 'pickaxe'],
    ['sandstone_slab', 'pickaxe'],
    ['stone', 'pickaxe'],
    ['deepslate', 'pickaxe'],

    ['sand', 'shovel'],
    ['red_sand', 'shovel'],
    ['gravel', 'shovel'],
    ['dirt', 'shovel'],
    ['grass_block', 'shovel'],
    ['white_concrete_powder', 'shovel'],
    ['soul_sand', 'shovel'],

    ['oak_log', 'axe'],
    ['spruce_planks', 'axe'],
    ['chest', 'axe'],

    ['oak_leaves', 'hoe'],
    ['hay_block', 'hoe'],
];

const FALL_CASES = [
    ['sand', true],
    ['red_sand', true],
    ['gravel', true],
    ['suspicious_sand', true],
    ['white_concrete_powder', true],
    ['anvil', true],
    ['damaged_anvil', true],
    ['dragon_egg', true],

    ['sandstone', false],
    ['red_sandstone', false],
    ['cut_sandstone', false],
    ['smooth_sandstone', false],
    ['sandstone_stairs', false],
    ['stone', false],
    ['air', false],
    ['', false],
    [null, false],
    [undefined, false],
];

const TREE_CASES = [
    ['oak_log', true],
    ['jungle_log', true],
    ['stripped_birch_log', true],
    ['acacia_wood', true],
    ['warped_stem', true],
    ['crimson_hyphae', true],
    ['mangrove_roots', true],
    ['bamboo', true],

    // leaves are NOT trunks - they are cheap to clear and often unavoidable in a canopy
    ['jungle_leaves', false],
    ['oak_planks', false],
    ['dirt', false],
    ['stone', false],
    [null, false],
];

let failures = 0;

for (const [name, want] of TOOL_CASES) {
    const got = toolFor(name);
    if (got !== want) {
        console.error(`FAIL toolFor(${JSON.stringify(name)}) = ${got}, expected ${want}`);
        failures++;
    }
}

for (const [name, want] of FALL_CASES) {
    const got = isFallingBlockName(name);
    if (got !== want) {
        console.error(`FAIL isFallingBlockName(${JSON.stringify(name)}) = ${got}, expected ${want}`);
        failures++;
    }
}

for (const [name, want] of TREE_CASES) {
    const got = isTreeTrunk(name);
    if (got !== want) {
        console.error(`FAIL isTreeTrunk(${JSON.stringify(name)}) = ${got}, expected ${want}`);
        failures++;
    }
}

const total = TOOL_CASES.length + FALL_CASES.length + TREE_CASES.length;
if (failures) {
    console.error(`\n${failures}/${total} cases FAILED`);
    process.exit(1);
}
console.log(`PASS: ${total}/${total} cases correct`);

// --- isCanopy ---------------------------------------------------------------------------------
// A leaf canopy is a ceiling for COLLISION but not for "am I under something". minecraft-data
// gives oak_leaves boundingBox 'block', so a naive overhead probe reads a bot standing under a
// tree as roofed - and climbToSurface would tower up through the canopy from open ground.
{
    const { isCanopy } = await import('../src/agent/library/tools.js');
    const c = (l, g, w) => { if (g !== w) { console.error(`FAIL ${l}: got ${g}`); process.exitCode = 1; } };
    c('oak leaves are canopy', isCanopy('oak_leaves'), true);
    c('cherry leaves are canopy', isCanopy('cherry_leaves'), true);
    c('flowering azalea leaves are canopy', isCanopy('flowering_azalea_leaves'), true);
    // Glass is a REAL roof - a greenhouse should not read as open sky.
    c('glass is not canopy', isCanopy('glass'), false);
    c('logs are not canopy', isCanopy('oak_log'), false);
    // Suffix, never includes: leaf_litter is ground cover. This file's own isFallingBlockName
    // exists because "sandstone".includes("sand") fired self_preservation every tick in a desert.
    c('leaf litter is not canopy', isCanopy('leaf_litter'), false);
    c('non-strings are not canopy', isCanopy(undefined), false);
    console.log('isCanopy: checks passed');
}
