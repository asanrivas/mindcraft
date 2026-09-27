/**
 * The Jev second opinion on memory duplicates.
 *
 *   bun tests/memory_fold_jev.test.mjs
 *
 * No network: the API is a fake. The live model's accuracy is scratchpad/fold_gym.mjs (union
 * 43/51, 0 false merges at 0.75). This suite holds the code around it to what makes that number
 * safe to act on:
 *   - it asks ONLY about pairs the store's own rule declines (the union, not a replacement);
 *   - a hint can merge, never lose: a user-authored or vanished target is ignored, not obeyed;
 *   - every merge it causes is logged with both texts; every failure leaves the store's own
 *     behaviour exactly as it was.
 */
import fs from 'fs';
import settings, { setSettings } from '../src/agent/settings.js';
import { MemoryStore, KIND, ORIGIN, wouldFold, legacyProseEntries, foldHintKey } from '../src/agent/memory_store.js';
import {
    planFolds, ruleTargets, unionCandidates, decide, announceConflicts, FOLD_THRESHOLD, VETO_THRESHOLD, CANDIDATES_PER_LINE,
} from '../src/agent/memory_fold_jev.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

const KEY = 'TEST_FOLD_KEY';
const base = { ...settings };
const configure = (c) => setSettings({ ...base, memory_fold_jev: { key_env: KEY, ...c } });
process.env[KEY] = 'k';
const quiet = () => {};

// A pair the Jaccard rule declines (rewritten vocabulary) - the kind of pair the union exists for.
const OLD = 'Never dig straight down because you can fall into lava or a cave.';
const NEW = 'Digging directly beneath yourself risks dropping into a lava pool.';
const store = () => {
    const s = new MemoryStore({ log: quiet });
    s.put({ kind: KIND.LESSON, key: 'dig', value: OLD, origin: ORIGIN.AGENT });
    return s;
};
const summary = `## Lessons\n- ${NEW}\n`;
const yes = (p) => async () => ({ ok: true, json: async () => ({ answers: { same: { noul: p } } }) });

check('the threshold is the measured one, not a knob', FOLD_THRESHOLD, 0.75);
check('the veto floor is the measured one', VETO_THRESHOLD, 0.2);
check('CONTROL: the store rule does NOT fold this pair on its own', wouldFold(OLD, NEW), false);

// --- which rows get asked about -------------------------------------------------------------------
const recs = [...store().records.values()];
check('a rule-declined near duplicate is a union candidate', unionCandidates(recs, KIND.LESSON, NEW).length, 1);
check('...and not a rule target', ruleTargets(recs, KIND.LESSON, NEW).length, 0);
check('a line the rule folds IS a rule target (so the veto can see it)', ruleTargets(recs, KIND.LESSON, OLD.toUpperCase()).length, 1);
check('another kind is never asked about', unionCandidates(recs, KIND.NOTE, NEW).length + ruleTargets(recs, KIND.NOTE, NEW).length, 0);
check('a line sharing no content words is never a candidate', unionCandidates(recs, KIND.LESSON, 'Cows give milk.').length, 0);
const userStore = new MemoryStore({ log: quiet });
userStore.put({ kind: KIND.LESSON, key: 'dig', value: OLD, origin: ORIGIN.USER });
check('a user-authored row is never a union candidate', unionCandidates([...userStore.records.values()], KIND.LESSON, NEW).length, 0);
const many = new MemoryStore({ log: quiet });
for (let i = 0; i < 6; i++) many.put({ kind: KIND.LESSON, key: `k${i}`, value: `lava pool digging risk number ${i} alpha${i}`, origin: ORIGIN.AGENT });
check(`at most ${CANDIDATES_PER_LINE} union questions per line`, unionCandidates([...many.records.values()], KIND.LESSON, NEW).length <= CANDIDATES_PER_LINE, true);

