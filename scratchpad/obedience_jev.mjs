// Jev column for the obedience harness: the same 8 confusable prompts as
// `scratchpad/obedience_ab.mjs`, scored the same way, but answered by a System One model
// (typesafe.ai's jev-1.13) returning a typed CHOICE over the command list instead of by a
// chat model returning text.
//
//   bun scratchpad/obedience_jev.mjs [runs]        # default 1 run per variant
//
// Needs TYPESAFE_API_KEY in the environment. Needs no Minecraft server, no RCON and no
// amyasan - which is the point: `obedience_ab.mjs` cannot run while the local LLM box is
// down, and on this branch it routinely is (docs/OBEDIENCE.md "Not done" §f, §h).
//
// WHY A SECOND HARNESS RATHER THAN A THIRD COLUMN IN THE FIRST ONE. The two measure
// different things and must not be confused for each other:
//
//   - obedience_ab.mjs measures THE DOCS AS THE AGENT USES THEM - one rendered string in a
//     system prompt, answered in free text that has to be parsed back. That is the real
//     path, and its score is the one `tests/obedience_contract.test.mjs` gates on.
//   - this file measures WHETHER THE CHOICE IS RECOVERABLE AT ALL from the descriptions,
//     with the renderer's 210-char budget out of the way. The command list becomes `criteria`
//     (93 options + NONE, ~9.1k chars compact / ~10.6k full, nowhere near Jev's 32k state
//     budget - the whole menu fits with room to spare), and the answer
//     comes back as a name plus a probability distribution - so a tie is VISIBLE instead of
//     being resolved into confident-sounding prose.
//
// It therefore runs TWO variants, which is where the value is:
//
//   COMPACT - criteria are `compactDescription(...)`, exactly the text the agent's model
//             gets today. A miss here is a miss the live agent is also exposed to.
//   FULL    - criteria are the untruncated descriptions from the source. A case that misses
//             on COMPACT and passes on FULL is a RENDERER problem, not a model problem: the
//             disambiguator exists and was deleted before anybody saw it.
//
// That comparison is what this file found on its first run (2026-09-20): "you are done, drop
// the goal" split NONE 0.45 / !endGoal 0.29 / !stop 0.14 on COMPACT - 7/8 - and passed on
// FULL at !endGoal 0.68. Cause: !endGoal's second sentence opened with "It will stop...",
// and compactDescription() keeps a follow-up sentence only when it opens with a
// KEEP_SENTENCE imperative - so the one clause distinguishing !endGoal from !stop never
// reached any model. Reworded to "Will stop..." (actions.js, comment there); both variants
// now score 8/8, 3 runs of 3. This is docs/OBEDIENCE.md §1 recurring on a command that
// sweep did not cover, which is the class of thing this harness exists to catch.
//
// Baselines, all on the 8 cases below:
//   qwen3.5-9B local, OLD renderer   5-6/8   (docs/OBEDIENCE.md §5)
//   qwen3.5-9B local, NEW renderer   7-8/8   (docs/OBEDIENCE.md §5)
//   jev-1.13 COMPACT                 8/8     3 runs of 3, 2026-09-20, after the !endGoal fix
//   jev-1.13 FULL                    8/8     3 runs of 3, 2026-09-20
//   jev-1.13 COMPACT, pre-fix        7/8     the run that found the !endGoal defect
//   ~300ms and ~3.6k input tokens per decision; input-only billing, ~$0.00015 a call.
//
// NOTE ON SCOPE: this scores COMMAND SELECTION ONLY, exactly as obedience_ab.mjs does. It
// says nothing about argument filling, and arguments are where Jev must NOT be used - it
// does not count or compare magnitudes reliably (its own jaggedness page says so), so
// coordinates and quantities stay in code. Selecting among candidates code has already
// extracted is the supported shape.
import { writeFileSync } from 'node:fs';
import real from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { hashDocs } from '../tools/obedience_lib.mjs';

setSettings(real);
const m = await import('../src/agent/commands/index.js');
m.blacklistCommands(real.blocked_actions);
const { actionsList } = await import('../src/agent/commands/actions.js');
const { queryList } = await import('../src/agent/commands/queries.js');

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) {
    console.error('TYPESAFE_API_KEY is not set - this harness needs it. Nothing measured.');
    process.exit(2);
}
const RUNS = Number(process.argv[2] || 1);

// The command menu, filtered the way getCommandDocs() filters it: blocked_actions are gone
// for everyone, hidden_actions stay chat-callable but must never be offered to a model.
const blocked = new Set(real.blocked_actions || []);
const hidden = new Set(real.hidden_actions || []);
const visible = [...queryList, ...actionsList]
    .filter(c => !blocked.has(c.name) && !hidden.has(c.name));

const NONE_DESC = 'No command fits this message, or the right response is plain conversation '
    + 'rather than an action.';

// The question itself. Jev is not asked to write a call - only to pick which command the
// message is asking for. "those redirections are binding" is load-bearing: half these
// descriptions end in "Do NOT use for X - use !other", and that IS the answer for the cases
// the harness is built out of.
const INSTRUCTIONS = 'A player has sent a chat message to Andy, a Minecraft bot. Andy answers '
    + 'by calling exactly one command. Each option below is one of Andy\'s commands and what '
    + 'it does; some options explicitly say when to use a different command instead, and '
    + 'those redirections are binding. Which single command should Andy call for '
    + '`message.text`? Choose NONE if no command fits.';

