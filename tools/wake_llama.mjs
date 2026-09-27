#!/usr/bin/env bun
/**
 * Conservative, watcher-only wake attempt for a stopped/sleeping llama-server on amyasan
 * (docs/gaps/operational.exec.md item 5b - ranked "Optional" in that plan: "gemini absorbing
 * outages is cheap and the ssh path adds real risk; ship only behind the arming marker, or
 * defer entirely"). This file is built and unit-tested (see wake_llama_lib.mjs and
 * tests/wake_llama.test.mjs) but NOTHING in this repository invokes it automatically -
 * wiring it into a timer, and creating the arming marker, is a human decision made on the
 * machine that owns amyasan, not something this codebase should do on its own.
 *
 * NEVER call this from inside the bot process. FallbackModel (src/models/fallback.js) is on
 * the model's own request path; a path from LLM activity to `ssh` on a remote box must not
 * exist. This is meant to be invoked by a human, or by a separately-configured watcher
 * timer - never as a side effect of a chat message or agent action.
 *
 * Guards, in order - every one defaults to "do nothing":
 *   1. The arming marker must exist: ~/.config/mindcraft/ALLOW_LLAMA_WAKE (override with
 *      --marker). Absent -> this only logs what it WOULD have done and exits 0. Unlike
 *      ALLOW_RESCUE_TP, this marker is not deleted on use - arming a supervisor's ongoing
 *      policy is different from a model spending a one-shot rescue - but every attempt is
 *      logged to logs/wake_llama.log so overuse stays visible.
 *   2. At least `--min-consecutive` (default 3) consecutive DOWN probes, read from
 *      tools/brain_health.mjs's own state file (logs/.brain_health_state.json's `streak`) -
 *      a single blip must not open an ssh session.
 *   3. Rate limit (shouldAttemptWake, wake_llama_lib.mjs): at most one attempt per 30 minutes,
 *      at most 3 per rolling 24h. A wake that did not stick twice is a human's problem.
 *
 * The attempt itself, only past all three guards and without --dry-run:
 *   ssh -o ConnectTimeout=10 <host> "powershell -Command Start-ScheduledTask -TaskName <task>"
 * If ssh itself does not complete within the connect timeout, this STOPS and says so - the
 * box is asleep or off, Start-ScheduledTask cannot reach a machine whose network stack is not
 * up, and Wake-on-LAN is deliberately out of scope: waking a sleeping personal Windows machine
 * is the owner's policy call, not a decision for a supervisor script to make on its own. (Per
 * CLAUDE.md, the fallback to gemini in the meantime costs ~1.4s of latency and flash pricing -
 * a cheap default while a human decides whether to add Wake-on-LAN as its own, separately
 * armed, marker.)
 *
 * Usage - `--dry-run` is the only mode this project's own tooling ever calls:
 *   bun tools/wake_llama.mjs --dry-run
 *   bun tools/wake_llama.mjs --dry-run --host amyasan --task LlamaServer
 *
 * A real attempt (only ever run by hand, by the box's owner, after arming it):
 *   bun tools/wake_llama.mjs
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { shouldAttemptWake } from './wake_llama_lib.mjs';

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

const HOST = args.host || 'amyasan';
const TASK = args.task || 'LlamaServer';
const MARKER = args.marker || join(homedir(), '.config', 'mindcraft', 'ALLOW_LLAMA_WAKE');
const STATE_FILE = args.state || join(ROOT, 'logs', '.brain_health_state.json');
const STAMPS_FILE = args.stamps || join(ROOT, 'logs', '.wake_llama_stamps.json');
const LOG_FILE = args.log || join(ROOT, 'logs', 'wake_llama.log');
const MIN_CONSECUTIVE = Number(args['min-consecutive'] || 3);
const DRY_RUN = !!args['dry-run'];

function loadStreak(path) {
    if (!existsSync(path)) return 0;
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return j.state === 'down' ? (j.streak || 0) : 0;
    } catch {
        return 0; // corrupt/missing state - refuse rather than guess a streak that opens ssh
    }
}

function loadAttempts(path) {
    if (!existsSync(path)) return [];
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(j.attempts) ? j.attempts : [];
    } catch {
        return [];
    }
}

function saveAttempts(path, attempts) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ attempts }, null, 2) + '\n');
}

function log(line) {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `${ts} ${line}\n`);
    console.log(`${ts} ${line}`);
}

function main() {
    const armed = existsSync(MARKER);
    const streak = loadStreak(STATE_FILE);
    const attempts = loadAttempts(STAMPS_FILE);
    const now = Date.now();

    const verdict = shouldAttemptWake(streak, attempts, now, { armed, minConsecutive: MIN_CONSECUTIVE });
    const inLastDay = attempts.filter(t => now - t < 24 * 3600_000).length;
    const cmdDescription = `ssh -o ConnectTimeout=10 ${HOST} "powershell -Command Start-ScheduledTask -TaskName ${TASK}"`;

    if (!armed) {
        log(`SKIP: not armed (create ${MARKER} to arm). Would run: ${cmdDescription}`);
        return process.exit(0);
    }
    if (!verdict) {
        log(`SKIP: armed but guard refused (streak=${streak}/${MIN_CONSECUTIVE}, `
            + `attempts_last_24h=${inLastDay}). Would run: ${cmdDescription}`);
        return process.exit(0);
    }
    if (DRY_RUN) {
        log(`DRY-RUN: guard passed (streak=${streak}, attempts_last_24h=${inLastDay}). `
            + `Would run: ${cmdDescription}`);
        return process.exit(0);
    }

    // *** Only reachable with the marker present, the guard satisfied, and --dry-run absent. ***
    log(`ATTEMPT: ${cmdDescription}`);
    attempts.push(now);
    saveAttempts(STAMPS_FILE, attempts);
    execFile('ssh', ['-o', 'ConnectTimeout=10', HOST,
        `powershell -Command Start-ScheduledTask -TaskName ${TASK}`], { timeout: 15000 },
        (err, stdout, stderr) => {
            if (err) {
                // ssh not completing means the box is asleep/off - stop, do not escalate to
                // Wake-on-LAN or retry immediately. The rate limit above bounds the next try.
                log(`FAILED (ssh did not complete - box likely asleep/off, stopping here): ${err.message}`);
                return process.exit(1);
            }
            log(`ssh completed: ${(stdout || stderr || '(no output)').trim()}`);
            process.exit(0);
        });
}

main();
