#!/usr/bin/env bun
/**
 * Out-of-process health probe for the primary llama-server (docs/gaps/operational.exec.md
 * item 5). Run this from a systemd user timer (or cron), NOT from inside the bot process -
 * FallbackModel already detects and escalates an outage on its OWN request path, but that
 * detection is worthless while the bot itself is down, restarting, or wedged. This is the
 * thing that notices even when nobody is playing and the agent process isn't running at all.
 *
 * What it reports, every run:
 *   - PRIMARY: up|down          - a direct GET against the primary's own /models endpoint,
 *                                  same shape as llamacpp.js's healthCheck() (2.5s abort).
 *   - FAILOVER: primary|backup|unknown - inferred from the BOT's own log (logs/service.log by
 *                                  default), not asked of the bot process. "unknown" means the
 *                                  log has no failover lines yet (fresh install, or a log that
 *                                  was rotated since the last trip) - never guessed as either
 *                                  state.
 *
 * A transition (and ONLY a transition) is appended to logs/brain_health.log, so the log stays
 * readable across weeks of 5-minute polling instead of filling with "still up" noise.
 *
 * Usage:
 *   bun tools/brain_health.mjs
 *   bun tools/brain_health.mjs --url http://amyasan:8000/v1 --service-log logs/service.log
 *
 * Exit code: 0 if the primary answered, 1 if it did not - so a timer/cron job can alert on a
 * nonzero exit without parsing any output.
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextLogState, inferFailoverState } from './brain_health_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
            out[key] = val;
        }
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));

const PRIMARY_URL = args.url || process.env.BRAIN_HEALTH_URL || 'http://amyasan:8000/v1';
const SERVICE_LOG = args['service-log'] || join(ROOT, 'logs', 'service.log');
const HEALTH_LOG = args['health-log'] || join(ROOT, 'logs', 'brain_health.log');
const STATE_FILE = args['state-file'] || join(ROOT, 'logs', '.brain_health_state.json');
const TIMEOUT_MS = Number(args.timeout || 2500);

/** Same shape as llamacpp.js's healthCheck(): a bare GET, no generation, short abort. */
async function probePrimary(url, timeoutMs) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/models`, { signal: ctrl.signal });
            return res.ok;
        } finally {
            clearTimeout(t);
        }
    } catch {
        return false;
    }
}

function loadState(path) {
    if (!existsSync(path)) return { state: null, since: null, streak: 0 };
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return { state: j.state ?? null, since: j.since ?? null, streak: j.streak ?? 0 };
    } catch {
        return { state: null, since: null, streak: 0 }; // corrupt state file - treat as first run
    }
}

function saveState(path, state, since, streak) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ state, since, streak }, null, 2) + '\n');
}

async function main() {
    const up = await probePrimary(PRIMARY_URL, TIMEOUT_MS);
    const now = Date.now();

    const prev = loadState(STATE_FILE);
    const { state, line } = nextLogState(prev.state, up, now, prev.since);
    const since = state === prev.state ? prev.since : now;
    // Consecutive-down streak, for tools/wake_llama.mjs's guard - reset the instant the
    // primary answers, so a single successful probe in the middle of a bad night resets it.
    const streak = state === 'down' ? (prev.state === 'down' ? prev.streak + 1 : 1) : 0;
    saveState(STATE_FILE, state, since, streak);

    if (line) {
        mkdirSync(dirname(HEALTH_LOG), { recursive: true });
        appendFileSync(HEALTH_LOG, line + '\n');
        console.log(line);
    }

    let failover = 'unknown';
    if (existsSync(SERVICE_LOG)) {
        try { failover = inferFailoverState(readFileSync(SERVICE_LOG, 'utf8')) || 'unknown'; }
        catch { /* unreadable log - report unknown rather than guessing */ }
    }

    console.log(`PRIMARY: ${up ? 'up' : 'down'} (${PRIMARY_URL})`);
    console.log(`FAILOVER: ${failover}`);
    process.exit(up ? 0 : 1);
}

main();