// --- the policy -------------------------------------------------------------------------------------
const agentRow = (key) => ({ key, origin: ORIGIN.AGENT, value: key });
check('sure same lesson -> into that row', decide([{ r: agentRow('a'), p: 0.9, rule: false }])?.into, 'a');
check('the best of several sure rows wins', decide([{ r: agentRow('a'), p: 0.8, rule: true }, { r: agentRow('b'), p: 0.95, rule: true }])?.into, 'b');
check('a sure row outranks a contradicted one (restated negation lands on the negation row)',
    decide([{ r: agentRow('orig'), p: 0.05, rule: true }, { r: agentRow('neg'), p: 0.95, rule: true }])?.into, 'neg');
check('a rule fold the model contradicts is VETOED', decide([{ r: agentRow('a'), p: 0.05, rule: true }])?.veto, true);
check('exactly at the floor is not vetoed', decide([{ r: agentRow('a'), p: 0.2, rule: true }]), null);
check('in between: the rule decides, as before', decide([{ r: agentRow('a'), p: 0.5, rule: true }]), null);
check('a low score on a row the rule DECLINED vetoes nothing', decide([{ r: agentRow('a'), p: 0.01, rule: false }]), null);
check('never "into" a user-authored row', decide([{ r: { key: 'u', origin: ORIGIN.USER, value: 'u' }, p: 0.99, rule: true }]), null);

// --- the parser the pre-pass uses sees what put() sees ------------------------------------------------
const blob = '## Lessons\n- one lesson here now\n* second lesson line here\n\n## Notes\nplain note line text\n## Goal\nnot prose\n## Players\n- Alice: a friend\n';
const seen = [];
const spy = new MemoryStore({ log: quiet });
const realPut = spy.put.bind(spy);
spy.put = (r) => { if (r.kind === KIND.LESSON || r.kind === KIND.NOTE) seen.push(`${r.kind}|${r.value}`); return realPut(r); };
spy.importLegacyBlob(blob);
check('legacyProseEntries yields exactly the prose values put() receives',
    JSON.stringify(legacyProseEntries(blob).map((e) => `${e.kind}|${e.value}`)), JSON.stringify(seen));

// --- planFolds -----------------------------------------------------------------------------------------
configure({ enabled: false });
let calls = 0;
const count = (f) => async (...a) => { calls++; return f(...a); };
check('disabled: no hints', (await planFolds(store(), summary, { log: quiet, fetch: count(yes(0.99)) })).size, 0);
check('disabled: no API call', calls, 0);

configure({ enabled: true });
delete process.env[KEY];
check('no key: no hints', (await planFolds(store(), summary, { log: quiet, fetch: count(yes(0.99)) })).size, 0);
check('no key: no API call', calls, 0);
process.env[KEY] = 'k';

