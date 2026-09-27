/**
 * Pure tests for the checkpoint marathon. No server, no bot:
 *   bun tests/marathon.test.mjs
 *
 * Two things here are worth guarding:
 *
 *   - The route budget. `planLoop` solves a radius from a straight-line budget, and the whole
 *     point of the feature is that the answer stays inside it. An off-by-one in the "one
 *     radius plus count-1 sides" geometry silently produces a route half again as long.
 *   - `nearestCompass`. Every block-level helper in skills.js indexes blocks as `p + d*n`, so
 *     a non-integer heading reads the wrong column and the bot mines a hole beside the wall
 *     it is standing against. The traveller may steer on any bearing, but it must only ever
 *     DIG along one of eight.
 */
import { planLoop, routeLength, routeFromPairs, describe as describeMarathon, ARRIVE_DIST } from '../src/agent/library/marathon.js';
import { nearestCompass } from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};
const checkNear = (label, got, want, tol) => {
    if (!(Math.abs(got - want) <= tol)) {
        console.error(`FAIL ${label}: got ${got}, expected ${want} +/- ${tol}`);
        failures++;
    }
};

// --- nearestCompass --------------------------------------------------------------------------
check('east', JSON.stringify(nearestCompass(1, 0)), '[1,0]');
check('south', JSON.stringify(nearestCompass(0, 1)), '[0,1]');
check('west', JSON.stringify(nearestCompass(-1, 0)), '[-1,0]');
check('north', JSON.stringify(nearestCompass(0, -1)), '[0,-1]');
check('south-east diagonal', JSON.stringify(nearestCompass(10, 10)), '[1,1]');
check('60 degrees rounds to the diagonal', JSON.stringify(nearestCompass(0.5, 0.866)), '[1,1]');
check('75 degrees rounds to due south', JSON.stringify(nearestCompass(0.259, 0.966)), '[0,1]');
// Scale must not matter: only the bearing does.
check('long vector, same heading', JSON.stringify(nearestCompass(300, 0)), '[1,0]');
// A degenerate heading must still return a usable integer direction rather than NaNs, because
// the caller feeds it straight into block arithmetic.
check('zero vector is still a direction', JSON.stringify(nearestCompass(0, 0)), '[1,0]');
for (const [dx, dz] of [[1, 0], [-3, 7], [0.001, -0.002], [-40, -1]]) {
    const [cx, cz] = nearestCompass(dx, dz);
    check(`integral (${dx},${dz})`, Number.isInteger(cx) && Number.isInteger(cz), true);
    check(`unit-ish (${dx},${dz})`, Math.abs(cx) <= 1 && Math.abs(cz) <= 1, true);
}

// --- planLoop geometry -----------------------------------------------------------------------
const center = { x: 3402, z: 4889 };
const six = planLoop(center, { count: 6, maxTotal: 1000, startAngleDeg: 60 });
check('six checkpoints', six.checkpoints.length, 6);
check('numbered from 1', six.checkpoints[0].n, 1);
checkNear('hexagon radius from a 1000-block budget', six.radius, 160, 1);
const sixLen = routeLength(center, six.checkpoints);
check('route inside its budget', sixLen <= 1000, true);
checkNear('route spends most of the budget', sixLen, 960, 15);
check('first checkpoint bearing honours startAngleDeg', six.checkpoints[0].bearingDeg, 60);
check('checkpoints start unreached', six.checkpoints.every(c => c.reachedAt === null), true);

// The budget must bind for every shape, not just the hexagon that was hand-checked.
for (const count of [2, 3, 4, 5, 6, 8, 12]) {
    for (const budget of [200, 1000, 5000]) {
        const { checkpoints } = planLoop(center, { count, maxTotal: budget });
        const len = routeLength(center, checkpoints);
        check(`count=${count} budget=${budget} inside budget`, len <= budget, true);
        // ...and not absurdly under it. Rounding vertices to whole blocks is the only slack.
        check(`count=${count} budget=${budget} not wasteful`, len > budget * 0.9, true);
    }
}

