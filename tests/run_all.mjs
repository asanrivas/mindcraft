#!/usr/bin/env bun
/**
 * Run every unit suite, in parallel, and report which ones failed.
 *
 *   bun tests/run_all.mjs                 # all of them (this is `bun run test`)
 *   bun tests/run_all.mjs --jobs 8        # more workers
 *   bun tests/run_all.mjs --only build    # substring filter over the file names
 *   bun tests/run_all.mjs --list          # print what would run and quit
 *
 * WHY THIS EXISTS, and why it is not just about speed.
 *
 * `package.json`'s `test` script used to be one line of 65 `bun tests/x.test.mjs && ...`, which is
 * the single most contended line in the repo - every session edits it, and concurrent writes have
 * silently dropped suites twice: measured 2026-09-22 at 54 entries in the script against 62 files
 * on disk, so EIGHT suites were being skipped by `bun run test`, including every one written since.
 * CLAUDE.md's answer was "never hand-edit it, regenerate it from a glob", which works only as long
 * as everybody remembers to regenerate. This runner does the glob at RUN time, so a suite that
 * exists is a suite that runs and there is no list left to lose. That is the real fix; the
 * regeneration rule was a workaround for the list existing at all.
 *
 * Speed matters too. Measured on this host (nproc=2), 65 suites: 23s serially, of which the four
 * slowest (creative 4.6s, no_undef 3.8s, contract 2.0s, teleport 1.2s) are half, and the remaining
 * ~60 are ~200ms each of almost pure `bun` process startup. That startup cost is why parallelism
 * pays far more than the two cores suggest - the workers are waiting, not computing.
 *
 * Each suite still runs as its OWN process, exactly as `bun tests/x.test.mjs` does, so:
 *   - a suite that crashes the runtime takes only itself down,
 *   - module-level state cannot leak between suites, and
 *   - running one suite by hand is unchanged, which is how anyone actually debugs a failure.
 *
 * A suite passes if it EXITS 0. That is the contract every suite here already follows
 * (`process.exit(failures === 0 ? 0 : 1)`); output is captured and shown only for failures, because
 * 65 suites of passing chatter is how a real failure goes unnoticed.
 */
import { readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const here = path.dirname(new URL(import.meta.url).pathname);
const only = opt('only', null);
// This file is deliberately NOT named *.test.mjs, so it cannot pick itself up and recurse.
let suites = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort();
if (only) suites = suites.filter(f => f.includes(only));

if (!suites.length) {
    console.log(`no suites matched${only ? ` --only ${only}` : ''}`);
    process.exit(1);
}
if (flag('list')) { for (const s of suites) console.log(s); process.exit(0); }

// Oversubscribe, but not far. The work is mostly process startup, so more workers than cores
// pays - up to the point where the few genuinely CPU-bound suites start starving each other and
// become the critical path. Measured on this host (nproc=2, 65 suites), total wall time:
//   1 worker (serial) 23.0s
//   2 workers         15.6s   no_undef 4.8s
//   3 workers         14.5s   no_undef 6.4s
//   4 workers         13.4s   no_undef 8.9s   <- best
//   6 workers         16.0s   no_undef 14.8s  <- contention now costs more than it saves
//   8 workers         14.2s   no_undef 14.2s
// So the floor is set by the slowest single suite, not by the count: past 4 workers, `no_undef`
// (which lints the whole tree) simply becomes the whole run. Hence min 4, and never more than 8.
const jobs = Math.max(1, Number(opt('jobs', Math.min(8, Math.max(4, cpus().length || 2)))));

// Slowest first: with a fixed worker count, starting the long ones early is what stops a 4.6s
// suite from being the last thing picked up and defining the total on its own.
const KNOWN_SLOW = ['creative', 'no_undef', 'contract', 'teleport', 'action_owner', 'build_order',
                    'coder_guard_wiring', 'build_support', 'deepinfra'];
const weight = (f) => { const i = KNOWN_SLOW.findIndex(k => f.startsWith(k)); return i === -1 ? 99 : i; };
const queue = [...suites].sort((a, b) => weight(a) - weight(b));

const results = [];
let started = 0;
const t0 = Date.now();

async function worker() {
    for (;;) {
        const file = queue.shift();
        if (!file) return;
        const n = ++started;
        const s = Date.now();
        const proc = Bun.spawn(['bun', path.join(here, file)], {
            cwd: path.join(here, '..'),
            stdout: 'pipe', stderr: 'pipe',
            env: { ...process.env, FORCE_COLOR: '0' },
        });
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        const ms = Date.now() - s;
        const ok = code === 0;
        results.push({ file, ok, ms, code, output: `${out}${err}` });
        // One line per suite, as it lands. Padded so the timings line up and a slow suite is
        // obvious without reading the summary.
        console.log(`${ok ? 'ok  ' : 'FAIL'} [${String(n).padStart(2)}/${suites.length}] ${String(ms).padStart(5)}ms  ${file}${ok ? '' : `  (exit ${code})`}`);
    }
}

await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));

const failed = results.filter(r => !r.ok);
const wall = ((Date.now() - t0) / 1000).toFixed(1);

// Failures print their WHOLE output, at the bottom, where it is the last thing on screen.
for (const r of failed) {
    console.log(`\n${'='.repeat(70)}\nFAILED: ${r.file} (exit ${r.code}, ${r.ms}ms)\n${'='.repeat(70)}`);
    console.log(r.output.trimEnd());
}

const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3)
    .map(r => `${r.file.replace('.test.mjs', '')} ${(r.ms / 1000).toFixed(1)}s`).join(', ');
console.log(`\n${'-'.repeat(70)}`);
console.log(`${results.length - failed.length}/${results.length} suites passed in ${wall}s `
    + `(${jobs} workers). Slowest: ${slowest}.`);
if (failed.length) console.log(`FAILED: ${failed.map(r => r.file).join(', ')}`);
process.exit(failed.length ? 1 : 0);
