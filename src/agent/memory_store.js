/**
 * Durable memory with database discipline.
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * `history.memory` was ONE free-text blob, rewritten wholesale by the model every time the
 * context filled up:
 *
 *     this.memory = await this.agent.prompter.promptMemSaving(turns);
 *
 * So a user-assigned task survived only as long as the model chose to keep restating it. It did
 * not. A real task - "build a base with 5 chests, mine the minerals below you, return to base" -
 * was silently replaced by one the model invented for itself:
 *
 *     ## Goal
 *     Travel west to red bed at -2572,63,5269 ... (~5820 blocks W remaining)
 *
 * and because that rewritten blob reloads on every restart, each restart re-committed the bot to
 * the wrong journey. The task was not abandoned; it was OVERWRITTEN, with no record that it had
 * ever existed. Prose has no integrity constraints.
 *
 * THE TECHNIQUES APPLIED
 * ----------------------
 * 1. TYPED RECORDS, not prose. `{kind, key, value, origin, ...}` with a primary key of
 *    `kind:key`, so a fact can be looked up, replaced and reasoned about individually.
 * 2. PROVENANCE ON EVERY ROW. `origin` is user | agent | system, recorded at write time.
 * 3. AN INTEGRITY CONSTRAINT. An agent-origin write may never modify or delete a user-origin
 *    record. This is the single rule that makes the failure above impossible - not a prompt
 *    asking the model nicely to remember, an enforced constraint that rejects the write.
 * 4. AN APPEND-ONLY JOURNAL (write-ahead log). Every accepted mutation is appended before the
 *    snapshot is rewritten, so state is reconstructible and "when did the goal change, and who
 *    changed it" is answerable after the fact. That question was unanswerable before.
 * 5. ATOMIC DURABLE WRITES. Snapshot to a temp file and rename, so a crash mid-write cannot
 *    leave a truncated memory.json - the file the bot depends on to know what it was doing.
 * 6. INDEXED RECALL with a bounded render, so the prompt cost stays fixed as memory grows.
 *
 * The pure logic lives here and takes an injectable clock; file IO is confined to the bottom.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'fs';
import path from 'path';

export const ORIGIN = { USER: 'user', AGENT: 'agent', SYSTEM: 'system' };

/**
 * Record kinds. `goal` is singular by design - a bot with two goals has none.
 */
export const KIND = {
    GOAL: 'goal',
    LOCATION: 'location',
    LESSON: 'lesson',
    PLAYER: 'player',
    NOTE: 'note',
};

/** Render order and per-kind caps. Goal first: it is the thing that kept getting lost. */
const RENDER_ORDER = [KIND.GOAL, KIND.LOCATION, KIND.PLAYER, KIND.LESSON, KIND.NOTE];
const KIND_CAPS = { [KIND.GOAL]: 1, [KIND.LOCATION]: 12, [KIND.PLAYER]: 8, [KIND.LESSON]: 10, [KIND.NOTE]: 10 };
const HEADINGS = {
    [KIND.GOAL]: 'Goal', [KIND.LOCATION]: 'Locations', [KIND.PLAYER]: 'Players',
    [KIND.LESSON]: 'Lessons', [KIND.NOTE]: 'Notes',
};

export function recordId(kind, key) {
    return `${kind}:${key}`;
}

/** Kinds whose lines are prose, not name/value pairs - rendered without a key. */
const PROSE_KINDS = new Set([KIND.LESSON, KIND.NOTE]);

/** Words that carry no identity in a lesson; dropped before comparing two of them. */
const PROSE_STOPWORDS = new Set(('a an the and or but if then than that this these those is are was were be been being '
    + 'do does did doing get gets got getting can could should would will just also very more most any all some '
    + 'to of in on at by for with from into onto up down out off over under again once here there when while '
    + 'it its your you i we they them he she him her my our their as so not no nor only own same too s t don now')
    .split(' '));

/**
 * Identity for a PROSE record (a lesson or a note).
 *
 * `normalizeKey` folds punctuation and plurals, which is enough for a name like "Coal ore" but
 * not for a sentence: every re-summarisation rewords it, so the key differs and a new row is
 * minted. Measured on a live bot, 90 of 101 stored rows were lessons and they were paraphrases
 * of four facts - six spellings of "on reconnect read memory first, then resume unfinished
 * task", six of "non-terminating code is killed at 10s", four of "hold position when the target
 * is offline". Only 10 ever render, so the other 80 were dead weight waiting to evict the
 * locations.
 *
 * So identity is the SET of content words, order and wording ignored:
 *   - a leading label is dropped ("**Drop Loops**: navTo fails..." and "**Nav Failures**:
 *     navTo fails..." were two rows with identical bodies);
 *   - stopwords and punctuation go;
 *   - what remains is sorted, so a reordered clause is the same lesson.
 *
 * @param {string} text
 * @returns {string[]} sorted content words
 */
export function proseTokens(text) {
    const withoutLabel = String(text ?? '').replace(/^\s*\*{0,2}[^:*\n]{1,40}\*{0,2}:\s+/, '');
    return [...new Set(withoutLabel
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .map(w => w.replace(/s$/, ''))
        // A bare digit is kept: numbers are usually the IDENTITY of a lesson ("killed at 10s",
        // "Y=-58", "240-min"), and dropping them made "fact number 0" and "fact number 5" the
        // same sentence.
        .filter(w => w && (w.length > 1 || /[0-9]/.test(w)) && !PROSE_STOPWORDS.has(w)))].sort();
}

