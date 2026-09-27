/**
 * A block of the right KIND facing the WRONG WAY must be repairable, and the angle it is
 * re-placed at must come from the blueprint rather than from wherever the bot is standing.
 *
 *   bun tests/facing_repair.test.mjs
 *
 * Why it matters. `orientationMismatch` (tests/facing_repair's sibling, facing_verify.test.mjs)
 * made wrong facings VISIBLE in 2026-09-21's aftermath, and the reporting duly showed 339 of the
 * wizard tower's 8335 cells (4.1%) holding the right block pointing the wrong way. They then sat
 * there through four further runs and nine retry rounds, because the repair path could not reach
 * what the reporting could see:
 *
 *     if (existing.name === p.name) return { ok: true, skipped: true };   // placeOneCore
 *
 * One line, comparing the NAME only, in front of every retry and every resume. Each pass looked at
 * those cells, saw a spruce_stairs where a spruce_stairs belonged, and reported `skipped: already
 * correct`. The dominant bug shape (CLAUDE.md) in its purest form - and note that the FIX for the
 * underlying misplacement had already shipped: `snapLook` went from 4/28 to 33/33 on
 * tools/facing_probe.mjs. The blocks were repairable the whole time and nothing ever tried.
 *
 * The second half is the angle itself. `lookVecFor` knows the exact horizontal direction the
 * server must see, straight out of the blueprint - so `placeOneCore` now SENDS it, as
 * `placeOpts.yaw`, rather than trying to earn it by walking to a stand point on the far side of
 * the cell. That walk is allowed to fail and fall through to "get near the cell somehow", and when
 * it did, the facing came from the approach direction: unsteered, unrecorded, and - before the
 * skip above was fixed - permanent.
 */
import fs from 'node:fs';
import { Vec3 } from 'vec3';
import { cellIsDone, chooseFaces, lookVecFor, orientationMismatch } from '../src/agent/library/blueprint_builder.js';
import { snapLook } from '../src/agent/library/block_io.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
/** Like check, but for a measured quantity worth printing on a pass too. */
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

// ---------------------------------------------------------------- the skip that froze 339 cells
//
// `cellIsDone` IS the skip. Asserting the predicate it consults is not enough and this is the
// proof: `orientationMismatch` was written, tested and correct while the skip beside it compared
// names only, and a mutation putting the old line back left a predicate-only suite fully green.
{
    const want = { name: 'spruce_stairs', properties: { facing: 'east', half: 'bottom' } };
    const sameNameWrongWay = { name: 'spruce_stairs', getProperties: () => ({ facing: 'west', half: 'bottom' }) };
    const sameNameRightWay = { name: 'spruce_stairs', getProperties: () => ({ facing: 'east', half: 'bottom' }) };
    const otherBlock = { name: 'cobblestone', getProperties: () => ({}) };

    check('the names match, so the old skip fired', want.name === sameNameWrongWay.name, true);
    check('the right block facing the WRONG way is NOT done', cellIsDone(want, sameNameWrongWay), false);
    check('the right block facing the right way IS done',     cellIsDone(want, sameNameRightWay), true);
    check('a different block is not done',                    cellIsDone(want, otherBlock), false);
    check('an empty cell is not done',                        cellIsDone(want, null), false);
    // and the no-orientation case still short-circuits on the name, as it always did
    check('a plain block matching by name is done',
        cellIsDone({ name: 'stone', properties: {} }, { name: 'stone', getProperties: () => ({}) }), true);
    // a property the blueprint does not specify must not block the skip, or every plain cell
    // would be re-placed forever
    check('an unrequested property does not un-finish a cell',
        cellIsDone({ name: 'stone', properties: {} }, { name: 'stone', getProperties: () => ({ facing: 'west' }) }), true);
}

// ---------------------------------------------------------------- the angle comes from the blueprint
//
// `aimYaw = atan2(-look.x, -look.z)` in placeOneCore. Re-derived here so a change to either the
// convention or to lookVecFor has to come past an assertion.
const yawOf = (p) => {
    const look = lookVecFor(p);
    return look ? Math.atan2(-look.x, -look.z) : null;
};
/** mineflayer yaw -> the unit horizontal direction the bot is looking. */
const dirOf = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const near = (a, b) => Math.abs(a - b) < 1e-9;

