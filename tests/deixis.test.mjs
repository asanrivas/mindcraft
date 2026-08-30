/**
 * Resolving "here" - pure decisions, no bot:
 *   bun tests/deixis.test.mjs
 *
 * WHY THIS EXISTS. 2026-08-29, 17:39: a player standing ~100 blocks from bob said
 * "Bob. build hut here". The message carries no coordinates and the model only sees the
 * bot's own $STATS position - so it fabricated a site near ITSELF (x=4912 = the bot's x,
 * z=5066 = invented), then garbled the arguments into a 2,312,019-block !fill whose corner
 * was at z=68, and spent the next two hours walking north placing a plank line across the
 * desert. The model cannot use what it never receives; deixisVerdict is how it receives it.
 *
 * The costs are asymmetric and the detection FAILS OPEN accordingly: a false positive adds
 * one line of true context; a false negative reproduces the hut bug. The negatives tested
 * here are only the ones that would make the note WRONG (pointing away from the speaker),
 * not merely unnecessary.
 */
import { isDeictic, deixisVerdict, deixisNote, deixisUnknownNote } from '../src/agent/deixis.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

// --- the message that produced the bug, and its family ---------------------------------------
for (const msg of [
    'Bob. build hut here',
    'come here',
    'over here!',
    'bring the diamonds to me',
    'follow me',
    'build a tower right where I am',
    "dig down where I'm standing",
    'put a chest next to me',
    'plant trees near me',
    'come',
    'HERE',                                   // case-insensitive
    'set up camp at this spot',
]) check(`deictic: "${msg}"`, isDeictic(msg), true);

// --- messages where a speaker-position note would be WRONG or meaningless --------------------
for (const msg of [
    'build a hut there',                      // points away from the speaker
    'go to 4412 64 4934',
    'adhere to the plan',                     // "here" inside a word
    'that tower is coherent with the base',
    'what is in the chest?',
    '',
]) check(`not deictic: "${msg}"`, isDeictic(msg), false);

// --- verdicts --------------------------------------------------------------------------------
const pos = { x: 4826.7, y: 65.2, z: 4990.9 };

check('known position -> note with FLOORED coords',
    deixisVerdict('asanrivas', 'build hut here', pos),
    'asanrivas is standing at (4826, 65, 4990). Words like "here"/"come"/"to me" in their message refer to that position, not to yours.');

check('entity not visible -> explicit UNKNOWN, forbidding invention',
    deixisVerdict('asanrivas', 'build hut here', null),
    deixisUnknownNote('asanrivas'));

check('Rcon (no entity ever) -> unknown note, not a crash',
    deixisVerdict('Rcon', 'come here', undefined),
    deixisUnknownNote('Rcon'));

check('non-deictic -> no note at all',
    deixisVerdict('asanrivas', 'go to 4412 64 4934', pos), null);

check('NaN position counts as unknown - a half-loaded entity must not print (NaN, NaN, NaN)',
    deixisVerdict('asanrivas', 'come here', { x: NaN, y: 65, z: 4990 }),
    deixisUnknownNote('asanrivas'));

// The note must be a statement about the SPEAKER, never an instruction to walk - modes and
// the action manager own movement decisions, not a context line.
const note = deixisNote('p', pos);
check('note does not command movement', /!goToPlayer|!navTo|!travel/.test(note), false);

console.log(failures === 0 ? 'deixis: all checks passed' : `deixis: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