/**
 * The same content words as `proseTokens`, but IN THE ORDER WRITTEN.
 *
 * `proseTokens` sorts, deliberately - a reordered clause is the same lesson, and at five-plus
 * words a shared set is overwhelming evidence. At three or four words it is not: "Water is faster
 * than walking." and "Walking is faster than water." have the identical set {water, faster,
 * walking} and mean opposite things. Order is the only thing that separates them, so the short
 * fold below compares sequences.
 *
 * Checked against every distinct lesson/note either bot has written (1575 values): requiring the
 * sequence rather than the set folds the same nine pairs and no others - real duplicates do not
 * permute their words, they add and drop filler.
 *
 * @returns {string[]} content words, de-duplicated, first occurrence order preserved
 */
export function proseSequence(text) {
    const withoutLabel = String(text ?? '').replace(/^\s*\*{0,2}[^:*\n]{1,40}\*{0,2}:\s+/, '');
    return [...new Set(withoutLabel
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .map(w => w.replace(/s$/, ''))
        .filter(w => w && (w.length > 1 || /[0-9]/.test(w)) && !PROSE_STOPWORDS.has(w)))];
}

/**
 * Jaccard overlap of two prose token sets. 1 = the same sentence reworded, 0 = unrelated.
 * @returns {number}
 */
export function proseSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    const B = new Set(b);
    let shared = 0;
    for (const w of a) if (B.has(w)) shared++;
    return shared / (a.length + b.length - shared);
}

/**
 * Two lessons this similar are the same lesson. Tuned against the 90 real rows above: 0.6
 * collapses the paraphrase families without merging distinct lessons - the nearest unrelated
 * pair in that set scores well below it. Raising it lets duplicates back in; lowering it starts
 * merging lessons that only share vocabulary.
 */
const PROSE_DUPLICATE_AT = 0.6;

/**
 * Below this many content words a sentence carries too little signal to fold safely - two short
 * lessons that share a word or two would score as identical. Short rows are cheap; a duplicate
 * of one costs far less than silently merging two distinct lessons.
 */
const PROSE_MIN_TOKENS = 5;

/**
 * ...but IDENTITY is not a fuzzy match, and the guard above was refusing both.
 *
 * Live on andy: `"Stop immediately when a player says stop."` (revision 37) and
 * `"Stop immediately when player says stop."` (revision 29) sat as two rows, permanently, in a
 * section that only renders 10. Both reduce to the token set {immediately, player, say, stop} -
 * FOUR words, so `PROSE_MIN_TOKENS` blocked the fold and the same sentence occupied two of the
 * ten slots forever.
 *
 * The guard is right about what it was written for. At 4 tokens a Jaccard of 0.6 means "3 of 5
 * words agree", which merges unrelated short lessons - the tests that caught that are real and
 * the threshold is untouched. But a score of exactly 1.0 is not an approximation: the two
 * sentences contain the *same content words*. Nothing is being guessed, so the length of the
 * sentence does not change the confidence.
 *
 * Measured over every distinct lesson/note either bot has ever written (1575 values,
 * `bots/{andy,bob}/memory_store.json.journal.jsonl`): exact-set folding below MIN_TOKENS merges
 * NINE pairs and every one is a genuine duplicate - the two "says stop" spellings, the same
 * sentence with and without a trailing full stop, one with a `**Player commands**:` label, and
 * "`goToSurface` is recovery (Y:64)" vs "for recovery". Zero false merges.
 *
 * Two tokens is the floor: a single shared content word is a topic, not a sentence.
 */
const PROSE_EXACT_MIN_TOKENS = 2;

/**
 * Reinforcement, and the ratchet it caused.
 *
 * `_evict` ranks by `revision` - how many times a fact has been independently re-learned - and
 * that was the correct fix for a bot narrating its stuck loop into memory. But revision is a
 * LIFETIME TOTAL that never decays, so once every incumbent is at 29-83 (measured on andy: 40
 * of 40 rows, every kind exactly at cap, revisions 29..187) a genuinely new fact arrives at
 * revision 1, sorts to the front of the victim list, and is evicted on the same call that
 * created it. The bot could no longer learn anything it had not already learned many times, and
 * nothing said so.
 *
 * WHY NOT DECAY REINFORCEMENT WITH AGE. It is the obvious fix and it is the wrong one here.
 * Narration is, by construction, the most recently and most frequently restated content in the
 * store - a stuck bot rewrites its loop on *every* summarisation. Any score that fades with
 * time-since-last-restatement therefore systematically favours the current bad episode over a
 * hard-won fact the bot has not had occasion to repeat this hour. That is precisely the recency
 * eviction this file replaced.
 *
 * THE FIX IS NOT A NEW SCORE, IT IS RESERVED CAPACITY. A brand-new row cannot be reinforced if it
 * is deleted before it has the chance, so a slice of each kind's cap is reserved for rows that
 * have not yet reached `ESTABLISHED_AT`. Ranking is otherwise unchanged, and the arithmetic gives
 * a bound that does not depend on the arrival RATE: with E established rows and P probationers,
 * `over = E + P - cap` and probation absorbs `P - slots` of it, so established rows lose
 * `max(0, E + slots - cap)` however many probationers turn up. Established shrinks to
 * `cap - slots` and stops. Consequences, both intended:
 *   - a new fact is admitted at the expense of the weakest established row and gets a real window
 *     to be restated in, ranked above later arrivals as soon as it is restated once;
 *   - a burst of non-folding paraphrases takes at most `probationSlots` of the cap, permanently.
 *     Beyond that the variants evict EACH OTHER. That is the bound the original bug needed:
 *     narration costs 3 of 10 lesson slots, not 10 of 10.
 *
 * The threshold is also where reinforcement stops mattering for admission - a row at
 * `ESTABLISHED_AT` is in, and there is deliberately no band between "proved itself" and "safe".
 * An earlier revision of this fix graduated rows at 3 while treating 8 as full protection, and
 * the gap was a death zone: a graduate was the weakest established row from the moment it
 * arrived, so it was evicted at revision 3 every time and the ratchet simply moved one step
 * later. One threshold, no gap.
 */
