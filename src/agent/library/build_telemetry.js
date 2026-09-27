/**
 * Live metrics for a blueprint build: one object, read by three consumers.
 *
 *   - the web UI, every second, through getFullState -> the MindServer's `state-update`
 *     (src/mindcraft/public/js/build-panel.js renders it)
 *   - bots/<name>/BUILD_STATUS.json, the current snapshot, for scripts and watchers
 *   - bots/<name>/BUILD_METRICS.jsonl, one sample every SAMPLE_EVERY_MS, for trends after the fact
 *
 * WHY. Everything about a build used to be visible only by grepping a shared log: a heartbeat line
 * every 200 cells, a five-key status file, and FAIL lines sampled down to the first three. So the
 * questions that decide what to do next could not be answered while it ran - how fast is it going,
 * how long is left, is it placing or only failing, which failure is dominant NOW - and every one of
 * the cathedral's stops on 2026-09-24/25 was diagnosed after the fact, from a log that had already
 * scrolled past the moment it went wrong. A crash, a stall and a watchdog stop all looked the same
 * from outside: a status file that stopped changing.
 *
 * Pure apart from the clock, which every method takes as an argument, so it is testable without a
 * bot, a world or a timer.
 */

// Rates are measured over a sliding window, not since the start: a build that ran fast for an hour
// and has placed nothing for ten minutes must READ as stalled, and a lifetime average hides that.
export const RATE_WINDOW_MS = 5 * 60_000;
// One trend sample every 30s: an hour of history is 120 points, small enough to send to the UI every
// second, fine enough to see a rate collapse within a minute of it happening.
export const SAMPLE_EVERY_MS = 30_000;
export const HISTORY_SAMPLES = 120;

// The action ceiling for !buildBlueprint, in MINUTES, and the rate it is sized from. The clock is a
// backstop only - the builder's own stop conditions end a bad run in minutes - so it must never be
// what ends a GOOD one. It has done that twice: 240 min stopped the wizard tower mid-retry, 600 min
// stopped the cathedral at 63%. Sized for the largest blueprint at the slowest sustained rate
// measured (21.4/min, cathedral 2026-09-25), twice over for the retry rounds;
// tests/build_timeout.test.mjs holds that against every file in blueprints/.
export const BUILD_MIN_RATE_PER_MIN = 20;
export const BUILD_BLUEPRINT_TIMEOUT_MIN = 72 * 60;

export class BuildTelemetry {
    constructor({ file, origin, total, now = Date.now() }) {
        this.file = file;
        this.origin = origin ? { x: origin.x, y: origin.y, z: origin.z } : null;
        this.total = total;
        this.startedAt = now;
        this.phase = 'preflight';
        this.phaseStartedAt = now;
        this.counts = { placed: 0, skipped: 0, failed: 0, waiting: 0, released: 0 };
        this.pass = null;                 // {planned, length} of the pass in progress, for its ETA
        this.layer = null;                // blueprint-local y of the cell being worked
        this.maxLayer = null;
        this.target = null;               // world coords of the cell being worked
        this.sinceLastPlaced = 0;
        this.site = { notes: [], preflight: [] };
        this.clear = { layer: null, targets: 0, visited: 0 };
        this.foundation = { placed: 0, tooDeep: 0, unread: 0 };
        this.stopped = null;              // why the build stopped early, if it did
        this.ended = null;                // why it ended at all: done, stopped, interrupted, threw
        this.verified = null;             // {pct, match, total}, once measured against the world
        this.failuresRef = null;          // the builder's live failures array, read on snapshot
        this.ctxRef = null;               // the builder's ctx, for the counters it already keeps
        this.placedAt = [];
        this.attemptAt = [];
        this.history = [];
        this.lastSampleAt = 0;
    }

    setPhase(name, now) {
        if (name === this.phase) return;
        this.phase = name;
        this.phaseStartedAt = now;
    }

    /** One placement attempt concluded. `placed` only when a block actually went down. */
    recordAttempt(now, { placed = false } = {}) {
        this.attemptAt.push(now);
        if (placed) this.placedAt.push(now);
        const cutoff = now - RATE_WINDOW_MS;
        while (this.attemptAt.length && this.attemptAt[0] < cutoff) this.attemptAt.shift();
        while (this.placedAt.length && this.placedAt[0] < cutoff) this.placedAt.shift();
    }

