/**
 * Asserting ground contact:
 *   bun tests/ground.test.mjs
 *
 * `groundVerdict` overrides the physics engine's own collision result, so its boundaries decide
 * whether the bot can jump at all - and a false positive is worse than the bug it fixes, because
 * it lets a FALLING body jump in mid-air and cancels the apex of a real one.
 */
import { groundVerdict } from '../src/agent/library/ground_truth.js';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// The case this exists for: flush on stone, velocity zeroed by a server correction, so
// prismarine-physics' `oldVelY < 0` test fails and reports a standing bot as airborne.
check('flush on a block with zero velocity IS standing',
      groundVerdict({ solidBelow: true, frac: 0, velY: 0 }), true);
check('...and with gravity still applied', groundVerdict({ solidBelow: true, frac: 0, velY: -0.078 }), true);
check('a hair above the face still counts', groundVerdict({ solidBelow: true, frac: 0.01, velY: 0 }), true);

// Nothing underneath: the flag is right and must stay false.
check('no block below is not standing', groundVerdict({ solidBelow: false, frac: 0, velY: 0 }), false);

// FALLING PAST a solid block. The block under the feet cell is solid the whole way down, so
// `solidBelow` alone would let a body jump in mid-air.
check('falling mid-block is not standing',
      groundVerdict({ solidBelow: true, frac: 0.5, velY: -0.5 }), false);
check('falling just below the next face is not standing',
      groundVerdict({ solidBelow: true, frac: 0.98, velY: -0.3 }), false);

// RISING off our own pillar. Claiming contact here would cancel the apex on the tick after
// take-off - the one tick in the flight that decides everything.
check('rising is never standing', groundVerdict({ solidBelow: true, frac: 0, velY: 0.42 }), false);
check('...even barely rising', groundVerdict({ solidBelow: true, frac: 0, velY: 0.001 }), false);

// The epsilon is the knob; make sure it is actually honoured rather than hard-coded.
check('epsilon is respected (inside)', groundVerdict({ solidBelow: true, frac: 0.05, velY: 0, epsilon: 0.1 }), true);
check('epsilon is respected (outside)', groundVerdict({ solidBelow: true, frac: 0.05, velY: 0, epsilon: 0.01 }), false);

// Degrade safely rather than throw: this runs on every physics tick.
check('no state is not standing', groundVerdict(undefined), false);
check('null state is not standing', groundVerdict(null), false);
check('a negative frac is rejected', groundVerdict({ solidBelow: true, frac: -0.2, velY: 0 }), false);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('ground: all checks passed');
