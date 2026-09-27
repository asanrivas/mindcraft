#!/usr/bin/env bun
/**
 * Backfill the corpus from the rotating debug logs.
 *
 *   bun tools/corpus_import.mjs            # dry run: say what would be imported
 *   bun tools/corpus_import.mjs --write
 *
 * `bots/<name>/logs/*.txt` is pruned to the newest 20 files once a minute, so whatever is
 * sitting there right now is the last of it. This lifts those turns into the permanent corpus
 * before the next sweep deletes them. It is idempotent - records are keyed by (bot, timestamp,
 * tag) and re-running skips what is already stored.
 *
 * The docs block cannot be recovered by exact match here (the logs predate the corpus, and the
 * agent state that rendered them is gone), so imported records are located by scanning for the
 * docs header and are marked `imported: true`. Treat them as a seed, not as the real capture.
 */
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { docsHash, docsSentinel, corpusDir } from '../src/utils/corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CONV = '\n\nConversation:\n';
const RESP = '\n\nResponse:\n';

/**
 * Split one debug-log file into its three parts.
 *
 * The delimiters are NOT unique: the conversing profile ends with its own "Conversation:"
 * header, so a rendered prompt contains one or more literal "\n\nConversation:\n" of its own
 * and a naive indexOf slices the prompt in half (observed: 53 of 56 files failing to parse).
 *
 * What makes the split reliable is that the messages are stored as JSON, where every newline
 * is escaped as \\n - so no literal "\n\nConversation:\n" can occur inside the blob. The log's
 * own marker is therefore always the LAST literal one, and the response marker is the first
 * literal one after it. Anything that still does not split cleanly is skipped, not guessed at.
 *
 * @returns {{ts: string, prompt: string, messages: Array, response: string}|null}
 */
export function parseLog(text) {
    const head = /^\[([^\]]+)\]/.exec(text);
    const ci = text.lastIndexOf(CONV);
    const ri = ci < 0 ? -1 : text.indexOf(RESP, ci);
    if (!head || ci < 0 || ri < 0 || ri < ci) return null;

    const pStart = text.indexOf('\nPrompt:\n');
    if (pStart < 0) return null;
    const prompt = text.slice(pStart + '\nPrompt:\n'.length, ci);
    const rawMsgs = text.slice(ci + CONV.length, ri);
    const response = text.slice(ri + RESP.length).replace(/\n+$/, '');

    let messages;
    try { messages = JSON.parse(rawMsgs); } catch { return null; }
    if (!Array.isArray(messages)) return null;

    // filename-style stamp: 2026-08-29T06-48-39-807Z -> ISO
    const ts = head[1].trim()
        .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z');

    return { ts, prompt, messages, response };
}

/**
 * Locate the command-docs block in a rendered prompt without having the original string.
 * Anchored on the headers getCommandDocs emits ("*CMDS - syntax:" / "*COMMANDS: Use") and
 * closed at the block's trailing "*" line. Returns null when the shape is not found - the
 * record is then stored whole, which costs space but never corrupts.
 */
export function findDocsBlock(prompt) {
    const start = (() => {
        for (const h of ['*CMDS - syntax:', '*COMMANDS: Use']) {
            const i = prompt.indexOf(h);
            if (i >= 0) return i;
        }
        return -1;
    })();
    if (start < 0) return null;
    const end = prompt.indexOf('\n*\n', start);
    if (end < 0) return null;
    return prompt.slice(start, end + '\n*\n'.length);
}

async function existingKeys(bot) {
    const dir = corpusDir(bot);
    const keys = new Set();
    for (const f of (await fs.readdir(dir).catch(() => []))) {
        if (!f.endsWith('.jsonl')) continue;
        const text = await fs.readFile(path.join(dir, f), 'utf-8');
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { const r = JSON.parse(line); keys.add(`${r.ts}|${r.tag}`); } catch { /* skip */ }
        }
    }
    return keys;
}

async function main() {
    const write = process.argv.includes('--write');
    const botsDir = path.join(ROOT, 'bots');
    let totalFound = 0, totalNew = 0, totalSkipped = 0, totalUnparsed = 0, docsLifted = 0;

    for (const bot of await fs.readdir(botsDir).catch(() => [])) {
        const logDir = path.join(botsDir, bot, 'logs');
        if (!existsSync(logDir)) continue;

        const files = (await fs.readdir(logDir)).filter(f => f.endsWith('.txt'));
        if (!files.length) continue;

        const seen = await existingKeys(bot);
        const byDay = new Map();
        const docsToWrite = new Map();
        let found = 0, added = 0, skipped = 0, unparsed = 0;

        for (const f of files) {
            const tag = f.split('_')[0]; // conversation | coding | memSaving
            const parsed = parseLog(await fs.readFile(path.join(logDir, f), 'utf-8'));
            if (!parsed) { unparsed++; continue; }
            found++;

            const key = `${parsed.ts}|${tag}`;
            if (seen.has(key)) { skipped++; continue; }
            seen.add(key);

            let prompt = parsed.prompt, docs_sha = null;
            const docs = findDocsBlock(parsed.prompt);
            if (docs) {
                docs_sha = docsHash(docs);
                prompt = parsed.prompt.split(docs).join(docsSentinel(docs_sha));
                docsToWrite.set(docs_sha, docs);
                docsLifted++;
            }

            const rec = {
                ts: parsed.ts,
                tag,
                model: null,        // not recorded in the old logs
                on_backup: false,   // unknown; assumed local. see --include-backup in harvest
                docs_mode: null,
                docs_sha,
                prompt,
                messages: parsed.messages,
                response: parsed.response,
                imported: true,
            };
            const day = String(parsed.ts).slice(0, 10);
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push(rec);
            added++;
        }

        totalFound += found; totalNew += added; totalSkipped += skipped; totalUnparsed += unparsed;
        console.log(`${bot.padEnd(16)} files=${String(files.length).padStart(4)} parsed=${String(found).padStart(4)} new=${String(added).padStart(4)} dup=${String(skipped).padStart(4)} unparsed=${String(unparsed).padStart(3)}`);

        if (write && added) {
            for (const [sha, docs] of docsToWrite) {
                const p = path.join(corpusDir(bot), 'docs', `${sha}.txt`);
                await fs.mkdir(path.dirname(p), { recursive: true });
                if (!existsSync(p)) await fs.writeFile(p, docs, 'utf-8');
            }
            for (const [day, recs] of byDay) {
                recs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
                const p = path.join(corpusDir(bot), `${day}.jsonl`);
                await fs.mkdir(path.dirname(p), { recursive: true });
                await fs.appendFile(p, recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
            }
        }
    }

    console.log(`\nparsed ${totalFound}, new ${totalNew}, already present ${totalSkipped}, unparsed ${totalUnparsed}, docs blocks lifted ${docsLifted}`);
    if (!write) console.log('dry run - pass --write to import');
}

if (import.meta.main) {
    main().catch(e => { console.error(e); process.exit(1); });
}
