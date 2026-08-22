import fs from 'fs';
import path from 'path';

/**
 * Standing instructions the user gives Andy to steer how it talks and acts.
 *
 * Distinct from memory on purpose. `history.memory` is written BY the model and is therefore
 * subject to drift - it has already corrupted itself once in this project, rewriting a command
 * signature until the bot acted on its own bad note. Steering is rendered verbatim and is never
 * round-tripped through the model: nothing here is ever summarised, rewritten or re-ingested.
 *
 * Directives change only when a user asks. The model does relay `!steer` on the user's behalf -
 * that is the point - but the command refuses while `self_prompter` is active, so an autonomous
 * loop cannot rewrite its own standing instructions.
 *
 * Kept small deliberately. Small models sit on the exponential decay branch of instruction
 * following, so a long directive list would quietly degrade the rules that already matter.
 */

const MAX_DIRECTIVES = 8;
const MAX_CHARS = 120;      // per directive
const MAX_TOTAL_CHARS = 600; // whole block, so it cannot crowd out the rest of the prompt

export class Steering {
    constructor(agent) {
        this.agent = agent;
        this.directives = [];
    }

    _file() {
        return path.join('bots', this.agent.name, 'steering.json');
    }

    load() {
        try {
            const raw = fs.readFileSync(this._file(), 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) this.directives = parsed.filter(d => d && typeof d.text === 'string');
        } catch (err) {
            this.directives = []; // absent or unreadable: start clean, this is not an error
        }
        if (this.directives.length) console.log(`Loaded ${this.directives.length} steering directive(s).`);
        return this.directives;
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this._file()), { recursive: true });
            fs.writeFileSync(this._file(), JSON.stringify(this.directives, null, 2));
        } catch (err) {
            console.error('Could not save steering directives:', err.message);
        }
    }

    /**
     * @returns {{ok:boolean, message:string}}
     */
    add(text) {
        const clean = String(text ?? '').trim().replace(/\s+/g, ' ');
        if (!clean) return { ok: false, message: 'Nothing to add - give me an instruction.' };
        if (clean.length > MAX_CHARS)
            return { ok: false, message: `Too long (${clean.length} chars, max ${MAX_CHARS}). Shorten it.` };
        if (this.directives.length >= MAX_DIRECTIVES)
            return { ok: false, message: `Already at the limit of ${MAX_DIRECTIVES}. Remove one first with !unsteer.` };
        if (this.directives.some(d => d.text.toLowerCase() === clean.toLowerCase()))
            return { ok: false, message: 'I am already steering on that.' };

        const total = this.directives.reduce((n, d) => n + d.text.length, 0) + clean.length;
        if (total > MAX_TOTAL_CHARS)
            return { ok: false, message: `That would push the steering block past ${MAX_TOTAL_CHARS} chars. Remove one first.` };

        this.directives.push({ text: clean, added: new Date().toISOString() });
        this.save();
        return { ok: true, message: `Steering added (${this.directives.length}/${MAX_DIRECTIVES}): "${clean}"` };
    }

    /** @param {number|string} which 1-based index, or 'all' */
    remove(which) {
        if (String(which).toLowerCase() === 'all') {
            const n = this.directives.length;
            this.directives = [];
            this.save();
            return { ok: true, message: n ? `Cleared all ${n} steering directive(s).` : 'There was nothing to clear.' };
        }
        const i = Number(which);
        if (!Number.isInteger(i) || i < 1 || i > this.directives.length)
            return { ok: false, message: `No directive ${which}. Use !steering to see the numbered list.` };
        const [gone] = this.directives.splice(i - 1, 1);
        this.save();
        return { ok: true, message: `Removed ${i}: "${gone.text}"` };
    }

    list() {
        if (!this.directives.length) return 'No steering directives. Add one with !steer("be brief").';
        return `Steering (${this.directives.length}/${MAX_DIRECTIVES}):\n`
            + this.directives.map((d, i) => `${i + 1}. ${d.text}`).join('\n');
    }

    /** Rendered verbatim into the prompt; empty string when there is nothing to say. */
    render() {
        if (!this.directives.length) return '';
        // Stated as an explicit override. Without it these lose to the numbered rules earlier in
        // the prompt - measured: "keep replies to one short sentence" was ignored because rule 9
        // tells the model to be proactive and offer next steps.
        return '=== STANDING INSTRUCTIONS FROM THE USER ===\n'
            + 'These OVERRIDE the numbered rules above wherever they conflict. Follow them exactly.\n'
            + this.directives.map((d, i) => `${i + 1}. ${d.text}`).join('\n')
            + '\n=== END STANDING INSTRUCTIONS ===';
    }
}
