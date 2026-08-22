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
