/**
 * Nether portal geometry, frame validation, cast planning, and the 8:1 coordinate mapping —
 * pure, no server, no bot:
 *
 *   bun tests/portal.test.mjs
 *
 * Refusal- and edge-weighted, per house style (world_guard.test.mjs, water_exit.test.mjs):
 * the cases that must NOT be refused (the cornerless minimum frame, a full corners-included
 * frame, a larger-than-minimum frame) carry as much weight as the ones that must be.
 */
import {
    framePlan, validateFrame, castPlan, isValidFrameSize,
    overworldToNether, netherToOverworld, isNetherDimension, portalReturnTarget,
    MIN_FRAME_WIDTH, MIN_FRAME_HEIGHT, MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT,
} from '../src/agent/library/portal.js';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        failures++;
    }
};
const ok = (label, cond) => { if (!cond) { console.error(`FAIL ${label}`); failures++; } };

const key = (c) => `${c.x},${c.y},${c.z}`;
const keySet = (arr) => new Set(arr.map(key));

// --- framePlan: geometry -----------------------------------------------------------------------

{
    const plan = framePlan({ x: 0, y: 64, z: 0 }, 'x');
    check('min frame: frame cell count', plan.frame.length, 10);
    check('min frame: interior cell count', plan.interior.length, 6);
    check('min frame: corner count', plan.corners.length, 4);

    // No cell appears in more than one of the three lists.
    const f = keySet(plan.frame), i = keySet(plan.interior), c = keySet(plan.corners);
    ok('frame/interior disjoint', [...f].every(k => !i.has(k)));
    ok('frame/corners disjoint', [...f].every(k => !c.has(k)));
    ok('interior/corners disjoint', [...i].every(k => !c.has(k)));

    // Interior strictly inside the outer rectangle (never on the boundary).
    ok('interior strictly inside x', plan.interior.every(p => p.x > 0 && p.x < 3));
    ok('interior strictly inside y', plan.interior.every(p => p.y > 64 && p.y < 68));
}

{
    // Both axes must be supported and produce genuinely different, non-overlapping geometry.
    const px = framePlan({ x: 10, y: 70, z: 10 }, 'x');
    const pz = framePlan({ x: 10, y: 70, z: 10 }, 'z');
    ok('x-axis frame varies x', new Set(px.frame.map(c => c.x)).size > 1);
    ok('x-axis frame constant z', new Set(px.frame.map(c => c.z)).size === 1);
    ok('z-axis frame varies z', new Set(pz.frame.map(c => c.z)).size > 1);
    ok('z-axis frame constant x', new Set(pz.frame.map(c => c.x)).size === 1);
    ok('x and z plans are distinct', key(px.frame[0]) !== key(pz.frame[0]) || px.frame.length !== pz.frame.length
        || JSON.stringify(px.frame) !== JSON.stringify(pz.frame));
}

{
    // A larger-than-minimum frame (still within vanilla bounds) must scale correctly.
    const plan = framePlan({ x: 0, y: 0, z: 0 }, 'x', { width: 6, height: 7 });
    check('6x7 frame cell count', plan.frame.length, 2 * (6 - 2) + 2 * (7 - 2));
    check('6x7 interior cell count', plan.interior.length, (6 - 2) * (7 - 2));
    check('6x7 corner count', plan.corners.length, 4);
}

// --- isValidFrameSize: bounds --------------------------------------------------------------------

ok('min size valid', isValidFrameSize(MIN_FRAME_WIDTH, MIN_FRAME_HEIGHT));
ok('max size valid', isValidFrameSize(MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT));
ok('too-narrow refused', !isValidFrameSize(MIN_FRAME_WIDTH - 1, MIN_FRAME_HEIGHT));
ok('too-short refused', !isValidFrameSize(MIN_FRAME_WIDTH, MIN_FRAME_HEIGHT - 1));
ok('too-wide refused', !isValidFrameSize(MAX_FRAME_WIDTH + 1, MAX_FRAME_HEIGHT));
ok('too-tall refused', !isValidFrameSize(MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT + 1));

// --- validateFrame: helper to build a fake world from a plan --------------------------------------

/** Builds a getName() over a plan: frame cells -> frameBlock, interior -> interiorBlock,
 *  corners -> cornerBlock (or unset, meaning "not present"), everything else -> null. */
function worldFor(plan, { frameBlock = 'obsidian', interiorBlock = 'air', cornerBlock = null, overrides = {} } = {}) {
    const f = keySet(plan.frame), i = keySet(plan.interior), c = keySet(plan.corners);
    return (x, y, z) => {
        const k = `${x},${y},${z}`;
        if (k in overrides) return overrides[k];
        if (f.has(k)) return frameBlock;
        if (i.has(k)) return interiorBlock;
        if (c.has(k)) return cornerBlock;
        return null;
    };
}

