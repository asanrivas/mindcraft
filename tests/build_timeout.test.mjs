/**
 * The !buildBlueprint action ceiling must outlast a GOOD build of every blueprint we have.
 *
 *   bun tests/build_timeout.test.mjs
 *
 * Why it matters. The ActionManager force-stops an action at its timeout, and for a build that is
 * the worst way to end: the throw skips the verification, and nothing resumes it. It happened twice
 * with a healthy build - 240 min stopped the wizard tower mid-retry (2026-09-22), 600 min stopped
 * the cathedral at 63%, still placing 22/min (2026-09-25). Both times the number was picked by feel
 * against a blueprint smaller than the next one. So derive it: largest blueprint, slowest sustained
 * rate measured, twice over for the retry rounds - and fail here, not ten hours into a build, when a
 * new blueprint outgrows it.
 */
import fs from 'node:fs';
import { BUILD_BLUEPRINT_TIMEOUT_MIN, BUILD_MIN_RATE_PER_MIN } from '../src/agent/library/build_telemetry.js';

let failures = 0;
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

const RETRY_FACTOR = 2;
let biggest = { file: null, cells: 0 };
for (const f of fs.readdirSync('blueprints').filter(f => f.endsWith('.json'))) {
    let cells = 0;
    try { cells = (JSON.parse(fs.readFileSync(`blueprints/${f}`, 'utf8')).placements || []).length; } catch { continue; }
    if (cells > biggest.cells) biggest = { file: f, cells };
}
const needed = Math.ceil((biggest.cells / BUILD_MIN_RATE_PER_MIN) * RETRY_FACTOR);
report('the ceiling outlasts the largest blueprint at the slowest measured rate',
    BUILD_BLUEPRINT_TIMEOUT_MIN >= needed,
    `${biggest.file}: ${biggest.cells} cells / ${BUILD_MIN_RATE_PER_MIN} per min x${RETRY_FACTOR} = ${needed} min; ceiling ${BUILD_BLUEPRINT_TIMEOUT_MIN}`);
report('the cathedral is among them (the blueprint that found the bug)', biggest.cells >= 35142, `${biggest.cells}`);

// The call site, not just the constant: a literal creeping back in is exactly the old bug.
const src = fs.readFileSync('src/agent/commands/actions.js', 'utf8');
const block = src.slice(src.indexOf("name: '!buildBlueprint'"), src.indexOf("name: '!serverFill'"));
report('!buildBlueprint passes the derived ceiling to runAsAction',
    /\}, true, BUILD_BLUEPRINT_TIMEOUT_MIN\)/.test(block), 'runAsAction(..., true, BUILD_BLUEPRINT_TIMEOUT_MIN)');
report('...and no literal minute count', !/\}, true, \d+\)/.test(block), 'no `}, true, <number>)`');

console.log(failures === 0 ? 'build_timeout: all checks passed' : `build_timeout: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
