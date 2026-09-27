/**
 * Pure helpers for `tools/brain_health.mjs` - the out-of-process watcher for the primary
 * llama-server (docs/gaps/operational.exec.md item 5). Kept separate from the executable so
 * the state-machine logic is unit-testable without a real HTTP probe, a real log file, or a
 * real clock.
 *
 * Why out-of-process at all: `src/models/fallback.js` already logs a warn on the first trip
 * and escalates a sustained one (`failoverAlertDue`), but both live INSIDE the bot process. A
 * stopped scheduled task or a sleeping Windows box is invisible to a checker that only runs
 * when the bot happens to be up and dispatching requests - and a wedged agent process cannot
 * report that it itself is wedged. This has to run as its own process, on its own timer.
 */

/**
 * Decide the transition line to append to `logs/brain_health.log`, or null if nothing changed.
 * Only TRANSITIONS are logged (up->down, down->up) - a probe running every 5 minutes for days
 * would otherwise fill the log with "still up" lines that say nothing new.
 *
 * @param {'up'|'down'|null} prevState  the last known state, or null on the very first run ever
 * @param {boolean} up                  this probe's result
 * @param {number} now                  epoch ms
 * @param {number|null} [sinceMs]       epoch ms the previous state began, if known - used only
 *                                       to report a duration on a down->up transition
 * @returns {{state: 'up'|'down', line: string|null}}
 */
export function nextLogState(prevState, up, now, sinceMs = null) {
    const state = up ? 'up' : 'down';
    if (prevState === state) return { state, line: null };
    const ts = new Date(now).toISOString();
    if (state === 'down') {
        return { state, line: `${ts} DOWN - primary llama-server unreachable` };
    }
    if (prevState === 'down' && typeof sinceMs === 'number') {
        const mins = ((now - sinceMs) / 60000).toFixed(1);
        return { state, line: `${ts} UP - primary llama-server recovered after ${mins} min down` };
    }
    return { state, line: `${ts} UP - primary llama-server reachable` };
}

/**
 * Was the bot running on its backup brain the last time it said anything about failover?
 *
 * Reads the bot's OWN log text rather than asking the bot process directly - the bot may be
 * down, restarting, or wedged, and this checker exists precisely to notice that. Only the
 * LAST matching line matters: `fallback.js` logs "is down" once per trip (`_trip`, first==true
 * branch) and "recovered" once per recovery (`_reset`), so whichever of the two appears most
 * recently in the log is the current state.
 *
 * @param {string} logText  contents of logs/service.log, or any text containing those lines
 * @returns {'primary'|'backup'|null}  null means "never mentioned failover" - unknown, not primary
 */
export function inferFailoverState(logText) {
    const lines = (logText || '').split('\n');
    let last = null;
    for (const line of lines) {
        if (/\[fallback\] primary .* is down:/.test(line)) last = 'backup';
        else if (/\[fallback\] primary .* recovered/.test(line)) last = 'primary';
    }
    return last;
}
