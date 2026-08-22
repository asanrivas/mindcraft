/**
 * Pure tests for the swimming primitives. No server, no bot:
 *   bun tests/swim.test.mjs
 *
 * Two of these are regressions for bugs that already exist in this codebase's history:
 *
 *   - `water_cauldron` must not be swimmable. nav.js classified anything whose name CONTAINED
 *     "water" as a river, which is the same substring mistake that made `sandstone` a falling
 *     block and froze the agent on mode:self_preservation for 11 minutes.
 *   - An unloaded chunk (`blockAt` -> null) must read as BLOCKED, never as air. Treating unknown
 *     as air is how a bot swims confidently into a ceiling it cannot see.
 */
import { isWaterName, isSwimmable, isLavaName, isBubbleColumn } from '../src/agent/library/tools.js';
import { verticalIntent, airPocketAbove, waterSurfaceY, nearestOpenColumn, oxygen }
    from '../src/agent/library/swim.js';
import { verdictFor } from '../src/agent/library/swim_probe.js';
import { swimCostFor, WATER_CLASS, SOLID_CLASS, AIR_CLASS, UNKNOWN_CLASS, HAZARD_CLASS as HZ }
    from '../src/agent/library/nav.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- classifiers -----------------------------------------------------------------------------
const WATER_CASES = [
    ['water', true],
    ['flowing_water', true],
    // THE regression. A cauldron is not a river.
    ['water_cauldron', false],
    ['waterlily', false],
    ['lily_pad', false],
    ['seagrass', false],   // swimmable, but not water itself
    ['sandstone', false],
    ['', false],
    [null, false],
    [undefined, false],
];
for (const [n, want] of WATER_CASES) check(`isWaterName(${JSON.stringify(n)})`, isWaterName(n), want);

const SWIM_CASES = [
    ['water', true],
    ['flowing_water', true],
    ['seagrass', true],
    ['tall_seagrass', true],
    ['kelp', true],
    ['kelp_plant', true],

    ['water_cauldron', false],
    ['bubble_column', false],   // a lift, not swimmable water - it steers the bot for you
    ['lily_pad', false],
    ['ice', false],
    ['powder_snow', false],
    ['air', false],
    [null, false],
];
for (const [n, want] of SWIM_CASES) check(`isSwimmable(${JSON.stringify(n)})`, isSwimmable(n), want);

const LAVA_CASES = [
    ['lava', true],
    ['flowing_lava', true],
    ['lava_cauldron', false],   // hazard by other means, but not a lava lake
    ['obsidian', false],
    ['magma_block', false],
    [null, false],
];
for (const [n, want] of LAVA_CASES) check(`isLavaName(${JSON.stringify(n)})`, isLavaName(n), want);

check('isBubbleColumn(bubble_column)', isBubbleColumn('bubble_column'), true);
check('isBubbleColumn(water)', isBubbleColumn('water'), false);

// --- vertical hysteresis ---------------------------------------------------------------------
// Rising is 7x faster than sinking, so a controller without a dead band overshoots every cycle
// and the bot porpoises. These pin the band and the no-chatter property.
const VERT_CASES = [
    // [y, targetY, prev, expected]
    [60, 64, 'hold', 'up'],       // well below
    [68, 64, 'hold', 'down'],     // well above
    [64, 64, 'hold', 'hold'],     // dead on
    [64.2, 64, 'hold', 'hold'],   // inside the band, no prior intent -> do nothing
    [63.8, 64, 'hold', 'hold'],
    // inside the band WITH a prior intent: keep going until the centre line is crossed
    [63.9, 64, 'up', 'up'],
    [64.1, 64, 'up', 'hold'],     // crossed the centre while rising -> stop
    [64.1, 64, 'down', 'down'],
    [63.9, 64, 'down', 'hold'],   // crossed the centre while sinking -> stop
];
for (const [y, t, prev, want] of VERT_CASES) {
    check(`verticalIntent(${y}, ${t}, prev=${prev})`, verticalIntent(y, t, 0.35, prev), want);
}

// --- geometry against a fake bot --------------------------------------------------------------
/**
 * @param {Record<string, string|null>} columns key "x,z" -> string of block names bottom-up from
 *        y=60, using 'w' water, 'a' air, 'I' packed_ice, 'G' glass, '?' unloaded (blockAt null).
 */
function fakeBot(columns, pos = { x: 0, y: 62, z: 0 }) {
    const LETTER = { w: 'water', a: 'air', I: 'packed_ice', G: 'glass', s: 'stone', k: 'kelp' };
    return {
        entity: {
            position: {
                x: pos.x, y: pos.y, z: pos.z,
                floored: () => ({
                    x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
                    offset(dx, dy, dz) { return { x: this.x + dx, y: this.y + dy, z: this.z + dz }; },
                }),
            },
        },
        blockAt(p) {
            const col = columns[`${p.x},${p.z}`];
            if (col === undefined) return null;           // unloaded
            const ch = col[p.y - 60];
            if (ch === undefined || ch === '?') return null;
            return { name: LETTER[ch] ?? 'stone' };
        },
    };
}