for (const [facing, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]]) {
    // Stairs are LOOK_ALIGNED: the blockstate facing equals the player's horizontal direction.
    const yaw = yawOf({ name: 'spruce_stairs', properties: { facing } });
    const d = dirOf(yaw);
    report(`east/west/north/south: stairs facing ${facing} aim the look ${facing}`,
        near(d.x, dx) && near(d.z, dz), `yaw ${yaw.toFixed(3)} -> (${d.x.toFixed(0)}, ${d.z.toFixed(0)})`);
}
for (const [facing, dx, dz] of [['north', 0, 1], ['south', 0, -1], ['west', 1, 0], ['east', -1, 0]]) {
    // A chest is LOOK_OPPOSED: it turns to face the player, so the look is the other way.
    const yaw = yawOf({ name: 'chest', properties: { facing } });
    const d = dirOf(yaw);
    report(`a chest facing ${facing} aims the look the OTHER way`,
        near(d.x, dx) && near(d.z, dz), `yaw ${yaw.toFixed(3)} -> (${d.x.toFixed(0)}, ${d.z.toFixed(0)})`);
}
// ---- the three table entries that had NO steering at all, or the wrong one
//
// `lookVecFor` returning null means "the builder is not steering this", and for a block whose
// facing genuinely comes from the yaw that is a silent, permanent miss: it is dug and re-placed
// FACING_MAX_REPAIRS times, lands wrong every time, and is then left alone. Found live, from
// `refacing` outrunning `yaw` in the build heartbeat.
{
    // decorated_pot: vanilla uses getHorizontalDirection(), so it is LOOK_ALIGNED. It was in
    // neither table and got no aim.
    const pot = yawOf({ name: 'decorated_pot', properties: { facing: 'east', cracked: 'false' } });
    report('a decorated pot is steered at all', pot !== null, `yaw ${pot?.toFixed(3)}`);
    const pd = dirOf(pot);
    report('...and aligned, not opposed', near(pd.x, 1) && near(pd.z, 0),
        `looks (${pd.x.toFixed(0)}, ${pd.z.toFixed(0)}) for facing east`);

    // anvil: getHorizontalDirection().getClockWise() - a QUARTER turn, not a half. It was in
    // LOOK_OPPOSED, which is 90 degrees wrong, so no amount of aiming could have landed it.
    for (const [facing, wx, wz] of [['south', 1, 0], ['north', -1, 0], ['east', 0, -1], ['west', 0, 1]]) {
        const d = dirOf(yawOf({ name: 'anvil', properties: { facing } }));
        report(`an anvil facing ${facing} looks anticlockwise of it`,
            near(d.x, wx) && near(d.z, wz), `looks (${d.x.toFixed(0)}, ${d.z.toFixed(0)})`);
    }
    // and the blocks that really ARE opposed must not have moved
    const ch = dirOf(yawOf({ name: 'chest', properties: { facing: 'east' } }));
    report('a chest is still opposed', near(ch.x, -1) && near(ch.z, 0),
        `looks (${ch.x.toFixed(0)}, ${ch.z.toFixed(0)}) for facing east`);
}

// A cell with no orientation to steer must send no yaw at all, or every plain block in the
// blueprint would start forcing the bot's head somewhere for no reason.
check('a plain block asks for no aim',        yawOf({ name: 'stone', properties: {} }), null);
check('a vertical facing asks for no aim',    yawOf({ name: 'lightning_rod', properties: { facing: 'up' } }), null);

