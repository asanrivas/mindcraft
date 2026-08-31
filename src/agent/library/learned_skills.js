import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

/**
 * Durable store of skills the agent has actually gotten to work.
 *
 * Why this exists: generated code used to be written to bots/<name>/action-code/ purely as a
 * debug artifact - the counter restarted at 0.js every launch, files were written *before*
 * linting, and nothing ever read them back. So every restart threw away everything the agent
 * had figured out.
 *
 * The important constraint is the write gate. Code is only stored after it ran without
 * throwing, so the store cannot fill up with plausible-looking code that never worked. An
 * unverified skill library would industrialise exactly the memory-corruption failure this
 * work set out to remove.
 *
 * Retrieval piggybacks on the existing SkillLibrary embedding search, which only started
 * working once the embedding model was actually being loaded.
 */
export class LearnedSkills {
    constructor(agentName) {
        this.fp = `./bots/${agentName}/skills.json`;
        this.skills = {};
        this.load();
    }

    load() {
        try {
            if (existsSync(this.fp)) {
                this.skills = JSON.parse(readFileSync(this.fp, 'utf8')) || {};
                const n = Object.keys(this.skills).length;
                if (n) console.log(`[LearnedSkills] Loaded ${n} learned skill(s)`);
            }
        } catch (err) {
            console.warn('[LearnedSkills] Failed to load store:', err.message);
            this.skills = {};
        }
    }

    save() {
        try {
            mkdirSync(this.fp.substring(0, this.fp.lastIndexOf('/')), { recursive: true });
            writeFileSync(this.fp, JSON.stringify(this.skills, null, 2));
        } catch (err) {
            console.warn('[LearnedSkills] Failed to save store:', err.message);
        }
    }

    /**
     * Record a skill that has been observed to work. Called only from the verified path.
     * @param {string} description - natural language description; this is what gets embedded.
     * @param {string} source - the code that ran.
     * @returns {string} the skill's key.
     */
    add(description, source) {
        const key = this._makeKey(description);
        const existing = this.skills[key];
        if (existing) {
            existing.successes += 1;
            existing.source = source; // keep the most recent version that worked
            existing.last_used = Date.now();
        } else {
            this.skills[key] = {
                name: key,
                description,
                source,
                created_at: Date.now(),
                last_used: Date.now(),
                successes: 1,
                failures: 0
            };
            console.log(`[LearnedSkills] Learned new skill: ${key}`);
        }
        this.save();
        return key;
    }

    /** Record that a previously learned skill failed, so ranking can demote it. */
    recordFailure(key) {
        if (this.skills[key]) {
            this.skills[key].failures += 1;
            this.save();
        }
    }

    /**
     * Docs for injection into $CODE_DOCS, ordered by observed reliability.
     * Skills that have failed more than they have succeeded are dropped rather than
     * offered up as suggestions.
     * @param {number} limit
     * @returns {string[]}
     */
    getDocs(limit = 5) {
        return Object.values(this.skills)
            .filter(s => s.successes > s.failures)
            .sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures) || b.last_used - a.last_used)
            .slice(0, limit)
            .map(s => `learned.${s.name}\n * ${s.description}`
                + ` (worked ${s.successes}x${s.failures ? `, failed ${s.failures}x` : ''})`
                + `\n * Code:\n${s.source}`);
    }

    count() {
        return Object.keys(this.skills).length;
    }

    _makeKey(description) {
        return description
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .trim()
            .split(/\s+/)
            .slice(0, 6)
            .join('_')
            .slice(0, 60) || 'skill';
    }
}

/**
 * Cross-invocation memory of code-generation FAILURES, keyed by intent (the same
 * `LearnedSkills._makeKey` key `add`/`recordFailure` use).
 *
 * The gap this closes: `LearnedSkills.recordFailure` only bumps a counter on a skill that has
 * ALREADY succeeded once under that key - the write gate that keeps the skill library honest
 * (docs at the top of this file) means an intent that has never worked leaves no trace there at
 * all. That is exactly the reported incident: 17 generated-code failures in three minutes,
 * invented mineflayer APIs and unparseable output, never a single success - so nothing informed
 * the next `!newAction` about any of it. `code_guard.js`'s `priorSignatures` dedupe only lives
 * for one `generateCode` call, so it cannot see across invocations either.
 *
 * This is deliberately a separate store from `LearnedSkills.skills`, not a field bolted onto
 * it: the skill store's shape (key -> one skill record) has no room for "many distinct failure
 * signatures per key" without changing what every existing reader of skills.json expects.
 *
 * Read back as CONTEXT, not as a gate - see coder.js's usage. Folding `bot.setBlock` ->
 * `bot.placeBlock` is exactly the correction a retry is FOR, and it necessarily shows up as a
 * *different* error on the next attempt; refusing on failure history would cut that off before
 * it has a chance to happen. Ranking is most-repeated-first, same principle `memory_store.js`
 * uses for eviction ("least-reinforced first, because recency hands the whole slot to whatever
 * just happened") - a failure that has recurred across several separate runs is more informative
 * than whatever happened to fail most recently.
 */
