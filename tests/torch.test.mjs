/**
 * The torch-placing light check. No server, no bot:
 *   bun tests/torch.test.mjs
 *
 * The regression this exists for is not "wasted torches". `mode:torch_placing` lists
 * `action:followPlayer` in its `interrupts`, so every time it fires it STOPS the follow. With
 * no light check at all (the old code was gated only on "no torch within 6 blocks") it fired in
 * a bright desert at dawn every 5 seconds, and a user's follow never got more than a few
 * seconds of run before being interrupted again.
 *
 * The live check can only ever exercise whichever quadrant the world happens to be in, hence a
 * pure function. Verified live on this server that the inputs are real: a surface block read
 * `block=0 sky=14 timeOfDay=17697`.
 */
import { torchIsWorthIt, TORCH_LIGHT_LEVEL } from '../src/agent/library/world.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

const NOON = 6000, DAWN = 1000, NIGHT = 17697, MIDNIGHT = 18000;

// --- the bug: bright open ground in daylight --------------------------------------------------
check('open desert at noon: no torch', torchIsWorthIt(0, 15, NOON), false);
check('open desert at dawn: no torch', torchIsWorthIt(0, 14, DAWN), false);

// --- the case torches are actually FOR ---------------------------------------------------------
check('underground, any time: torch', torchIsWorthIt(0, 0, NOON), true);
check('cave at night: torch', torchIsWorthIt(0, 0, NIGHT), true);
check('open ground at night: torch', torchIsWorthIt(0, 14, NIGHT), true);
check('open ground at midnight: torch', torchIsWorthIt(0, 15, MIDNIGHT), true);

// --- already lit: never place, whatever the sky is doing ---------------------------------------
check('lit cave: no torch', torchIsWorthIt(14, 0, NIGHT), false);
check('lit surface at night: no torch', torchIsWorthIt(TORCH_LIGHT_LEVEL, 15, NIGHT), false);
check('just below the threshold still counts as dark',
    torchIsWorthIt(TORCH_LIGHT_LEVEL - 1, 0, NIGHT), true);

// --- night boundaries --------------------------------------------------------------------------
// Sky light is stored UNSCALED: it reads 15 on the surface at midnight exactly as at noon, so
// the time check is the only thing separating "daylight reaches me" from "it does not".
check('12999 is still day', torchIsWorthIt(0, 15, 12999), false);
check('13000 is night', torchIsWorthIt(0, 15, 13000), true);
check('22999 is night', torchIsWorthIt(0, 15, 22999), true);
check('23000 is day again', torchIsWorthIt(0, 15, 23000), false);

// --- a dim sky is not daylight -----------------------------------------------------------------
// Under an overhang or a shallow roof the sky light is attenuated; that block is dark even at
// noon, which is exactly where a player would put a torch.
check('shaded overhang at noon: torch', torchIsWorthIt(0, TORCH_LIGHT_LEVEL - 1, NOON), true);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('PASS: torch light check correct');
