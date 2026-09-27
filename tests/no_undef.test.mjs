/**
 * Does every identifier this code uses actually exist?
 *
 *   bun tests/no_undef.test.mjs
 *
 * WHY THIS EXISTS, measured 2026-09-23. Removing a superseded escape mechanism also removed the
 * constant `RESCUE_GIVE_UP` that a DIFFERENT function still referenced. The module imported fine,
 * every unit suite passed, and the defect only appeared in a live build as
 *
 *     3x"threw: RESCUE_GIVE_UP is not defined"
 *
 * - by which time a bot that could not be freed was looping on one cell instead of stopping with a
 * reason, because the escalation threw before it could fire.
 *
 * The check that was being relied on - `bun -e "await import('...')"` - cannot catch this. An
 * import only evaluates the top level; a name used inside a function body is not resolved until
 * that line runs, and the lines that run rarely are exactly the error paths. Deleting code is when
 * this happens, and deleting code is something this repo does on purpose.
 *
 * Scoped to `no-undef` deliberately: style findings in files other sessions own are not this
 * suite's business, and a test that fails for someone else's semicolon gets disabled.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

const FILES = fs.readdirSync('src/agent/library')
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/agent/library/${f}`);

let out = '';
try {
    out = execFileSync('node_modules/.bin/eslint', ['-f', 'json', ...FILES], { encoding: 'utf8' });
} catch (e) {
    // eslint exits non-zero when it finds anything; the report is still on stdout.
    out = e.stdout || '';
}
if (!out.trim()) {
    console.log('no_undef: SKIP (eslint produced no report - is it installed?)');
    process.exit(0);
}

const report = JSON.parse(out);
const undef = [];
for (const file of report) {
    for (const m of file.messages) {
        if (m.ruleId !== 'no-undef') continue;
        // Globals the flat eslint config does not declare but that genuinely exist at runtime.
        // These are NOT missing symbols, and listing them here is cheaper than widening the
        // project's lint config on behalf of files other sessions own:
        //   process     - node.
        //   Compartment - injected by SES once `lockdown()` has run (lockdown.js:34 constructs
        //                 one, and the file itself warns when SES is absent).
        if (/'(process|Compartment)' is not defined/.test(m.message)) continue;
        undef.push(`${file.filePath.replace(process.cwd() + '/', '')}:${m.line}  ${m.message}`);
    }
}

console.log(`checked ${FILES.length} library file(s)`);
if (undef.length) {
    console.log(`FAIL ${undef.length} undefined identifier(s) - these throw only when the line runs:`);
    for (const u of undef) console.log(`  ${u}`);
    process.exit(1);
}
console.log('no_undef: every identifier resolves');
process.exit(0);
