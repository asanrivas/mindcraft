/**
 * When the navigator may jump:
 *   bun tests/jump.test.mjs
 *
 * The refusals ARE the feature. Bridging's worst case is a wasted plank; jumping's worst case is a
 * bot at the bottom of a ravine, because **a jump is the only recovery in this navigator that
 * cannot be undone**. So the cases that must NOT fire matter more than the one that must.
 *
 * The reach and rise limits below are not opinions - they were measured against the real physics
 * engine in `scratchpad/sim/` (see RESULTS.md): vanilla apex 1.252, this server's apex 0.000
 * without help, level gaps up to 3 clearing at every take-off lead, rise 2 impossible at every
 * width and every lead.
 */
import { jumpVerdict } from '../src/agent/library/nav.js';
import { JumpAssist } from '../src/agent/library/jump_assist.js';
import { EventEmitter } from 'events';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

/** A jump that should be taken: one-block gap, level landing, benign floor below. */
const ok = {
    disabled: false, wet: false, lava: false, cooldown: false, attemptsSpent: false,
    failedHere: false, lowHealth: false, grounded: true, headroom: true,
    rise: 0, stepDownAhead: false, gapAhead: true, span: 1,
    landingStandable: true, landingHeadroom: true, corridorClear: true,
    lethalFall: false, hazardBelow: false, landingDrop: 0,
};

// --- the case it exists for ---------------------------------------------------------------------
check('one-block gap, level landing', jumpVerdict(ok).jump, true);
check('...and the reason names the geometry', jumpVerdict(ok).reason, 'span 1, rise 0');
check('three-block gap still jumps', jumpVerdict({ ...ok, span: 3 }).jump, true);
check('a drop landing is fine', jumpVerdict({ ...ok, span: 2, landingDrop: 3 }).jump, true);

// --- reach, measured ----------------------------------------------------------------------------
// Width 4 is reachable but only in 7 of 11 take-off windows - a coin flip once server lag is
// involved - so the shipped reach is one below the measured maximum.
check('four is beyond the shipped reach', jumpVerdict({ ...ok, span: 4 }).jump, false);
check('...and says so', jumpVerdict({ ...ok, span: 4 }).reason.includes('no landing within 3'), true);
check('no landing at all is refused', jumpVerdict({ ...ok, span: null }).jump, false);

// --- rise: the honesty refusal ------------------------------------------------------------------
// Vanilla jump apex is 1.25 blocks. A 2-block ledge is not jumpable at any impulse "vanilla
// parity" allows, and the sim confirms it fails at every width and every lead. Trying anyway is
// the bunny-hop-against-a-wall behaviour auto_jump.js was written to stop.
check('a one-block rise is jumpable', jumpVerdict({ ...ok, rise: 1, span: 1 }).jump, true);
check('a two-block rise is NOT', jumpVerdict({ ...ok, rise: 2, span: 1 }).jump, false);
check('...and says why', jumpVerdict({ ...ok, rise: 2 }).reason.includes('too tall to jump'), true);
check('a three-block rise is NOT', jumpVerdict({ ...ok, rise: 3, span: 1 }).jump, false);
// A rise costs a block of reach: widths 0-2 clear at every lead, width 3 drops to 7/11.
check('rise 1 reaches 2', jumpVerdict({ ...ok, rise: 1, span: 2 }).jump, true);
check('rise 1 does NOT reach 3', jumpVerdict({ ...ok, rise: 1, span: 3 }).jump, false);

// --- refusals ------------------------------------------------------------------------------------
check('disabled', jumpVerdict({ ...ok, disabled: true }).jump, false);
// The only refusal whose absence causes a CONTENTION bug rather than a terrain one.
check('wet - SwimAssist owns the key', jumpVerdict({ ...ok, wet: true }).jump, false);
check('lava', jumpVerdict({ ...ok, lava: true }).jump, false);
check('cooling down', jumpVerdict({ ...ok, cooldown: true }).jump, false);
check('attempts spent', jumpVerdict({ ...ok, attemptsSpent: true }).jump, false);
check('already failed this exact jump', jumpVerdict({ ...ok, failedHere: true }).jump, false);
check('hurt, with a drop to land', jumpVerdict({ ...ok, lowHealth: true, landingDrop: 2 }).jump, false);
check('hurt but a level landing is still fine',
    jumpVerdict({ ...ok, lowHealth: true, landingDrop: 0 }).jump, true);
check('not standing on anything', jumpVerdict({ ...ok, grounded: false }).jump, false);
check('no headroom to jump into', jumpVerdict({ ...ok, headroom: false }).jump, false);
// A wall is digAhead's job; a step is AutoJump's. This is also the guard against jumping when the
// stall was really a corner wedge.
check('a wall is not a gap', jumpVerdict({ ...ok, gapAhead: false }).jump, false);
// A one-wide trench with a floor one below is a route the PLANNER already has (drop 1, step up 1).
check('a step down is not a gap', jumpVerdict({ ...ok, stepDownAhead: true }).jump, false);
check('nowhere to stand on the far side',
    jumpVerdict({ ...ok, landingStandable: false }).jump, false);
check('no headroom on the far side', jumpVerdict({ ...ok, landingHeadroom: false }).jump, false);
check('something overhead along the way', jumpVerdict({ ...ok, corridorClear: false }).jump, false);

