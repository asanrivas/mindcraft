/**
 * Noticing when the SERVER moves the bot. No server, no bot:
 *   bun tests/teleport.test.mjs
 *
 * Until this existed, nothing in the agent consumed `forcedMove` at all - only the swim probe
 * and SwimAssist's anti-cheat valve did. So an operator could `/tp andy asanrivas` and the bot
 * would carry straight on toward wherever it had been walking, because the in-flight travel leg
 * keeps its original target. Observed live: `/tp andy asanrivas` at 00:22:57 and again at
 * 00:36:28, each followed by the bot heading back for a base 7000 blocks away.
 *
 * THE THRESHOLD IS THE WHOLE DESIGN, and the branches that must NOT fire matter more than the
 * one that must. `forcedMove` fires on EVERY server position packet - login, respawn, and the
 * routine anti-cheat corrections this server sends constantly. Counting them unconditionally is
 * the exact mistake that tripped SwimAssist's sprint-boost valve during spawn.
 */
import { teleportVerdict } from '../src/agent/agent.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        failures++;
    }
};

const SETTLED = { sinceSpawnMs: 60_000 };

// --- the case this exists for -------------------------------------------------------------------
check('a long jump on a settled bot is a teleport',
    teleportVerdict({ jumped: 7000, ...SETTLED }), 'report');
check('an across-the-valley /tp is a teleport',
    teleportVerdict({ jumped: 40, ...SETTLED }), 'report');

// --- anti-cheat corrections must NEVER read as teleports ---------------------------------------
// swim_assist's forcedMove valve exists because this server corrects the client constantly.
check('a sub-block correction is not a teleport',
    teleportVerdict({ jumped: 0.4, ...SETTLED }), 'below-threshold');
check('a few blocks of rubber-banding is not a teleport',
    teleportVerdict({ jumped: 3, ...SETTLED }), 'below-threshold');
check('just under the threshold is not a teleport',
    teleportVerdict({ jumped: 7.99, ...SETTLED }), 'below-threshold');
check('exactly at the threshold IS a teleport',
    teleportVerdict({ jumped: 8, ...SETTLED }), 'report');

// --- login and respawn ---------------------------------------------------------------------------
// The login position packet arrives before the bot has done anything, and mineflayer emits a
// DELAYED forcedMove 1.5s after a respawn.
check('the login position packet is not a teleport',
    teleportVerdict({ jumped: 9000, sinceSpawnMs: 100 }), 'spawn');
check('...still suppressed just inside the grace window',
    teleportVerdict({ jumped: 9000, sinceSpawnMs: 4999 }), 'spawn');
check('...and reported once the window has passed',
    teleportVerdict({ jumped: 9000, sinceSpawnMs: 5000 }), 'report');

// --- teleports we asked for ----------------------------------------------------------------------
// !serverTp is the rescue hatch. Reporting its own teleport would cancel the rescue mid-flight.
check('an expected teleport is not reported',
    teleportVerdict({ jumped: 500, ...SETTLED, expected: true }), 'expected');
check('with cheats on, teleporting is just how you travel',
    teleportVerdict({ jumped: 500, ...SETTLED, cheatOn: true }), 'cheat');

// --- coalescing ----------------------------------------------------------------------------------
// Being moved several times in a row is one event to the model, not five.
check('a second teleport straight after the first is coalesced',
    teleportVerdict({ jumped: 500, ...SETTLED, sinceLastReportMs: 200 }), 'coalesced');
check('...and reported again once the cooldown expires',
    teleportVerdict({ jumped: 500, ...SETTLED, sinceLastReportMs: 3000 }), 'report');
check('the first ever report is not coalesced',
    teleportVerdict({ jumped: 500, ...SETTLED }), 'report');

// --- precedence ----------------------------------------------------------------------------------
// A cheap distance test first means the common case (a correction) costs nothing else.
check('below threshold wins over everything',
    teleportVerdict({ jumped: 1, sinceSpawnMs: 0, expected: true, cheatOn: true,
                      sinceLastReportMs: 0 }), 'below-threshold');

// --- degenerate input ----------------------------------------------------------------------------
// distanceTo on a missing entity should never be reported as a teleport.
check('NaN is not a teleport', teleportVerdict({ jumped: NaN, ...SETTLED }), 'below-threshold');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('PASS: teleport detection correct');
