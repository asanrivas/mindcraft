/**
 * The pure parts of the training-corpus pipeline:
 *   bun tests/corpus.test.mjs
 *
 * These four functions decide whether a captured turn survives into a dataset intact. The
 * failures they guard against are all silent - a corrupted system prompt, a docs block left
 * inline, a log file sliced at the wrong marker - and none of them would throw. They would
 * just produce a plausible-looking dataset that teaches the model the wrong thing.
 */
import { splitDocs, restoreDocs, docsHash, docsSentinel } from '../src/utils/corpus.js';
import { parseLog, findDocsBlock } from '../tools/corpus_import.mjs';
import { templateKey, commandsIn, classifyResult } from '../tools/harvest.mjs';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}: got ${g}, expected ${w}`); failures++; }
};

// --- splitDocs / restoreDocs ------------------------------------------------------------------
const DOCS = '*CMDS - syntax: !cmd*\n!stats: get stats\n!inventory: list items\n*\n';
const PROMPT = `You are andy.\n${DOCS}\nExamples:\nfoo\nConversation:`;

{
    const { body, sha } = splitDocs(PROMPT, DOCS);
    check('docs are lifted out of the body', body.includes('!inventory'), false);
    check('a sentinel is left in their place', body.includes(docsSentinel(sha)), true);
    check('teacher form restores the prompt byte-for-byte', restoreDocs(body, sha, DOCS), PROMPT);
    check('student form drops them entirely', restoreDocs(body, sha, '').includes('!inventory'), false);
    // The student prompt is the training input; a leaked sentinel would be a token the model
    // never sees at inference time.
    check('...and leaves no sentinel behind', restoreDocs(body, sha, '').includes('COMMAND_DOCS'), false);
    check('hash is stable', sha, docsHash(DOCS));
}

// Degrading safely matters more than degrading cleverly: if the prompt format changes and the
// docs are no longer found verbatim, storing the record WHOLE costs disk. Guessing at a
// boundary would silently truncate the system prompt of every example.
check('unmatched docs store the prompt whole', splitDocs('no docs here', DOCS),
      { body: 'no docs here', sha: null });
check('missing docs argument is not an error', splitDocs(PROMPT, null), { body: PROMPT, sha: null });
check('null prompt is not an error', splitDocs(null, DOCS), { body: '', sha: null });
check('restore without a sha is a no-op', restoreDocs('abc', null, DOCS), 'abc');

// --- parseLog ---------------------------------------------------------------------------------
// The real bug this exists for: the conversing profile ENDS with its own "Conversation:"
// header, so a rendered prompt contains the delimiter too. Taking the first match sliced the
// prompt in half and 53 of 56 files failed to parse. Newlines are escaped inside the JSON
// blob, so the log's own marker is always the last literal one.
{
    const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const promptWithDecoy = `You are andy.\n${DOCS}\nsome text\n\nConversation:\n`;
    const file = `[2026-08-29T06-48-39-807Z] \nPrompt:\n${promptWithDecoy}` +
                 `\n\nConversation:\n${JSON.stringify(messages, null, 2)}` +
                 `\n\nResponse:\n!stats\n\n`;
    const p = parseLog(file);
    check('a decoy "Conversation:" in the prompt does not split it', p !== null, true);
    check('...the prompt is recovered whole', p.prompt, promptWithDecoy);
    check('...the messages parse', p.messages.length, 2);
    check('...the response is recovered', p.response, '!stats');
    check('...the stamp becomes ISO', p.ts, '2026-08-29T06:48:39.807Z');
}
check('a truncated file is skipped, not guessed at', parseLog('[2026-01-01T00-00-00-000Z] \nPrompt:\nx'), null);
check('unparseable messages are skipped', parseLog(
    '[2026-01-01T00-00-00-000Z] \nPrompt:\nx\n\nConversation:\n{not json\n\nResponse:\ny\n'), null);

// --- findDocsBlock ----------------------------------------------------------------------------
// Only used for backfilling old logs, where the exact docs string is gone.
check('finds a compact docs block', findDocsBlock(PROMPT), DOCS);
check('finds a minimal docs block',
      findDocsBlock('hi\n*COMMANDS: Use !cmd*\n!a, !b\n*\nbye') !== null, true);
check('returns null rather than guessing when absent', findDocsBlock('no docs at all'), null);
check('returns null when the block never closes', findDocsBlock('*CMDS - syntax: x*\n!a'), null);

// --- templateKey ------------------------------------------------------------------------------
// The imbalance this defends against is real: 3,412 VERIFIED SHELTER against 22 TRAVEL. Two
// replies that differ only in coordinates are one training signal, not two.
check('coordinates collapse to one template',
      templateKey("Got it! I'm at x: 4611, y: 111, z: 4702.") ===
      templateKey("Got it! I'm at x: -22, y: 64, z: 5034."), true);
check('quoted arguments collapse too',
      templateKey('!collectBlocks("oak_log", 10)') === templateKey('!collectBlocks("stone", 3)'), true);
// ...but genuinely different behaviour must NOT collapse, or the cap silently deletes variety.
check('different commands stay distinct',
      templateKey('!travel("west", 40)') === templateKey('!dive(3)'), false);
check('different prose stays distinct',
      templateKey('Sure, digging now.') === templateKey('I cannot reach that.'), false);

// --- commandsIn -------------------------------------------------------------------------------
check('extracts commands', commandsIn('ok !stats then !travel("west", 5)'), ['stats', 'travel']);
check('plain chat yields none', commandsIn('Hello there!'), []);

// --- classifyResult ---------------------------------------------------------------------------
// The first version scanned whole log lines for words like "failed" or "stuck" and labelled
// 52.7% of the corpus as failed. Nearly all of it was the agent's own prompt echoed into the
// log. These are the exact strings that produced the false positives.
for (const echo of [
    "Example: Code output: Could not find any oak_log in 20 blocks.",
    "Your behavior log: I'm stuck!",
    "- Viewing chest contents can time out (code execution refused)",
    "WARN: Error with embedding model, using word-overlap instead.",
    "- Handle idle timeouts gracefully by notifying users of reconnection.",
])
    check(`prompt echo is not an outcome: ${echo.slice(0, 32)}...`,
          classifyResult([echo]).outcome !== 'failed', true);

// Two defences, and it matters which is doing the work. Text like "Failed to load
// node-canvas-webgl" IS a failure when read as a result body, and classifyResult says so - it
// is kept out of the corpus STRUCTURALLY, by only ever being handed the body of an
// "Agent executed: !cmd and got:" block, which a startup warning is never inside. Do not
// "fix" this by adding startup strings to the text patterns; that would start excluding real
// failures that happen to be worded the same way.
check('a failure verb in a RESULT body is still a failure',
      classifyResult(['Failed to load node-canvas-webgl']).outcome, 'failed');

check('VERIFIED wins', classifyResult(['VERIFIED TRAVEL: moved 100/100 blocks']),
      { outcome: 'verified', verified: 'TRAVEL' });
check('navigator success', classifyResult(['NAV: arrived=true covered=9.0 replans=0']).outcome, 'verified');
check('navigator failure', classifyResult(['NAV: arrived=false covered=0.0 replans=2']).outcome, 'failed');
check('a self-reported refusal is a failure',
      classifyResult(['Refused: rescue teleport is disabled. Walk there instead.']).outcome, 'failed');
check('an explicit timeout is a failure',
      classifyResult(['[placeBlock] pathfinder goto timed out after 4000ms']).outcome, 'failed');
// A query result is neither a success nor a failure, and calling it either would poison the
// label for every !stats and !inventory turn.
check('a query result is quiet', classifyResult(['STATS', 'Position: x:1, y:2, z:3']).outcome, 'quiet');
check('an empty body is quiet', classifyResult([]).outcome, 'quiet');
check('null body is not an error', classifyResult(null).outcome, 'quiet');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('corpus: all checks passed');
