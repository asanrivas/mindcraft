/**
 * Pure tech-tree resolver: wood -> stone -> iron -> diamond, over an inventory count map.
 * No bot, no network, no filesystem, no clock:
 *   bun tests/progression.test.mjs
 *
 * Task T5 of docs/gaps/resource-progression.exec.md. Scope is exactly `progression.js`'s pure
 * exports - no `progressTo` executor, no command, no live mcdata.
 */
import { resolveProgression, firstUnsatisfied, progressionTier, ORES, TOOL_GATES, MAX_MINE_DEPTH }
    from '../src/agent/library/progression.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};
const ok = (label, cond) => { if (!cond) { console.error(`FAIL ${label}`); failures++; } };

const kinds = (steps) => steps.map((s) => `${s.kind}:${s.item}`);
const indexOfStep = (steps, kind, item) => steps.findIndex((s) => s.kind === kind && s.item === item);

// --- empty inventory: must resolve to the wood step, not crash -------------------------------
{
    const r = resolveProgression('wooden_pickaxe', 1, {});
    ok('wooden_pickaxe from empty inv does not crash / errors', !r.error);
    check('wooden_pickaxe from empty inv is unsatisfied', r.satisfied, false);
    ok('wooden_pickaxe plan starts by collecting wood', kinds(r.steps).includes('collect:oak_log'));
    ok('wooden_pickaxe plan ends by crafting the pickaxe', r.steps[r.steps.length - 1].kind === 'craft'
        && r.steps[r.steps.length - 1].item === 'wooden_pickaxe');
}

// --- a full diamond kit resolves to nothing left, not a spurious next step --------------------
{
    const r = resolveProgression('diamond_pickaxe', 1, { diamond_pickaxe: 1 });
    check('full diamond kit: satisfied', r.satisfied, true);
    check('full diamond kit: no steps', r.steps.length, 0);
    ok('full diamond kit: no error', !r.error);
}

// --- exact-name discipline: unsmelted ore must NOT satisfy the ingot requirement --------------
{
    const rOre = resolveProgression('iron_ingot', 1, { iron_ore: 99 });
    check('iron_ore does not satisfy iron_ingot', rOre.satisfied, false);
    ok('iron_ingot plan still contains a smelt step', kinds(rOre.steps).includes('smelt:iron_ingot'));

    const rRaw = resolveProgression('iron_ingot', 1, { raw_iron: 99 });
    check('raw_iron alone does not satisfy iron_ingot', rRaw.satisfied, false);
    ok('iron_ingot plan (with raw_iron held) still smelts', kinds(rRaw.steps).includes('smelt:iron_ingot'));
    // But holding enough raw_iron should mean no MINE step is needed for it.
    ok('holding raw_iron skips the mine step', !kinds(rRaw.steps).includes('mine:raw_iron'));
    // Whereas raw_iron in the fixture above (iron_ore only) is NOT credited, so mining is still needed.
    ok('iron_ore does not stand in for raw_iron either', kinds(rOre.steps).includes('mine:raw_iron'));
}

// --- best-of-tier: wooden + diamond pickaxe together = diamond tier ---------------------------
{
    check('diamond alone is diamond tier', progressionTier({ diamond_pickaxe: 1 }), 'diamond');
    check('wooden + diamond together is still diamond tier (best-of)',
        progressionTier({ wooden_pickaxe: 1, diamond_pickaxe: 1 }), 'diamond');
    check('wooden alone is wood tier', progressionTier({ wooden_pickaxe: 1 }), 'wood');
    check('stone + wooden is stone tier (best-of, not first-found)',
        progressionTier({ wooden_pickaxe: 1, stone_pickaxe: 1 }), 'stone');
    check('nothing at all is bare', progressionTier({}), 'bare');
    check('unrelated items do not confer a tier', progressionTier({ oak_log: 64, cobblestone: 64 }), 'bare');
}

// --- partial counts: 2 of a required 3 is still unsatisfied -----------------------------------
{
    const steps = [{ kind: 'mine', item: 'raw_iron', count: 3 }];
    const u = firstUnsatisfied(steps, { raw_iron: 2 });
    ok('2 of 3 required is reported unsatisfied', u !== null);
    check('the reported step is the raw_iron one', u && u.item, 'raw_iron');

    const satisfied = firstUnsatisfied(steps, { raw_iron: 3 });
    check('3 of 3 required is satisfied (null)', satisfied, null);

    const over = firstUnsatisfied(steps, { raw_iron: 10 });
    check('more than required is also satisfied', over, null);
}

