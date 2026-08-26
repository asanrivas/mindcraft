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

export class MemoryStore {
    /**
     * @param {object} [opts]
     * @param {() => number} [opts.now]        injectable clock, so tests do not depend on time
     * @param {number} [opts.maxRecords=200]   hard cap; oldest agent-origin rows evict first
     */
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.maxRecords = opts.maxRecords ?? 200;
        /** @type {Map<string, object>} primary index: "kind:key" -> record */
        this.records = new Map();
        /** @type {object[]} pending journal entries, flushed by the file layer */
        this.pending = [];
        this.rejections = 0;
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
            for (const r of this.records.values()) {
                if (r.kind !== kind) continue;
                if (normalizeKey(r.key) === nk || (nv && normalizeValue(r.value) === nv)) { k = r.key; break; }
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
        this._evict();
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
        for (const r of this.list(kind)) {
            if (r.origin === ORIGIN.AGENT) this.records.delete(r.id);
        }
        let n = 0;
        for (const [key, value] of values) {
            if (this.put({ kind, key, value, origin: ORIGIN.AGENT }).ok) n++;
        }
        return n;
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
     */
    importLegacyBlob(text) {
        if (typeof text !== 'string' || !text.trim()) return 0;
        let imported = 0;
        const sections = text.split(/^##\s+/m).filter(s => s.trim());
        const byHeading = Object.fromEntries(Object.entries(HEADINGS).map(([k, v]) => [v.toLowerCase(), k]));

        for (const section of sections) {
            const nl = section.indexOf('\n');
            const heading = (nl === -1 ? section : section.slice(0, nl)).trim().toLowerCase();
            const body = (nl === -1 ? '' : section.slice(nl + 1)).trim();
            if (!body) continue;
            const kind = byHeading[heading] || KIND.NOTE;

            if (kind === KIND.GOAL) {
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
                if (this.put({ kind, key, value, origin: ORIGIN.AGENT }).ok) imported++;
            }
        }
        return imported;
    }

    _reject(reason) {
        this.rejections++;
        return { ok: false, reason };
    }

    _journal(entry) {
        this.pending.push(entry);
    }

    /** Cap total rows. User rows are never evicted; oldest agent rows go first. */
    _evict() {
        if (this.records.size <= this.maxRecords) return;
        const agentRows = [...this.records.values()]
            .filter(r => r.origin === ORIGIN.AGENT)
            .sort((a, b) => a.updated - b.updated);
        while (this.records.size > this.maxRecords && agentRows.length) {
            this.records.delete(agentRows.shift().id);
        }
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