// --- the refusal that decides whether this is safe ------------------------------------------------
// Without it the bot leaps a ravine on a probe that was one stale chunk read from wrong. But it
// must not be so strict that it refuses every real gap: a walkway over a ravine is the situation
// gaps actually OCCUR in, and a first version that refused anything wider than one block never
// jumped once in the live gym. The margin is what justifies the line - widths 0-2 clear at all
// eleven take-off leads, sprint or not; width 3 does not, without sprint.
check('a 3-wide gap over a lethal drop is refused',
    jumpVerdict({ ...ok, span: 3, lethalFall: true }).jump, false);
check('a 2-wide gap over a lethal drop is allowed',
    jumpVerdict({ ...ok, span: 2, lethalFall: true }).jump, true);
check('a 1-wide gap over a lethal drop is allowed',
    jumpVerdict({ ...ok, span: 1, lethalFall: true }).jump, true);

// LAVA IS NOT A LONG DROP. A missed jump into a ravine costs health, which the bot recovers; a
// missed jump into lava costs the bot AND its inventory, and nothing recovers that. They shared a
// threshold at first, and the gym duly jumped a 2-wide gap over lava.
check('any gap over lava is refused, however narrow',
    jumpVerdict({ ...ok, span: 1, hazardBelow: true, lethalFall: true }).jump, false);
check('...and says lava, not "lethal drop"',
    jumpVerdict({ ...ok, span: 1, hazardBelow: true, lethalFall: true }).reason.includes('lava'), true);
// Water is the opposite case - a benign floor the swim stack recovers from.
check('a gap over water is fine at full reach',
    jumpVerdict({ ...ok, span: 3, lethalFall: false, hazardBelow: false }).jump, true);

// --- precedence: the cheapest refusal wins, so the log names the real problem ---------------------
check('disabled outranks everything',
    jumpVerdict({ ...ok, disabled: true, wet: true, lava: true, gapAhead: false }).reason,
    'jumping disabled (server corrections)');
check('wet outranks the terrain checks',
    jumpVerdict({ ...ok, wet: true, gapAhead: false, span: null }).reason.includes('SwimAssist'), true);
check('lava outranks the fall check',
    jumpVerdict({ ...ok, lava: true, lethalFall: true, span: 3 }).reason, 'lava');

// --- the anti-cheat valve --------------------------------------------------------------------------
function fakeBot() {
    const bot = new EventEmitter();
    bot.entity = { position: { floored: () => ({ offset: () => ({}) }) }, velocity: { x: 0, y: 0, z: 0 } };
    bot.blockAt = () => ({ boundingBox: 'block' });
    bot.controlState = {};
    bot.setControlState = (k, v) => { bot.controlState[k] = v; };
    return bot;
}
{
    const ja = new JumpAssist(fakeBot());
    // THE SPAWN CASE. mineflayer emits forcedMove for every server position packet - login,
    // teleports, routine corrections - so an unconditional counter trips before the bot has
    // jumped at all. SwimAssist observed 4 "rubber-bands" during spawn and has no test for it.
    for (let i = 0; i < 6; i++) ja._forcedMove();
    check('corrections while NOT airborne do not disable jumping', ja.disabled, false);

    ja.active = true;
    for (let i = 0; i < 4; i++) ja._forcedMove();
    check('four corrections mid-flight disable it', ja.disabled, true);
    check('...and end the flight', ja.active, false);
}
{
    const ja = new JumpAssist(fakeBot());
    ja.active = true;
    // Three inside the window is under the limit; the window must really slide.
    for (let i = 0; i < 3; i++) ja._forcedMove();
    check('three is under the limit', ja.disabled, false);
    ja.forcedMoves = ja.forcedMoves.map(() => Date.now() - 20000);   // age them out
    for (let i = 0; i < 3; i++) ja._forcedMove();
    check('three more after the window has passed is still under the limit', ja.disabled, false);
}
{
    // A dead mechanism must latch too: a bot that cannot leave the ground should stop trying and
    // bridge, rather than burning anti-cheat exposure on take-offs that do nothing.
    const ja = new JumpAssist(fakeBot());
    ja.noteOutcome(false); ja.noteOutcome(false);
    check('two failed take-offs is not yet fatal', ja.disabled, false);
    ja.noteOutcome(false);
    check('three failed take-offs disables jumping', ja.disabled, true);
    const ja2 = new JumpAssist(fakeBot());
    ja2.noteOutcome(false); ja2.noteOutcome(false); ja2.noteOutcome(true); ja2.noteOutcome(false);
    check('a success resets the failure count', ja2.disabled, false);
}
{
    // THE WORST REGRESSION THIS FEATURE COULD CAUSE: a leaked `active` flag mutes AutoJump
    // forever, destroying the one-block step the whole navigator is built on. The self-expiry is
    // the guard of last resort, behind the caller's `finally`.
    const ja = new JumpAssist(fakeBot());
    ja.begin(1, 0);
    check('begin sets active', ja.active, true);
    ja.activeUntil = Date.now() - 1;
    ja._tick();
    check('active self-expires even if nobody calls end()', ja.active, false);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('jump: all checks passed');
