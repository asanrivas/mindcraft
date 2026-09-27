/**
 * Pure ballistics tests. No server, no bot:
 *   bun tests/archery.test.mjs
 *
 * The constants are vanilla defaults awaiting live calibration; what these tests pin is the
 * MATHS - that solvePitch round-trips against simulateShot, that lead is linear, and that the
 * friendly-fire corridor geometry cannot be reasoned away by an off-by-sign.
 */
import { ARROW, simulateShot, solvePitch, leadPoint, friendlyInCorridor } from '../src/agent/library/archery.js';

let failures = 0;
const check = (label, cond, want) => {
    const ok = want === undefined ? !!cond : cond === want;
    if (!ok) { console.error(`FAIL ${label}: got ${JSON.stringify(cond)}`); failures++; }
};
const approx = (a, b, eps) => Math.abs(a - b) <= eps;

// --- simulateShot ------------------------------------------------------------------------------
{
    // Flat shot: must drop below launch height and only lose range with drag.
    const s = simulateShot(0, ARROW.speed);
    check('flat shot travels', s.range > 30, true);
    const d10 = s.dropAt(10), d20 = s.dropAt(20);
    check('drop at 10 is negative', d10 < 0);
    check('drop grows with distance', d20 < d10);
    check('flight time grows with distance', s.ticksTo(20) > s.ticksTo(10));
}
{
    // 45 degrees flies further than flat at the same speed.
    const flat = simulateShot(0, ARROW.speed);
    const up = simulateShot(Math.PI / 4, ARROW.speed);
    check('45deg outranges flat', up.range > flat.range);
}

// --- solvePitch round-trips against the simulation ----------------------------------------------
for (const dist of [8, 15, 24, 35]) {
    for (const dy of [0, 3, -3]) {
        const sol = solvePitch({ dist, dy });
        check(`solvePitch(${dist}, dy=${dy}) solvable`, sol !== null);
        if (sol) {
            const sim = simulateShot(sol.pitch, ARROW.speed);
            const drop = sim.dropAt(dist);
            check(`round-trip d=${dist} dy=${dy} hits within 0.25`, drop !== null && approx(drop, dy, 0.25));
        }
    }
}
{
    // Beyond real bow range: must refuse, not extrapolate.
    check('300 blocks is out of range', solvePitch({ dist: 300, dy: 0 }), null);
    // Point blank: aims straight at it.
    const pb = solvePitch({ dist: 0.3, dy: 1 });
    check('point blank solvable', pb !== null);
}

// --- lead ---------------------------------------------------------------------------------------
{
    const led = leadPoint({ x: 10, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0.2 }, 10);
    check('lead x', approx(led.x, 11, 1e-9));
    check('lead z', approx(led.z, 2, 1e-9));
    const still = leadPoint({ x: 5, y: 5, z: 5 }, null, 10);
    check('no velocity, no lead', still.x === 5 && still.z === 5);
}

// --- friendly-fire corridor ----------------------------------------------------------------------
{
    // Friendly dead ahead, nearer than the target: refuse.
    check('friendly in line refused',
        friendlyInCorridor(20, 0, [{ yaw: 0.05, dist: 10 }]), true);
    // Friendly well off-axis: fine.
    check('friendly off-axis ok',
        friendlyInCorridor(20, 0, [{ yaw: 1.2, dist: 10 }]), false);
    // Friendly BEHIND the target: the arrow stops first.
    check('friendly behind target ok',
        friendlyInCorridor(10, 0, [{ yaw: 0.02, dist: 30 }]), false);
    // Wrap-around bearings: -PI and +PI are the same direction.
    check('bearing wraparound handled',
        friendlyInCorridor(20, Math.PI - 0.01, [{ yaw: -Math.PI + 0.01, dist: 10 }]), true);
    check('no friendlies ok', friendlyInCorridor(20, 0, []), false);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: archery maths correct');
