/**
 * Pure tests for the `!blueprints` query (docs/gaps/operational.exec.md item 1). No server:
 *   bun tests/blueprints_query.test.mjs
 *
 * The root cause this command fixes: compact command docs render only `name:type` for a
 * param, never its description - so `file:string` on !buildBlueprint/!buildStatus gave the
 * model nothing but "a string", and it invented "file.json". Nothing enumerated the directory.
 * `summarizeBlueprint`/`formatBlueprintList` are the pure half; the `fs` read is a few lines in
 * the query's own `perform`, mirrored from `blueprint_builder.js`'s `placements || raw` shape
 * rather than imported from it (a different workstream owns that file for this pass).
 */
// Import index.js FIRST: queries.js and index.js import each other (queries.js needs
// getCommandDocs for !help; index.js needs queryList to build commandList), and whichever
// module a test imports first is the one that starts mid-initialized on the circular edge.
// Both `getCommandDocs`/`compactDescription` (index.js) and `queryList` (queries.js) are
// function/const declarations reached only at call time, not at module-top-level, so the only
// thing that actually matters is import ORDER in this file - not in the app itself, which
// never hits this because nothing there imports queries.js before index.js finishes.
import { compactDescription } from '../src/agent/commands/index.js';
import { summarizeBlueprint, formatBlueprintList } from '../src/agent/commands/queries.js';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}:\n  got  ${g}\n  want ${w}`); failures++; }
};
const contains = (label, got, want) => {
    if (!got.includes(want)) { console.error(`FAIL ${label}: ${JSON.stringify(want)} missing from ${JSON.stringify(got)}`); failures++; }
};

// --- summarizeBlueprint -------------------------------------------------------------------
check('a real placements shape',
    summarizeBlueprint({ meta: { name: 'Base' }, placements: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 2, z: 5 }] }),
    { count: 2, size: { width: 4, height: 3, length: 6 }, name: 'Base' });

check('a bare array (no meta/placements wrapper) still reads',
    summarizeBlueprint([{ x: 0, y: 0, z: 0 }]),
    { count: 1, size: { width: 1, height: 1, length: 1 }, name: null });

check('empty placements array', summarizeBlueprint({ placements: [] }), { count: 0, size: null, name: null });
check('no placements key at all', summarizeBlueprint({}), { count: 0, size: null, name: null });
check('junk input does not throw', summarizeBlueprint(null), { count: 0, size: null, name: null });
check('placements with garbage entries are skipped, not counted toward the bbox',
    summarizeBlueprint({ placements: [{ x: 0, y: 0, z: 0 }, { name: 'no coords' }] }).size,
    { width: 1, height: 1, length: 1 });

// --- formatBlueprintList -------------------------------------------------------------------
check('empty list is a true answer, not an error', formatBlueprintList([]), 'No blueprints found in blueprints/.');
check('null list', formatBlueprintList(null), 'No blueprints found in blueprints/.');

contains('one entry names the file and the counts',
    formatBlueprintList([{ file: 'blueprints/survival_base.json', count: 3654, size: { width: 32, height: 25, length: 31 }, name: 'Unnamed' }]),
    'blueprints/survival_base.json: 3654 blocks, 32x25x31');

// An unreadable entry must not hide the readable ones next to it.
const mixed = formatBlueprintList([
    { file: 'blueprints/good.json', count: 10, size: { width: 2, height: 2, length: 2 }, name: null },
    { file: 'blueprints/bad.json', error: 'Unexpected token in JSON' },
]);
contains('a good entry survives next to a bad one', mixed, 'blueprints/good.json: 10 blocks');
contains('the bad entry says unreadable, not silently dropped', mixed, 'blueprints/bad.json (unreadable: Unexpected token in JSON)');

// --- the cross-reference survives compaction (CLAUDE.md: overlapping commands must cite each
// other, and the measured rule is that this is a prohibition/pointer, not prose) ----------------
contains('buildStatus points at !blueprints after compaction',
    compactDescription('Diff the world against a blueprint JSON: how much is built, and the nearest wrong blocks as Place/Replace fixes. Use !blueprints to list valid file paths.'),
    'Use !blueprints to list valid file paths.');
contains('buildBlueprint points at !blueprints after compaction',
    compactDescription('Hand-build a blueprint JSON block by block, flying to each position and placing by hand. Slow, but leaves a survival-legal build. Use !blueprints to list valid file paths.'),
    'Use !blueprints to list valid file paths.');

console.log(failures === 0 ? 'blueprints_query: all checks passed' : `blueprints_query: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