// --- firstUnsatisfied skips satisfied prefixes -------------------------------------------------
{
    const steps = [
        { kind: 'collect', item: 'oak_log', count: 2 },
        { kind: 'craft', item: 'oak_planks', count: 8 },
        { kind: 'craft', item: 'wooden_pickaxe', count: 1 },
    ];
    const u = firstUnsatisfied(steps, { oak_log: 2, oak_planks: 8 });
    ok('skips satisfied prefix', u !== null);
    check('lands on the first unmet step', u && u.item, 'wooden_pickaxe');
    check('a fully satisfied plan reports null', firstUnsatisfied(steps, { oak_log: 2, oak_planks: 8, wooden_pickaxe: 1 }), null);
    check('empty steps array is trivially satisfied', firstUnsatisfied([], {}), null);
}

// --- the chain must not skip a tier the bot cannot actually harvest with its current tool ------
{
    // Bare-handed request for diamond: every gate must appear, in order, none skipped.
    const r = resolveProgression('diamond_pickaxe', 1, {});
    check('bare-handed diamond request is unsatisfied', r.satisfied, false);
    const iWooden = indexOfStep(r.steps, 'craft', 'wooden_pickaxe');
    const iStone = indexOfStep(r.steps, 'craft', 'stone_pickaxe');
    const iIron = indexOfStep(r.steps, 'craft', 'iron_pickaxe');
    const iDiamondMine = indexOfStep(r.steps, 'mine', 'diamond');
    const iDiamondCraft = indexOfStep(r.steps, 'craft', 'diamond_pickaxe');
    ok('wooden_pickaxe step present', iWooden >= 0);
    ok('stone_pickaxe step present', iStone >= 0);
    ok('iron_pickaxe step present', iIron >= 0);
    ok('diamond mine step present', iDiamondMine >= 0);
    ok('diamond craft step present', iDiamondCraft >= 0);
    ok('wooden precedes stone', iWooden < iStone);
    ok('stone precedes iron', iStone < iIron);
    ok('iron precedes the diamond MINE step (cannot harvest diamond without it)', iIron < iDiamondMine);
    ok('diamond mine precedes the diamond craft', iDiamondMine < iDiamondCraft);

    // Already holding a stone_pickaxe: wood/stone crafts must NOT reappear, but iron still must
    // be inserted before the diamond mine step - the tier the bot cannot yet harvest.
    const r2 = resolveProgression('diamond_pickaxe', 1, { stone_pickaxe: 1 });
    ok('stone_pickaxe already held: no wooden_pickaxe craft re-appears',
        indexOfStep(r2.steps, 'craft', 'wooden_pickaxe') === -1);
    ok('stone_pickaxe already held: no stone_pickaxe craft re-appears',
        indexOfStep(r2.steps, 'craft', 'stone_pickaxe') === -1);
    const i2Iron = indexOfStep(r2.steps, 'craft', 'iron_pickaxe');
    const i2DiamondMine = indexOfStep(r2.steps, 'mine', 'diamond');
    ok('iron_pickaxe still inserted (cannot mine diamond with stone tier)', i2Iron >= 0);
    ok('iron_pickaxe precedes the diamond mine step', i2Iron >= 0 && i2Iron < i2DiamondMine);

    // Cobblestone (needed for stone_pickaxe) is itself tool-gated on wooden_pickaxe.
    const r3 = resolveProgression('stone_pickaxe', 1, {});
    const i3Wooden = indexOfStep(r3.steps, 'craft', 'wooden_pickaxe');
    const i3Cobble = indexOfStep(r3.steps, 'mine', 'cobblestone');
    ok('wooden_pickaxe crafted before cobblestone is mined', i3Wooden >= 0 && i3Cobble >= 0 && i3Wooden < i3Cobble);
}

// --- must NOT fire: already-held ore/tool means no redundant step ------------------------------
{
    const rHeld = resolveProgression('raw_iron', 5, { raw_iron: 5 });
    check('already holding enough raw_iron: satisfied', rHeld.satisfied, true);
    check('already holding enough raw_iron: no steps', rHeld.steps.length, 0);

    const rTable = resolveProgression('wooden_pickaxe', 1, { crafting_table: 1, oak_planks: 8, stick: 4 });
    ok('crafting_table already held: no craft:crafting_table step', indexOfStep(rTable.steps, 'craft', 'crafting_table') === -1);
    ok('materials already held: no more oak_log collection needed', indexOfStep(rTable.steps, 'collect', 'oak_log') === -1);

    // An iron_pickaxe plan must contain no diamond-tier step at all.
    const rIron = resolveProgression('iron_pickaxe', 1, {});
    ok('iron_pickaxe plan has no diamond craft step', indexOfStep(rIron.steps, 'craft', 'diamond_pickaxe') === -1);
    ok('iron_pickaxe plan has no diamond mine step', indexOfStep(rIron.steps, 'mine', 'diamond') === -1);
}

