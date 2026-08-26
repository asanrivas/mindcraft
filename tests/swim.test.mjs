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
import { verticalIntent, airPocketAbove, waterSurfaceY, nearestOpenColumn, oxygen, bankTargetAhead }
    from '../src/agent/library/swim.js';
import { Vec3 } from 'vec3';
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

// --- bankTargetAhead -------------------------------------------------------------------------
// The shoreline the marathon ground against: floating at (4264, 62, 4931), heading +x, with
// water at x+1 and a one-block bank at x+2 whose top face is y=63. The bot could see the land
// and had no move that would put it on top.
{
    const world = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    const put = (x, y, z, name) => world.set(key(x, y, z),
        { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' });
    // A 7-wide strip at the bot's feet level and below, mirroring the live slice.
    for (let x = 4261; x <= 4267; x++) {
        for (let y = 58; y <= 70; y++) put(x, y, 4931, 'air');
    }
    for (let x = 4261; x <= 4265; x++) for (let y = 58; y <= 62; y++) put(x, y, 4931, 'water');
    for (let x = 4266; x <= 4267; x++) for (let y = 58; y <= 62; y++) put(x, y, 4931, 'stone');

    const bot = {
        entity: { position: new Vec3(4264.89, 62.26, 4931.35) },
        blockAt: (v) => world.get(key(v.x, v.y, v.z)) ?? null,
    };
    const t = bankTargetAhead(bot, 1, 0);
    check('finds the bank top ahead', t && `${t.x},${t.y},${t.z}`, '4266,63,4931');

    // Backwards there is nothing but open water, so there is nothing to climb onto.
    check('no bank behind', bankTargetAhead(bot, -1, 0), null);

    // A bank taller than maxRise is not a step, it is a cliff - refuse rather than swim at it.
    check('a cliff is not a bank', bankTargetAhead(bot, 1, 0, { maxRise: 0 }), null);
    // ...and one further away than reach is somebody else's problem.
    check('out of reach', bankTargetAhead(bot, 1, 0, { reach: 1 }), null);

    // An unloaded chunk must read as blocked, never as air - same invariant as airPocketAbove.
    const blind = { entity: bot.entity, blockAt: () => null };
    check('unloaded chunk is not a bank', bankTargetAhead(blind, 1, 0), null);

    // A ledge with no headroom is not standable: solid floor, solid ceiling one above.
    put(4266, 64, 4931, 'stone');
    check('no headroom on the ledge means no bank', bankTargetAhead(bot, 1, 0, { maxRise: 0 }), null);
}

// The second shoreline, at (4279, 62, 4934): the bank due EAST is a two-block step, which a
// floating bot cannot climb - it can only swim as high as the water surface, and `onGround` is
// unusable here so there is no jump. Half a step to the SOUTH-EAST the same shore is a one-block
// step. The search has to look across the forward cone, and has to prefer the LOWER step to the
// straighter one, or it declares the whole shoreline impassable - which is what happened: four
// consecutive legs covering 0.0, 3.5, 2.0, 0.0 blocks.
{
    // Build the world from a heightmap: H(x,z) is the topmost solid y. Anything above it is air,
    // except the pond, which is water at y=62.
    const H = (x, z) => {
        if (z >= 4935) return 62;             // the low south shelf: a ONE-block step up
        if (x >= 4281) return 63;             // the east ridge: a TWO-block step up
        return 61;                            // the pond floor
    };
    let pondIsWater = true;
    const blockAt = (v) => {
        const h = H(v.x, v.z);
        if (v.y <= h) return { name: 'stone', boundingBox: 'block' };
        if (pondIsWater && h === 61 && v.y === 62) return { name: 'water', boundingBox: 'empty' };
        return { name: 'air', boundingBox: 'empty' };
    };
    const bot = { entity: { position: new Vec3(4280.00, 62.00, 4934.70) }, blockAt };

    const t = bankTargetAhead(bot, 1, 0);
    check('takes the one-block step in the cone, not the two-block step dead ahead',
        t && `${t.x},${t.y},${t.z}`, '4281,63,4935');

    // Straight-ahead-only search: the same shore now reads as a two-block scramble.
    const straight = bankTargetAhead(bot, 1, 0, { cone: false, maxRise: 3 });
    check('the two-block step is what lies straight ahead',
        straight === null || `${straight.x},${straight.y},${straight.z}`, '4281,64,4934');
    // ...and at the real default it is correctly reported as unclimbable rather than attempted.
    check('a two-block bank is refused, not attempted',
        bankTargetAhead(bot, 1, 0, { cone: false }), null);

    // A standable cell BEHIND A WALL is not a bank. This is the one that cost eight seconds a
    // leg: from (4280, 62, 4935) the search picked a real ledge three blocks east with two solid
    // blocks in between, and the bot swam into the wall reporting "gained 0.00".
    {
        const wall = (v) => {
            if (v.y <= 61) return { name: 'stone', boundingBox: 'block' };          // lake bed
            if (v.x === 4281 || v.x === 4282) {                                     // the 2-high wall
                return v.y <= 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
            }
            if (v.x === 4283) {                                                     // the ledge behind it
                return v.y <= 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
            }
            return v.y === 62 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' };
        };
        const walled = { entity: { position: new Vec3(4280.0, 62.0, 4935.0) }, blockAt: wall };
        check('a ledge behind a wall is not a bank', bankTargetAhead(walled, 1, 0), null);
    }

    // A LEVEL exit - dry ground at the same height as the water we are floating in - must win
    // over any step up, however straight ahead that step is.
    const level = bankTargetAhead(
        { entity: bot.entity, blockAt: (v) => (v.z >= 4935 && v.y <= 61) || (v.z < 4935 && v.x >= 4281 && v.y <= 63) || (v.z < 4935 && v.x < 4281 && v.y <= 61)
            ? { name: 'stone', boundingBox: 'block' }
            : (v.z < 4935 && v.x < 4281 && v.y === 62)
                ? { name: 'water', boundingBox: 'empty' }
                : { name: 'air', boundingBox: 'empty' } },
        1, 0);
    check('a level exit beats a step up', level && `${level.x},${level.y},${level.z}`, '4281,62,4935');
}

// --- flooding digs must be priced as the non-solution they are -------------------------------
// On land a dug block yields a path. At the waterline it yields WATER: the bot pays the effort
// and gains a longer swim, then repeats one block on. That is literally how it mined a canal
// across a lake. `floodDigCost` has to dominate `digCost` so a detour wins, while staying
// finite - a bot already in water must still be able to cut its way out as a last resort.
{
    const nav = await import('../src/agent/library/nav.js');
    const src = (await import('fs')).readFileSync(
        new URL('../src/agent/library/nav.js', import.meta.url), 'utf8');
    const num = (k) => Number((src.match(new RegExp(k + ':\\s*(\\d+)')) || [])[1]);
    check('floodDigCost exists', Number.isFinite(num('floodDigCost')), true);
    check('flooding digs cost more than ordinary ones', num('floodDigCost') > num('digCost'), true);
    check('...but are not infinite', num('floodDigCost') < 1000, true);
    check('the flood test checks all four neighbours and above',
        /\[1, 0\], \[-1, 0\], \[0, 1\], \[0, -1\]/.test(src) && /yy \+ 1/.test(src), true);
}


// --- swimTo must always yield a real macrotask ------------------------------------------------
// The regression that killed a live bot: followPlayer loops on swimTo while the player is in
// water, and swimTo's fast exits await nothing but `bot.look(..., force)` - which resolves
// without a timer or any I/O (mineflayer physics.js returns from the force branch before
// awaiting lookingTask, and returns even earlier when the look delta is zero). A loop of pure
// microtasks never lets the event loop reach its timer/IO phases, so the socket goes unread and
// the SERVER drops the client: "andy lost connection: Timed out", 70s into a follow. From the
// outside that is indistinguishable from the bot drowning.
//
// The test: schedule a timer, then run the fast path. If swimTo yields properly the timer fires
// before it resolves. If it only awaits microtasks, it does not.
{
    const { swimTo } = await import('../src/agent/library/swim.js');

    const at = (x, y, z) => new Vec3(x, y, z);
    const fakeBot = (overrides = {}) => ({
        interrupt_code: false,
        entity: {
            position: at(0, 64, 0),
            velocity: at(0, 0, 0),
            yaw: 0, pitch: 0,
            isInWater: true,
            isCollidedHorizontally: false,
        },
        // Resolves immediately, exactly like the real force-look.
        look: async () => {},
        setControlState: () => {},
        blockAt: () => ({ name: 'water', boundingBox: 'empty' }),
        ...overrides,
    });

    // Already inside `arrive`: swimTo returns 'arrived' on its first loop iteration.
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);
    const r = await swimTo(fakeBot(), at(0, 64, 0), { arrive: 1.5, timeoutMs: 5000 });
    check('the fast path still reports arrived', r.reason, 'arrived');
    check('...and yielded a macrotask on the way', timerFired, true);

    // The lava refusal returns before even the look. Same requirement.
    const lavaBot = fakeBot({ blockAt: () => ({ name: 'lava', boundingBox: 'empty' }) });
    lavaBot.entity.isInLava = true;
    let timerFired2 = false;
    setTimeout(() => { timerFired2 = true; }, 0);
    const r2 = await swimTo(lavaBot, at(0, 64, 0), { arrive: 1.5, timeoutMs: 5000 });
    check('lava is still refused', r2.reason.startsWith('lava'), true);
    check('...and the refusal yielded too', timerFired2, true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: swim primitives correct');
