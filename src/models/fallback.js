/**
 * Failover wrapper around a chat model.
 *
 * Andy's primary brain is a local llama-server reached over an SSH tunnel from a Windows box.
 * When that box sleeps, reboots, or the tunnel drops, every request fails at the socket and the
 * bot goes deaf - previously it just answered "My brain disconnected, try again." forever.
 *
 * This routes to a backup provider instead, and remembers that the primary is down so the next
 * N seconds of requests skip it rather than paying a connect timeout each turn.
 *
 * The breaker BACKS OFF EXPONENTIALLY, and this is not premature generality - it is a response
 * to measurement. The first version retried on a flat 60s cooldown, and a real 16-hour outage
 * produced 178 recorded trips and ZERO recoveries: roughly 950 pointless re-dials of a dead
 * socket, every one of them on the critical path of a user's turn. Doubling from 60s to a 15
 * minute ceiling turns that into ~70 attempts, and the health probe below takes even those off
 * the critical path.
 *
 * States: closed -> open (on an availability error, with growing backoff) -> half-open (one
 * trial request, or a successful background probe) -> closed.
 *
 * It is deliberately the ONLY place that decides "is the model down". Providers just throw.
 *
 * Guarantees the same contract the callers already rely on: `sendRequest` always resolves to a
 * string, never rejects. `promptCoding`/`promptMemSaving` in prompter.js have no try/catch, so a
 * rejection there would propagate into the agent loop.
 */

const DISCONNECT_MESSAGE = 'My brain disconnected, try again.';

/** Errors that mean "the server is not reachable", as opposed to "it answered with an error". */
export function isAvailabilityError(err) {
    if (!err) return false;
    const code = err.code || err.cause?.code || err.errno;
    if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
         'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
         'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
    if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const status = err.status;
    if (typeof status === 'number' && status >= 500) return true; // 502/503/504 from a proxy
    const msg = String(err.message || '');
    return /connection error|fetch failed|socket hang up|timed? ?out|network/i.test(msg);
}

/**
 * Exponential backoff with a ceiling. Pure, so the schedule is testable without waiting hours.
 * failures=1 -> base, 2 -> 2x, 3 -> 4x ... clamped to max.
 */
export function backoffFor(failures, base, max) {
    if (failures <= 0) return 0;
    const exp = base * Math.pow(2, failures - 1);
    return Math.min(exp, max);
}

export class FallbackModel {
    /**
     * @param {object} primary        model instance with sendRequest()
     * @param {object[]} backups      ordered fallbacks, tried left to right
     * @param {object} [opts]
     * @param {number} [opts.cooldown_ms=60000]      base backoff after the first failure
     * @param {number} [opts.max_cooldown_ms=900000]  ceiling for the exponential backoff
     * @param {number} [opts.probe_ms=30000]          background health-probe interval while open
     * @param {string} [opts.label='chat']       for log lines only
     */
    constructor(primary, backups = [], opts = {}) {
        this.primary = primary;
        this.backups = (backups || []).filter(Boolean);
        this.cooldown_ms = opts.cooldown_ms ?? 60000;
        this.max_cooldown_ms = opts.max_cooldown_ms ?? 900000;   // 15 minutes
        this.probe_ms = opts.probe_ms ?? 30000;
        this.consecutiveFailures = 0;
        this.downSince = null;
        this.trips = 0;
        this._probeTimer = null;
        this.label = opts.label || 'chat';
        this.down_until = 0;
        this.on_backup = false;             // last request was served by a backup
        this.model_name = primary.model_name; // which model actually served it
    }

    _primaryDown() {
        return Date.now() < this.down_until;
    }

    _trip(err) {
        const first = !this._primaryDown();
        this.consecutiveFailures++;
        this.trips++;
        if (this.downSince === null) this.downSince = Date.now();
        const wait = backoffFor(this.consecutiveFailures, this.cooldown_ms, this.max_cooldown_ms);
        this.down_until = Date.now() + wait;
        if (first) {
            console.warn(`[fallback] primary ${this.label} model (${this.primary.model_name}) is down: `
                + `${err?.message || err}. Using backup for the next ${Math.round(wait / 1000)}s `
                + `(failure #${this.consecutiveFailures}).`);
        }
        this._startProbe();
    }

