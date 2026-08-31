/**
 * Doc-contract test for command-selection obedience. No server, no model, no network:
 *   bun tests/obedience_contract.test.mjs
 *
 * WHY THIS IS TESTED, AND WHY IT IS SPLIT IN TWO TIERS (docs/gaps/operational.exec.md item 4).
 *
 * `scratchpad/obedience_ab.mjs` measures whether a REAL local 9B model actually picks the
 * right command when two commands could plausibly apply. CLAUDE.md's "Writing a description
 * the model will obey" section documents what that measurement found: renaming a param from
 * `depth` to `y` flipped the model 5/5, and moving a prohibition onto the TEMPTING command
 * (not the correct one) flipped it 5/5 again. That harness needs `amyasan` up, and per this
 * whole branch's premise (LLM failover), amyasan is routinely down - so it cannot be part of
 * `bun run test`.
 *
 * What CAN run offline is a check that the specific disambiguating clauses measurement found
 * are still present in the RENDERED docs - i.e. after `compactDescription` and
 * `getCommandDocs` have done their truncating, not in the raw source string. This is a
 * NECESSARY condition, not a sufficient one: it proves no known disambiguator has silently
 * regressed (a description edit, a compaction-budget change, a param rename), but it cannot
 * discover a NEW ambiguity the way a live model can. Tier 2 below is the freshness check that
 * keeps that limitation honest instead of pretending this file is the whole harness.
 *
 * Tier 1 (below, fatal): render the docs exactly the way the prompt does -
 * `setSettings(real)` -> `blacklistCommands` -> `getCommandDocs(agent)` with real
 * `hidden_actions` - and assert each measured disambiguator survives.
 *
 * Tier 2 (below, mostly non-fatal): a docs-hash freshness check against
 * `scratchpad/obedience.last.json` (gitignored, per-machine, written by
 * `scratchpad/obedience_ab.mjs`). Fatal ONLY when a prior run exists, the docs are byte-for-
 * byte what it measured, and the score it got was below the bar - i.e. a MEASURED regression.
 * An absent or stale record is a loud warning that exits 0, because a dead LLM box must not
 * block unrelated commits.
 */
import settingsReal from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
setSettings(settingsReal);
const { getCommandDocs, blacklistCommands, compactDescription } = await import('../src/agent/commands/index.js');
blacklistCommands(settingsReal.blocked_actions);
import { hashDocs, obedienceVerdict } from '../tools/obedience_lib.mjs';
import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
const check = (label, cond) => {
    if (!cond) { console.error(`FAIL ${label}`); failures++; }
};
const contains = (label, haystack, needle) => {
    if (!haystack.includes(needle)) {
        console.error(`FAIL ${label}: ${JSON.stringify(needle)} missing from rendered docs`);
        failures++;
    }
};
const omits = (label, haystack, needle) => {
    if (haystack.includes(needle)) {
        console.error(`FAIL ${label}: ${JSON.stringify(needle)} should not appear in rendered docs`);
        failures++;
    }
};
/** Grab the one docs line for a command, so an assertion can't accidentally match another line. */
function lineFor(docs, name) {
    const re = new RegExp(`^${name}\\b.*$`, 'm');
    const m = docs.match(re);
    return m ? m[0] : '';
}

// ============================================================================================
// TIER 1 - pure, fatal, renders the docs exactly as the prompt does.
// ============================================================================================

check('command_docs_mode is compact (this test pins compact-mode rendering)',
    (settingsReal.command_docs_mode || 'full') === 'compact');

const agent = { name: 'andy', blocked_actions: settingsReal.blocked_actions, hidden_actions: settingsReal.hidden_actions };
const docs = getCommandDocs(agent);

// --- !collectBlocks <-> !branchMine: the prohibition sits on the TEMPTING command ------------
// CLAUDE.md: '"Use !branchMine for ores" written on !branchMine changed nothing; "Do NOT use
// for ores - use !branchMine" on !collectBlocks flipped the 9B 5/5.'
{
    const collect = lineFor(docs, '!collectBlocks');
    contains('!collectBlocks carries its ore prohibition', collect, 'Do NOT');
    contains('!collectBlocks points at !branchMine', collect, '!branchMine');
    const branch = lineFor(docs, '!branchMine');
    contains('!branchMine cross-references !collectBlocks back', branch, '!collectBlocks');
}

// --- !branchMine's param renders as `y`, not `depth` -----------------------------------------
// CLAUDE.md: "!branchMine(depth,...) made the 9B pass a distance where an absolute Y was
// wanted - out-of-domain calls, 5/5. Renamed to `y`." Compact mode renders ONLY `name:type`,
// so this is the one place the param's identity reaches the model at all.
{
    const branch = lineFor(docs, '!branchMine');
    contains('!branchMine param renders as y:', branch, 'y:');
    omits('!branchMine param no longer renders as depth:', branch, 'depth:');
}

// --- overlapping pairs must cross-reference each other ---------------------------------------
const pairs = [
    ['!scanArea', '!gridView'],
    ['!nearbyBlocks', '!surroundings'],
];
for (const [a, b] of pairs) {
    const lineA = lineFor(docs, a);
    const lineB = lineFor(docs, b);
    check(`${a} line exists`, lineA.length > 0);
    check(`${b} line exists`, lineB.length > 0);
    contains(`${a} cross-references ${b}`, lineA, b);
    contains(`${b} cross-references ${a}`, lineB, a);
}