// --- unknown item: an error, never a throw, never a spuriously-satisfied plan -------------------
{
    let threw = false;
    let r;
    try { r = resolveProgression('unobtainium_widget', 1, {}); } catch (e) { threw = true; }
    check('unknown item does not throw', threw, false);
    ok('unknown item reports an error', typeof r.error === 'string' && r.error.length > 0);
    check('unknown item is not satisfied', r.satisfied, false);
    check('unknown item yields no steps', r.steps.length, 0);

    // Even if the (nonsensical) item name happens to already be "held", unknown is still an error.
    const r2 = resolveProgression('unobtainium_widget', 1, { unobtainium_widget: 99 });
    ok('unknown item errors even when the count map has that key', typeof r2.error === 'string');
}

// --- malformed input is handled, not thrown -----------------------------------------------------
{
    let threw = false;
    try { resolveProgression('', 1, {}); resolveProgression(null, 1, {}); resolveProgression(undefined, 1, {}); }
    catch (e) { threw = true; }
    check('empty/null/undefined target does not throw', threw, false);
    check('empty target reports an error', typeof resolveProgression('', 1, {}).error, 'string');
    check('a bogus count (0) is treated as 1, not a crash',
        resolveProgression('wooden_pickaxe', 0, {}).satisfied, false);
}

// --- injected deps: a caller can extend/override the tables without editing this module ---------
{
    const deps = { ores: { emerald: { blocks: ['emerald_ore'], targetY: 10, tool: 'iron_pickaxe' } } };
    const r = resolveProgression('emerald', 1, {}, deps);
    ok('injected ore fixture resolves without touching the built-in tables', !r.error);
    ok('injected ore triggers the iron_pickaxe gate', indexOfStep(r.steps, 'craft', 'iron_pickaxe') >= 0);
    ok('injected ore produces its own mine step', indexOfStep(r.steps, 'mine', 'emerald') >= 0);
    // Built-in tables are untouched by the previous call.
    ok('built-in ORES table unaffected by injected deps', !ORES.emerald);
}

// --- ORES / TOOL_GATES sanity ---------------------------------------------------------------
{
    check('TOOL_GATES has the four pickaxe tiers', TOOL_GATES.length, 4);
    for (const tool of TOOL_GATES) {
        ok(`${tool} ends in _pickaxe`, tool.endsWith('_pickaxe'));
    }
    for (const [name, ore] of Object.entries(ORES)) {
        ok(`${name}: tool is one of TOOL_GATES`, TOOL_GATES.includes(ore.tool));
        ok(`${name}: has at least one block source`, Array.isArray(ore.blocks) && ore.blocks.length > 0);
        ok(`${name}: targetY does not go below the bedrock-noise floor`, ore.targetY >= MAX_MINE_DEPTH);
    }
    check('diamond is clamped to the documented floor', ORES.diamond.targetY, MAX_MINE_DEPTH);
}

// --- steps never contain a bare substring-matched name (regression for the sandstone-class bug) -
{
    // A fixture designed to trip a substring matcher: holding "iron_pickaxe_head" (a decoy that
    // contains "iron_pickaxe" as a substring) must NOT be read as holding an iron_pickaxe.
    const r = resolveProgression('iron_pickaxe', 1, { iron_pickaxe_head: 99 });
    check('a decoy item containing the target name as a substring does not satisfy it', r.satisfied, false);
    ok('the plan still crafts the real iron_pickaxe', indexOfStep(r.steps, 'craft', 'iron_pickaxe') >= 0);

    // And the reverse: holding the four pickaxe tiers must be read by exact tier, not because
    // every one of them contains the substring "pickaxe".
    check('holding only a wooden_pickaxe (which contains "pickaxe") reads as wood tier, not diamond',
        progressionTier({ wooden_pickaxe: 1 }), 'wood');
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: progression resolver (pure tech-tree state machine) correct');
