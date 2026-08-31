/**
 * Pure decision logic for `tools/wake_llama.mjs` - see that file's header and
 * docs/gaps/operational.exec.md item 5b for the full guard rationale. This is deliberately the
 * most conservative script in the repo: it can run a command on someone else's personal
 * machine over ssh, so every one of these checks defaults to "don't."
 */

/**
 * Should a wake attempt be made right now?
 *
 * The negative cases matter more than the positive one - a wake that fires spuriously is the
 * failure mode that costs someone their machine doing something unexpected while they're away
 * from it, not a missed optimisation.
 *
 * @param {number} consecutiveDownProbes  how many consecutive brain_health probes found the
 *                                        primary down (0 if the most recent probe was up)
 * @param {number[]} attempts             epoch-ms timestamps of past wake attempts, any order
 * @param {number} now                    epoch ms "now" (injectable for tests)
 * @param {object} [opts]
 * @param {boolean} [opts.armed=false]     the ALLOW_LLAMA_WAKE marker exists. Without it this
 *                                         ALWAYS returns false, before anything else is even
 *                                         considered - an unarmed watcher only ever alerts.
 * @param {number} [opts.minConsecutive=3] a single blip must not trigger an ssh session, any
 *                                         more than it trips FallbackModel's own alert.
 * @param {number} [opts.minGapMs=1800000] at most one attempt per 30 minutes.
 * @param {number} [opts.maxPerDay=3]      at most 3 attempts per rolling 24h - a wake that did
 *                                         not stick twice is a human's problem, not a retry
 *                                         loop's.
 * @param {number} [opts.dayMs=86400000]
 * @returns {boolean}
 */
export function shouldAttemptWake(consecutiveDownProbes, attempts, now, opts = {}) {
    const {
        armed = false,
        minConsecutive = 3,
        minGapMs = 30 * 60_000,
        maxPerDay = 3,
        dayMs = 24 * 60 * 60_000,
    } = opts;
    if (!armed) return false;
    if (consecutiveDownProbes < minConsecutive) return false;

    const list = attempts || [];
    const inLastDay = list.filter(t => now - t < dayMs);
    if (inLastDay.length >= maxPerDay) return false;

    if (list.length > 0) {
        const last = Math.max(...list);
        if (now - last < minGapMs) return false;
    }
    return true;
}
