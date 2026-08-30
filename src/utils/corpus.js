/**
 * Append-only training corpus.
 *
 * The debug logs in `bots/<name>/logs/` are NOT a dataset: `cleanupOldLogs` keeps the most
 * recent 20 files and deletes the rest once a minute, so the entire history on disk was 54
 * prompt/response pairs covering 20 minutes. That rotation is correct for its purpose (a
 * human reading back the last few turns) and is deliberately left alone - this writes a
 * second, parallel record that is never rotated.
 *
 * Storage shape. Every turn ships the same ~11,233-char command-docs block inside its system
 * prompt (2,808 tokens, 38% of a measured 7,393-token prompt). Storing that per record would
 * be ~90% duplication, so the docs are lifted into `corpus/docs/<sha>.txt` once and replaced
 * in the body by a sentinel. That is not only a size win: it is exactly the seam context
 * distillation needs, since the teacher form re-injects the docs and the student form drops
 * them. Doing the split at WRITE time makes it an exact string operation against the docs the
 * agent actually rendered - never a regex guess at a block boundary after the fact.
 *
 * This must never break the agent. `promptCoding`/`promptMemSaving` have no try/catch (see
 * CLAUDE.md, backup brain), so a throw here would propagate into the agent loop. Every entry
 * point swallows its own errors and the writer is fire-and-forget.
 */
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

/** Short content hash. 12 hex chars is ample for the handful of docs variants that exist. */
export function docsHash(s) {
    return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * Printable and self-describing on purpose. A literal NUL would be invisible in a JSONL file
 * and survives poorly through editors and shells; this reads plainly in a corpus record.
 */
export function docsSentinel(sha) {
    return `<<<COMMAND_DOCS:${sha}>>>`;
}

/**
 * Replace the command-docs block in a rendered prompt with a sentinel.
 *
 * Exact substring removal. If the docs are not found verbatim the prompt is stored whole and
 * `sha` is null, so a future prompt-format change degrades to "bigger records" rather than to
 * silently corrupted ones.
 *
 * @returns {{body: string, sha: string|null}}
 */
export function splitDocs(prompt, docs) {
    if (!prompt || !docs) return { body: prompt ?? '', sha: null };
    const i = prompt.indexOf(docs);
    if (i < 0) return { body: prompt, sha: null };
    const sha = docsHash(docs);
    return {
        body: prompt.slice(0, i) + docsSentinel(sha) + prompt.slice(i + docs.length),
        sha,
    };
}

/**
 * Inverse of splitDocs. Passing '' yields the STUDENT form (docs dropped entirely); passing
 * the real docs yields the TEACHER form. Those two are the whole point of the split.
 */
export function restoreDocs(body, sha, docs) {
    if (!body || !sha) return body ?? '';
    return body.split(docsSentinel(sha)).join(docs ?? '');
}

/** True when the record carries a liftable docs block. */
export function hasDocs(rec) {
    return Boolean(rec && rec.docs_sha);
}

export function corpusDir(botName) {
    return path.join(ROOT, 'bots', botName, 'corpus');
}

/** Written once per distinct docs block, then reused by hash. */
async function ensureDocs(botName, sha, docs) {
    const file = path.join(corpusDir(botName), 'docs', `${sha}.txt`);
    try {
        await fs.access(file);
        return; // already stored
    } catch { /* not yet written */ }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, docs, 'utf-8');
}

/**
 * Append one LLM turn to the corpus. Fire-and-forget: callers must not depend on it.
 *
 * @param {object} o
 * @param {string} o.botName
 * @param {string} o.tag          'conversation' | 'coding' | 'memSaving'
 * @param {string} o.prompt       the fully rendered system prompt
 * @param {Array}  o.messages     conversation turns handed to the model
 * @param {string} o.response     the model's generation
 * @param {string} [o.docs]       the exact command-docs string embedded in `prompt`
 * @param {string} [o.docsMode]   settings.command_docs_mode at render time
 * @param {string} [o.model]      which model actually served the request
 * @param {boolean} [o.onBackup]  true when a cloud backup answered, not the local model
 */
export async function recordTurn(o) {
    try {
        const { botName, tag, prompt, messages, response } = o;
        if (!botName || typeof response !== 'string') return;

        const { body, sha } = splitDocs(prompt, o.docs);
        if (sha) await ensureDocs(botName, sha, o.docs);

        const rec = {
            ts: new Date().toISOString(),
            tag,
            // Which model answered decides whether a turn belongs in a self-distillation set at
            // all: a Gemini-authored reply would teach the local model to imitate Gemini.
            model: o.model ?? null,
            on_backup: Boolean(o.onBackup),
            docs_mode: o.docsMode ?? null,
            docs_sha: sha,
            prompt: body,
            messages,
            response,
        };

        const day = rec.ts.slice(0, 10);
        const file = path.join(corpusDir(botName), `${day}.jsonl`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf-8');
    } catch (err) {
        // Never surface into the agent loop.
        console.warn('[corpus] record failed:', err?.message || err);
    }
}
