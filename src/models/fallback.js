/**
 * Failover wrapper around a chat model.
 *
 * Andy's primary brain is a local llama-server reached over an SSH tunnel from a Windows box.
 * When that box sleeps, reboots, or the tunnel drops, every request fails at the socket and the
 * bot goes deaf - previously it just answered "My brain disconnected, try again." forever.
 *
 * This routes to a backup provider instead, and remembers that the primary is down so the next
 * N seconds of requests skip it rather than paying a connect timeout each turn (a plain
 * circuit breaker: closed -> open on an availability error -> half-open after `cooldown_ms`).
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

export class FallbackModel {
    /**
     * @param {object} primary        model instance with sendRequest()
     * @param {object[]} backups      ordered fallbacks, tried left to right
     * @param {object} [opts]
     * @param {number} [opts.cooldown_ms=60000]  how long to skip a primary that failed
     * @param {string} [opts.label='chat']       for log lines only
     */
    constructor(primary, backups = [], opts = {}) {
        this.primary = primary;
        this.backups = (backups || []).filter(Boolean);
        this.cooldown_ms = opts.cooldown_ms ?? 60000;
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
        this.down_until = Date.now() + this.cooldown_ms;
        if (first) {
            console.warn(`[fallback] primary ${this.label} model (${this.primary.model_name}) is down: `
                + `${err?.message || err}. Using backup for the next ${Math.round(this.cooldown_ms / 1000)}s.`);
        }
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
                    if (this._primaryDown()) {
                        console.log(`[fallback] primary ${this.label} model recovered.`);
                    }
                    this.down_until = 0;
                    this.on_backup = false;
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
