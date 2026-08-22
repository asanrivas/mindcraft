/**
 * Branch mining safety and geometry. No server, no bot:
 *   bun tests/mining.test.mjs
 *
 * This module exists because `skills.collectBlock` cannot mine on this server and fails
 * SILENTLY - both of its routes to the ore go through mineflayer-pathfinder, which cannot move
 * this bot. Three live !collectBlocks calls produced zero output of any kind.
 *
 * The tests here are mostly about NOT killing the bot: every safety rule below has a real
 * incident behind it somewhere in this project.
 */
import { safeToBreak, isOreName, exposedOres, countItems, pickOpenDirection,
         formatMineReport, ORE_NAMES, DEFAULT_MINE_Y, STEP_NAV, MAX_STALLS } from '../src/agent/library/mining.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

/** Build the relative reader safeToBreak expects. `map` is keyed "dx,dy,dz". */
const reader = (self, map = {}) => (dx, dy, dz) =>
    (dx === 0 && dy === 0 && dz === 0) ? self : (map[`${dx},${dy},${dz}`] ?? 'stone');

// --- ore naming -------------------------------------------------------------------------------
check('plain ore', isOreName('diamond_ore'), true);
check('deepslate variant', isOreName('deepslate_diamond_ore'), true);
check('ancient debris counts', isOreName('ancient_debris'), true);
check('stone is not ore', isOreName('stone'), false);
check('a diamond BLOCK is not ore', isOreName('diamond_block'), false);
check('ore list has no duplicates', new Set(ORE_NAMES).size, ORE_NAMES.length);
check('mine depth is below sea level', DEFAULT_MINE_Y < 0, true);

// --- safety: the rules that keep the bot alive --------------------------------------------------
check('plain stone is safe', safeToBreak(reader('stone')).ok, true);

// Unloaded chunks are NEVER safe. Same invariant the world guard and swim code both had to learn:
// blockAt returning null means "I do not know", not "air".
check('unknown self is unsafe', safeToBreak(reader('unknown')).ok, false);
check('unknown neighbour is unsafe', safeToBreak(reader('stone', { '1,0,0': 'unknown' })).ok, false);
check('unknown says why', /unloaded/.test(safeToBreak(reader('unknown')).reason), true);

// Breaking into a lava lake floods the corridor and kills the bot.
for (const side of ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']) {
    check(`lava at ${side} blocks the dig`, safeToBreak(reader('stone', { [side]: 'lava' })).ok, false);
}
check('flowing lava also blocks', safeToBreak(reader('stone', { '0,0,1': 'flowing_lava' })).ok, false);
check('lava reason is named', safeToBreak(reader('stone', { '1,0,0': 'lava' })).reason, 'lava adjacent');

// Never dig the fluid itself.
check('lava self is unsafe', safeToBreak(reader('lava')).ok, false);
check('water self is unsafe', safeToBreak(reader('water')).ok, false);

// Gravel/sand above pours onto the bot's head the moment the support goes.
check('gravel above blocks the dig', safeToBreak(reader('stone', { '0,1,0': 'gravel' })).ok, false);
check('sand above blocks the dig', safeToBreak(reader('stone', { '0,1,0': 'sand' })).ok, false);
// The canonical isFallingBlockName lives in tools.js precisely because
// "sandstone".includes("sand") froze the agent for 11 minutes. Sandstone does NOT fall.
check('sandstone above is FINE', safeToBreak(reader('stone', { '0,1,0': 'sandstone' })).ok, true);

check('bedrock is unbreakable', safeToBreak(reader('bedrock')).ok, false);
check('bedrock names itself', safeToBreak(reader('bedrock')).reason, 'bedrock');
// 'bedrock'.includes('bed') is true - the third appearance of that bug class in this repo.
check('bedrock is not treated as a bed', isOreName('bedrock'), false);

// --- THE REGRESSION: single-block steps need sub-block arrival tolerances ---------------------------
// nav's goal defaults are arriveDist 2 and arriveY 1.25, which are correct for travelling
// somewhere and fatal for stepping one block: the target starts INSIDE the tolerance, so
// navigateTo returns arrived=true without moving. Observed live - a staircase from y=62 to y=52
// burned its entire 200-step budget in one second, never descended a block, and then reported
// "Returned to base". Do not relax these back toward the nav defaults.
check('step arriveDist is sub-block', STEP_NAV.arriveDist < 1, true);
check('step arriveY is sub-block', STEP_NAV.arriveY < 1, true);
check('step nav still allows digging', STEP_NAV.allowDig, true);
check('stall limit is small but not 1', MAX_STALLS >= 2 && MAX_STALLS <= 5, true);

