/**
 * Failover logic tests. No server, no network:
 *   bun tests/fallback.test.mjs
 *
 * These pin the two properties the agent loop depends on:
 *   1. sendRequest ALWAYS resolves to a string (prompter's promptCoding/promptMemSaving have
 *      no try/catch - a rejection there propagates into the agent loop).
 *   2. A primary that fails at the socket is skipped for `cooldown_ms` instead of being
 *      re-dialled every turn, and is re-tried once the cooldown expires.
 */
import { FallbackModel, isAvailabilityError, backoffFor } from '../src/models/fallback.js';

let failures = 0;
const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); failures++; }
};

/** Minimal stand-in for a model provider. */
function fake(name, behaviour) {
    const m = { model_name: name, calls: 0 };
    m.sendRequest = async () => {
        m.calls++;
        const r = typeof behaviour === 'function' ? behaviour(m.calls) : behaviour;
        if (r instanceof Error) throw r;
        return r;
    };
    return m;
}

const connErr = () => Object.assign(new Error('Connection error.'), { code: 'ECONNREFUSED' });
const apiErr = () => Object.assign(new Error('bad request'), { status: 400 });

// --- error classification ------------------------------------------------------------------
check('ECONNREFUSED is availability', isAvailabilityError(connErr()));
check('503 is availability', isAvailabilityError({ status: 503 }));
check('APIConnectionError is availability', isAvailabilityError({ name: 'APIConnectionError' }));
check('socket hang up is availability', isAvailabilityError(new Error('socket hang up')));
check('400 is NOT availability', !isAvailabilityError(apiErr()));
check('null is NOT availability', !isAvailabilityError(null));

// --- happy path ----------------------------------------------------------------------------
{
    const primary = fake('local', 'from local');
    const backup = fake('cloud', 'from cloud');
    const fb = new FallbackModel(primary, [backup]);
    check('primary used when healthy', await fb.sendRequest([], '') === 'from local');
    check('backup untouched when healthy', backup.calls === 0);
    check('model_name reports who served it', fb.model_name === 'local');
}

// --- primary down --------------------------------------------------------------------------
{
    const primary = fake('local', connErr());
    const backup = fake('cloud', 'from cloud');
    const fb = new FallbackModel(primary, [backup], { cooldown_ms: 10_000 });

    check('falls back on connection error', await fb.sendRequest([], '') === 'from cloud');
    check('marked as on_backup', fb.on_backup === true);
    check('model_name reports the backup that served it', fb.model_name === 'cloud');

    // Second turn must NOT re-dial the dead primary - that is the whole point of the breaker.
    const before = primary.calls;
    check('second call still served', await fb.sendRequest([], '') === 'from cloud');
    check('primary skipped during cooldown', primary.calls === before);
}

// --- non-availability errors also fail over, but do NOT trip the breaker --------------------
{
    const primary = fake('local', apiErr());
    const backup = fake('cloud', 'from cloud');
    const fb = new FallbackModel(primary, [backup], { cooldown_ms: 10_000 });
    check('falls back on API error too', await fb.sendRequest([], '') === 'from cloud');
    await fb.sendRequest([], '');
    check('primary retried after a non-availability error', primary.calls === 2);
}

// --- recovery ------------------------------------------------------------------------------
{
    // fails once, then healthy
    const primary = fake('local', n => (n === 1 ? connErr() : 'from local'));
    const backup = fake('cloud', 'from cloud');
    const fb = new FallbackModel(primary, [backup], { cooldown_ms: 0 }); // expire immediately
    check('used backup on the failing turn', await fb.sendRequest([], '') === 'from cloud');
    check('primary retried once cooldown expired', await fb.sendRequest([], '') === 'from local');
    check('on_backup cleared after recovery', fb.on_backup === false);
}

// --- everything down -----------------------------------------------------------------------
{
    const primary = fake('local', connErr());
    const backup = fake('cloud', connErr());
    const fb = new FallbackModel(primary, [backup], { cooldown_ms: 10_000 });
    const res = await fb.sendRequest([], '');
    check('returns a string when all fail', typeof res === 'string' && res.length > 0);
    check('does not reject when all fail', res === 'My brain disconnected, try again.');
}