const ESTABLISHED_AT = 8;
const PROBATION_FRACTION = 0.3;
const PROBATION_MIN = 2;

/** How many below-threshold rows a kind may hold before they start evicting one another. */
export function probationSlots(cap, userRows = 0) {
    return Math.min(Math.max(PROBATION_MIN, Math.ceil(cap * PROBATION_FRACTION)),
                    Math.max(0, cap - userRows));
}

/**
 * Collapse a key to its identity, so re-summarising updates a fact instead of duplicating it.
 *
 * Live memory had grown to 66 records, mostly near-duplicates, because each summarisation
 * invents slightly different wording for the same fact and every variant became its own row:
 *
 *     "Coal: 7-8 blk W/SW of base, 7 down"      vs  "Coal ore: 7-8 blocks W/SW of base, 7 down"
 *     "Chests: x3391-3395, y62, z4886"          vs  "5 chests: x3391-3395, y62, z4886"
 *     "Torches: 3393,62,4887; 3391,62,4887"     vs  "Torches inside: 3393,62,4887 and ..."
 *
 * Nothing was lost, but recall bloats and the prompt fills with the same fact three times. So
 * strip the parts that vary without changing meaning: leading counts, the "ore" suffix, plural
 * s, and positional qualifiers.
 */
export function normalizeKey(key) {
    return String(key ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')          // punctuation is never identity
        .replace(/^\s*\d+\s+/, '')              // "5 chests" -> "chests"
        .replace(/\b(ore|ores|block|blocks)\b/g, '')
        .replace(/\b(inside|nearby|location|locations|here|area|spot)\b/g, '')
        .replace(/s\b/g, '')                    // crude plural fold; identity only, never displayed
        .replace(/\s+/g, ' ')
        .trim();
}

/** Collapse a value the same way, to catch two keys carrying one fact. */
export function normalizeValue(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\b(and|the|of|at|approximately|approx|about|around)\b/g, ' ')
        .replace(/\bblk\b/g, '')
        .replace(/\b(block|blocks)\b/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

/**
 * Transient episode state minted as a Location.
 *
 * THE BUG. `andy.json`'s `saving_memory` prompt tells the summariser to write Locations as
 * `[name@X:n,Y:n,Z:n]`. `importLegacyBlob`'s non-prose parser splits a line on its FIRST colon -
 * which lands right after the literal "X" label, not after a real value - so EVERY location
 * written under that template keys as `<name>@X`, genuine places included:
 * `desert village@X`, `iron_ore@X`, `chest@X` are all real places wearing the same artifact
 * that `current@X`, `hold_spot@X` and `nav_failures@X` wear. So "@X" cannot be the signal - it
 * is universal noise from the template, and stripping it is normalisation, not detection.
 *
 * THE SIGNAL is the semantic name underneath: is this word naming a PLACE, or is it naming a
 * piece of the bot's OWN in-flight navigation bookkeeping (where it is right now, what it is
 * currently steering toward, where it last failed, where it was before a teleport)? That
 * bookkeeping is re-derived every summarisation for as long as the episode lasts - andy
 * rewrote `Current` 187 times in one journal - and `$STATS` already carries the live position,
 * so nothing durable is lost by refusing it a Location slot.
 *
 * Evidence (real journals, `bots/{andy,bob}/memory_store.json.journal.jsonl`, 2026-08-31):
 * bob wrote `current@X` x65, `hold_spot@X` x66, `target@X` x32, `nav_target@X` x26,
 * `nav_failures@X` x25, `drop_zone@X` x24, `dig_zone@X` x15, `target_cluster@X` x34,
 * `previous_drop_zone@X` x13 - against `desert village@X` x81, `iron_ore@X` x21, `chest@X`
 * x20, `diamond_cluster@X`, `coal_cluster@X`, all genuine and NOT filtered. andy wrote
 * `Current` x187 (its single most-rewritten key), `Target dry spot` x57, `Follow target` x11,
 * `Previous teleport start/origin` x8, `Status` x3 - against `Base` x137, `Desert bed
 * (respawn)` x84, `DANGER` x68, `Shaft` x59, `Coal ore`/`Copper ore`, `Doorway`, `Torches
 * inside`, all genuine.
 *
 * A deliberately NARROW, evidence-derived pattern set - the plan this exists for is explicit
 * that an over-broad denylist silently eating real places is the worse bug. Not filtered
 * (left as places, on purpose): hazard call-outs (`DANGER`, `EMERGENCY` - a warning about a
 * place is still about a place), the ore cluster itself (`diamond_cluster`, `coal_cluster` -
 * only a *targeted* cluster is transient), and anything not matching a pattern below, on the
 * theory that a false KEEP costs one wasted slot and a false DROP costs a place.
 *
 * @param {string} key  the raw key as `importLegacyBlob` parsed it (before `@X` is meaningful)
 * @returns {boolean}
 */
const TRANSIENT_PLACE_PATTERNS = [
    /^(current|position|pos|status|previous)$/, // bare episode-state words: "Current", "pos", "Status", "**Previous**"
    /^current(\s|$)/,                            // "Current", "Current pos", "Current (after disconnect)", "current_loop"
    /(^|\s)pos(ition)?$/,                        // "Last pos", "Last known pos", "Current pos"
    /^nav\s(target|failures?)/,                  // "nav_target", "nav_failures", "nav_target_chest3"
    /^(previous|recent)\steleport/,               // "Previous teleport start/origin", "Recent teleport origin"
    /^follow\s?target/,                          // "Follow target", "Follow target (user-set)"
    /^target(\s|$)/,                             // "target", "Target dry spot", "target_cluster*"
    /^(previous\s)?(drop|dig)\s?zone/,           // "drop_zone", "dig_zone", "previous_drop_zone", "drop_zone_recent"
    /^hold\s?spot/,                              // "hold_spot"
];

/**
 * Does this text pin a point in the world, at all?
 *
 * Deliberately GENEROUS, because it is used as a veto: anything it calls a coordinate is kept as
 * a place. A false "yes" costs one slot; a false "no" can delete the bot's memory of where its
 * base is. Two signals, either sufficient:
 *   - an axis-labelled number, which is what the `saving_memory` template emits
 *     (`4744,Y:75,Z:4733`, `x3391-3395`, `y42-48`);
 *   - two or more runs of three-plus digits, which on this world is an X and a Z
 *     (`3391,62,4890`, `-2572,63,5269`, `4460-4470, 62, 4680-4690`, `4886.30,62.00,4456.53`).
 * No relative offset in the real corpus carries either: distances are one and two digit numbers.
 */
export function hasAbsoluteCoords(text) {
    const s = String(text ?? '');
    if (/\b[xyz]\s*[:=]?\s*~?-?\d/i.test(s)) return true;
    return (s.match(/\d{3,}/g) || []).length >= 2;
}

/**
 * Phrasing that describes a position only in relation to wherever the bot happened to be.
 * "5 blocks East", "23 NW", "2W/2SW+2up", "12 down", "of current position", "coords unknown".
 */
const RELATIVE_VALUE_PATTERNS = [
    /\b\d+\s*(?:[-–—]\s*\d+\s*)?(?:blocks?|blk)\b/i,   // "5 blocks East", "7-8 blk W/SW"
    /\b\d+\s*(?:[-–—]\s*\d+)?\s*(?:N|S|E|W|NE|NW|SE|SW)\b/,  // "23 NW", "3W", "2W/2SW", "8 SE"
    /\b\d+\s*(?:up|down|dn)\b/i,                                  // "12 down", "7dn", "+2up"
    /\b(?:of|from)\s+(?:the\s+)?current\b/i,                      // "of current position"
    /\bco-?ord(?:inate)?s?\b[^.;]{0,24}\bunknown\b/i,             // "exact coords unknown"
];

/**
 * Transient episode state minted as a Location - the VALUE half.
 *
 * `isTransientPlaceKey` catches junk by NAME (`current@X`, `nav_failures@X`). It cannot catch a
 * plausible name carrying an unresolvable body, and andy's live store holds three of those:
 *
 *     5 chests        `5 blocks East` of current position.
 *     Veins from shaft  Cu 2W/2SW+2up; Fe 6W&7SW/3up; Coal 7-8W/SW+7dn.
 *     Copper ore      ~14 blocks W, 12 down
 *
 * A place recorded as an offset from a position the bot no longer occupies is unresolvable
 * forever - and worse than useless, because "5 blocks East" reads as actionable and sends the
 * bot east from wherever it now is. The summariser mints these constantly: 93 distinct such
 * values across 158 writes in the two real journals.
 *
 * THE VETO COMES FIRST, and it is the whole safety argument. Over-filtering - deleting the bot's
 * genuine place memory - is far worse than tolerating junk, so a row is dropped only when it
 * carries NO absolute coordinate ANYWHERE (key or value; `chest@4882,64,4455` puts them in the
 * key) *and* it reads as a relative offset. Validated against every location either bot has ever
 * written (947 distinct key/value pairs, `bots/{andy,bob}/*.journal.jsonl`, 2026-08-31): 93
 * dropped, all relative, none with a coordinate.
 *
 * Must-KEEP cases this deliberately does NOT touch, all real:
 *   - `DANGER: Water pockets at ~1 block away and 2 blocks SE; Cavity at 3394, 58, 4889.` -
 *     relative phrasing AND a real coordinate. The coordinate wins; a hazard call-out is a fact
 *     about a place.
 *   - `Nearby sandy area: 4460-4470, 62, 4680-4690`, `Water Pool: ~6 blocks NE (approx
 *     4697-4703 range)` - ranges, not points, but locatable.
 *   - `Doorway: 3392,62-63,4889 S wall` - a trailing " S wall" that the compass pattern matches;
 *     the coordinate veto keeps it.
 *   - `chest@4882,64,4455: chest (full, but used for depositing items)` and
 *     `asanrivas@4886.30,62.00,4456.53` - coordinates live in the KEY, so key and value are
 *     tested together.
 *   - `Biome: Desert`, `Block Below: Cobblestone.`, `Inventory: ...` - no coordinate and no
 *     relative offset either. Junk, but not *this* junk; 39 such rows are tolerated on purpose
 *     rather than widened into. The probation slice in `_evict` churns them out on its own.
 */
export function isTransientPlaceValue(key, value) {
    const combined = `${key ?? ''} ${value ?? ''}`;
    if (hasAbsoluteCoords(combined)) return false;
    return RELATIVE_VALUE_PATTERNS.some(re => re.test(combined));
}

export function isTransientPlaceKey(key) {
    let s = String(key ?? '').toLowerCase().trim();
    if (!s) return false;
    s = s.replace(/[*`]/g, '').trim();          // markdown emphasis: "**Previous**" -> "previous"
    s = s.replace(/@x$/, '');                    // the template artifact only, never a real "@<coords>" suffix
    s = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return TRANSIENT_PLACE_PATTERNS.some(re => re.test(s));
}

export class MemoryStore {
    /**
     * @param {object} [opts]
     * @param {() => number} [opts.now]        injectable clock, so tests do not depend on time
     * @param {number} [opts.maxRecords=200]   hard cap; oldest agent-origin rows evict first
     * @param {(msg:string)=>void} [opts.log]  injectable, like the clock - tests collect instead
     *                                         of printing, and can then ASSERT on what was said.
     */
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.log = opts.log || (msg => console.log(msg));
        this.maxRecords = opts.maxRecords ?? 200;
        /** @type {Map<string, object>} primary index: "kind:key" -> record */
        this.records = new Map();
        /** @type {object[]} pending journal entries, flushed by the file layer */
        this.pending = [];
        this.rejections = 0;
        /** @type {object[]} every row eviction has taken, so a discard is never silent */
        this.evicted = [];
    }

    /**
     * Insert or update a record.
     *
     * @param {object} r
     * @param {string} r.kind    one of KIND
     * @param {string} r.key     unique within kind; for GOAL the key is always 'current'
     * @param {string} r.value   the fact itself
     * @param {string} r.origin  ORIGIN.USER | AGENT | SYSTEM
     * @returns {{ok:boolean, reason?:string, record?:object}}
     */
    put({ kind, key, value, origin = ORIGIN.AGENT }) {
        if (!kind || typeof kind !== 'string') return this._reject('missing kind');
        if (typeof value !== 'string' || !value.trim()) return this._reject('empty value');
        if (!Object.values(ORIGIN).includes(origin)) return this._reject(`bad origin "${origin}"`);
        let k = String(key ?? 'current').trim() || 'current';

        // Fold onto an existing row that means the same thing, so a re-worded restatement UPDATES
        // the fact rather than adding a third copy of it. Match on the normalised key first, then
        // on the normalised value - two different keys can carry one fact ("Coal" / "Coal ore").
        if (kind !== KIND.GOAL) {
            const nk = normalizeKey(k), nv = normalizeValue(value);
            let folded = false;
            for (const r of this.records.values()) {
                if (r.kind !== kind) continue;
                if (normalizeKey(r.key) === nk || (nv && normalizeValue(r.value) === nv)) { k = r.key; folded = true; break; }
            }
            // A lesson survives rewording, so exact-match folding never catches it. Compare
            // content-word SETS and treat a close enough match as the same lesson - otherwise
            // every summarisation mints one more spelling of a fact already recorded.
            if (PROSE_KINDS.has(kind)) {
                const tokens = proseTokens(value);
                if (!folded && tokens.length >= PROSE_MIN_TOKENS) {
                    let best = null, bestScore = 0;
                    for (const r of this.records.values()) {
                        if (r.kind !== kind) continue;
                        const other = proseTokens(r.value);
                        if (other.length < PROSE_MIN_TOKENS) continue;
                        const score = proseSimilarity(tokens, other);
                        if (score > bestScore) { best = r; bestScore = score; }
                    }
                    if (best && bestScore >= PROSE_DUPLICATE_AT) k = best.key;
                } else if (tokens.length >= PROSE_EXACT_MIN_TOKENS && tokens.length < PROSE_MIN_TOKENS) {
                    // Runs even when the key/value fold already matched: that fold picks ONE row,
                    // and the thing being fixed here is a PAIR of incumbents. Short-circuiting on
                    // it is why andy's two "says stop" rows survived every restatement.
                    // Too short to guess at, but identity is not a guess: the same content words
                    // in a different order or with different filler IS the same sentence. See
                    // PROSE_EXACT_MIN_TOKENS - measured over 1575 real values, 9 folds, 0 wrong.
                    const seq = proseSequence(value).join(' ');
                    const same = [];
                    for (const r of this.records.values()) {
                        if (r.kind !== kind) continue;
                        if (proseSequence(r.value).join(' ') === seq) same.push(r);
                    }
                    if (same.length) {
                        // Rows the guard let in BEFORE this existed are still sitting there in
                        // pairs - andy holds "...when a player says stop." at revision 37 beside
                        // "...when player says stop." at 29, and neither can evict the other. A
                        // write proves they are one sentence, so collapse them: the
                        // best-reinforced survives and inherits the others' reinforcement, the
                        // way `scratchpad/compact.mjs` folds. Safe ONLY on this branch - every
                        // member has an identical token set, so they are mutually identical.
                        // Fuzzy matches are not: A~C and B~C does not make A~B.
                        same.sort((a, b) => (b.revision - a.revision) || (b.updated - a.updated)
                            || (a.key < b.key ? -1 : 1));
                        const survivor = same[0];
                        for (const dup of same.slice(1)) {
                            survivor.revision += dup.revision;
                            this._discard(dup, 'same sentence as an existing row');
                        }
                        k = survivor.key;
                    }
                }
            }
        }

        const id = recordId(kind, k);
        const existing = this.records.get(id);

        // THE CONSTRAINT. Everything else in this file is bookkeeping; this is the fix.
        if (existing && existing.origin === ORIGIN.USER && origin === ORIGIN.AGENT) {
            return this._reject(`cannot overwrite user-authored ${id}`);
        }

        const t = this.now();
        const record = {
            id, kind, key: k, value: value.trim(), origin,
            created: existing?.created ?? t,
            updated: t,
            revision: (existing?.revision ?? 0) + 1,
        };
        this.records.set(id, record);
        this._journal({ op: 'put', at: t, id, origin, value: record.value });
        if (!this._batched) this._evict();
        return { ok: true, record };
    }

    /** @returns {object|null} */
    get(kind, key = 'current') {
        return this.records.get(recordId(kind, key)) || null;
    }

    /** All records of a kind, newest first. */
    list(kind) {
        return [...this.records.values()]
            .filter(r => r.kind === kind)
            .sort((a, b) => b.updated - a.updated);
    }

    /**
     * Delete a record. Agent-origin callers may not delete user-authored rows - same constraint
     * as put, because "overwrite" and "delete then write" must not differ in effect.
     */
    delete(kind, key = 'current', by = ORIGIN.AGENT) {
        const id = recordId(kind, key);
        const existing = this.records.get(id);
        if (!existing) return this._reject(`no such record ${id}`);
        if (existing.origin === ORIGIN.USER && by === ORIGIN.AGENT) {
            return this._reject(`cannot delete user-authored ${id}`);
        }
        this.records.delete(id);
        this._journal({ op: 'delete', at: this.now(), id, origin: by });
        return { ok: true };
    }

    /** Convenience: the current goal's text, or null. */
    goal() {
        return this.get(KIND.GOAL)?.value ?? null;
    }

    /**
     * Set the goal. Defaults to USER origin because the goals that matter come from a person;
     * an agent setting its own goal must say so explicitly and will then be refused if a
     * user-authored goal already stands.
     */
    setGoal(value, origin = ORIGIN.USER) {
        return this.put({ kind: KIND.GOAL, key: 'current', value, origin });
    }

    /**
     * Replace all AGENT-origin records of the given kinds with a fresh set.
     *
     * This is what the periodic LLM summarisation calls. It cannot touch user rows, so
     * re-summarising is safe by construction rather than by the model's good behaviour.
     */
    replaceAgentRecords(kind, values) {
        return this._batch(() => {
            for (const r of this.list(kind)) {
                if (r.origin === ORIGIN.AGENT) this.records.delete(r.id);
            }
            let n = 0;
            for (const [key, value] of values) {
                if (this.put({ kind, key, value, origin: ORIGIN.AGENT }).ok) n++;
            }
            return n;
        });
    }

    /**
     * Render for the `$MEMORY` prompt placeholder, bounded so prompt cost does not grow with
     * memory size. Goal first and never truncated away - it is the highest-value line.
     */
    render(budgetChars = 1200) {
        const parts = [];
        for (const kind of RENDER_ORDER) {
            const rows = this.list(kind).slice(0, KIND_CAPS[kind] ?? 10);
            if (!rows.length) continue;
            if (kind === KIND.GOAL) {
                parts.push(`## ${HEADINGS[kind]}\n${rows[0].value}`);
            } else if (PROSE_KINDS.has(kind)) {
                // Their keys are content hashes for dedup, not names - printing them would repeat
                // the sentence back at itself.
                parts.push(`## ${HEADINGS[kind]}\n` + rows.map(r => `- ${r.value}`).join('\n'));
            } else {
                parts.push(`## ${HEADINGS[kind]}\n` + rows.map(r => `- ${r.key}: ${r.value}`).join('\n'));
            }
        }
        let out = parts.join('\n\n');
        if (out.length > budgetChars) {
            // Trim from the END so the goal survives; note the truncation rather than hiding it.
            out = out.slice(0, budgetChars - 20) + '\n...(truncated)';
        }
        return out;
    }

    /** Serialisable state. */
    snapshot() {
        return { version: 1, records: [...this.records.values()] };
    }

    loadSnapshot(data) {
        this.records.clear();
        if (!data || !Array.isArray(data.records)) return 0;
        for (const r of data.records) {
            if (!r?.kind || !r?.value) continue;
            const key = r.key ?? 'current';
            this.records.set(recordId(r.kind, key), {
                id: recordId(r.kind, key), kind: r.kind, key, value: r.value,
                origin: Object.values(ORIGIN).includes(r.origin) ? r.origin : ORIGIN.AGENT,
                created: r.created ?? this.now(), updated: r.updated ?? this.now(),
                revision: r.revision ?? 1,
            });
        }
        return this.records.size;
    }

    /**
     * Adopt the old free-text blob without losing it.
     *
     * The legacy format is markdown `## Section` blocks. Everything imported is AGENT origin -
     * we cannot know what a human actually asked for from prose written by a model, and marking
     * it USER would grant the very immunity this class exists to withhold.
     *
     * `allowGoal` DEFAULTS TO FALSE, and that default is the load-bearing part. This method is
     * called on every periodic summarisation, and the summariser is an LLM writing markdown
     * under a template that literally contains a `## Goal` header - so with goals allowed, the
     * model mints itself a goal out of whatever it happened to be talking about. Observed: a
     * user cleared the goal with `!endGoal`, and the very next summarisation re-created
     * "Mine minerals below the base at 3391,62,4890..." as an agent record, from the recent
     * turns alone. The store already refuses to let the model OVERWRITE a user's goal; nothing
     * stopped it INVENTING one where none stood, which is the same self-corruption wearing a
     * different hat.
     *
     * A goal is a directive, not a memory. It arrives through `!goal` - explicit, authored and
     * logged - or not at all. Only the one-time legacy migration passes `allowGoal: true`,
     * because there the blob IS the previous state rather than a fresh invention.
     */
    importLegacyBlob(text, { allowGoal = false } = {}) {
        if (typeof text !== 'string' || !text.trim()) return 0;
        return this._batch(() => this._importLegacyBlob(text, { allowGoal }));
    }

    _importLegacyBlob(text, { allowGoal }) {
        let imported = 0;
        this.skippedGoals = 0;
        this.skippedPlaces = 0;
        this.prunedPlaces = 0;
        const sections = text.split(/^##\s+/m).filter(s => s.trim());
        const byHeading = Object.fromEntries(Object.entries(HEADINGS).map(([k, v]) => [v.toLowerCase(), k]));

        for (const section of sections) {
            const nl = section.indexOf('\n');
            const heading = (nl === -1 ? section : section.slice(0, nl)).trim().toLowerCase();
            const body = (nl === -1 ? '' : section.slice(nl + 1)).trim();
            if (!body) continue;
            const kind = byHeading[heading] || KIND.NOTE;

            if (kind === KIND.GOAL) {
                if (!allowGoal) { this.skippedGoals++; continue; }
                if (this.put({ kind: KIND.GOAL, key: 'current', value: body, origin: ORIGIN.AGENT }).ok) imported++;
                continue;
            }
            for (const line of body.split('\n')) {
                const clean = line.replace(/^[-*]\s*/, '').trim();
                if (!clean) continue;

                let key, value;
                if (PROSE_KINDS.has(kind)) {
                    // Lessons and notes are sentences, not name/value pairs. Splitting them on the
                    // first colon produced rows like
                    //   "goToSurface unreliable; climbOut: goToSurface unreliable; c"
                    // where the key was a TRUNCATED PREFIX OF ITS OWN VALUE, displayed twice.
                    // Key them by normalised content instead - identity only, never rendered.
                    value = clean;
                    key = normalizeKey(clean).slice(0, 48) || clean.slice(0, 32);
                } else {
                    const m = clean.match(/^([^:]{1,40}):\s*(.+)$/);
                    key = m ? m[1].trim() : clean.slice(0, 32);
                    value = m ? m[2].trim() : clean;
                    // "Parched:: Parched:" came from a value that just restates its own key.
                    if (normalizeValue(value) === normalizeKey(key)) value = clean;
                }
                if (kind === KIND.LOCATION
                    && (isTransientPlaceKey(key) || isTransientPlaceValue(key, value))) {
                    this.skippedPlaces++;
                    this.prunedPlaces += this._pruneTransientPlace(key);
                    continue;
                }
                if (this.put({ kind, key, value, origin: ORIGIN.AGENT }).ok) imported++;
            }
        }
        // Never silent - see `skippedGoals` above and CLAUDE.md's "an override is never
        // silent". Logged here, not in history.js, because this filter is entirely internal
        // to importLegacyBlob and its evidence.
        if (this.skippedPlaces > 0) {
            this.log(`[MemoryStore] dropped ${this.skippedPlaces} transient location row(s) `
                + `the summariser tried to store as places (current position / nav targets / `
                + `teleport bookkeeping, or an offset from a position the bot has left - already `
                + `live in STATS, not a durable place)`
                + (this.prunedPlaces ? `; pruned ${this.prunedPlaces} already in the store.` : '.'));
        }
        return imported;
    }

    /**
     * Refusing a write does not remove the same junk already sitting in the store, and until the
     * saturation fix that junk was IMMORTAL: `isTransientPlaceKey` shipped, yet bob still holds
     * `hold_spot@X` at revision 66 and `current@X` at 65, because a filtered write can no longer
     * refresh them and nothing else could out-score them.
     *
     * So a refused write also prunes the row it would have refreshed - but ONLY if that row fails
     * the same test on its own merits. The re-check is the safety: a summarisation that writes
     * `5 chests: 5 blocks East of current position` must not be allowed to delete a stored
     * `5 chests: 4574,68,4814`, which is a real place that happens to share a key.
     *
     * @returns {number} rows pruned
     */
    _pruneTransientPlace(key) {
        const nk = normalizeKey(key);
        let pruned = 0;
        for (const r of [...this.records.values()]) {
            if (r.kind !== KIND.LOCATION || r.origin !== ORIGIN.AGENT) continue;
            if (normalizeKey(r.key) !== nk) continue;
            if (!isTransientPlaceKey(r.key) && !isTransientPlaceValue(r.key, r.value)) continue;
            this._discard(r, 'transient place, superseded by a filtered write');
            pruned++;
        }
        return pruned;
    }

    /**
     * Run `fn` as ONE write, capping the store against the finished statement rather than against
     * each line as it lands.
     *
     * A summarisation restates everything the bot still knows and then adds what it just learned,
     * so evicting per-row makes the row the summariser happens to list FIRST the stalest the
     * moment the batch ends - and the new fact appended at the bottom of the same summary then
     * evicts it. Measured on a replay of andy's real store: 15 summarisations, one new place each,
     * and `Shaft` (revision 75) and `DANGER` (73) were destroyed purely for being listed first,
     * while `5 chests: 5 blocks East of current position` survived for being listed late.
     * Nothing about that is a judgement of the facts.
     */
    _batch(fn) {
        this._batched = true;
        // ONE timestamp for the whole statement. Without this the eviction order inside a
        // summarisation is just the order the model happened to list its facts in, and the
        // saturation replay showed exactly that: `Shaft` (revision 75) and `DANGER` (73) died for
        // being written first while junk written last survived. Every fact restated in a
        // summarisation is equally fresh, because it was restated in that summarisation.
        const real = this.now, stamp = this.now();
        this.now = () => stamp;
        try { return fn(); } finally { this.now = real; this._batched = false; this._evict(); }
    }

    _reject(reason) {
        this.rejections++;
        return { ok: false, reason };
    }

    _journal(entry) {
        this.pending.push(entry);
    }

    /**
     * Cap rows. User rows are never evicted; oldest agent rows go first.
     *
     * PER-KIND caps are enforced here and not only at render. They used to bound the render
     * alone, so a bot in a stuck loop kept minting lessons that were stored forever and never
     * shown: 90 of 101 live rows were lessons, 10 of which rendered. The global cap then evicts
     * the OLDEST agent rows - the durable, hard-won facts - to make room for the newest noise.
     * Bounding each kind at its own cap means a runaway section can only ever crowd out itself.
     */
    _evict() {
        for (const [kind, cap] of Object.entries(KIND_CAPS)) {
            const mine = [...this.records.values()].filter(r => r.kind === kind);
            let over = mine.length - cap;
            if (over <= 0) continue;

            const agentRows = mine.filter(r => r.origin === ORIGIN.AGENT);
            const slots = probationSlots(cap, mine.length - agentRows.length);

            // Below the threshold a row has not yet proved itself, so it is ranked on what
            // evidence it does have (least-reinforced, then oldest - a row that has sat through
            // several summarisations without being restated has been offered and refused).
            const probation = agentRows.filter(r => r.revision < ESTABLISHED_AT)
                .sort((a, b) => (a.revision - b.revision) || (a.updated - b.updated));

            // At or above it, the ORIGINAL ordering applies - but with the two keys swapped, so
            // STALENESS leads and reinforcement only breaks the tie.
            //
            // Staleness leads because it is the signal the real stores actually carry. On bob the
            // stalest location rows are `previous_drop_zone@X` (19h), `nav_failures@X` (18h) and
            // `target@X` (9h) - all dead episode state - while the genuine `chest@X`,
            // `iron_ore@X` and `desert village@X` are the freshest. On andy the two stalest of
            // twelve are `Target dry spot` (11.7h) and `Current`, and the seven durable facts
            // were all restated in the last batch. Leading with lifetime reinforcement instead
            // would have kept `current@X` (65) and `hold_spot@X` (66) over `chest@X` (24) -
            // exactly backwards.
            //
            // Reinforcement breaks the tie because eviction takes the MINIMUM, and that is what
            // lets a new fact climb without ever endangering a durable one: a fresh graduate
            // enters at ESTABLISHED_AT, below every incumbent, so `Base` at revision 160 is never
            // the victim - while the graduate only has to out-rank the NEXT graduate, not `Base`,
            // to survive and keep climbing.
            const established = agentRows.filter(r => r.revision >= ESTABLISHED_AT)
                .sort((a, b) => (a.updated - b.updated) || (a.revision - b.revision));

            // 1. Probationers beyond their reserved slice evict each other. This is the bound on
            //    narration: a burst of non-folding paraphrases churns inside the slice and can
            //    never reach an established row.
            let excess = probation.length - slots;
            while (over > 0 && excess > 0 && probation.length) {
                this._discard(probation.shift(), 'probation slice full'); over--; excess--;
            }
            // 2. Otherwise the new fact is admitted at the expense of the stalest established
            //    row. This is what unfreezes a saturated store.
            while (over > 0 && established.length) {
                this._discard(established.shift(), 'least recently reinforced'); over--;
            }
            // 3. Nothing established left to trim - fall back inside the slice.
            while (over > 0 && probation.length) {
                this._discard(probation.shift(), 'over cap, none established'); over--;
            }
        }
        if (this.records.size <= this.maxRecords) return;
        const agentRows = [...this.records.values()]
            .filter(r => r.origin === ORIGIN.AGENT)
            .sort((a, b) => a.updated - b.updated);
        while (this.records.size > this.maxRecords && agentRows.length) {
            this._discard(agentRows.shift(), 'global record cap');
        }
    }

    /**
     * Drop a row, and SAY SO. A silent discard is indistinguishable from never having been
     * offered the fact - which is exactly how the saturation bug stayed invisible while the store
     * quietly refused everything new for days. Journalled too, so "when did we lose that" is
     * answerable after the fact, the same reason `put` and `delete` are.
     */
    _discard(record, reason) {
        this.records.delete(record.id);
        this.evicted.push({ ...record, reason });
        this._journal({ op: 'evict', at: this.now(), id: record.id, reason, revision: record.revision });
        this.log(`[MemoryStore] evicted ${record.kind} "${record.key}" (revision ${record.revision}, `
            + `${reason}): ${record.value.slice(0, 60)}`);
    }
}

// ---------------------------------------------------------------------------------------------
// File layer. Kept separate so everything above is testable without touching a disk.
// ---------------------------------------------------------------------------------------------

/**
 * Atomically write the snapshot: temp file then rename.
 *
 * A plain writeFileSync over the live file can be interrupted and leave a truncated JSON, and
 * this is the file the bot reads to learn what it was doing. rename(2) is atomic on the same
 * filesystem, so a reader sees either the old file or the new one, never a half-written one.
 */
export function saveStore(store, filePath) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(store.snapshot(), null, 2));
    renameSync(tmp, filePath);
    flushJournal(store, `${filePath}.journal.jsonl`);
}

/** Append accepted mutations to the write-ahead log and clear the pending buffer. */
export function flushJournal(store, journalPath) {
    if (!store.pending.length) return 0;
    const lines = store.pending.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
        appendFileSync(journalPath, lines);
    } catch {
        return 0;   // a full disk must never take the bot down
    }
    const n = store.pending.length;
    store.pending = [];
    return n;
}

export function loadStore(filePath, opts = {}) {
    const store = new MemoryStore(opts);
    if (!existsSync(filePath)) return store;
    try {
        store.loadSnapshot(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
        // A corrupt snapshot must not stop the bot from starting; it starts empty instead.
    }
    return store;
}