// An explicit radius overrides the budget solve, so a caller can ask for a specific ring.
const fixed = planLoop(center, { count: 6, radius: 50 });
checkNear('explicit radius wins', Math.hypot(fixed.checkpoints[0].x - center.x, fixed.checkpoints[0].z - center.z), 50, 1);

// Checkpoints must be distinct blocks - a ring that collapses onto itself is instantly "done".
const keys = new Set(six.checkpoints.map(c => `${c.x},${c.z}`));
check('checkpoints are distinct', keys.size, 6);
// ...and all of them further from the centre than the arrival tolerance, or the bot would be
// standing on checkpoint 1 the moment the route is drawn.
check('no checkpoint is already underfoot',
    six.checkpoints.every(c => Math.hypot(c.x - center.x, c.z - center.z) > ARRIVE_DIST), true);

// --- routeLength -----------------------------------------------------------------------------
checkNear('routeLength is centre-to-first plus the sides',
    routeLength({ x: 0, z: 0 }, [{ x: 3, z: 4 }, { x: 3, z: 14 }]), 15, 1e-9);

// --- describe --------------------------------------------------------------------------------
check('describe survives a missing marathon',
    describeMarathon(null).includes('No marathon planned'), true);
const partial = {
    plannedLength: 960,
    checkpoints: [
        { n: 1, x: 1, z: 2, reachedAt: '2026-08-26T00:00:00Z', y: 64, tookMs: 61000, dug: 3, legs: 4, walked: 170 },
        { n: 2, x: 9, z: 9, reachedAt: null, y: null, tookMs: null, dug: 0, legs: 0 },
    ],
};
const text = describeMarathon(partial);
check('describe counts reached checkpoints', text.includes('1/2 checkpoints'), true);
check('describe reports mining', text.includes('mined 3'), true);
check('describe marks the pending one', text.includes('#2 (9, 9) pending'), true);

// --- routeFromPairs --------------------------------------------------------------------------
// A regular ring is convenient and often wrong: around (4312, 4934) on this world, NO rotation
// of a hexagon at radius 100 or 120 puts all six vertices on dry ground. Hand-picked routes are
// the escape hatch, so their parsing has to be strict - a typo that silently drops a checkpoint
// produces a shorter route that still reports success.
{
    const ok = routeFromPairs('4412,4934 4362,5021 4262,5021 4212,4934 4225,4884 4399,4884');
    check('parses six checkpoints', ok.checkpoints?.length, 6);
    check('numbers them from 1', ok.checkpoints[0].n, 1);
    check('keeps the order given', `${ok.checkpoints[5].x},${ok.checkpoints[5].z}`, '4399,4884');
    check('starts unreached', ok.checkpoints.every(c => c.reachedAt === null), true);
    check('has no bearing', ok.checkpoints[0].bearingDeg, null);

    check('tolerates extra whitespace and semicolons',
        routeFromPairs('  1,2 ;  3,4  ').checkpoints?.length, 2);
    check('accepts negative coordinates',
        routeFromPairs('-100,-200 5,6').checkpoints?.[0].x, -100);

    // Failures must be reported, never silently dropped.
    check('rejects a single checkpoint', !!routeFromPairs('1,2').error, true);
    check('rejects empty input', !!routeFromPairs('').error, true);
    check('rejects nonsense', !!routeFromPairs('1,2 banana').error, true);
    check('rejects a missing coordinate', !!routeFromPairs('1,2 3').error, true);
    check('rejects fractional coordinates', !!routeFromPairs('1.5,2 3,4').error, true);
    check('rejects more than twelve', !!routeFromPairs(
        Array.from({ length: 13 }, (_, i) => `${i},0`).join(' ')).error, true);
    // A repeat is instantly "reached" the moment the previous one is, silently shortening the run.
    check('rejects a repeated checkpoint', !!routeFromPairs('1,2 3,4 1,2').error, true);

    // The budget still binds - routeLength is the same function the command checks against.
    const len = routeLength({ x: 4312, z: 4934 }, ok.checkpoints);
    check('the surveyed route fits a 1000-block budget', len <= 1000, true);
    checkNear('...and is the length the survey predicted', len, 627, 5);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('marathon: all checks passed');