export class FailureLog {
    constructor(agentName) {
        this.fp = `./bots/${agentName}/skill_failures.json`;
        this.entries = {}; // key -> { signature -> {count, message, last_seen} }
        this.load();
    }

    load() {
        try {
            if (existsSync(this.fp)) {
                this.entries = JSON.parse(readFileSync(this.fp, 'utf8')) || {};
            }
        } catch (err) {
            // FAIL OPEN: a corrupt or unreadable store must never block code generation. Worst
            // case we simply forget prior failures, which is the status quo this closes a gap in.
            console.warn('[FailureLog] Failed to load store, starting empty:', err.message);
            this.entries = {};
        }
    }

    save() {
        try {
            mkdirSync(this.fp.substring(0, this.fp.lastIndexOf('/')), { recursive: true });
            writeFileSync(this.fp, JSON.stringify(this.entries, null, 2));
        } catch (err) {
            console.warn('[FailureLog] Failed to save store:', err.message);
        }
    }

    /**
     * Record one occurrence of a failure for an intent key.
     * @param {string} key        LearnedSkills._makeKey(intent) - stable per intent
     * @param {string} signature  code_guard.failureSignature(code, error) - stable per distinct failure
     * @param {string} message    short human-readable tail, for display only
     */
    record(key, signature, message) {
        if (!key || !signature) return;
        try {
            const bucket = this.entries[key] || (this.entries[key] = {});
            const existing = bucket[signature];
            if (existing) {
                existing.count += 1;
                existing.last_seen = Date.now();
            } else {
                bucket[signature] = { count: 1, message: String(message || '').slice(0, 200), last_seen: Date.now() };
            }
            // Bound distinct signatures per intent so one flailing intent can't grow forever.
            // Evict least-reinforced (lowest count, then oldest) - same rule as below.
            const sigs = Object.keys(bucket);
            if (sigs.length > FailureLog.MAX_SIGNATURES_PER_KEY) {
                sigs.sort((a, b) => (bucket[a].count - bucket[b].count) || (bucket[a].last_seen - bucket[b].last_seen));
                delete bucket[sigs[0]];
            }
            // Bound total intents tracked, same eviction rule, so the store itself cannot grow
            // without limit across a long-running bot's whole history of intents.
            const keys = Object.keys(this.entries);
            if (keys.length > FailureLog.MAX_KEYS) {
                const weakest = (k) => Object.values(this.entries[k])
                    .reduce((acc, v) => Math.max(acc, v.count), 0);
                keys.sort((a, b) => weakest(a) - weakest(b));
                delete this.entries[keys[0]];
            }
            this.save();
        } catch (err) {
            console.warn('[FailureLog] Failed to record failure:', err.message);
        }
    }

    /**
     * Prior failures for this intent, most-repeated first, capped - meant for injection as
     * CONTEXT the model can act on, never as a refusal. Fails open (empty array) on any missing
     * or corrupt data.
     * @param {string} key
     * @param {number} limit
     * @returns {Array<{signature:string, count:number, message:string}>}
     */
    getTop(key, limit = 3) {
        try {
            const bucket = this.entries[key];
            if (!bucket || typeof bucket !== 'object') return [];
            return Object.entries(bucket)
                .map(([signature, v]) => ({ signature, count: v && v.count || 0, message: v && v.message || '' }))
                .sort((a, b) => b.count - a.count)
                .slice(0, Math.max(0, limit));
        } catch (err) {
            console.warn('[FailureLog] Failed to read store:', err.message);
            return [];
        }
    }
}
FailureLog.MAX_SIGNATURES_PER_KEY = 12;
FailureLog.MAX_KEYS = 300;