// --- no backup configured: same contract as before -----------------------------------------
{
    const primary = fake('local', connErr());
    const fb = new FallbackModel(primary, []);
    check('no-backup wrapper still returns a string', await fb.sendRequest([], '') === 'My brain disconnected, try again.');
}

// --- ordered chain: first backup wins, second is the spare ----------------------------------
{
    const primary = fake('local', connErr());
    const b1 = fake('cloud1', connErr());
    const b2 = fake('cloud2', 'from cloud2');
    const fb = new FallbackModel(primary, [b1, b2]);
    check('tries backups in order', await fb.sendRequest([], '') === 'from cloud2');
    check('first backup was attempted', b1.calls === 1);
}

// --- exponential backoff ------------------------------------------------------------------------
// Measured motivation: a 16-hour outage on a flat 60s cooldown produced 178 trips and ZERO
// recoveries - ~950 re-dials of a dead socket, each on the critical path of a user turn.
check('backoff f=1 is the base', backoffFor(1, 60000, 900000) === 60000);
check('backoff doubles', backoffFor(2, 60000, 900000) === 120000);
check('backoff f=4', backoffFor(4, 60000, 900000) === 480000);
check('backoff clamps at max', backoffFor(9, 60000, 900000) === 900000);
check('backoff f=0 is zero', backoffFor(0, 60000, 900000) === 0);
// 16 hours of retries: flat-60s would be ~960 attempts, backoff is under 80.
{
    let t = 0, attempts = 0;
    while (t < 16 * 3600 * 1000) { attempts++; t += backoffFor(attempts, 60000, 900000); }
    check('16h outage costs <80 attempts, not ~960', attempts < 80);
}

{
    // The breaker widens its window with each consecutive failure...
    const primary = fake('local', connErr());
    const backup = fake('cloud', 'from cloud');
    const fb = new FallbackModel(primary, [backup], { cooldown_ms: 1000, max_cooldown_ms: 8000 });
    await fb.sendRequest([], '');
    check('first failure counted', fb.consecutiveFailures === 1);
    const firstWindow = fb.down_until - Date.now();
    fb.down_until = 0;                      // expire it so the next call retries the primary
    await fb.sendRequest([], '');
    check('second failure counted', fb.consecutiveFailures === 2);
    check('window grew', (fb.down_until - Date.now()) > firstWindow);
    check('outage start recorded', fb.downSince !== null);
    check('status reports it open', fb.status.open === true);
    fb.stop();
}
{
    // ...and forgets the whole outage on recovery.
    const primary = fake('local', n => (n === 1 ? connErr() : 'from local'));
    const fb = new FallbackModel(primary, [fake('cloud', 'from cloud')], { cooldown_ms: 0 });
    await fb.sendRequest([], '');
    check('failures counted before recovery', fb.consecutiveFailures === 1);
    await fb.sendRequest([], '');
    check('failures reset on recovery', fb.consecutiveFailures === 0);
    check('downSince cleared', fb.downSince === null);
    check('breaker closed', fb.status.open === false);
    fb.stop();
}
{
    // A background health probe closes the breaker with NO user request at all - recovery
    // should never cost somebody a turn.
    let healthy = false;
    const primary = fake('local', connErr());
    primary.healthCheck = async () => healthy;
    const fb = new FallbackModel(primary, [fake('cloud', 'from cloud')],
                                 { cooldown_ms: 60000, probe_ms: 20 });
    await fb.sendRequest([], '');
    check('probe: breaker open', fb.status.open === true);
    healthy = true;
    await new Promise(r => setTimeout(r, 120));
    check('probe closed the breaker unaided', fb.status.open === false);
    check('probe reset the failure count', fb.consecutiveFailures === 0);
    fb.stop();
}
{
    // A provider with no healthCheck must still work - no timer, no crash.
    const fb = new FallbackModel(fake('local', connErr()), [fake('cloud', 'ok')], { cooldown_ms: 50 });
    await fb.sendRequest([], '');
    check('no healthCheck: no probe timer', fb._probeTimer === null);
    fb.stop();
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: fallback failover correct');
