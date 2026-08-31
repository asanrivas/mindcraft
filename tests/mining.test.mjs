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
         formatMineReport, ORE_NAMES, DEFAULT_MINE_Y, STEP_NAV, MAX_STALLS,
         descentStepVerdict, descentDirectionScore, pickDescentDirection,
         depthDelta, depthAdvisory,
         DESCENT_PROBE, WORLD_BOTTOM_Y, BEDROCK_TOP_Y, DEEPEST_MINE_Y } from '../src/agent/library/mining.js';

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

// --- DESCENT: the decision layer the Y=-45 stall was missing -------------------------------------
//
// The incident: `staircaseDown` reported `no descent progress` at (4529,-45,4715) after digging
// ONE block in FOUR seconds, and the model answered that generic stall by freelancing `digDown`
// into the bedrock layer and oscillating there for ~2h. The staircase had walked into a cave its
// own air-preferring direction heuristic steered it toward, and it never once looked at the cell
// it was about to land on. These tests are the geometry, offline.

// Reader relative to the cell AHEAD at foot level. Default rock everywhere, so a fixture only
// states the cells that make its case.
const descentAt = (map = {}, fill = 'stone') => (dx, dy, dz) => map[`${dx},${dy},${dz}`] ?? fill;

{
    // The normal step: solid rock all round. A guard that refuses legitimate descent is WORSE
    // than the bug it fixes - the bot then cannot reach ore at all - so this case comes first.
    const v = descentStepVerdict(descentAt());
    check('solid rock descends', v.ok, true);
    check('and digs three cells', v.cells.length, 3);
    check('landing is reported', v.landing, 'stone');
    check('deepslate descends too', descentStepVerdict(descentAt({}, 'deepslate')).ok, true);

    // Half-dug ground (feet+head already air, floor solid, landing solid) is an ordinary step,
    // not a cave: only the floor needs breaking.
    const partial = descentStepVerdict(descentAt({ '0,0,0': 'air', '0,1,0': 'air' }));
    check('an open doorway with a floor still descends', partial.ok, true);
    check('and only digs what is there', partial.cells.length, 1);
}

{
    // THE BUG. The landing at (0,-2,0) is air: the step would hang over a cavity, every dig
    // returns 'skipped', and planPath has no move into a floorless column (nav.js: a level move
    // needs a standable cell, the drop scan needs ground within maxDrop, digCostAt needs
    // below===SOLID). That is how three stalls fit into four seconds.
    const v = descentStepVerdict(descentAt({ '0,-2,0': 'air' }));
    check('an open landing REFUSES', v.ok, false);
    check('and it is a turn, not a death', v.turn, true);
    check('and it names itself', v.reason, 'open landing');
    check('cave_air counts as open', descentStepVerdict(descentAt({ '0,-2,0': 'cave_air' })).ok, false);

    // A whole open column ahead is the cave mouth itself - same refusal, different sentence, so
    // the log distinguishes "ledge over a cavity" from "staring into a cave".
    const cave = descentStepVerdict(descentAt({
        '0,0,0': 'air', '0,1,0': 'air', '0,-1,0': 'cave_air', '0,-2,0': 'cave_air',
    }));
    check('an open column REFUSES', cave.ok, false);
    check('an open column turns', cave.turn, true);
    check('an open column names itself', cave.reason, 'no floor ahead');
}

{
    // Lava is never a survivable landing: a miss costs the bot AND its whole inventory, which is
    // why every verdict in nav.js refuses it outright instead of pricing it. Fatal rather than a
    // turn, because a lava lake does not end at a cell boundary - turning re-opens the same lake.
    const v = descentStepVerdict(descentAt({ '0,-2,0': 'lava' }));
    check('lava under the landing REFUSES', v.ok, false);
    check('lava is fatal, not a turn', v.turn, false);
    check('lava names itself', /lava/.test(v.reason), true);
    check('flowing lava too', descentStepVerdict(descentAt({ '0,-2,0': 'flowing_lava' })).ok, false);

    // Lava beside any cell we would break is safeToBreak's rule, and it still applies here.
    const side = descentStepVerdict(descentAt({ '0,1,1': 'lava' }));
    check('lava beside the head cell refuses', side.ok, false);
    check('lava beside is fatal', side.turn, false);
    check('lava beside says why', side.reason, 'lava adjacent');

    // Water is benign - the swim stack recovers from it - but a staircase into a flooded pocket
    // floods the staircase, so it turns rather than dying.
    const wet = descentStepVerdict(descentAt({ '0,-2,0': 'water' }));
    check('water under the landing refuses', wet.ok, false);
    check('water is a turn', wet.turn, true);
    check('water names itself', /water/.test(wet.reason), true);
}

