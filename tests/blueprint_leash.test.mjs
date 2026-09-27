/**
 * The site leash: how far outside a blueprint's own footprint the bot may wander before a leg
 * is abandoned and it is walked back.
 *
 *   bun tests/blueprint_leash.test.mjs
 *
 * Why it matters: the navigator's stall ladder ends in "recentring", which walks somewhere else
 * and retries. Crossing open country that is correct; inside a build it is not, because every
 * cell the builder wants is behind the bot. Measured 2026-08-30 on a footprint spanning
 * x 4700-4731: bob reached x=4761 and the placement rate fell 8.6 -> 2.5 blocks/min, every
 * later cell failing "out of reach (no walkable route)" from sixty blocks away.
 *
 * The cases that must NOT fire matter most here: a false positive walks the bot to the centre
 * of the site mid-build, which costs a leg every time it fires.
 */
import { offSite, parkSpot } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
    else console.log(`ok   ${name}`);
}
/** Like check, but for a measured property whose NUMBER is worth printing on a pass too. */
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

// the real footprint from the run that produced the measurement
const box = { minX: 4700, maxX: 4731, minZ: 4600, maxZ: 4630, centreX: 4715, centreZ: 4615 };

check('inside the footprint is on-site',        offSite({ x: 4715, z: 4615 }, box), false);
check('on the corner is on-site',               offSite({ x: 4700, z: 4600 }, box), false);
// Working a wall means standing OUTSIDE the footprint - that is normal, not a stray.
check('one block outside is on-site',           offSite({ x: 4699, z: 4615 }, box), false);
check('just inside the leash is on-site',       offSite({ x: 4731 + 23, z: 4615 }, box), false);
check('exactly at the leash is on-site',        offSite({ x: 4731 + 24, z: 4615 }, box), false);
check('past the leash is OFF-site',             offSite({ x: 4731 + 25, z: 4615 }, box), true);
// the measured stray
check('x=4761 (the observed drift) is OFF-site', offSite({ x: 4761, z: 4614 }, box), true);
// distance is diagonal, not per-axis: 20 east AND 20 north is 28.3 away, not 20
check('diagonal stray counts the hypotenuse',   offSite({ x: 4751, z: 4650 }, box), true);
check('20 on one axis alone stays on-site',     offSite({ x: 4751, z: 4615 }, box), false);
// a bigger leash forgives a further stray
check('leash is a parameter',                   offSite({ x: 4761, z: 4614 }, box, 40), false);

// ---- where to go when nothing is reachable: OUT, not UP
//
// The obvious rally point is the station - open sky above the middle of the build - and it is the
// wrong one: it sits above the WHOLE structure, so reaching it from inside the tower is a
// fifty-block climb through the building. Measured 2026-09-23: four recentres, one arrived, three
// fell 43.9, 48.9 and 51.2 blocks short, and the break-out after each reported `not enclosed` -
// the bot was never sealed, it simply could not fly to a point above the roof.
//
// Out to the side is cheap, and it is where the work is: 877 of the 922 cells left were reachable
// from outside the footprint, only 45 from inside it.
{
    const box = { minX: 100, maxX: 140, minZ: 200, maxZ: 230, centreX: 120, centreZ: 215, topY: 180 };
    const park = (x, y, z) => parkSpot({ x, y, z }, box, 8);

    const w = park(105, 90, 215);
    check('a bot near the west edge leaves west', w.x, 92.5);
    check('at its own altitude', w.y, 90);
    check('without moving sideways', w.z, 215);

    check('a bot near the east edge leaves east', park(138, 90, 215).x, 148.5);
    check('a bot near the north edge leaves north', park(120, 90, 203).z, 192.5);
    check('a bot near the south edge leaves south', park(120, 90, 228).z, 238.5);

    // the point of the exercise: the hop is SHORT, where the station hop was ~50 blocks
    const from = { x: 105, y: 90, z: 215 };
    const to = park(from.x, from.y, from.z);
    const hop = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    report('the hop is short', hop < 20, `${hop.toFixed(1)} blocks, against ~50 up to the station`);

    // and it always ends OUTSIDE the footprint, which is the whole point
    for (const [x, z] of [[105, 215], [138, 215], [120, 203], [120, 228], [120, 215]]) {
        const p = park(x, 90, z);
        const outside = p.x < box.minX || p.x > box.maxX || p.z < box.minZ || p.z > box.maxZ;
        check(`parking from (${x}, ${z}) lands outside the footprint`, outside, true);
    }
    // a bot already well outside is sent no further in
    check('a bot already outside still parks outside',
        park(50, 90, 215).x < box.minX, true);
}

console.log(failures === 0 ? 'blueprint_leash: all checks passed' : `blueprint_leash: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