// Same 8 cases as obedience_ab.mjs, same accepted answers. Keep the two lists in step: a case
// that only exists in one file cannot be compared across harnesses, which is the whole point.
const CASES = [
    ['I want diamonds, go mine some', ['!branchMine']],
    ["you're stuck in a cave, get back to daylight", ['!climbOut']],
    ['check my build at 100,200 to 110,210 - is every block right?', ['!gridView']],
    ['what is the ground like at 100,200 to 110,210 before I build?', ['!scanArea']],
    ['go to 4412 64 4934', ['!navTo']],
    ['put a torch down where you are', ['!placeHere']],
    ['you are done, drop the goal', ['!endGoal']],
    ['just teleport yourself over here at 500 70 500, walking is slow', ['NONE', '!travel', '!navTo']],
];

/**
 * One Choice question against the live API. Retries only what is worth retrying: a network
 * failure or a 5xx/429 is transient, a 4xx is a bug in this file and must surface loudly
 * rather than be hidden behind three more identical attempts.
 * @returns {Promise<{choice: string, confidence: number, probabilities: Object, ms: number, usage: Object}>}
 */
async function ask(message, criteria, tries = 3) {
    const body = JSON.stringify({
        state: { message: { from: 'a player', text: message } },
        model: 'jev-latest',
        questions: { command: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
    });
    for (let attempt = 1; ; attempt++) {
        const t0 = Date.now();
        let res, text;
        try {
            res = await fetch('https://api.typesafe.ai/v1/systemone', {
                method: 'POST',
                headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
                body,
            });
            text = await res.text();
        } catch (err) {
            if (attempt >= tries) throw new Error(`network: ${err.message}`);
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
        }
        if (!res.ok) {
            const transient = res.status === 429 || res.status >= 500;
            if (!transient || attempt >= tries) {
                throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            }
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
        }
        const parsed = JSON.parse(text);
        const a = parsed.answers.command;
        return {
            choice: a.choice,
            confidence: a.confidence ?? NaN,
            probabilities: a.probabilities || {},
            ms: Date.now() - t0,
            usage: parsed.usage || {},
        };
    }
}

/** The three highest-probability options, for reading a near-tie off the line. */
function top3(probabilities) {
    return Object.entries(probabilities)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(' ');
}

const variants = {
    COMPACT: Object.fromEntries(visible.map(c => [c.name, m.compactDescription(c.description)])),
    FULL: Object.fromEntries(visible.map(c => [c.name, c.description])),
};

const summary = {};
for (const [label, base] of Object.entries(variants)) {
    const criteria = { ...base, NONE: NONE_DESC };
    const chars = Object.entries(criteria).reduce((n, [k, v]) => n + k.length + v.length, 0);
    console.log(`\n===== JEV ${label} (${Object.keys(criteria).length} options, ${chars} chars of criteria) =====`);
    const scores = [];
    let tokens = 0;
    for (let run = 0; run < RUNS; run++) {
        let hits = 0;
        for (const [message, want] of CASES) {
            let line, ok = false;
            try {
                const a = await ask(message, criteria);
                ok = want.includes(a.choice);
                tokens += a.usage.input_tokens || 0;
                line = `${a.choice.padEnd(16)} conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms  [${top3(a.probabilities)}]`;
            } catch (err) {
                line = `ERR ${err.message.slice(0, 80)}`;
            }
            if (ok) hits++;
            console.log(`  ${ok ? 'ok  ' : 'MISS'} ${message.slice(0, 46).padEnd(47)} -> ${line}`);
        }
        scores.push(hits);
        console.log(`  run ${run + 1}: ${hits}/${CASES.length}`);
    }
    summary[label] = scores;
    console.log(`  JEV ${label}: ${scores.join(', ')} of ${CASES.length}   (~${tokens} input tokens total)`);
}

console.log('\n--- baselines, same 8 cases ---');
console.log('  qwen3.5-9B OLD renderer: 5-6/8   NEW renderer: 7-8/8   (docs/OBEDIENCE.md §5)');
for (const [label, scores] of Object.entries(summary)) console.log(`  jev-1.13 ${label}: ${scores.join(', ')} of 8`);

// Recorded under its OWN name. tests/obedience_contract.test.mjs reads
// scratchpad/obedience.last.json and treats it as the live-model measurement of the docs the
// AGENT uses; writing this run there would claim a measurement of a path that was never
// exercised. Nothing reads this file yet - it exists so a later session can tell whether a
// recorded Jev score still matches the docs as they render today.
const agent = { name: 'andy', blocked_actions: real.blocked_actions, hidden_actions: real.hidden_actions };
writeFileSync('scratchpad/obedience_jev.last.json', JSON.stringify({
    docsHash: hashDocs(m.getCommandDocs(agent)),
    model: 'jev-1.13',
    runs: RUNS,
    scores: summary,
    date: new Date().toISOString(),
}, null, 2));
console.log('\nwrote scratchpad/obedience_jev.last.json');
