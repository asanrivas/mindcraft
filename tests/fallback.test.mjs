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
import { FallbackModel, isAvailabilityError } from '../src/models/fallback.js';

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

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: fallback failover correct');