// The case a naive implementation rejects: the 10-block cornerless frame must VALIDATE.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const getName = worldFor(plan, { cornerBlock: null }); // corners absent entirely
    const r = validateFrame(getName, anchor, 'x');
    ok('cornerless 10-block frame validates', r.ok);
    check('cornerless frame: no missing', r.missing.length, 0);
    check('cornerless frame: no obstructions', r.obstructions.length, 0);
}

// A full 12/14-block frame with corners ALSO filled in obsidian must still pass — a validator
// that refuses a legitimate frame is worse than none.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const getName = worldFor(plan, { cornerBlock: 'obsidian' });
    const r = validateFrame(getName, anchor, 'x');
    ok('full frame with corners validates', r.ok);
}

// crying_obsidian is NOT obsidian: a frame edge built from it must refuse, by name.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const badCell = plan.frame[0];
    const getName = worldFor(plan, {
        overrides: { [key(badCell)]: 'crying_obsidian' },
    });
    const r = validateFrame(getName, anchor, 'x');
    ok('crying_obsidian frame refuses', !r.ok);
    ok('refusal names a reason', typeof r.reason === 'string' && r.reason.length > 0);
    ok('refusal mentions the offending cell', r.missing.some(m => m.found === 'crying_obsidian'));
    // and it must not be caught by a substring match against "obsidian" — confirm the exact
    // pair the CLAUDE.md lesson calls out.
    ok('crying_obsidian is rejected by strict equality, not substring', 'crying_obsidian'.includes('obsidian') && !r.ok);
}

// One frame block missing (unloaded / air instead of obsidian) must refuse.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const missingCell = plan.frame[3];
    const getName = worldFor(plan, {
        overrides: { [key(missingCell)]: 'air' },
    });
    const r = validateFrame(getName, anchor, 'x');
    ok('one missing frame block refuses', !r.ok);
    check('exactly one missing cell reported', r.missing.length, 1);
    check('missing cell matches', key(r.missing[0]), key(missingCell));
}

// An unloaded chunk (getName -> null) must never read as a free pass.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const cellIdx = plan.frame[5];
    const getName = worldFor(plan, { overrides: { [key(cellIdx)]: null } });
    const r = validateFrame(getName, anchor, 'x');
    ok('unloaded frame cell refuses (unknown is not safe)', !r.ok);
}

// An obstructed interior refuses.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const blockedCell = plan.interior[0];
    const getName = worldFor(plan, { overrides: { [key(blockedCell)]: 'stone' } });
    const r = validateFrame(getName, anchor, 'x');
    ok('obstructed interior refuses', !r.ok);
    ok('obstruction reason names it', /obstruct/.test(r.reason));
    check('obstruction cell reported', key(r.obstructions[0]), key(blockedCell));
}

// A lit portal (interior full of nether_portal blocks) is reported as lit.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const getName = worldFor(plan, { interiorBlock: 'nether_portal' });
    const r = validateFrame(getName, anchor, 'x');
    ok('lit frame validates', r.ok);
    ok('lit frame reports lit', r.lit);
    check('lit count matches interior size', r.litCount, plan.interior.length);
}

// Partial ignition (some but not all interior cells lit) must not report fully lit.
{
    const anchor = { x: 0, y: 64, z: 0 };
    const plan = framePlan(anchor, 'x');
    const getName = worldFor(plan, {
        interiorBlock: 'air',
        overrides: { [key(plan.interior[0])]: 'nether_portal' },
    });
    const r = validateFrame(getName, anchor, 'x');
    ok('partially lit still validates as a frame', r.ok);
    ok('partially lit is not reported fully lit', !r.lit);
    check('litCount counts only the lit cells', r.litCount, 1);
}

// A larger, valid, corners-included frame also validates (accepts sizes up to vanilla max).
{
    const anchor = { x: 100, y: 60, z: 100 };
    const plan = framePlan(anchor, 'z', { width: MAX_FRAME_WIDTH, height: MAX_FRAME_HEIGHT });
    const getName = worldFor(plan, { cornerBlock: 'obsidian' });
    const r = validateFrame(getName, anchor, 'z', { width: MAX_FRAME_WIDTH, height: MAX_FRAME_HEIGHT });
    ok('max-size frame validates', r.ok);
}

// --- castPlan --------------------------------------------------------------------------------

