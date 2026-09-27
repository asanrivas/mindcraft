/**
 * A second opinion on "is this new lesson one the store already holds?", for the pairs the
 * store's own Jaccard rule declines.
 *
 * WHAT WAS MEASURED (scratchpad/fold_gym.mjs, 51 labelled pairs from both bots' journals):
 *   heuristic alone          38/51   missed folds 13   false merges 0
 *   jev alone at 0.75        38/51   missed folds 13   false merges 0
 *   UNION (heuristic OR jev) 43/51   missed folds  8   false merges 0
 * The two fail on DIFFERENT pairs - the rule is strong where the wording barely moved, the model
 * where the vocabulary was rewritten - so the shape that ships is the union, not a replacement:
 * keep the rule, ask only about what it declines.
 *
 * THE THRESHOLD IS 0.75 AND IS NOT A TUNING KNOB. It is the lowest step that held false merges
 * at zero in every run; at 0.70 the model merged "Reconnection resets active task state; memory
 * persists but is not a work queue" into "...memory persists to resume context" - the goal-vs-
 * memory distinction the whole store exists to keep. A false merge is silent and expensive (a
 * lesson disappears), a missed one costs a render slot. Moving the number means re-labelling.
 *
 * SHAPE. `put` is synchronous and stays that way. This runs BEFORE a summary is imported, asks
 * its questions in parallel, and returns hints `importLegacyBlob` passes to `put` as `foldInto`
 * (a verified duplicate) or `noFold` (a vetoed rule fold - see VETO_THRESHOLD).
 * Every fold it causes is logged by name, both texts in full - never silent. Every failure
 * returns no hints: the store then does exactly what it did before this file existed.
 */
import settings from './settings.js';
import {
    wouldFold, proseTokens, proseSimilarity, normalizeKey, normalizeValue, proseKey, legacyProseEntries, foldHintKey, ORIGIN,
} from './memory_store.js';

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const FOLD_THRESHOLD = 0.75;
// THE VETO. The union above can only ADD folds, so it cannot fix a false merge the rule makes on
// its own - and the rule makes one on every negation: proseTokens drops "not", so "Player names
// are NOT case-sensitive" and "Player names are case-sensitive" are one token set. Measured by
// mindcraft-f8 in fold_gym.mjs, 13 constructed probes (10 minimal negations, 3 controls):
//   rule 2/13 (10 false merges) - jev >= 0.75 13/13 - union 3/13 (10) - union AND jev >= 0.20 13/13
// and on the 51 real pairs the veto costs nothing (44/51, 0 merged, same as the plain union).
// 0.20 is mid-plateau (0.10-0.25): >3x the model's highest score on a contradiction (0.06), far
// under its lowest on a true duplicate (0.94). Caveat from the same session: the negative sets
// are thin (9 real, 10 constructed), so "zero false merges" is not a large-sample claim.
export const VETO_THRESHOLD = 0.20;
// Only the most similar few rows are worth a question: the model is asked "same lesson?", and a
// row sharing no content words with the new line is not a plausible duplicate at all.
export const CANDIDATES_PER_LINE = 3;
const MAX_PARALLEL = 6;

// The gym's question, verbatim. Phrased as what the two notes SAY, not what the store should
// DO - asking for the action instead cost accuracy and calibration in laya_recover_gym.py.
export const SAME_LESSON = {
    type: 'noul',
    instructions: 'Two notes a Minecraft bot wrote into its own long-term memory are shown as '
        + '`note_one` and `note_two`. Do they state the same lesson, so that keeping both would '
        + 'be storing one fact twice?',
    criteria: {
        true: 'the same lesson in different words - either one could replace the other and '
            + 'nothing the bot needs would be lost',
        false: 'different lessons, or the same subject with a different point - keeping only '
            + 'one of them would lose something the bot needs',
    },
};

export function foldConfig() {
    const c = settings.memory_fold_jev ?? {};
    return {
        enabled: c.enabled === true,
        timeoutMs: c.timeout_ms ?? 4000,
        url: c.url ?? DEFAULT_URL,
        model: c.model ?? 'jev-latest',
        keyEnv: c.key_env ?? 'TYPESAFE_API_KEY',
    };
}

/**
 * Rows the store's OWN rules would fold this line onto - the same tests `put` applies (key,
 * value, then `wouldFold`). These are what the veto asks about. All origins: a rule fold onto a
 * user-authored row is rejected by `put` and the lesson LOST, so a veto there saves it.
 */
export function ruleTargets(records, kind, value) {
    const nk = normalizeKey(proseKey(value)), nv = normalizeValue(value);
    return records.filter((r) => r.kind === kind
        && (normalizeKey(r.key) === nk || (nv && normalizeValue(r.value) === nv) || wouldFold(value, r.value)));
}

/**
 * Rows the rules DECLINE that are still worth asking about - the union's side. Pure. Only
 * agent-authored rows (a fold onto a user row is rejected by `put`), only the most similar few,
 * and never a row sharing no content words with the line.
 */