{   // open column: water up to 64, air above
    const bot = fakeBot({ '0,0': 'wwwwwaaaa' });
    const r = airPocketAbove(bot, 0, 0, 62);
    check('airPocketAbove open .blocked', r.blocked, false);
    check('airPocketAbove open .y', r.y, 65);
    check('waterSurfaceY open', waterSurfaceY(bot, 0, 0, 62), 65);
}
{   // capped by packed ice
    const bot = fakeBot({ '0,0': 'wwwwwIaaa' });
    const r = airPocketAbove(bot, 0, 0, 62);
    check('airPocketAbove ice .blocked', r.blocked, true);
    check('airPocketAbove ice .blocker', r.blocker, 'packed_ice');
    check('waterSurfaceY ice', waterSurfaceY(bot, 0, 0, 62), null);
}
{   // capped by glass
    const bot = fakeBot({ '0,0': 'wwwwwGaaa' });
    check('airPocketAbove glass .blocker', airPocketAbove(bot, 0, 0, 62).blocker, 'glass');
}
{   // kelp is not a ceiling - the bot swims straight through it
    const bot = fakeBot({ '0,0': 'wwwkkkaaa' });
    check('airPocketAbove through kelp .y', airPocketAbove(bot, 0, 0, 62).y, 66);
}
{   // deeper than maxRise: must terminate, not loop
    const deep = 'w'.repeat(80);
    const bot = fakeBot({ '0,0': deep }, { x: 0, y: 60, z: 0 });
    const r = airPocketAbove(bot, 0, 0, 60, 24);
    check('airPocketAbove too deep .blocked', r.blocked, true);
    check('airPocketAbove too deep .blocker', r.blocker, 'too_deep');
}
{   // THE regression: an unloaded chunk is blocked, never air
    const bot = fakeBot({ '0,0': 'ww?wwaaa' });
    const r = airPocketAbove(bot, 0, 0, 60);
    check('airPocketAbove unloaded .blocked', r.blocked, true);
    check('airPocketAbove unloaded .blocker', r.blocker, 'unloaded');
}
{   // a column that is not in the map at all is also blocked
    const bot = fakeBot({ '0,0': 'wwwww' });
    check('airPocketAbove missing column', airPocketAbove(bot, 9, 9, 62).blocked, true);
}

{   // under ice, with one open column two blocks east
    const bot = fakeBot({
        '0,0': 'wwwwwIaa',
        '1,0': 'wwwwwIaa',
        '2,0': 'wwwwwaaa',
        '0,1': 'wwwwwIaa',
    });
    const open = nearestOpenColumn(bot, 6);
    check('nearestOpenColumn found', open !== null, true);
    check('nearestOpenColumn x', open && Math.floor(open.pos.x), 2);
    check('nearestOpenColumn z', open && Math.floor(open.pos.z), 0);
}
{   // fully sealed: must return null rather than an unreachable guess
    const bot = fakeBot({
        '0,0': 'wwwwwIaa', '1,0': 'wwwwwIaa', '-1,0': 'wwwwwIaa',
        '0,1': 'wwwwwIaa', '0,-1': 'wwwwwIaa',
    });
    check('nearestOpenColumn sealed', nearestOpenColumn(bot, 3), null);
}

// --- probe decision rule ----------------------------------------------------------------------
// The threshold is 0.08 b/t = 1.6 blocks/s = 96 blocks/min, against ~25 blocks/min overland.
// Three of these encode things the first live run taught us, and each would have produced a
// wrong verdict under the naive rule:
//   - the fastest holdable control combination is the operative speed, not `fwd` alone
//   - forcedMove is meaningless without this server's idle baseline (it emitted 217 in 35s)
//   - depth 0 is walking; shallow-but-wet is still a valid HORIZONTAL measurement. The obvious
//     story - "1 block deep means it is standing on the bottom in the broken land physics" -
//     was measured and found false: the same water read 0.098 b/t on a clean run.
const VERDICTS = [
    [{ fwd: 0.098, depth: 4 }, 'swim'],
    [{ fwd: 0.080, depth: 4 }, 'swim'],
    [{ fwd: 0.060, depth: 4 }, 'neutral'],
    [{ fwd: 0.020, depth: 4 }, 'avoid'],

    // the fastest holdable combination wins, even when plain forward looks hopeless
    [{ fwd: 0.021, fwdJump: 0.121, depth: 4 }, 'swim'],
    // shallow but wet: still a valid horizontal number (measured live at depth 1)
    [{ fwd: 0.098, depth: 1 }, 'swim'],
    // dry: whatever was measured, it was not swimming
    [{ fwd: 0.098, depth: 0 }, 'invalid'],

    // rubber-banding is judged against the idle baseline, never as an absolute count
    [{ fwd: 0.098, depth: 4, forcedMoves: 217, baselineForced: 31 }, 'swim'],   // 31/phase idle -> normal
    [{ fwd: 0.098, depth: 4, forcedMoves: 217, baselineForced: 2 }, 'avoid'],   // 15x baseline -> rejected
    [{ fwd: 0.098, depth: 4, forcedMoves: 9, baselineForced: 0 }, 'swim'],      // no baseline, cannot judge

    // boost that made no difference should be reported, not silently shipped
    [{ fwd: 0.098, depth: 4, sprint: 0.098, boost26: 0.098, boost32: 0.098 }, 'swim'],

    [{ depth: 4 }, 'invalid'],
];
for (const [m, want] of VERDICTS) {
    check(`verdictFor(${JSON.stringify(m)})`, verdictFor(m).verdict, want);
}
check('verdictFor flags unmeasurable vertical in shallow water',
    verdictFor({ fwd: 0.098, depth: 1 }).reason.includes('vertical rates NOT measurable'), true);