{
    // Bedrock is where the incident ENDED. It cannot be broken, so the step is impossible; say so
    // instead of stalling generically and letting the model dig down for two hours.
    const v = descentStepVerdict(descentAt({ '0,-1,0': 'bedrock' }));
    check('bedrock in the floor REFUSES', v.ok, false);
    check('bedrock is fatal, not a turn', v.turn, false);
    check('bedrock names itself', v.reason, 'bedrock');
    // Standing ON bedrock is fine - it is only digging it that is not.
    check('bedrock as the landing is standable', descentStepVerdict(descentAt({ '0,-2,0': 'bedrock' })).ok, true);
}

{
    // Unloaded is never air and never rock. Guessing "air" below the landing is precisely how a
    // bot walks into a cave; guessing "solid" is how it walks off one.
    const below = descentStepVerdict(descentAt({ '0,-2,0': 'unknown' }));
    check('an unloaded landing refuses', below.ok, false);
    check('an unloaded landing is fatal', below.turn, false);
    check('an unloaded landing says why', /unloaded/.test(below.reason), true);
    check('an unloaded dig cell refuses', descentStepVerdict(descentAt({ '0,0,0': 'unknown' })).ok, false);
    check('an unloaded neighbour refuses', descentStepVerdict(descentAt({ '0,2,0': 'unknown' })).ok, false);
}

{
    // MUST NOT FIRE. Gravel above a dig cell is safeToBreak's job and still refuses; sandstone is
    // NOT a falling block, and treating it as one froze the agent for 11 minutes once already.
    check('gravel above the head cell refuses', descentStepVerdict(descentAt({ '0,2,0': 'gravel' })).ok, false);
    check('sandstone above is FINE', descentStepVerdict(descentAt({ '0,2,0': 'sandstone' })).ok, true);
    // An ore in the way is rock like any other - never a refusal.
    check('an ore in the floor still descends', descentStepVerdict(descentAt({ '0,-1,0': 'deepslate_diamond_ore' })).ok, true);
}

// --- direction: descent wants ROCK, a corridor wants AIR -----------------------------------------
{
    // Score reader: `at(step, dy)` along one bearing. Solid everywhere unless the fixture says so.
    const rayAt = (map = {}, fill = 'deepslate') => (i, dy) => map[`${i},${dy}`] ?? fill;

    check('solid rock scores positive', descentDirectionScore(rayAt()) > 0, true);
    // An open cavern: nothing to cut into and nothing to land on, the exact Y=-45 geometry.
    const open = {};
    for (let i = 1; i <= DESCENT_PROBE; i++) { open[`${i},${-(i - 1)}`] = 'cave_air'; open[`${i},${-i - 1}`] = 'cave_air'; }
    check('an open cavern scores negative', descentDirectionScore(rayAt(open)) < 0, true);
    check('rock beats air for a descent', descentDirectionScore(rayAt()) > descentDirectionScore(rayAt(open)), true);
    // A hollow floor alone is enough to lose: the landing is what the old code never checked.
    const hollow = {};
    for (let i = 1; i <= DESCENT_PROBE; i++) hollow[`${i},${-i - 1}`] = 'cave_air';
    check('a hollow floor scores below solid', descentDirectionScore(rayAt(hollow)) < descentDirectionScore(rayAt()), true);
    check('lava on the bearing is refused outright', descentDirectionScore(rayAt({ '3,-2': 'lava' })) < 0, true);
    check('unloaded on the bearing is refused', descentDirectionScore(rayAt({ '2,-1': 'unknown' })) < 0, true);
    // A bedrock wall is not a hazard, it is the end of the staircase in that bearing: it stops
    // the probe and costs the bearing its viability (score > 0 is what pickDescentDirection
    // requires), while bedrock far enough out still leaves usable steps in front of it.
    check('a near bedrock wall is not viable', descentDirectionScore(rayAt({ '2,-1': 'bedrock' })) <= 0, true);
    check('a bedrock wall scores below clear rock',
          descentDirectionScore(rayAt({ '2,-1': 'bedrock' })) < descentDirectionScore(rayAt()), true);
}

