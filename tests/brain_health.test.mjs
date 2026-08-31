/**
 * Pure logic behind tools/brain_health.mjs, the out-of-process watcher for the primary
 * llama-server (docs/gaps/operational.exec.md item 5). No server, no network, no filesystem:
 *   bun tests/brain_health.test.mjs
 *
 * The executable itself (the fetch, the log files) is deliberately thin and untested here -
 * see tools/brain_health.mjs's header for why it has to run out-of-process at all. What's
 * tested is the state machine: which transitions get logged, and how the bot's own log is
 * read to infer whether it is currently on its backup brain.
 */
import { nextLogState, inferFailoverState } from '../tools/brain_health_lib.mjs';

let failures = 0;
const check = (label, cond) => {
    if (!cond) { console.error(`FAIL ${label}`); failures++; }
};

// --- nextLogState: only TRANSITIONS produce a line -------------------------------------------
const T0 = 1_700_000_000_000;

check('first-ever probe, up: state up, a line (not silently first)',
    nextLogState(null, true, T0).state === 'up' && nextLogState(null, true, T0).line !== null);

check('first-ever probe, down: state down, a line',
    nextLogState(null, false, T0).state === 'down' && nextLogState(null, false, T0).line !== null);

check('up -> up: no line (not a transition)',
    nextLogState('up', true, T0).line === null);

check('down -> down: no line (not a transition)',
    nextLogState('down', false, T0).line === null);

{
    const r = nextLogState('up', false, T0);
    check('up -> down: state is down', r.state === 'down');
    check('up -> down: line mentions unreachable', /unreachable/i.test(r.line));
}

{
    const since = T0 - 25 * 60_000; // was down for 25 minutes
    const r = nextLogState('down', true, T0, since);
    check('down -> up: state is up', r.state === 'up');
    check('down -> up: line reports the outage duration', /25\.0 min/.test(r.line));
    check('down -> up: line says recovered', /recovered/i.test(r.line));
}

{
    // down -> up with no known `since` (state file missing/corrupt) must still produce a
    // sensible line, not throw or print "NaN min".
    const r = nextLogState('down', true, T0, null);
    check('down -> up with unknown since: still logs, no NaN', r.line !== null && !/NaN/.test(r.line));
}

// --- inferFailoverState: reads the BOT's log, last matching line wins ------------------------
check('empty log: unknown (never null-guessed as a real state)',
    inferFailoverState('') === null);

check('log with no failover lines at all: unknown',
    inferFailoverState('some unrelated line\nanother one\n') === null);

check('a single "is down" line: backup',
    inferFailoverState('[fallback] primary chat model (local) is down: Connection error.. Using backup for the next 60s (failure #1).\n')
        === 'backup');

check('a single "recovered" line: primary',
    inferFailoverState('[fallback] primary chat model recovered after 1.0 min and 1 failed attempt(s).\n')
        === 'primary');

check('down then recovered: primary (last line wins)',
    inferFailoverState(
        '[fallback] primary chat model (local) is down: Connection error.. Using backup for the next 60s (failure #1).\n'
        + '[fallback] primary chat model recovered after 1.0 min and 1 failed attempt(s).\n'
    ) === 'primary');

check('recovered then down again: backup (last line wins, not the first)',
    inferFailoverState(
        '[fallback] primary chat model recovered after 1.0 min and 1 failed attempt(s).\n'
        + '[fallback] primary chat model (local) is down: Connection error.. Using backup for the next 60s (failure #1).\n'
    ) === 'backup');

check('unrelated log noise around the real lines does not confuse the parser',
    inferFailoverState(
        'some random line about something else\n'
        + '[fallback] primary chat model (local) is down: Connection error.. Using backup for the next 60s (failure #1).\n'
        + 'a player joined\nanother random line\n'
    ) === 'backup');

console.log(failures === 0 ? 'brain_health: all checks passed' : `brain_health: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