export function unionCandidates(records, kind, value) {
    const t = proseTokens(value);
    return records
        .filter((r) => r.kind === kind && r.origin === ORIGIN.AGENT)
        .map((r) => ({ r, s: proseSimilarity(t, proseTokens(r.value)) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, CANDIDATES_PER_LINE)
        .map(({ r }) => r);
}

/**
 * Pure policy for one line, given the model's score for each asked row:
 *   into   the best AGENT row the model is sure states the same lesson (>= 0.75) - this
 *          outranks the rules, so a restated negation lands on the negation row, not the original
 *   veto   the rules would fold, and the model puts some target under 0.20 - keep it apart
 *   null   let the store's rules decide, exactly as before
 * @param {{r: object, p: number, rule: boolean}[]} scored
 */
export function decide(scored) {
    let best = null;
    for (const x of scored) if (x.r.origin === ORIGIN.AGENT && x.p >= FOLD_THRESHOLD && (!best || x.p > best.p)) best = x;
    if (best) return { into: best.r.key, p: best.p, r: best.r };
    const vetoed = scored.find((x) => x.rule && x.p < VETO_THRESHOLD);
    if (vetoed) return { veto: true, p: vetoed.p, r: vetoed.r };
    return null;
}

async function askSame(a, b, cfg, key, fetchImpl) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
        const res = await fetchImpl(cfg.url, {
            method: 'POST',
            signal: ctl.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: { note_one: a, note_two: b }, model: cfg.model, questions: { same: SAME_LESSON } }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = (await res.json())?.answers?.same?.noul;
        if (typeof p !== 'number' || Number.isNaN(p)) throw new Error('malformed answer');
        return p;
    } finally {
        clearTimeout(timer);
    }
}

async function inBatches(jobs, n) {
    const out = [];
    for (let i = 0; i < jobs.length; i += n) out.push(...await Promise.all(jobs.slice(i, i + n).map((j) => j())));
    return out;
}

/**
 * Hints for `store.importLegacyBlob(summary, { foldHints })`. Never throws.
 * @returns {Promise<Map<string, {into: string}|{veto: true}>>} keyed by foldHintKey(kind, value)
 */
export async function planFolds(store, summary, { log = console.log, fetch: fetchImpl = fetch } = {}) {
    const hints = new Map();
    const cfg = foldConfig();
    if (!cfg.enabled) return hints;
    const key = process.env[cfg.keyEnv];
    if (!key) return hints;

    const records = [...store.records.values()];
    const lines = [];
    const questions = [];
    for (const { kind, value } of legacyProseEntries(summary)) {
        // An exact restatement needs no opinion: the store folds it by value and nothing changes.
        if (records.some((r) => r.kind === kind && r.value === value)) continue;
        const rule = ruleTargets(records, kind, value).slice(0, CANDIDATES_PER_LINE);
        const asked = rule.length ? rule : unionCandidates(records, kind, value);
        if (!asked.length) continue;
        const line = { kind, value, qs: asked.map((r) => ({ r, rule: rule.length > 0, i: questions.length + asked.indexOf(r) })) };
        lines.push(line);
        for (const r of asked) questions.push({ a: value, b: r.value });
    }
    if (!questions.length) return hints;

    let answers;
    try {
        answers = await inBatches(questions.map((q) => () => askSame(q.a, q.b, cfg, key, fetchImpl)), MAX_PARALLEL);
    } catch (err) {
        // All or nothing: a partial set of answers would make folds depend on which calls happened
        // to finish, invisibly. No hints means the store's own rules, exactly as before.
        log(`[MemoryStore] jev fold check unavailable (${err.name === 'AbortError' ? 'timed out' : err.message}) - store rules only`);
        return hints;
    }

    let folds = 0, vetoes = 0;
    for (const line of lines) {
        const d = decide(line.qs.map((q) => ({ r: q.r, rule: q.rule, p: answers[q.i] })));
        if (!d) continue;
        hints.set(foldHintKey(line.kind, line.value), d.veto
            ? { veto: true, against: d.r.key, kind: line.kind, value: line.value, againstValue: d.r.value }
            : { into: d.into });
        if (d.veto) {
            vetoes++;
            log(`[MemoryStore] jev VETO (p=${d.p.toFixed(2)}, ${line.kind}): "${line.value}" kept apart from "${d.r.value}" - the word rule would have merged them`);
        } else {
            folds++;
            log(`[MemoryStore] jev fold (p=${d.p.toFixed(2)}, ${line.kind}): "${line.value}" -> existing "${d.r.value}"`);
        }
    }
    log(`[MemoryStore] jev fold check: ${questions.length} question(s), ${folds} fold(s), ${vetoes} veto(es)`);
    return hints;
}

// Pairs already put to a person this process, so each disagreement is raised ONCE, not on every
// summary that restates it. In memory only: after a restart it may be asked once more.
const announced = new Set();

/**
 * Tell a person that two lessons disagree - the decision the store must not make on its own.
 * Asked by the user (2026-09-25): at capacity a contradiction otherwise evicts the lesson it
 * argues with, silently choosing the newer claim. `put` protects the disputed row for that write;
 * this is the other half, and it is what makes keeping both worth anything.
 *
 * Only while BOTH rows still exist (a later write may have settled or evicted one), once per
 * pair, never while the bot is told to be quiet. `!` is stripped from the quoted lessons so a
 * lesson that mentions a command cannot read as one in chat.
 * @returns {string[]} what was said
 */
export function announceConflicts(agent, store, hints, seen = announced) {
    const said = [];
    if (!hints?.size || agent?.shut_up) return said;
    const clean = (t) => String(t).replace(/!(?=\w)/g, '').slice(0, 120);
    for (const h of hints.values()) {
        if (!h?.veto) continue;
        const pair = `${h.kind}\n${h.value}\n${h.againstValue}`;
        if (seen.has(pair)) continue;
        const rows = [...store.records.values()].filter((r) => r.kind === h.kind);
        if (!rows.some((r) => r.value === h.value) || !rows.some((r) => r.value === h.againstValue)) continue;
        seen.add(pair);
        const msg = `I have two ${h.kind}s that disagree: "${clean(h.againstValue)}" vs "${clean(h.value)}". Which one is right?`;
        said.push(msg);
        agent.openChat(msg);
    }
    return said;
}