for (const axis of ['x', 'z']) {
    const anchor = { x: 5, y: 64, z: 5 };
    const plan = framePlan(anchor, axis);
    const steps = castPlan(anchor, axis);

    check(`castPlan(${axis}) step count matches frame count`, steps.length, plan.frame.length);

    const frameSet = keySet(plan.frame);
    const castCells = keySet(steps.map(s => s.cell));
    check(`castPlan(${axis}) covers exactly the frame cells`, [...castCells].sort().join('|'),
        [...frameSet].sort().join('|'));

    // Every cell is scheduled exactly once.
    const seen = new Set();
    let duplicated = false;
    for (const s of steps) {
        const k = key(s.cell);
        if (seen.has(k)) duplicated = true;
        seen.add(k);
    }
    ok(`castPlan(${axis}) has no duplicate cells`, !duplicated);

    // Invariant: every requiresSolid cell is either NOT a frame cell (mold — natural terrain
    // or a backing wall) or is a frame cell already scheduled at an earlier step.
    const scheduledBefore = new Set();
    let invariantHolds = true;
    for (const step of steps) {
        for (const rs of step.requiresSolid) {
            const k = key(rs);
            if (frameSet.has(k) && !scheduledBefore.has(k)) invariantHolds = false;
        }
        scheduledBefore.add(key(step.cell));
    }
    ok(`castPlan(${axis}) requiresSolid cells are mold or already-scheduled`, invariantHolds);
}

// Both axes must produce genuinely different plans (different coordinates).
{
    const anchor = { x: 5, y: 64, z: 5 };
    const sx = castPlan(anchor, 'x');
    const sz = castPlan(anchor, 'z');
    ok('x/z cast plans differ', JSON.stringify(sx) !== JSON.stringify(sz));
}

// --- 8:1 coordinate mapping --------------------------------------------------------------------

// Round trip: a nether coordinate survives nether -> overworld -> nether exactly (this
// direction is lossless; the reverse is inherently lossy — 8 overworld columns share 1
// nether column — so it is tested separately below, not as a round trip).
for (const n of [0, 1, -1, 5, -5, 100, -100, 12345, -12345]) {
    const ow = netherToOverworld({ x: n, y: 70, z: -n });
    const back = overworldToNether(ow);
    check(`nether->overworld->nether round trip x=${n}`, back.x, n);
    check(`nether->overworld->nether round trip z=${-n}`, back.z, -n);
}

// Negative-coordinate rounding: FLOOR, not truncate. These specifically catch a truncating
// implementation, which agrees with floor only at multiples of 8.
check('overworldToNether(-17) floors to -3, not -2', overworldToNether({ x: -17, y: 0, z: 0 }).x, -3);
check('overworldToNether(-1) floors to -1', overworldToNether({ x: -1, y: 0, z: 0 }).x, -1);
check('overworldToNether(-8) is exactly -1', overworldToNether({ x: -8, y: 0, z: 0 }).x, -1);
check('overworldToNether(-9) floors to -2', overworldToNether({ x: -9, y: 0, z: 0 }).x, -2);
check('overworldToNether(7) floors to 0', overworldToNether({ x: 7, y: 0, z: 0 }).x, 0);
check('overworldToNether(8) is exactly 1', overworldToNether({ x: 8, y: 0, z: 0 }).x, 1);
check('overworldToNether(-17) z axis too', overworldToNether({ x: 0, y: 0, z: -17 }).z, -3);

// Y is never scaled, in either direction, including a negative Y.
check('overworldToNether does not scale Y', overworldToNether({ x: 800, y: -40, z: -800 }).y, -40);
check('netherToOverworld does not scale Y', netherToOverworld({ x: 100, y: 120, z: -100 }).y, 120);

// --- isNetherDimension ------------------------------------------------------------------------

for (const [name, want] of [
    ['the_nether', true], ['minecraft:the_nether', true], ['world_nether', true],
    ['overworld', false], ['minecraft:overworld', false], ['the_end', false],
    ['nether_wastes', false],  // a BIOME, not a dimension - must not be conflated
    ['', false], [null, false], [undefined, false], [42, false],
]) check(`isNetherDimension(${JSON.stringify(name)})`, isNetherDimension(name), want);

// --- portalReturnTarget ------------------------------------------------------------------------

{
    const r = portalReturnTarget({
        remembered: { x: 10, y: 65, z: 20 },
        hereDim: 'the_nether',
        herePos: { x: 1, y: 70, z: 2 },
    });
    check('remembered wins over coord-hint', r.source, 'remembered');
    check('remembered target passed through', r.target, { x: 10, y: 65, z: 20 });
}

{
    // No remembered portal, standing in the overworld: hint is the nether-side coordinate.
    const r = portalReturnTarget({ hereDim: 'overworld', herePos: { x: 800, y: 65, z: -17 } });
    check('coord-hint source from overworld', r.source, 'coord-hint');
    check('coord-hint scales down from overworld', r.target, overworldToNether({ x: 800, y: 65, z: -17 }));
}

{
    // No remembered portal, standing in the nether: hint is the overworld-side coordinate.
    const r = portalReturnTarget({ hereDim: 'the_nether', herePos: { x: 100, y: 65, z: -2 } });
    check('coord-hint source from nether', r.source, 'coord-hint');
    check('coord-hint scales up from nether', r.target, netherToOverworld({ x: 100, y: 65, z: -2 }));
}

{
    const r = portalReturnTarget({});
    ok('no data at all refuses', typeof r.refuse === 'string' && r.refuse.length > 0);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: portal geometry, validation, casting and coordinate mapping correct');