check('verdictFor reports a dead boost',
    verdictFor({ fwd: 0.098, depth: 4, sprint: 0.098, boost26: 0.098, boost32: 0.098 })
        .reason.includes('boost had no effect'), true);
// A boost that worked in the 0.026 phase must NOT be written off because the 0.032 phase
// beached - this is the live run that produced 0.127 / 0.093 against a 0.098 baseline.
check('verdictFor judges the boost on its best phase',
    verdictFor({ fwd: 0.098, depth: 7, sprint: 0.098, boost26: 0.127, boost32: 0.093 })
        .reason.includes('boost had no effect'), false);

// --- oxygen ------------------------------------------------------------------------------------
// air_supply keeps counting DOWN past zero while drowning, which reached chat as "Air: -1 / 20".
check('oxygen clamps negatives to 0', oxygen({ oxygenLevel: -1 }), 0);
check('oxygen clamps far negatives', oxygen({ oxygenLevel: -14 }), 0);
check('oxygen passes normal values', oxygen({ oxygenLevel: 13 }), 13);
check('oxygen caps at 20', oxygen({ oxygenLevel: 25 }), 20);
check('oxygen defaults to full when unset', oxygen({}), 20);
check('oxygen survives a null bot', oxygen(null), 20);

// --- A* water cost model ----------------------------------------------------------------------
// THE regression: a cell in the middle of a river used to be charged waterCost TWICE - once for
// wet feet/head and again for the wet block below - so it cost 30 "blocks walked" and even a
// 6-wide river lost to a 60-block detour.
{
    const W = WATER_CLASS, S = SOLID_CLASS, A = AIR_CLASS, U = UNKNOWN_CLASS;
    const on = { swimEnabled: true, waterCost: 2, waterEntryCost: 6, unknownCost: 3 };
    const off = { swimEnabled: false, waterCost: 2, waterEntryCost: 6, unknownCost: 3 };

    // floating mid-river: wet feet, wet head, water below -> ONE charge, not three
    check('mid-river charged once', swimCostFor({ feet: W, head: W, below: W }, on), 2);
    // wading: wet feet, dry head, solid floor -> still one charge
    check('wading charged once', swimCostFor({ feet: W, head: A, below: S }, on), 2);
    // standing on the bank next to water is free
    check('dry land is free', swimCostFor({ feet: A, head: A, below: S }, on), 0);

    // the gate: with swimEnabled off, the old price applies unchanged
    check('gate off keeps the old price', swimCostFor({ feet: W, head: W, below: W }, off), 15);
    check('gate off, wading', swimCostFor({ feet: W, head: A, below: S }, off), 15);

    // impassable cases must stay impassable
    check('solid feet unreachable', swimCostFor({ feet: S, head: A, below: S }, on), null);
    check('solid head unreachable', swimCostFor({ feet: A, head: S, below: S }, on), null);
    check('hazard below unreachable', swimCostFor({ feet: A, head: A, below: HZ }, on), null);
    check('lava at feet unreachable', swimCostFor({ feet: HZ, head: A, below: S }, on), null);
    check('nothing underfoot', swimCostFor({ feet: A, head: A, below: A }, on), null);

    // unknown chunks still discourage, and still stack with water
    check('unknown underfoot', swimCostFor({ feet: A, head: A, below: U }, on), 3);
    check('wet and unknown', swimCostFor({ feet: U, head: W, below: W }, on), 5);

    // The numbers that decide a river vs a detour: 6 wet cells + one entry charge = 18,
    // which must beat walking 60 blocks around. Under the old double-charged 15 it was 180.
    const river = 6 * swimCostFor({ feet: W, head: W, below: W }, on) + on.waterEntryCost;
    check('a 6-wide river beats a 60-block detour', river < 60, true);
    const oldRiver = 6 * swimCostFor({ feet: W, head: W, below: W }, off) * 2;
    check('...which it did not before', oldRiver > 60, true);
    // ...but an ocean must still lose to any land route.
    check('a 500-wide ocean loses', 500 * swimCostFor({ feet: W, head: W, below: W }, on) > 500, true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: swim primitives correct');
