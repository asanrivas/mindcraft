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

// --- the correction/teleport line is SHARED, not duplicated -----------------------------------
// `forcedMove` cannot tell an operator /tp from an anti-cheat nudge; only distance can. Four
// subsystems have needed that line and each drew it privately, so the agreement between
// teleport detection and SwimAssist's boost valve was a coincidence. It stopped being one when
// both started importing `library/server_corrections.js` - this asserts nobody re-localises it,
// because the symptom of drift is the 2026-08-30 17:46:27 bug returning with no code change at
// the site of the failure: a harness teleport counted as anti-cheat and latching the valve.
{
    const fs = await import('fs');
    const { TELEPORT_MIN_BLOCKS, CORRECTION_MIN_BLOCKS } =
        await import('../src/agent/library/server_corrections.js');
    const { SwimAssist } = await import('../src/agent/library/swim_assist.js');
    const c = (l, g, w) => { if (g !== w) { console.error(`FAIL ${l}: got ${g}, expected ${w}`); process.exitCode = 1; } };

    // The valve's upper edge IS the teleport threshold - one value, reached two ways.
    const sa = new SwimAssist({ entity: null, on() {}, removeListener() {} });
    c('SwimAssist takes its upper edge from the shared constant', sa.opts.correctionMax, TELEPORT_MIN_BLOCKS);
    c('...and its lower edge too', sa.opts.correctionMin, CORRECTION_MIN_BLOCKS);

    // And neither site may quietly go back to its own literal.
    const agentSrc = fs.readFileSync('src/agent/agent.js', 'utf8');
    c('agent.js does not redefine the threshold locally',
      /const\s+TELEPORT_MIN_BLOCKS\s*=/.test(agentSrc), false);
    c('agent.js imports it instead',
      /import\s*\{[^}]*TELEPORT_MIN_BLOCKS[^}]*\}\s*from\s*'\.\/library\/server_corrections\.js'/.test(agentSrc), true);
    const swimSrc = fs.readFileSync('src/agent/library/swim_assist.js', 'utf8');
    c('swim_assist.js does not hardcode the band',
      /correctionMax:\s*\d/.test(swimSrc) || /correctionMin:\s*\d/.test(swimSrc), false);
    console.log('correction/teleport constant: shared, checks passed');
}
