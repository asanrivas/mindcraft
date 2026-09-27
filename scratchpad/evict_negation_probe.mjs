/**
 * What a vetoed contradiction costs, at capacity, on bob's REAL store.
 *
 *   bun scratchpad/evict_negation_probe.mjs
 *
 * Reads bots/bob/memory_store.json, works on an in-memory copy, writes nothing back. No server,
 * no bot, no network.
 *
 * WHY THIS EXISTS. `scratchpad/fold_gym.mjs` measured the FOLD decision and closed one hole: a
 * lesson and its negation tokenise identically (proseTokens drops not/no/nor), the Jaccard rule
 * folds them, and the fact is overwritten by its own negation. The cure is a model veto - fold
 * only when `(rule OR jev >= 0.75) AND jev >= 0.20` - which is now live in memory_fold_jev.js.
 *
 * But a veto does not delete the negation. It makes it its own row, and the LESSON cap is 10.
 * So the same loss can arrive by the other door: admit the contradiction, overflow the cap, and
 * let `_evict` choose the casualty. This probe asks who that is, on the store as it stands.
 *
 * THE ANSWER WAS NOT INCIDENTAL, which is why it was worth writing down. bob's ten lessons
 * carry revisions [1, 4, 7, 17, 104, 107, 108, 126, 127, 136]. ESTABLISHED_AT is 8, so three
 * are probationers; `probationSlots(10, 0)` is 3; admitting the negation makes four
 * probationers against three slots, so exactly one goes - the least-reinforced, ties broken by
 * age. Both revision-1 rows tie, the original is the older, and the original is the one
 * discarded. So the contradiction displaced the very lesson it argued with, in one step.
 *
 * (An earlier version of this comment said the slice "holds two". It does not - it holds three.
 * The measured outcome was right and the mechanism I gave for it was wrong, which is exactly
 * the failure this repo names as its dominant bug shape: the code measured something true and
 * concluded something false. The assertion below now checks the OUTCOME, which is what anyone
 * actually cares about, instead of restating an arithmetic I got wrong once already.)
 *
 * WHAT IS SHIPPED NOW. The policy question - at capacity with a contradiction arriving,
 * something must give - was decided by the user: keep both rows and tell a person.
 * `put({noFold, disputes})` exempts the disputed row from eviction for that single write, and
 * `announceConflicts()` has Bob say the pair aloud once. With both arguments it works: measured
 * on bob's real store, the disputed lesson is kept at revision 1, the negation is stored, and
 * the cap is paid by one unrelated row (rev 17, the stalest established one).
 *
 * TWO DISTINCT WAYS TO LOSE THE SAME LESSON, and the whole point of the probe is that they are
 * told apart. A disputed lesson can disappear by being
 *
 *   OVERWRITTEN - the negation folds onto the disputed row's own key and replaces its value.
 *                 Silent: no eviction, no log line, the row count never moves.
 *   EVICTED     - the negation is stored as its own row, the cap overflows, and _evict picks
 *                 the disputed row as the casualty. Logged, and the row count still never moves.
 *
 * The outcome ("the lesson is gone") is identical, so an assertion on the outcome alone cannot
 * tell you which one you are looking at - and this file has already been wrong about that once.
 * It briefly carried a version whose `noFold`-alone branch was labelled an eviction
 * demonstration while actually exercising the fold path, because put() read
 *
 *     if (noFold && disputes && ...) this._protected.add(...)
 *     else if (kind !== KIND.GOAL) { ...the entire fold block... }
 *
 * and `noFold` alone therefore fell through and folded. That is fixed - the flags are
 * independent now, `noFold` suppresses folding on its own and `disputes` only adds the eviction
 * exemption - so the checks below name the MECHANISM, and stay meaningful whichever way a
 * future change breaks.
 */
import fs from 'fs';
import { loadStore } from '../src/agent/memory_store.js';

const REAL = new URL('../bots/bob/memory_store.json', import.meta.url);
if (!fs.existsSync(REAL)) {
    console.error('bots/bob/memory_store.json is not there - nothing to measure.');
    process.exit(2);
}