{
    // THE INVERSION, asserted on ONE fixture so the difference between the two heuristics IS the
    // test: +x is an open tunnel, -x is solid rock. A corridor wants the tunnel (nothing to dig);
    // a staircase wants the rock (something to cut a step into, and a floor to land on).
    const dirBot = (blocks) => ({
        entity: { position: { floored: () => ({ x: 0, y: 0, z: 0,
            offset(dx, dy, dz) { return { x: dx, y: dy, z: dz }; } }) } },
        blockAt: (p) => {
            const n = blocks[`${p.x},${p.y},${p.z}`];
            return n === undefined ? { name: 'deepslate' } : (n === null ? null : { name: n });
        },
    });
    const world = {};
    for (let i = 1; i <= 8; i++) for (let dy = -10; dy <= 2; dy++) world[`${i},${dy},0`] = 'cave_air';

    check('a corridor prefers the open bearing', `${pickOpenDirection(dirBot(world)).x},${pickOpenDirection(dirBot(world)).z}`, '1,0');
    const d = pickDescentDirection(dirBot(world));
    check('a descent picks a bearing', d !== null, true);
    check('a descent REFUSES the open bearing', `${d.x},${d.z}` === '1,0', false);
    check('a descent reports its score', d.score > 0, true);

    // exclude is what turn-on-stall passes: bearings already tried must not be re-picked.
    const first = pickDescentDirection(dirBot({}));
    const second = pickDescentDirection(dirBot({}), [first]);
    check('exclude is honoured', `${second.x},${second.z}` === `${first.x},${first.z}`, false);
    const all = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    check('all four excluded -> null', pickDescentDirection(dirBot({}), all), null);

    // Standing inside a cavern: every bearing is air, so there is no bearing to commit a descent
    // to. null here is what lets the caller say 'open cavern' instead of 'no descent progress'.
    const cavern = {};
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]])
        for (let i = 1; i <= 8; i++) for (let dy = -10; dy <= 2; dy++) cavern[`${dx*i},${dy},${dz*i}`] = 'cave_air';
    check('an open cavern has no descent bearing', pickDescentDirection(dirBot(cavern)), null);
    // ...and an unloaded world is not a cavern, but it is equally not somewhere to dig.
    const nullBot = {
        entity: { position: { floored: () => ({ x: 0, y: 0, z: 0,
            offset(dx, dy, dz) { return { x: dx, y: dy, z: dz }; } }) } },
        blockAt: () => null,
    };
    check('an unloaded world has no bearing', pickDescentDirection(nullBot), null);
}

// --- depth awareness: the "below target Y" primitive ---------------------------------------------
{
    // `check` compares strictly, so shapes are compared as JSON - the three shapes must stay
    // distinguishable, since a caller switching on them reads `at` as falsy otherwise.
    const shape = (o) => JSON.stringify(o);
    check('above the target', shape(depthDelta(20, -12)), '{"above":32}');
    check('below the target', shape(depthDelta(-61, -53)), '{"below":8}');
    check('at the target', shape(depthDelta(-12, -12)), '{"at":true}');
    check('fractional y is rounded, not truncated', shape(depthDelta(-11.6, -12)), '{"at":true}');
    check('a below delta is never negative', depthDelta(-64, 0).below > 0, true);
}

{
    // MUST NOT FIRE on the surface: $STATS is built from this, and an advisory on every prompt is
    // a tax on every turn. Same rule as the in-water and jump lines.
    check('silent at y=70', depthAdvisory(70), null);
    check('silent at y=5', depthAdvisory(5), null);
    check('silent at sea level', depthAdvisory(63), null);
    check('silent at y=0', depthAdvisory(0), null);

    const mid = depthAdvisory(-12);
    check('speaks underground', typeof mid === 'string' && mid.length > 0, true);
    // Monotone: it must never claim the bot is below a level it is above. From -12 the answer is
    // "keep going", and telling the model otherwise is what sent it digging into bedrock.
    check('never says BELOW when above', /below/i.test(mid), false);
    check('and names the floor it is heading for', new RegExp(`${DEEPEST_MINE_Y}`).test(mid), true);

    const deep = depthAdvisory(-58);
    check('speaks below the useful floor', /BELOW/.test(deep), true);
    check('and says the hard part', /dig UP/.test(deep), true);
    check('and counts the overshoot', /5 BELOW/.test(deep), true);

    // The layer the incident actually ended in.
    const rock = depthAdvisory(-61);
    check('names the bedrock layer', /bedrock layer/.test(rock), true);
    check('bedrock advice is to go UP', /dig UP/.test(rock), true);
    check('the world bottom is encoded', new RegExp(`${WORLD_BOTTOM_Y}`).test(rock), true);
    check('bedrock top is encoded', new RegExp(`${BEDROCK_TOP_Y}`).test(rock), true);
    check('the deepest useful level clears the bedrock noise', DEEPEST_MINE_Y > BEDROCK_TOP_Y, true);
    check('and the default mine depth is legal', DEFAULT_MINE_Y >= DEEPEST_MINE_Y, true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: mining safety, descent and depth geometry correct');