// --- exposedOres: a local scan, not a 64-block search ---------------------------------------------
{
    const fakeBot = (blocks) => ({
        entity: { position: { floored: () => ({ x: 0, y: 0, z: 0,
            offset(dx, dy, dz) { return { x: dx, y: dy, z: dz }; } }) } },
        blockAt: (p) => {
            const n = blocks[`${p.x},${p.y},${p.z}`];
            return n === undefined ? { name: 'stone' } : (n === null ? null : { name: n });
        },
    });

    const ores = exposedOres(fakeBot({ '2,0,0': 'diamond_ore', '1,0,0': 'coal_ore' }), 3);
    check('finds the ores', ores.length, 2);
    check('nearest first', ores[0].name, 'coal_ore');
    check('reports the name', ores[1].name, 'diamond_ore');

    check('no ore -> empty', exposedOres(fakeBot({}), 2).length, 0);
    // An unloaded cell must not be mistaken for an ore or crash the scan.
    check('unloaded cells are skipped', exposedOres(fakeBot({ '1,0,0': null }), 1).length, 0);
    // Radius is honoured, so a distant read cannot drag the bot off the corridor.
    check('respects the radius', exposedOres(fakeBot({ '5,0,0': 'diamond_ore' }), 2).length, 0);
}

// --- direction choice ------------------------------------------------------------------------------
{
    const dirBot = (blocks) => ({
        entity: { position: { floored: () => ({ x: 0, y: 0, z: 0,
            offset(dx, dy, dz) { return { x: dx, y: dy, z: dz }; } }) } },
        blockAt: (p) => {
            const n = blocks[`${p.x},${p.y},${p.z}`];
            return n === undefined ? { name: 'stone' } : (n === null ? null : { name: n });
        },
    });
    // Open air in +x should win over solid rock elsewhere.
    const open = {};
    for (let i = 1; i <= 6; i++) open[`${i},0,0`] = 'air';
    const d = pickOpenDirection(dirBot(open));
    check('prefers the open direction', `${d.x},${d.z}`, '1,0');

    // Never tunnel toward lava, even if the rest of that direction is open.
    const lava = { ...open, '3,0,0': 'lava' };
    const d2 = pickOpenDirection(dirBot(lava));
    check('refuses a lava direction', `${d2.x},${d2.z}` === '1,0', false);
}

// --- inventory counting -------------------------------------------------------------------------------
{
    const bot = { inventory: { items: () => [
        { name: 'diamond', count: 3 }, { name: 'raw_iron', count: 10 }, { name: 'cobblestone', count: 64 },
    ] } };
    check('counts matching items', countItems(bot, ['diamond', 'raw_iron']), 13);
    check('ignores non-matching', countItems(bot, ['emerald']), 0);
    check('empty list is zero', countItems(bot, []), 0);
}

// --- the report line ------------------------------------------------------------------------------------
{
    const line = formatMineReport({
        minedY: -12, dug: 240, ores: 7, branches: 8, seconds: 421, gained: 19,
        oreNames: { deepslate_iron_ore: 4, deepslate_diamond_ore: 3 },
        returned: true, stopped: null,
    });
    check('starts with VERIFIED', line.startsWith('VERIFIED MINE:'), true);
    check('reports depth', /y=-12/.test(line), true);
    check('reports ore kinds', /diamond_orex3/.test(line), true);
    check('reports inventory delta', /inventory \+19/.test(line), true);
    check('confirms the return trip', /Returned to base/.test(line), true);
}
{
    // A failed return must be stated plainly - a bot that mines and cannot get home has produced
    // nothing, and that must not read as success.
    const line = formatMineReport({
        minedY: -12, dug: 10, ores: 0, branches: 0, seconds: 60, gained: 0,
        oreNames: {}, returned: false, distanceHome: 84, stopped: 'inventory full',
    });
    check('failed return is explicit', /NOT back at base \(84 blocks away\)/.test(line), true);
    check('stop reason is reported', /Stopped: inventory full/.test(line), true);
}
{
    // A run that dug NOTHING must not wear the VERIFIED badge. The first live run reported
    // "VERIFIED MINE ... Returned to base" while floating in a river having achieved nothing -
    // the same vacuous-success failure that hid collectBlock being broken for months.
    const nothing = formatMineReport({
        minedY: 62, dug: 0, ores: 0, branches: 2, seconds: 0, gained: 0,
        oreNames: {}, returned: true, stopped: null, descendStopped: 'no descent progress',
    });
    check('a no-op is not VERIFIED', /VERIFIED/.test(nothing), false);
    check('a no-op says it failed', nothing.startsWith('MINE FAILED'), true);
    check('a no-op explains the descent', /no descent progress/.test(nothing), true);

    const refused = formatMineReport({ refused: true, stopped: 'standing in water - move to dry land first' });
    check('a refusal is not VERIFIED', /VERIFIED/.test(refused), false);
    check('a refusal names the precondition', /standing in water/.test(refused), true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: mining safety and geometry correct');