// Work on a copy. loadStore takes a path and the store may write; the real file is bob's live
// memory and another session is running him.
const COPY = new URL('./evict_negation_probe.copy.json', import.meta.url);
fs.copyFileSync(REAL, COPY);

const lessonsOf = s => [...s.records.values()].filter(r => r.kind === 'lesson');
const NEGATION = 'Player names are NOT case-sensitive for `followPlayer`.';
const isOriginal = v => /case-sensitive/i.test(v) && !/NOT/i.test(v);

/** One run: fresh copy of bob's store, admit the vetoed negation, report the casualty. */
function run({ protect }) {
    fs.copyFileSync(REAL, COPY);
    const logs = [];
    const store = loadStore(COPY.pathname, { log: m => logs.push(m) });
    const before = lessonsOf(store).map(r => ({ key: r.key, revision: r.revision, value: r.value }));
    const disputed = before.find(r => isOriginal(r.value));

    store.put({
        kind: 'lesson',
        key: 'player names not case sensitive',
        value: NEGATION,
        noFold: true,
        // The shipped protection. `disputes` names the row the veto fired to defend, and
        // exempts it from eviction FOR THIS WRITE ONLY.
        ...(protect && disputed ? { disputes: disputed.key } : {}),
    });

    const survivors = new Set(lessonsOf(store).map(r => r.key));
    const evicted = before.filter(r => !survivors.has(r.key));
    const original = lessonsOf(store).find(r => isOriginal(r.value));
    const negation = lessonsOf(store).find(r => r.value === NEGATION);
    // OVERWRITTEN vs EVICTED: the disputed row's key still exists, but now holds the negation.
    const overwritten = !!lessonsOf(store).find(r => r.key === disputed?.key && r.value === NEGATION);

    console.log(`\n--- ${protect ? 'WITH noFold + disputes (as shipped)'
        : 'WITH noFold ALONE (no fold expected; eviction still allowed)'}`);
    console.log(`  lessons ${before.length} -> ${lessonsOf(store).length}, evicted ${evicted.length}:`);
    for (const r of evicted) console.log(`    revision ${r.revision}  ${r.value.slice(0, 95)}`);
    for (const l of logs.filter(l => /evict/i.test(l))) console.log(`    log: ${l.slice(0, 135)}`);
    console.log(`  disputed lesson: ${original ? `KEPT (revision ${original.revision})`
        : (overwritten ? 'LOST - OVERWRITTEN in place (silent)' : 'LOST - evicted (logged)')}`
        + `   |   negation stored: ${negation ? 'yes' : 'no'}`);

    fs.rmSync(COPY);
    return { evicted, original, negation, overwritten };
}

fs.copyFileSync(REAL, COPY);
const peek = lessonsOf(loadStore(COPY.pathname, { log: () => {} }));
fs.rmSync(COPY);
console.log(`bob holds ${peek.length} lessons (cap 10), revisions `
    + JSON.stringify(peek.map(r => r.revision).sort((a, b) => a - b)));

const bare = run({ protect: false });
const kept = run({ protect: true });

// The invariant, stated as an outcome rather than as eviction arithmetic: the disputed lesson
// and its contradiction both survive, and the cap is paid for by exactly one OTHER lesson.
const fails = [];
// `noFold` must suppress the fold on its own. Losing the row to EVICTION here is allowed -
// that is ordinary cap policy, and it is what `disputes` exists to override.
if (bare.overwritten) fails.push('`noFold` alone let the negation overwrite the disputed row in '
    + 'place - the flags have re-coupled and the silent overwrite is back');
if (!bare.negation) fails.push('`noFold` alone did not store the negation as its own row');
if (!kept.original) fails.push('WITH `disputes` the disputed lesson was still evicted - the protection is not holding');
if (!kept.negation) fails.push('the contradiction was not stored - "keep both and tell a person" needs both');
if (kept.evicted.length !== 1) fails.push(`expected exactly one other lesson to go, got ${kept.evicted.length}`);
if (kept.evicted.some(r => isOriginal(r.value))) fails.push('the evicted row WAS the disputed one');

console.log(fails.length ? `\nFAIL\n  ${fails.join('\n  ')}` : '\nok - both rows kept, exactly one other lesson paid for the cap');
process.exit(fails.length ? 1 : 0);
