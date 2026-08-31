// Obedience regression harness: 8 confusable prompts vs the live command docs, scored
// against the expected command. Run from repo root: bun scratchpad/obedience_ab.mjs
// Drives the LOCAL model with andy.json's own params; also prints the OLD-renderer docs
// score for comparison. Baselines 2026-08-29: OLD 5-6/8, NEW 7-8/8 (docs/OBEDIENCE.md §5).
//
// Also writes scratchpad/obedience.last.json = {docsHash, score, date} for the NEW-docs run,
// so tests/obedience_contract.test.mjs can tell a MEASURED regression (score < 7 against the
// exact docs it just hashed) from an UNMEASURED change (docs edited since the last time this
// harness ran) without needing a model itself. See tools/obedience_lib.mjs for the verdict.
import { writeFileSync } from 'node:fs';
process.chdir('/home/asanrivas/mindcraft');
import real from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import { hashDocs } from '../tools/obedience_lib.mjs';
setSettings(real);
const m = await import('../src/agent/commands/index.js');
m.blacklistCommands(real.blocked_actions);
const agent = { name:'andy', blocked_actions: real.blocked_actions, hidden_actions: real.hidden_actions };

const NEW = m.getCommandDocs(agent);
// Reconstruct the OLD renderer: split('.')[0], 60-char cap, and no hidden_actions (so the
// four debug harnesses + !goToSurface are back in the menu, as they were).
const { actionsList } = await import('../src/agent/commands/actions.js');
const { queryList } = await import('../src/agent/commands/queries.js');
const byName = new Map([...queryList, ...actionsList].map(c => [c.name, c.description]));
const oldTrunc = (d) => { let x = d.split('.')[0]; return x.length > 60 ? x.substring(0,57) + '...' : x; };
const OLD = NEW.split('\n').map(line => {
  const mm = line.match(/^(!\w+)(\[\w+\])?(\([^)]*\))?: /);
  if (!mm) return line;
  return line.slice(0, mm[0].length) + oldTrunc(byName.get(mm[1]));
}).join('\n') + [...byName.keys()].filter(n => (real.hidden_actions||[]).includes(n))
  .map(n => `${n}: ${oldTrunc(byName.get(n))}`).join('\n');

const CASES = [
  ['I want diamonds, go mine some', ['!branchMine']],
  ["you're stuck in a cave, get back to daylight", ['!climbOut']],
  ['check my build at 100,200 to 110,210 - is every block right?', ['!gridView']],
  ['what is the ground like at 100,200 to 110,210 before I build?', ['!scanArea']],
  ['go to 4412 64 4934', ['!navTo']],
  ['put a torch down where you are', ['!placeHere']],
  ['you are done, drop the goal', ['!endGoal']],
  ['just teleport yourself over here at 500 70 500, walking is slow', ['NONE','!travel','!navTo']],
];

const { LlamaCpp } = await import('../src/models/llamacpp.js');
// andy.json's own params for this model, so the test matches how Andy really talks to it.
const model = new LlamaCpp('qwen3.5-9b-uncensored', 'http://amyasan:8000/v1', {
    max_tokens: 120, temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5,
    chat_template_kwargs: { enable_thinking: false },
});

const sys = (docs) => `You are Andy, a Minecraft bot. Choose the single best command for the user's request.
Reply with ONLY the command call, nothing else. If no command fits, reply NONE.
${docs}`;

let newScore = null;
for (const [label, docs] of [['OLD', OLD], ['NEW', NEW]]) {
  console.log(`\n===== ${label} (${docs.length} chars) =====`);
  let hits = 0;
  for (const [req, want] of CASES) {
    let out;
    try { out = (await model.sendRequest([{role:'user', content:req}], sys(docs))).trim().split('\n')[0]; }
    catch (e) { out = 'ERR ' + e.message.slice(0,60); }
    const cmd = (out.match(/^!?[A-Za-z]+/) || [''])[0].replace(/^!?/,'!');
    const ok = want.some(w => w === 'NONE' ? /NONE/i.test(out) : cmd === w);
    if (ok) hits++;
    console.log(`  ${ok ? 'ok  ' : 'MISS'} ${req.slice(0,45).padEnd(46)} -> ${out.slice(0,50)}`);
  }
  console.log(`  ${label}: ${hits}/${CASES.length}`);
  if (label === 'NEW') newScore = hits;
}

// Per-machine, gitignored (scratchpad/*.json) - not a checked-in baseline, just "what did the
// docs look like, and how did they score" the last time someone with a live amyasan ran this.
const record = { docsHash: hashDocs(NEW), score: newScore, date: new Date().toISOString() };
writeFileSync('scratchpad/obedience.last.json', JSON.stringify(record, null, 2) + '\n');
console.log(`\nWrote scratchpad/obedience.last.json: score=${newScore}/${CASES.length} docsHash=${record.docsHash.slice(0,12)}...`);
