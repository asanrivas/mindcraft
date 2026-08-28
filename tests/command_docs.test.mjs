/**
 * Compact command docs, as a pure function. No server, no bot:
 *   bun tests/command_docs.test.mjs
 *
 * WHY THIS IS TESTED. `command_docs_mode: "compact"` used to render a description as
 * `description.split('.')[0]` capped at 60 chars. Both halves of that were wrong, and both
 * failures were invisible - the docs still looked fine, they were just missing the part that
 * told the model which command to pick:
 *
 *   1. THE DISAMBIGUATION LIVES IN THE SECOND SENTENCE. "Use this instead of !collectBlocks
 *      for ores" (!branchMine), "Do NOT use to build structures" (!placeHere), "Disabled
 *      unless a marker file is present; not usable for travel" (!serverTp), "Use when stuck
 *      underground" (!climbOut - the only thing separating it from !goToSurface). Every one
 *      of those was deleted before the model ever saw it.
 *
 *   2. SPLITTING ON A BARE "." BREAKS MID-ABBREVIATION. !climbBankTest rendered as
 *      "Debug: repeatedly attempt swim" (split inside `swim.climbBank`), which reads like an
 *      ordinary swim command rather than a debug harness. !marathonRoute rendered as
 *      "Set an explicit checkpoint marathon from coordinates, e" - taking with it the
 *      `"4412,4934 4362,5021 ..."` example, the ONLY documentation of its argument format.
 *
 * The follow-up sentences kept are the imperative ones (KEEP_SENTENCE). Prose second
 * sentences - "This includes a breakdown of required ingredients..." (!getCraftingPlan) - are
 * still dropped, because the budget exists to be spent on choosing, not on describing.
 */
import { compactDescription } from '../src/agent/commands/index.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); failures++; }
};
const contains = (label, got, want) => {
    if (!got.includes(want)) { console.error(`FAIL ${label}: ${JSON.stringify(want)} missing from ${JSON.stringify(got)}`); failures++; }
};
const omits = (label, got, want) => {
    if (got.includes(want)) { console.error(`FAIL ${label}: ${JSON.stringify(want)} should have been dropped from ${JSON.stringify(got)}`); failures++; }
};

// --- the abbreviation bugs, verbatim from the descriptions that produced them -------------
check('swim.climbBank is not a sentence end',
    compactDescription('Debug: repeatedly attempt swim.climbBank toward a compass direction for N seconds.'),
    'Debug: repeatedly attempt swim.climbBank toward a compass direction for N seconds.');

check('e.g. is not a sentence end',
    compactDescription('Set an explicit checkpoint marathon from coordinates, e.g. "4412,4934 4362,5021 ...".'),
    'Set an explicit checkpoint marathon from coordinates, e.g. "4412,4934 4362,5021 ...".');

check('e.g., inside parentheses survives',
    compactDescription('Give a friendly name to a chest at specific coordinates for easy access later (e.g., "ores", "food", "building").'),
    'Give a friendly name to a chest at specific coordinates for easy access later (e.g., "ores", "food", "building").');

// --- the disambiguating second sentence must survive ---------------------------------------
contains('branchMine keeps its cross-reference',
    compactDescription('Dig down and branch-mine for ores, then return to where you started. Use this instead of !collectBlocks for ores.'),
    'Use this instead of !collectBlocks for ores.');

contains('placeHere keeps its prohibition',
    compactDescription('Place a given block next to you. Do NOT use to build structures, only use for single blocks/torches/beds.'),
    'Do NOT use to build structures');

contains('serverTp keeps the guard, not just "Operator rescue only"',
    compactDescription('Operator rescue only. Disabled unless a marker file is present; not usable for travel.'),
    'not usable for travel');

contains('climbOut keeps the "when" that separates it from !goToSurface',
    compactDescription('Cut a staircase up to the surface. Use when stuck underground in a cave or tunnel.'),
    'Use when stuck underground');

contains('stay keeps "Pauses all modes" - the difference from !stop',
    compactDescription('Stay in the current location no matter what. Pauses all modes.'),
    'Pauses all modes.');

contains('endGoal keeps its refusal condition',
    compactDescription('Call when you have accomplished your goal. It will stop self-prompting and the current action. Refused if the last build verification showed the work is incomplete.'),
    'Refused if the last build verification');

// A kept sentence may sit behind a dropped one: serverFill's argument order is sentence 3.
contains('a kept sentence is reachable past a dropped one',
    compactDescription('PREFERRED for building. Instant server /fill - thousands of blocks at once, no walking. Takes BOTH corners in full 3D: (blockType, x1, y1, z1, x2, y2, z2).'),
    'Takes BOTH corners in full 3D');

// --- prose is still dropped: the budget is for choosing, not describing ---------------------
omits('a "This includes..." second sentence is dropped',
    compactDescription("Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory."),
    'This includes');

// --- bounds ---------------------------------------------------------------------------------
const longFirst = compactDescription('x'.repeat(400));
if (longFirst.length > 120) { console.error(`FAIL first sentence cap: ${longFirst.length} chars`); failures++; }
if (!longFirst.endsWith('...')) { console.error('FAIL first sentence cap: no ellipsis'); failures++; }

const manyKept = compactDescription('Short first. ' + ('Use it wisely and often. '.repeat(20)));
if (manyKept.length > 210) { console.error(`FAIL total cap: ${manyKept.length} chars`); failures++; }

check('no trailing whitespace on a single sentence', compactDescription('  Just one sentence.  '), 'Just one sentence.');

// --- the alias table is a contract ------------------------------------------------------------
// Two failures, both silent. (1) 'cf' meant chestForget while 'cfi' meant chestFind - one
// letter apart, opposite effects, and not the prefix pattern cp/cpn and ct/ctn follow, so a
// model reaching for "find" deleted a saved name. (2) 'ca' -> !fill and 'gtc' ->
// !goToCoordinates outlived their commands: both were added to blocked_actions, which splices
// them out of commandMap, but expandCommandAlias resolves against its own table and never
// checks. The alias expanded into a name nothing could look up.
import settingsReal from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
setSettings(settingsReal);
const { COMMAND_ALIASES } = await import('../src/agent/commands/index.js');
const { actionsList } = await import('../src/agent/commands/actions.js');
const { queryList } = await import('../src/agent/commands/queries.js');

const realNames = new Set([...actionsList, ...queryList].map(c => c.name));
const blocked = new Set(settingsReal.blocked_actions || []);

for (const [alias, command] of Object.entries(COMMAND_ALIASES)) {
    const name = '!' + command;
    if (!realNames.has(name)) {
        console.error(`FAIL alias '${alias}' -> ${name}, which is not a command`); failures++;
    }
    if (blocked.has(name)) {
        console.error(`FAIL alias '${alias}' -> ${name}, which is in blocked_actions - it will expand into a command that has been spliced out of commandMap`); failures++;
    }
}

// The one chest command that discards state must not be reachable by a near-miss on a
// read-only one. chestForget drops a saved label (persisted, so it is gone after a restart).
if (Object.values(COMMAND_ALIASES).includes('chestForget')) {
    console.error("FAIL chestForget has an alias - it is destructive and sits one letter from the read-only chest commands"); failures++;
}
check("'cf' resolves to the read-only command", COMMAND_ALIASES['cf'], 'chestFind');

console.log(failures === 0 ? 'command_docs: all checks passed' : `command_docs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