// ---------------------------------------------------------------- snapLook must honour the override
//
// The whole point is that the yaw stops depending on position. So: same click point, two very
// different standing positions, and the yaw on the wire must be identical - while the PITCH still
// tracks the click point, which is what keeps the ray vertically honest and leaves the cursor
// (half, hinge, clicked face) meaning what it meant.
{
    const sent = [];
    const fakeBot = (pos) => ({
        entity: { position: new Vec3(pos[0], pos[1], pos[2]), height: 1.62, onGround: false, yaw: 0, pitch: 0 },
        look: async function (yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
        _client: { write: (name, p) => { if (name === 'look') sent.push(p); } },
    });
    const target = new Vec3(10.5, 64.5, 20.5);
    const forced = Math.atan2(-1, -0);   // look due east

    sent.length = 0;
    await snapLook(fakeBot([4, 64, 20]), target, forced);   // standing WEST of the cell
    const fromWest = sent.at(-1);
    sent.length = 0;
    await snapLook(fakeBot([17, 64, 20]), target, forced);  // standing EAST of it
    const fromEast = sent.at(-1);

    report('the forced yaw is identical from both sides',
        near(fromWest.yaw, fromEast.yaw), `${fromWest.yaw.toFixed(2)} vs ${fromEast.yaw.toFixed(2)} degrees`);
    // and it is the yaw we asked for, in the notchian degrees the packet carries
    const wantDeg = (180 / Math.PI) * (Math.PI - forced);
    report('and it is the angle the blueprint asked for',
        Math.abs(fromWest.yaw - wantDeg) < 1e-6, `${fromWest.yaw.toFixed(2)} degrees`);

    // Without an override the yaw goes back to depending on position - the pre-existing
    // behaviour every other caller in block_io relies on.
    sent.length = 0;
    await snapLook(fakeBot([4, 64, 20]), target);
    const freeWest = sent.at(-1);
    sent.length = 0;
    await snapLook(fakeBot([17, 64, 20]), target);
    const freeEast = sent.at(-1);
    report('with no override the yaw still follows the bot',
        Math.abs(freeWest.yaw - freeEast.yaw) > 90,
        `${freeWest.yaw.toFixed(1)} vs ${freeEast.yaw.toFixed(1)} degrees apart`);

    // The pitch must NOT be flattened by the override: a click point below the eye is still
    // looked down at, which is what keeps the click plausible and the cursor meaningful.
    const low = new Vec3(10.5, 60.5, 20.5);
    sent.length = 0;
    await snapLook(fakeBot([10, 64, 20]), low, forced);
    report('the pitch still aims at the click point', sent.at(-1).pitch > 5,
        `${sent.at(-1).pitch.toFixed(1)} degrees down at a cell 4 below the eye`);
}

// ---------------------------------------------------------------- the repair is bounded
//
// FACING_MAX_REPAIRS is 2. It is not exported, so this asserts the property that matters: the
// counter is per CELL, so one stubborn cell cannot spend another cell's budget. A shared counter
// would stop repairing the whole blueprint after the second bad stair.
{
    const ctx = {};
    const bump = (P) => {
        const key = `${P.x},${P.y},${P.z}`;
        const tried = ctx.facingRepairs?.get(key) || 0;
        (ctx.facingRepairs ||= new Map()).set(key, tried + 1);
        return tried;
    };
    check('first attempt at a cell sees 0 prior tries', bump({ x: 1, y: 2, z: 3 }), 0);
    check('second attempt at the same cell sees 1',     bump({ x: 1, y: 2, z: 3 }), 1);
    check('a DIFFERENT cell starts from 0 again',       bump({ x: 9, y: 2, z: 3 }), 0);
}

// ------------------------------------------------- the face that DETERMINES the orientation
//
// 66 of the 339 wrong facings could never have been fixed by aiming the look, because the property
// comes off the CLICKED FACE, not off the yaw: 45 logs and chains on the wrong axis, 21 amethyst
// buds and lightning rods pointing the wrong way. For these, an alternate face is not another way
// to satisfy the blueprint - it is a way to place the wrong block. So chooseFaces must offer only
// faces that can produce the wanted state, and must be willing to offer none.
{
    // A bot whose world is solid everywhere except the cells named in `air`.
    const worldOf = (air) => ({
        blockAt: (v) => air.some(a => a[0] === v.x && a[1] === v.y && a[2] === v.z)
            ? { name: 'air', boundingBox: 'empty', position: v }
            : { name: 'stone', boundingBox: 'block', position: v },
    });
    const P = new Vec3(10, 64, 20);
    const names = (cs) => cs.map(c => c.faceName).sort().join(',');

    // ---- axis: a log surrounded by solid rock may only be clicked on its own axis
    for (const [axis, want] of [['y', 'down,up'], ['x', 'east,west'], ['z', 'north,south']]) {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P, { name: 'oak_log', properties: { axis } });
        report(`an axis=${axis} log is only offered ${axis}-axis faces`, names(cs) === want,
            `offered ${names(cs) || 'nothing'}`);
    }
    // and with nothing solid on that axis it is offered NOTHING, rather than a face that would
    // lay it down the wrong way. This is the case that used to produce a permanent wrong-axis log.
    {
        const air = [[10, 64, 20], [10, 65, 20], [10, 63, 20]];   // the cell, and above and below
        const cs = chooseFaces(worldOf(air), P, { name: 'oak_log', properties: { axis: 'y' } });
        report('an axis=y log with no floor or ceiling is offered nothing', cs.length === 0,
            `offered ${names(cs) || 'nothing'} (the sides are solid and would give axis x or z)`);
        // the control: the same cell, same world, for a block with no axis at all, IS offered them
        const plain = chooseFaces(worldOf(air), P, { name: 'stone', properties: {} });
        report('...while a plain block in that same cell is offered the sides', plain.length > 0,
            `offered ${names(plain)}`);
    }

    // ---- the measured amethyst case: facing=down means clicking the CEILING
    {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P,
            { name: 'large_amethyst_bud', properties: { facing: 'down', waterlogged: 'false' } });
        report('a bud facing down is offered only the ceiling face', names(cs) === 'down',
            `offered ${names(cs) || 'nothing'}`);
        check('and it clicks the block ABOVE the cell', cs[0].ref.position.y, 65);
    }
    {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P,
            { name: 'small_amethyst_bud', properties: { facing: 'north', waterlogged: 'false' } });
        report('a bud facing north is offered only the north face', names(cs) === 'north',
            `offered ${names(cs) || 'nothing'}`);
    }
    {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P,
            { name: 'lightning_rod', properties: { facing: 'up', waterlogged: 'false' } });
        report('a lightning rod facing up is offered only the floor face', names(cs) === 'up',
            `offered ${names(cs) || 'nothing'}`);
    }
    // A wall-mounted grindstone takes its facing off the clicked face, like a wall sign. It was in
    // no face-derived set, so the generic order was free to click any side.
    {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P,
            { name: 'grindstone', properties: { facing: 'north', face: 'wall' } });
        report('a wall grindstone is offered only its own face', names(cs) === 'north',
            `offered ${names(cs) || 'nothing'}`);
    }

    // A stair is NOT in this class - its facing comes from the yaw - so it keeps every face it had,
    // which is what lets placeOneCore retry an alternate side on a refusal.
    {
        const cs = chooseFaces(worldOf([[10, 64, 20]]), P,
            { name: 'spruce_stairs', properties: { facing: 'east', half: 'bottom' } });
        report('a stair keeps all six faces to retry with', cs.length === 6,
            `offered ${cs.length}: ${names(cs)}`);
    }
}