const lines = [];
let s = store();
let hints = await planFolds(s, summary, { log: (m) => lines.push(m), fetch: yes(0.91) });
check('a sure "same lesson" becomes a hint', hints.get(foldHintKey(KIND.LESSON, NEW))?.into, 'dig');
check('...logged with BOTH texts, never silent', lines.some((l) => l.includes(NEW) && l.includes(OLD) && l.includes('p=0.91')), true);
check('below 0.75 is no hint', (await planFolds(store(), summary, { log: quiet, fetch: yes(0.74) })).size, 0);
for (const [label, f] of [
    ['HTTP 500', async () => ({ ok: false, status: 500 })],
    ['network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['malformed answer', async () => ({ ok: true, json: async () => ({}) })],
]) {
    const l2 = [];
    check(`${label}: no hints`, (await planFolds(store(), summary, { log: (m) => l2.push(m), fetch: f })).size, 0);
    check(`${label}: and says the check was unavailable`, l2.some((l) => l.includes('unavailable')), true);
}

// --- end to end through the real store ----------------------------------------------------------------
const lessons = (st) => [...st.records.values()].filter((r) => r.kind === KIND.LESSON);
s = store();
s.importLegacyBlob(summary);
check('CONTROL: without hints the reworded lesson is a SECOND row', lessons(s).length, 2);

s = store();
hints = await planFolds(s, summary, { log: quiet, fetch: yes(0.91) });
s.importLegacyBlob(summary, { foldHints: hints });
check('with the hint it updates the existing row instead', lessons(s).length, 1);
check('...keeping its key', lessons(s)[0].key, 'dig');
check('...and counting the reinforcement', lessons(s)[0].revision, 2);

// A hint must never cost a lesson. Target turned user-authored, or vanished, between the async
// check and the write: the hint is ignored and the line lands as its own row.
s = store();
hints = await planFolds(s, summary, { log: quiet, fetch: yes(0.91) });
s.records.get(lessons(s)[0].id).origin = ORIGIN.USER;
s.importLegacyBlob(summary, { foldHints: hints });
check('a hint onto a user-authored row is ignored, and the lesson is kept', lessons(s).length, 2);
s = store();
hints = await planFolds(s, summary, { log: quiet, fetch: yes(0.91) });
s.delete(KIND.LESSON, 'dig');
s.importLegacyBlob(summary, { foldHints: hints });
check('a hint onto a vanished row is ignored, and the lesson is kept', lessons(s).length, 1);
check('...as the new text', lessons(s)[0].value, NEW);

// --- the veto, end to end: the negation hazard ----------------------------------------------------
const POS = 'Player names are case-sensitive for `followPlayer`.';
const NEG = 'Player names are NOT case-sensitive for followPlayer.';
const NEG2 = 'Player names are not case sensitive when using followPlayer.';
check('CONTROL: the word rule treats the negation as the same lesson', wouldFold(NEG, POS), true);
const negStore = () => { const x = new MemoryStore({ log: quiet }); x.put({ kind: KIND.LESSON, key: 'names', value: POS, origin: ORIGIN.AGENT }); return x; };
// The model's answer depends on which pair it is shown: contradiction low, agreement high.
const judge = (low) => async (_u, { body }) => {
    const { note_one, note_two } = JSON.parse(body).state;
    const contradicts = /\bnot\b/i.test(note_one) !== /\bnot\b/i.test(note_two);
    return { ok: true, json: async () => ({ answers: { same: { noul: contradicts ? low : 0.95 } } }) };
};
s = negStore();
s.importLegacyBlob(`## Lessons\n- ${NEG}\n`);
check('CONTROL: without the veto the negation OVERWRITES the lesson', lessons(s).map((r) => r.value).join('|'), NEG);

s = negStore();
const vlog = [];
s.importLegacyBlob(`## Lessons\n- ${NEG}\n`, { foldHints: await planFolds(s, `## Lessons\n- ${NEG}\n`, { log: (m) => vlog.push(m), fetch: judge(0.05) }) });
check('with the veto both lessons survive', lessons(s).length, 2);
check('...the original untouched', lessons(s).some((r) => r.value === POS && r.revision === 1), true);
check('...and the veto is logged with both texts', vlog.some((l) => l.includes('VETO') && l.includes(NEG) && l.includes(POS)), true);

// The next summary restates the negation. Both rows now match by the word rule; it must land on
// the negation row it agrees with, not the original it contradicts - and not mint a third row.
s.importLegacyBlob(`## Lessons\n- ${NEG2}\n`, { foldHints: await planFolds(s, `## Lessons\n- ${NEG2}\n`, { log: quiet, fetch: judge(0.05) }) });
check('a restated negation does not mint a third row', lessons(s).length, 2);
check('...lands on the negation row', lessons(s).some((r) => r.value === NEG2), true);
check('...and leaves the original alone', lessons(s).some((r) => r.value === POS && r.revision === 1), true);

s = negStore();
s.importLegacyBlob(`## Lessons\n- ${NEG}\n`, { foldHints: await planFolds(s, `## Lessons\n- ${NEG}\n`, { log: quiet, fetch: judge(0.5) }) });
check('a middling score does not veto: the rule folds, as before', lessons(s).length, 1);

// A vetoed line whose key collides with the row it contradicts must not land on that id.
const kc = new MemoryStore({ log: quiet });
kc.put({ kind: KIND.LESSON, key: 'same', value: 'first lesson text here', origin: ORIGIN.AGENT });
kc.put({ kind: KIND.LESSON, key: 'same', value: 'second different lesson', origin: ORIGIN.AGENT, noFold: true });
check('noFold on a colliding key keeps both rows', lessons(kc).length, 2);
check('...the first untouched', lessons(kc).some((r) => r.key === 'same' && r.value === 'first lesson text here'), true);

// --- each hint flag works ALONE (mindcraft-f8 found the pair was coupled) -------------------------
// The fold block's `else` once bound to the `disputes` test, so `noFold` without `disputes` ran the
// full fuzzy fold - the negation overwrote the lesson it contradicts, silently - and a `foldInto`
// could be overridden by the word rules. Every earlier test passed both flags together.
const alone = negStore();
alone.put({ kind: KIND.LESSON, key: 'player names not case sensitive', value: NEG, origin: ORIGIN.AGENT, noFold: true });
check('noFold WITHOUT disputes still keeps the line apart', lessons(alone).length, 2);
check('...and leaves the lesson it contradicts untouched', lessons(alone).some((r) => r.value === POS && r.revision === 1), true);

// foldInto must beat the store's rules. B holds the line's own value (differently punctuated) and
// sits FIRST, so the rules' key/value scan reaches B before the hinted row's self-match on A - under
// the old else-binding the line landed on B. The hint names A; A must take it and B stay put.
const into = new MemoryStore({ log: quiet });
into.put({ kind: KIND.LESSON, key: 'B', value: 'Player names are case-sensitive for followPlayer!', origin: ORIGIN.AGENT });
into.put({ kind: KIND.LESSON, key: 'A', value: 'Case matters when you type a player name for following.', origin: ORIGIN.AGENT });
const valueTwin = new MemoryStore({ log: quiet });
valueTwin.put({ kind: KIND.LESSON, key: 'B', value: 'Player names are case-sensitive for followPlayer!', origin: ORIGIN.AGENT });
valueTwin.put({ kind: KIND.LESSON, key: 'x', value: POS, origin: ORIGIN.AGENT });
check('CONTROL: without a hint the rules put the line on B', valueTwin.records.get('lesson:B')?.revision, 2);
into.put({ kind: KIND.LESSON, key: 'x', value: POS, origin: ORIGIN.AGENT, foldInto: 'A' });
check('foldInto outranks the rules: A took the line', into.records.get('lesson:A')?.revision, 2);
check('...and B, the rules\' pick, is untouched', into.records.get('lesson:B')?.revision, 1);
check('...no third row', lessons(into).length, 2);

// --- at capacity: a contradiction must not evict the lesson it disputes -----------------------------
// Bob's real lesson profile (mindcraft-f8, evict_negation_probe.mjs): cap 10, revisions
// [1,4,7,17,104,107,108,126,127,136], and the revision-1 row is the one the negation disputes -
// so without protection it is DETERMINISTICALLY the casualty.
function bobLike() {
    const x = new MemoryStore({ log: quiet });
    const revs = [1, 4, 7, 17, 104, 107, 108, 126, 127, 136];
    revs.forEach((rev, i) => {
        const value = i === 0 ? POS : `distinct lesson number ${i} about topic${i} and thing${i}`;
        for (let n = 0; n < rev; n++) x.put({ kind: KIND.LESSON, key: i === 0 ? 'names' : `l${i}`, value, origin: ORIGIN.AGENT });
    });
    return x;
}
const cap = bobLike();
check('the fixture is at capacity with bob\'s profile', lessons(cap).map((r) => r.revision).sort((a, b) => a - b).join(','), '1,4,7,17,104,107,108,126,127,136');
const noProtect = bobLike();
noProtect.importLegacyBlob(`## Lessons\n- ${NEG}\n`, { foldHints: new Map([[foldHintKey(KIND.LESSON, NEG), { veto: true }]]) });
check('CONTROL: a veto WITHOUT protection evicts the disputed lesson itself', lessons(noProtect).some((r) => r.value === POS), false);

const prot = bobLike();
const ph = await planFolds(prot, `## Lessons\n- ${NEG}\n`, { log: quiet, fetch: judge(0.05) });
prot.importLegacyBlob(`## Lessons\n- ${NEG}\n`, { foldHints: ph });
check('with protection the disputed lesson survives', lessons(prot).some((r) => r.value === POS), true);
check('...beside the contradiction', lessons(prot).some((r) => r.value === NEG), true);
check('...the cap still holds', lessons(prot).length, 10);
// Which row pays is ordinary eviction policy, not this code's choice: here (no user rows, 3
// probation slots) it is the stalest established row; on bob's real store (2 slots) it is his
// revision-4 probationer. What must hold everywhere: exactly one OTHER lesson goes.
const gone = cap.records.size && [...bobLike().records.values()].filter((r) => r.kind === KIND.LESSON)
    .filter((r) => !lessons(prot).some((q) => q.key === r.key)).map((r) => r.value);
check('...and exactly one OTHER lesson paid for it', gone.length === 1 && gone[0] !== POS && gone[0] !== NEG, true);
check('protection lasts one write only', prot._protected.size, 0);

// --- telling a person ----------------------------------------------------------------------------------
const talker = () => { const a = { shut_up: false, lines: [] }; a.openChat = (m) => a.lines.push(m); return a; };
let tk = talker();
const said = new Set();
announceConflicts(tk, prot, ph, said);
check('the disagreement is put to a person', tk.lines.length, 1);
check('...quoting both lessons', tk.lines[0]?.includes('case-sensitive') && tk.lines[0]?.includes('NOT'), true);
announceConflicts(tk, prot, ph, said);
check('...once, not on every summary that restates it', tk.lines.length, 1);
tk = talker(); tk.shut_up = true;
check('never while told to be quiet', announceConflicts(tk, prot, ph, new Set()).length, 0);
check('not when one of the two is already gone', announceConflicts(talker(), noProtect, ph, new Set()).length, 0);
const bang = new Map([['x', { veto: true, kind: KIND.LESSON, value: 'use !stop now', againstValue: 'never use !stop' }]]);
const bangStore = new MemoryStore({ log: quiet });
bangStore.put({ kind: KIND.LESSON, key: 'a', value: 'use !stop now', origin: ORIGIN.AGENT });
bangStore.put({ kind: KIND.LESSON, key: 'b', value: 'never use !stop', origin: ORIGIN.AGENT });
check('a quoted command cannot read as one in chat', /!stop/.test(announceConflicts(talker(), bangStore, bang, new Set())[0] ?? '!stop'), false);

// --- the hook ---------------------------------------------------------------------------------------------
const hist = fs.readFileSync(new URL('../src/agent/history.js', import.meta.url), 'utf8');
const sm = hist.slice(hist.indexOf('async summarizeMemories('));
check('summarizeMemories asks for hints BEFORE importing',
    sm.indexOf('await planFolds(this.store, summary)') > 0
    && sm.indexOf('await planFolds(this.store, summary)') < sm.indexOf('importLegacyBlob(summary, { foldHints })'), true);
check('...and tells a person about contradictions AFTER importing',
    sm.indexOf('announceConflicts(this.agent, this.store, foldHints)') > sm.indexOf('importLegacyBlob(summary, { foldHints })'), true);
const storeSrc = fs.readFileSync(new URL('../src/agent/memory_store.js', import.meta.url), 'utf8');
for (const [name, want] of [['PROSE_DUPLICATE_AT', '0.6'], ['PROSE_MIN_TOKENS', '5'], ['PROSE_EXACT_MIN_TOKENS', '2']]) {
    check(`${name} unchanged (fold_gym.mjs scored this exact rule)`, storeSrc.match(new RegExp(`const ${name} = ([0-9.]+);`))?.[1], want);
}

setSettings(base);
delete process.env[KEY];
console.log(failures === 0 ? 'memory_fold_jev: all checks passed' : `memory_fold_jev: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
