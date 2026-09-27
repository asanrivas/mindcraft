/**
 * Preflight and the progress watchdog: the two checks that turn today's expensive failures into a
 * line of text before a block moves, or a stop after two hundred attempts instead of five thousand.
 *
 *   bun tests/build_preflight.test.mjs
 *
 * Both are pure over injected probes, so the interesting cases are asserted with a fake world.
 *
 * WHAT THEY WOULD HAVE CAUGHT, each measured on this server:
 *   - `chain` and `grass` renamed by Mojang: `equip chain failed: undefined is not an object
 *     (evaluating 'item.components.length')`, 45 placements across two blueprints, traced by hand.
 *   - an origin one block below grade: two full terrain-clear layers over a 45x35 footprint, found
 *     by looking at a screenshot.
 *   - a build that placed NOTHING for 23 hours: 5,238 identical `flyNear` failures, and a later
 *     variant that managed 1,524 in seventy seconds before the server dropped the client.
 *
 * The cases that must NOT fire matter as much: a preflight that cries wolf on good ground, or a
 * watchdog that stops a build which is merely slow, would both be worse than nothing.
 */
import { preflightBuild, progressVerdict, normaliseWhy } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
const hit = (lines, text) => lines.some(l => l.includes(text));

/** A flat world at `ground`, with every name placeable unless listed in `missing`. */
const probeFor = ({ ground = 64, missing = [], built = false } = {}) => ({
    hasItem: (name) => !missing.includes(name),
    surfaceAt: () => ground,
    naturalAt: () => !built,
});
const slab = (n, y = 0) => Array.from({ length: n * n }, (_, i) =>
    ({ x: i % n, y, z: Math.floor(i / n), name: 'stone' }));

// ---- the rename case
{
    const cells = [...slab(8), { x: 3, y: 1, z: 3, name: 'chain' }, { x: 4, y: 1, z: 4, name: 'chain' }];
    const pf = preflightBuild(cells, { x: 0, y: 64, z: 0 }, probeFor({ missing: ['chain'] }));
    check('an unplaceable name is reported', hit(pf.lines, 'chain x2'), true);
    check('and counted', pf.unknown.get('chain'), 2);
}

// ---- the origin-below-grade case, which is what happened on the live build
{
    const cells = slab(45);
    const pf = preflightBuild(cells, { x: 0, y: 63, z: 0 }, probeFor({ ground: 64 }));
    check('an origin below grade is reported', hit(pf.lines, 'below grade'), true);
    check('with the correction to hand', pf.suggestedY, 64);
    check('and the excavation quantified', pf.clearCells > 0, true);
}

// ---- above grade is the opposite mistake and must also be caught
{
    const pf = preflightBuild(slab(10), { x: 0, y: 70, z: 0 }, probeFor({ ground: 64 }));
    check('an origin above grade is reported', hit(pf.lines, 'above grade'), true);
    check('with the correction', pf.suggestedY, 64);
}

// ---- the footprint is wet: what sank the 2026-09-22 tower siting
{
    const pf = preflightBuild(slab(10), { x: 0, y: 63, z: 0 },
        { hasItem: () => true, surfaceAt: () => 63, naturalAt: () => true, waterAt: () => true });
    check('water at the base plane is reported', hit(pf.lines, 'hold WATER'), true);
}
{
    const pf = preflightBuild(slab(10), { x: 0, y: 64, z: 0 },
        { hasItem: () => true, surfaceAt: () => 64, naturalAt: () => true, waterAt: () => false });
    check('dry ground says nothing about water', hit(pf.lines, 'WATER'), false);
}

// ---- the lot already belongs to somebody
{
    const pf = preflightBuild(slab(10), { x: 0, y: 64, z: 0 }, probeFor({ built: true }));
    check('a built-on footprint is reported', hit(pf.lines, 'BUILT blocks'), true);
}

// ---- and the case that must stay QUIET: good names, right y, natural ground
{
    const pf = preflightBuild(slab(10), { x: 0, y: 64, z: 0 }, probeFor());
    check('a clean site says so and nothing else', pf.lines.length, 1);
    check('and says it is clear', hit(pf.lines, 'clear:'), true);
    check('with no phantom grade correction', pf.gradeDelta, 0);
}

// ---- an unreadable world is reported, never treated as fine
{
    const pf = preflightBuild(slab(6), { x: 0, y: 64, z: 0 },
        { hasItem: () => true, surfaceAt: () => null, naturalAt: () => true });
    check('an unloaded site is reported', hit(pf.lines, 'could not read the ground'), true);
}

// ---- the watchdog: silent below the limit, loud at it
{
    check('a working build is never stopped',
        progressVerdict({ sinceLastPlaced: 199, failuresByWhy: new Map([['out of reach', 199]]) }), null);
    const v = progressVerdict({ sinceLastPlaced: 200, failuresByWhy: new Map([['out of reach', 150], ['refused', 50]]) });
    check('200 attempts with nothing placed stops the build', v?.stop, true);
    check('and names the dominant reason', v.why.includes('out of reach'), true);
    check('with its count', v.why.includes('150x'), true);
}

// ---- a build that is merely SLOW must not be stopped: the counter resets on every placement
{
    let since = 0;
    for (let i = 0; i < 1000; i++) {
        since++;
        if (i % 50 === 0) since = 0;                       // one placement every fifty attempts
        if (progressVerdict({ sinceLastPlaced: since, failuresByWhy: new Map() })) { failures++; break; }
    }
    check('a slow but progressing build runs on', since < 200, true);
}

// ---- the limit is a parameter, so a caller with a harder site can raise it
{
    check('the limit is adjustable',
        progressVerdict({ sinceLastPlaced: 50, failuresByWhy: new Map([['x', 50]]), limit: 50 })?.stop, true);
}

// ---- failure reasons must aggregate by CAUSE, not by timing
// Measured 2026-09-22 in a live build: `20x"refused by server (ack 42ms)" 14x"...(ack 41ms)"
// 12x"...(ack 40ms)"` - one cause reported as its own top three, because the tally keyed on the
// raw string. The watchdog's "dominant reason" used the same key.
{
    check('ack timings collapse to one cause',
        normaliseWhy('refused by server (ack 42ms)') === normaliseWhy('refused by server (ack 41ms)'), true);
    check('coordinates collapse too',
        normaliseWhy('no solid neighbor at (4571, 63, 4595)') === normaliseWhy('no solid neighbor at (4599, 71, 4604)'), true);
    // ...but genuinely different causes must NOT be merged, or the tally hides the second one.
    check('different causes stay different',
        normaliseWhy('refused by server (ack 42ms)') === normaliseWhy('out of reach (no clear hover within range)'), false);
    check('a missing reason is still reported', normaliseWhy(undefined), 'unknown');
    const v = progressVerdict({ sinceLastPlaced: 200, failuresByWhy: new Map([[normaliseWhy('refused by server (ack 42ms)'), 200]]) });
    check('the watchdog names the collapsed cause', v.why.includes('refused by server'), true);
}

console.log(failures === 0 ? 'build_preflight: all checks passed' : `build_preflight: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