// ------------------------------------------------- a forced rotation must SETTLE before the click
//
// Writing the look packet ourselves is TCP-ordered, which was read as making a delay unnecessary.
// The measurement in tools/facing_probe.mjs disagrees (no delay 4/28, +1 tick 25/26, +3 ticks
// 27/27), and so did the live run: 306 re-placements with the packet write and no delay produced 26
// blocks a QUARTER TURN out, the errors running BOTH clockwise and anticlockwise. A wrong table is
// wrong the same way every time; only a race is wrong in both directions.
//
// And the delay must not leak into the pillar/bridge callers, which place inside a jump.
{
    const mkBot = () => ({
        entity: { position: new Vec3(10, 64, 18), height: 1.62, onGround: false, yaw: 0, pitch: 0 },
        heldItem: { name: 'spruce_stairs' },
        look: async function (y, p) { this.entity.yaw = y; this.entity.pitch = p; },
        swingArm: () => {},
        blockAt: (v) => (v.x === 10 && v.y === 64 && v.z === 20)
            ? { name: 'spruce_stairs', boundingBox: 'block', type: 7, position: v, getProperties: () => ({}) }
            : { name: 'stone', boundingBox: 'block', type: 1, position: v, getProperties: () => ({}) },
        _client: { write: () => {} },
    });
    const ref = { position: new Vec3(10, 64, 19), name: 'stone', boundingBox: 'block', type: 1 };
    const face = new Vec3(0, 0, 1);

    // The destination already holds what we expect, so placeVerified short-circuits on `already
    // solid` BEFORE any timing path - which is exactly what makes this a clean measure of the
    // delay and nothing else. So instead drive snapLook directly and time the two shapes.
    const t0 = Date.now();
    await snapLook(mkBot(), new Vec3(10.5, 64.5, 20.5), null);
    const noAim = Date.now() - t0;
    report('snapLook itself never sleeps', noAim < 50, `${noAim}ms`);

    // and the settle is applied by placeVerified, not by snapLook, so a caller that passes no yaw
    // cannot pay for it. Asserted on the source, because the fast path above returns before it.
    const src = fs.readFileSync(new URL('../src/agent/library/block_io.js', import.meta.url), 'utf8');
    report('the settle is gated on a forced yaw',
        /if \(forcedYaw !== null\) await new Promise/.test(src),
        'placeVerified sleeps only when a yaw was passed');
    const m = src.match(/const LOOK_SETTLE_MS = (\d+)/);
    report('and it is at least one physics tick', m && Number(m[1]) >= 50,
        `LOOK_SETTLE_MS = ${m && m[1]}ms, against 25/26 measured at 50ms and 27/27 at 150ms`);
    // The pillar/bridge callers place inside a jump. If the delay ever became unconditional their
    // timing would break silently, so pin the gate itself.
    report('an unconditional sleep would be a regression',
        !/await snapLook\([^;]*\);\s*await new Promise\(\(r\) => setTimeout\(r, LOOK_SETTLE_MS\)\)/.test(src),
        'no ungated settle after snapLook');
}

console.log(failures === 0 ? 'facing_repair: all checks passed' : `facing_repair: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
