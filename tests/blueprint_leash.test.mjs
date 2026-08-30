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
import { offSite } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
    else console.log(`ok   ${name}`);
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

console.log(failures === 0 ? 'blueprint_leash: all checks passed' : `blueprint_leash: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