    /** Placements per minute over the window. Fewer than a full window elapsed: over what has. */
    perMinute(now, stamps = this.placedAt) {
        const span = Math.min(RATE_WINDOW_MS, Math.max(1, now - this.startedAt));
        const recent = stamps.filter(t => t >= now - RATE_WINDOW_MS).length;
        return recent / (span / 60_000);
    }

    /**
     * The dominant failure reasons right now, most frequent first, each with the blocks it hit.
     * The reason alone was not actionable: the cathedral's first 10h ended with "1,002 refused by
     * server" and no way to say WHICH blocks the server refused without re-reading the world -
     * and "a wrong face for one block type" and "everything, everywhere" need different fixes.
     */
    topFailures(limit = 5, blockLimit = 4) {
        const byWhy = new Map();
        for (const f of this.failuresRef || []) {
            const k = String(f.why || '?').replace(/\s*\(.*$/s, '').slice(0, 60);
            let g = byWhy.get(k);
            if (!g) byWhy.set(k, g = { n: 0, blocks: new Map() });
            g.n++;
            const name = f.name || '?';
            g.blocks.set(name, (g.blocks.get(name) || 0) + 1);
        }
        return [...byWhy.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, limit)
            .map(([why, g]) => ({
                why, n: g.n,
                blocks: [...g.blocks.entries()].sort((a, b) => b[1] - a[1]).slice(0, blockLimit)
                    .map(([name, n]) => ({ name, n })),
            }));
    }

    /** A trend point, if one is due. Returned so the caller can persist it. */
    maybeSample(now) {
        if (now - this.lastSampleAt < SAMPLE_EVERY_MS) return null;
        this.lastSampleAt = now;
        const s = {
            ts: now, phase: this.phase,
            placed: this.counts.placed, skipped: this.counts.skipped, failed: this.counts.failed,
            waiting: this.counts.waiting,
            perMin: Number(this.perMinute(now).toFixed(1)),
            attemptsPerMin: Number(this.perMinute(now, this.attemptAt).toFixed(1)),
        };
        this.history.push(s);
        if (this.history.length > HISTORY_SAMPLES) this.history.shift();
        return s;
    }

    /** Everything, derived fields included, as plain JSON. */
    snapshot(now) {
        const ctx = this.ctxRef || {};
        const perMin = this.perMinute(now);
        const attemptsPerMin = this.perMinute(now, this.attemptAt);
        const standing = this.counts.placed + this.counts.skipped;
        // ETA only for the pass in progress, and only from the ATTEMPT rate: a pass visits every
        // cell once, whatever each visit concludes. Across passes it cannot be known - the retry
        // rounds' size depends on how many fail - so it is not pretended.
        let passEtaMs = null;
        if (this.pass && attemptsPerMin > 0) {
            const left = Math.max(0, this.pass.length - this.pass.planned) + this.counts.waiting;
            passEtaMs = Math.round((left / attemptsPerMin) * 60_000);
        }
        return {
            // the keys BUILD_STATUS.json always had, so existing watchers keep working
            ts: now, phase: this.phase, total: this.total,
            placed: this.counts.placed, failed: this.counts.failed,
            done: standing + this.counts.failed,

            file: this.file, origin: this.origin,
            startedAt: this.startedAt, elapsedMs: now - this.startedAt,
            phaseStartedAt: this.phaseStartedAt, phaseElapsedMs: now - this.phaseStartedAt,
            counts: { ...this.counts },
            standingPct: this.total ? Number(((standing / this.total) * 100).toFixed(1)) : 0,
            perMin: Number(perMin.toFixed(1)),
            attemptsPerMin: Number(attemptsPerMin.toFixed(1)),
            pass: this.pass ? { ...this.pass } : null,
            passEtaMs,
            layer: this.layer, maxLayer: this.maxLayer, target: this.target,
            sinceLastPlaced: this.sinceLastPlaced,
            topFailures: this.topFailures(),
            health: {
                rescues: ctx.rescues || 0, recentres: ctx.recentres || 0,
                supportsUsed: ctx.supportsUsed || 0, supportsBuilt: ctx.supportsBuilt || 0,
                yawAimed: ctx.yawAimed || 0, refacing: ctx.facingRepairsTried || 0,
                leashed: ctx.leashed || 0,
            },
            clear: { ...this.clear }, foundation: { ...this.foundation },
            site: { notes: [...this.site.notes], preflight: [...this.site.preflight] },
            stopped: this.stopped, ended: this.ended, verified: this.verified,
            history: this.history.slice(),
        };
    }
}

/** "1h 23m", "4m 05s", "12s" - for humans reading a snapshot. */
export function formatDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
}