    /** Close the breaker and forget the outage. */
    _reset() {
        const wasDown = this.downSince !== null;
        if (wasDown) {
            const mins = ((Date.now() - this.downSince) / 60000).toFixed(1);
            console.log(`[fallback] primary ${this.label} model recovered after ${mins} min `
                + `and ${this.consecutiveFailures} failed attempt(s).`);
        }
        this.consecutiveFailures = 0;
        this.downSince = null;
        this.down_until = 0;
        this.on_backup = false;
        this._stopProbe();
    }

    /**
     * Poll the primary's cheap health endpoint while the breaker is open.
     *
     * Recovery detection used to cost a user-facing turn: the breaker only discovered the server
     * was back when a real request happened to be routed to it after the cooldown, so the first
     * turn after any recovery paid the full connect attempt. A `/v1/models` GET costs nothing and
     * runs off the critical path, so the breaker can close BEFORE anyone asks it anything.
     */
    _startProbe() {
        if (this._probeTimer || typeof this.primary.healthCheck !== 'function') return;
        this._probeTimer = setInterval(async () => {
            try {
                const ok = await this.primary.healthCheck();
                if (ok) this._reset();
            } catch { /* still down; keep waiting */ }
        }, this.probe_ms);
        // Never hold the process open just to poll a dead model.
        if (typeof this._probeTimer.unref === 'function') this._probeTimer.unref();
    }

    _stopProbe() {
        if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
    }

    /** Release the probe timer. */
    stop() { this._stopProbe(); }

    /** For !stats and logging. */
    get status() {
        return {
            label: this.label,
            model: this.model_name,
            open: this._primaryDown(),
            failures: this.consecutiveFailures,
            trips: this.trips,
            downMinutes: this.downSince === null ? 0 : (Date.now() - this.downSince) / 60000,
            retryInSec: this._primaryDown() ? Math.round((this.down_until - Date.now()) / 1000) : 0,
        };
    }

    /** Order to try providers in: primary first unless it is cooling down. */
    _chain() {
        const primary = { model: this.primary, isPrimary: true };
        const backups = this.backups.map(model => ({ model, isPrimary: false }));
        // When the primary is cooling down it goes last, not away: if every backup also fails,
        // one more attempt at the local server beats returning nothing.
        return this._primaryDown() ? [...backups, primary] : [primary, ...backups];
    }

    async _dispatch(method, args) {
        const errors = [];
        for (const { model, isPrimary } of this._chain()) {
            if (typeof model[method] !== 'function') continue;
            try {
                const res = await model[method](...args);
                this.model_name = model.model_name;
                if (isPrimary) {
                    this._reset();
                } else {
                    this.on_backup = true;
                }
                return res;
            } catch (err) {
                errors.push(`${model.model_name}: ${err?.message || err}`);
                if (isPrimary) {
                    if (isAvailabilityError(err)) {
                        this._trip(err);
                    } else {
                        console.warn(`[fallback] primary ${this.label} model errored (${err?.message || err}); trying backup.`);
                    }
                } else {
                    console.warn(`[fallback] backup ${model.model_name} failed: ${err?.message || err}`);
                }
            }
        }
        const detail = errors.length ? errors.join(' | ') : 'no provider supports ' + method;
        console.error(`[fallback] every ${this.label} model failed - ${detail}`);
        return null;
    }

    async sendRequest(...args) {
        const res = await this._dispatch('sendRequest', args);
        return res === null ? DISCONNECT_MESSAGE : res;
    }

    async sendVisionRequest(...args) {
        const res = await this._dispatch('sendVisionRequest', args);
        return res === null ? DISCONNECT_MESSAGE : res;
    }

    async embed(...args) {
        const res = await this._dispatch('embed', args);
        if (res === null) throw new Error('No available embedding model.');
        return res;
    }
}