// --- the chest list/find/named family -------------------------------------------------------
{
    const chestFind = lineFor(docs, '!chestFind');
    contains('!chestFind cross-references !chestList', chestFind, '!chestList');
    const chestListNamed = lineFor(docs, '!chestListNamed');
    contains('!chestListNamed cross-references !chestPutNamed', chestListNamed, '!chestPutNamed');
    contains('!chestListNamed cross-references !chestTakeNamed', chestListNamed, '!chestTakeNamed');
    contains('!chestListNamed cross-references !chestList', chestListNamed, '!chestList');
}

// --- !climbOut keeps the "when" that separates it from the hidden !goToSurface ---------------
{
    const climbOut = lineFor(docs, '!climbOut');
    contains('!climbOut keeps its "Use when" disambiguator', climbOut, 'Use when');
    contains('!climbOut names the situation (buried/stuck)', climbOut, 'stuck');
}

// --- !placeHere keeps its prohibition ---------------------------------------------------------
contains('!placeHere keeps "Do NOT use to build structures"', lineFor(docs, '!placeHere'), 'Do NOT use to build structures');

// --- hidden harness commands must not reach the model's docs at all --------------------------
// settings.js hidden_actions: measurement harnesses a person drives by hand. CLAUDE.md:
// "!climbBankTest rendered in the compact docs as 'Debug: repeatedly attempt swim' - which
// reads like an ordinary swim command." They must be entirely absent, not merely truncated.
for (const name of (settingsReal.hidden_actions || [])) {
    omits(`hidden action ${name} does not appear in rendered docs`, docs, name + '(');
    omits(`hidden action ${name} does not appear in rendered docs (no-param form)`, docs, name + ':');
}
check('hidden_actions is non-empty (this loop would pass vacuously otherwise)', (settingsReal.hidden_actions || []).length > 0);

// --- params are self-explanatory bare: no command should render a bare single-letter or ------
// generically-named param that the model has no other way to disambiguate (compact mode shows
// ONLY `name:type` - CLAUDE.md: "the param NAME is the only param documentation compact mode
// shows"). This is a narrow, evidence-derived check, not a general style rule: the only case
// measurement actually flagged is `depth` on !branchMine, asserted above. Here we just confirm
// no OTHER command reintroduced a bare `depth` param that isn't !dive's (documented distance).
{
    const depthLines = docs.split('\n').filter(l => /\bdepth:num\b/.test(l));
    for (const l of depthLines) {
        check(`bare 'depth:' param only on !dive (found: ${l.split('(')[0]})`, l.startsWith('!dive'));
    }
}

// ============================================================================================
// TIER 2 - docs-hash freshness check against the live harness's last recorded run.
// Non-fatal except for a MEASURED regression (fresh-fail). See obedienceVerdict() for the
// four branches and tools/obedience_lib.mjs for why they are split this way.
// ============================================================================================
{
    const currentHash = hashDocs(docs);
    const lastPath = 'scratchpad/obedience.last.json';
    let last = null;
    if (existsSync(lastPath)) {
        try { last = JSON.parse(readFileSync(lastPath, 'utf8')); } catch { /* corrupt - treat as absent */ }
    }
    const verdict = obedienceVerdict(currentHash, last);
    switch (verdict) {
        case 'unmeasured':
            console.warn('WARN: no scratchpad/obedience.last.json found - command docs have '
                + 'never been measured against a live model on this machine. Run '
                + '`bun scratchpad/obedience_ab.mjs` (needs amyasan) to measure them.');
            break;
        case 'stale':
            console.warn('WARN: command docs changed since the last measured obedience run - '
                + 'run `bun scratchpad/obedience_ab.mjs` to re-measure.');
            break;
        case 'fresh-pass':
            console.log(`obedience: docs unchanged since last measured run, score ${last.score} - OK`);
            break;
        case 'fresh-fail':
            console.error(`FAIL obedience: docs unchanged since last measured run, but scored `
                + `${last.score} (< 7) - a real, measured regression. Re-check the descriptions `
                + `changed since the previous passing run.`);
            failures++;
            break;
    }
}

// --- pure verdict function itself: all four branches, no model, no filesystem ----------------
check("obedienceVerdict: no record -> 'unmeasured'", obedienceVerdict('abc', null) === 'unmeasured');
check("obedienceVerdict: record missing docsHash -> 'unmeasured'", obedienceVerdict('abc', { score: 8 }) === 'unmeasured');
check("obedienceVerdict: hash mismatch -> 'stale'", obedienceVerdict('abc', { docsHash: 'xyz', score: 8 }) === 'stale');
check("obedienceVerdict: hash match, score >= bar -> 'fresh-pass'", obedienceVerdict('abc', { docsHash: 'abc', score: 7 }) === 'fresh-pass');
check("obedienceVerdict: hash match, score < bar -> 'fresh-fail'", obedienceVerdict('abc', { docsHash: 'abc', score: 6 }) === 'fresh-fail');
check("obedienceVerdict: custom minScore respected", obedienceVerdict('abc', { docsHash: 'abc', score: 5 }, { minScore: 5 }) === 'fresh-pass');
check("hashDocs is deterministic", hashDocs('same input') === hashDocs('same input'));
check("hashDocs distinguishes different input", hashDocs('a') !== hashDocs('b'));

console.log(failures === 0 ? 'obedience_contract: all checks passed' : `obedience_contract: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
