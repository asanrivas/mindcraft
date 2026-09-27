/**
 * Pure guard logic behind tools/wake_llama.mjs (docs/gaps/operational.exec.md item 5b). No
 * server, no network, no ssh:
 *   bun tests/wake_llama.test.mjs
 *
 * This script can run a command on someone else's personal machine, so the NEGATIVE cases are
 * the ones that matter - a wake that fires spuriously is the failure mode that costs a person
 * something unexpected happening on their machine while they're away from it, not a missed
 * optimisation. Every case below is named after the exec plan's own acceptance list: "unarmed
 * never, 2 fails never, 3 fails yes, 4th within 30 min no, 4th attempt in 24h no."
 */
import { shouldAttemptWake } from '../tools/wake_llama_lib.mjs';

let failures = 0;
const check = (label, cond) => {
    if (!cond) { console.error(`FAIL ${label}`); failures++; }
};

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- unarmed: never, no matter how sustained the outage or how few past attempts -------------
check('unarmed, 3 consecutive fails: never', shouldAttemptWake(3, [], NOW, { armed: false }) === false);
check('unarmed, 10 consecutive fails: never', shouldAttemptWake(10, [], NOW, { armed: false }) === false);
check('unarmed is the default (no opts): never', shouldAttemptWake(5, [], NOW) === false);

// --- below the consecutive-failure threshold: never, even armed ------------------------------
check('armed, 0 fails: never', shouldAttemptWake(0, [], NOW, { armed: true }) === false);
check('armed, 2 fails: never (below default threshold of 3)', shouldAttemptWake(2, [], NOW, { armed: true }) === false);

// --- 3 fails, armed, no prior attempts: yes ---------------------------------------------------
check('armed, 3 fails, no prior attempts: yes', shouldAttemptWake(3, [], NOW, { armed: true }) === true);
check('armed, more than 3 fails also qualifies: yes', shouldAttemptWake(7, [], NOW, { armed: true }) === true);

// --- rate limit: a 4th call within 30 minutes of the last attempt is refused -----------------
{
    const lastAttempt = NOW - 10 * MIN; // 10 minutes ago
    check('armed, 3 fails, last attempt 10 min ago: no (within 30 min gap)',
        shouldAttemptWake(3, [lastAttempt], NOW, { armed: true }) === false);
}
{
    const lastAttempt = NOW - 29 * MIN;
    check('armed, 3 fails, last attempt 29 min ago: still no',
        shouldAttemptWake(3, [lastAttempt], NOW, { armed: true }) === false);
}
{
    const lastAttempt = NOW - 31 * MIN;
    check('armed, 3 fails, last attempt 31 min ago: yes (past the 30 min gap)',
        shouldAttemptWake(3, [lastAttempt], NOW, { armed: true }) === true);
}

// --- daily cap: a 4th attempt within 24h is refused even if the 30-minute gap has passed ------
{
    const attempts = [NOW - 20 * HOUR, NOW - 10 * HOUR, NOW - 2 * HOUR]; // 3 already today
    check('armed, 3 fails, 3 attempts already in the last 24h: no, even with gap satisfied',
        shouldAttemptWake(3, attempts, NOW, { armed: true }) === false);
}
{
    // Same shape, but the oldest of the three has aged out of the 24h window - a 3rd (not 4th)
    // attempt within the rolling day is allowed again.
    const attempts = [NOW - 25 * HOUR, NOW - 10 * HOUR, NOW - 2 * HOUR];
    check('armed, oldest attempt aged out of the 24h window: yes',
        shouldAttemptWake(3, attempts, NOW, { armed: true }) === true);
}
{
    // Only 2 attempts in the last 24h, but the most recent was 5 minutes ago - the gap guard
    // still refuses even though the daily cap has room.
    const attempts = [NOW - 20 * HOUR, NOW - 5 * MIN];
    check('armed, under the daily cap but inside the 30 min gap: no',
        shouldAttemptWake(3, attempts, NOW, { armed: true }) === false);
}

// --- custom thresholds are respected, not hardcoded -------------------------------------------
check('custom minConsecutive respected (below it)',
    shouldAttemptWake(2, [], NOW, { armed: true, minConsecutive: 5 }) === false);
check('custom minConsecutive respected (at it)',
    shouldAttemptWake(5, [], NOW, { armed: true, minConsecutive: 5 }) === true);
check('custom maxPerDay respected',
    shouldAttemptWake(3, [NOW - HOUR], NOW, { armed: true, maxPerDay: 1, minGapMs: 0 }) === false);
check('custom minGapMs respected',
    shouldAttemptWake(3, [NOW - 5 * MIN], NOW, { armed: true, minGapMs: MIN }) === true);
check('custom dayMs respected (older window forgives sooner)',
    shouldAttemptWake(3, [NOW - 2 * HOUR], NOW, { armed: true, maxPerDay: 1, dayMs: HOUR, minGapMs: 0 }) === true);

console.log(failures === 0 ? 'wake_llama: all checks passed' : `wake_llama: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
