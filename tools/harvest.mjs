#!/usr/bin/env bun
/**
 * Build a fine-tuning dataset from the captured corpus.
 *
 *   bun tools/harvest.mjs --report                 # what have I got, and what would be dropped
 *   bun tools/harvest.mjs --out data/train.jsonl   # write the student-form dataset
 *   bun tools/harvest.mjs --form both --out data/pairs.jsonl
 *
 * Input is `bots/<name>/corpus/*.jsonl` (see src/utils/corpus.js), not `bots/<name>/logs/` -
 * the latter is rotated down to 20 files a minute and is not a dataset.
 *
 * WHAT THIS IS FOR. The measured prompt on this deployment is 7,393 tokens, of which the
 * command-docs block is 2,808 (38%). The bot does not need to be made smarter - across 16 MB
 * of service.log there are zero malformed commands - it needs that block moved out of the
 * context window and into the weights. So the target task is CONTEXT DISTILLATION:
 *
 *      teacher  = system prompt WITH docs   -> response      (what the model does today)
 *      student  = system prompt WITHOUT docs -> same response (what we want it to do)
 *
 * The teacher is deliberately the local model itself. A stronger teacher would be worse here:
 * we are not trying to change the behaviour, only to stop paying 2,808 tokens per turn to get
 * it, and a cloud model's phrasing would drag the student off the behaviour already verified
 * in production.
 *
 * SELECTION IS THE WHOLE JOB. Raw capture is badly imbalanced - the outcome markers in
 * service.log run 3,412 VERIFIED SHELTER against 22 TRAVEL and 3 MINE, because a mode firing
 * on a loop writes far more records than a rare interesting action. Training on that yields a
 * bot that digs shelters. Everything below exists to stop that.
 */
import { promises as fs } from 'fs';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { restoreDocs } from '../src/utils/corpus.js';
import { commandExists } from '../src/agent/commands/index.js';
// The ROOT settings.js - the actual config file. `src/agent/settings.js` is an empty
// mutable holder that main.js populates at runtime via setSettings(), so a standalone
// tool importing it gets {} and every blocked-command check silently passes.
import settings from '../settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const o = {
        bot: null,               // null = every bot with a corpus
        out: null,
        form: 'student',         // student | teacher | both
        tag: 'conversation',     // conversation | coding | memSaving | all
        includeBackup: false,
        maxPerTemplate: 5,
        maxPerCommand: 60,      // Infinity to disable
        keepBlocked: false,     // keep turns that use a now-blocked command
        keepInvalid: false,     // keep turns that call a non-existent command
        minResponseChars: 2,
        serviceLog: path.join(ROOT, 'logs', 'service.log'),
        outcomeWindowSec: 90,
        report: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--bot') o.bot = next();
        else if (a === '--out') o.out = next();
        else if (a === '--form') o.form = next();
        else if (a === '--tag') o.tag = next();
        else if (a === '--include-backup') o.includeBackup = true;
        else if (a === '--max-per-template') o.maxPerTemplate = Number(next());
        else if (a === '--max-per-command') o.maxPerCommand = Number(next());
        else if (a === '--keep-blocked') o.keepBlocked = true;
        else if (a === '--keep-invalid') o.keepInvalid = true;
        else if (a === '--min-chars') o.minResponseChars = Number(next());
        else if (a === '--service-log') o.serviceLog = next();
        else if (a === '--window') o.outcomeWindowSec = Number(next());
        else if (a === '--report' || a === '--report-only') o.report = true;
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
        else { console.error(`unknown flag: ${a}`); usage(); process.exit(1); }
    }
    if (!o.out) o.report = true; // never silently do nothing
    return o;
}

function usage() {
    console.log(`
bun tools/harvest.mjs [--bot andy] [--out data/train.jsonl]
                      [--form student|teacher|both] [--tag conversation|all]
                      [--max-per-template 5] [--include-backup] [--report]

  --form student   system prompt with the command docs REMOVED  (the thing you train on)
  --form teacher   system prompt with the docs left in          (control / eval baseline)
  --form both      emit both, tagged with "form", for a paired comparison

  --max-per-template N   cap near-identical responses (default 5)
  --keep-blocked         keep turns using a command that settings.blocked_actions now blocks
                         (default: dropped - the model cannot emit it at inference time)
  --keep-invalid         keep turns calling a command that does not exist (default: dropped)
  --max-per-command N    cap examples per command (default 60; use Infinity to disable).
                         Together these stop one looping mode dominating the set. Surplus is
                         dropped by outcome - a failed turn goes before a verified one.
  --report               print the funnel and the surviving distribution, write nothing
`.trim());
}

// ---------------------------------------------------------------- loading

async function listBots(explicit) {
    if (explicit) return [explicit];
    const botsDir = path.join(ROOT, 'bots');
    const out = [];
    for (const name of await fs.readdir(botsDir).catch(() => [])) {
        if (existsSync(path.join(botsDir, name, 'corpus'))) out.push(name);
    }
    return out;
}

async function loadCorpus(bot) {
    const dir = path.join(ROOT, 'bots', bot, 'corpus');
    const recs = [];
    let malformed = 0;
    for (const f of (await fs.readdir(dir).catch(() => []))) {
        if (!f.endsWith('.jsonl')) continue;
        const text = await fs.readFile(path.join(dir, f), 'utf-8');
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line);
                r._bot = bot;
                recs.push(r);
            } catch { malformed++; }
        }
    }
    return { recs, malformed };
}

/** Docs blocks are stored once by hash; load them all so both forms can be rendered. */
async function loadDocsMap(bot) {
    const dir = path.join(ROOT, 'bots', bot, 'corpus', 'docs');
    const map = new Map();
    for (const f of (await fs.readdir(dir).catch(() => []))) {
        if (!f.endsWith('.txt')) continue;
        map.set(f.replace(/\.txt$/, ''), await fs.readFile(path.join(dir, f), 'utf-8'));
    }
    return map;
}

// ---------------------------------------------------------------- outcome join
//
// service.log lines look like:   [2026-08-29 06:58:45] [andy] <message>
// Corpus timestamps are ISO-UTC and the two clocks agree on this host, so a turn at T is
// labelled from that bot's lines in [T, T + window].
//
// This is an ANNOTATION, not a filter. A timestamp join across two log streams gets edge
// cases wrong, and silently dropping good training rows on a heuristic is worse than
// carrying a label the caller can choose to trust.

// A timestamp, then an OPTIONAL [bot] tag. Action results are logged as
//     [2026-08-28 14:40:37] Agent executed: !travel and got: Action output:
// with no bot tag at all, so requiring one drops exactly the lines that carry the outcome.
const LOG_LINE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] (?:\[([^\]]+)\] ?)?(.*)$/;

/**
 * Flatten service.log into timestamped events.
 *
 * Entries are MULTI-LINE: only the first line carries the stamp and the result body follows
 * unprefixed. Of 3,521 VERIFIED lines just 31 have a prefix - the other 3,490 are continuation
 * lines - so a parser that skips unmatched lines throws away 99% of the outcome signal (which
 * is what the first version of this did, reporting zero verified labels).
 *
 * Continuation lines inherit the previous entry's time and bot. Bot attribution is therefore
 * best-effort: with two agents interleaving, an untagged entry is credited to whichever agent
 * logged last. That is why the outcome is carried as a label and never used to drop rows.
 */
/**
 * Flatten a service log into ACTION-RESULT blocks.
 *
 * The first version scanned every line for words like "failed" or "stuck" and labelled 52.7% of
 * the corpus as failed. Almost all of it was the agent's own prompt being echoed into the log:
 * few-shot examples ("Example: Code output: Could not find any oak_log"), the behaviour log
 * ("Your behavior log: I'm stuck!"), memory bullets ("- Viewing chest contents can time out"),
 * and startup warnings ("Failed to load node-canvas-webgl"). Across both logs "stuck" alone
 * matched 3,391 lines and "error" 3,048, against only 3,819 real action results in total.
 *
 * So outcomes are read ONLY from the blocks the agent writes when an action returns:
 *
 *     [2026-08-29 09:18:42] Agent executed: !travel and got: Action output:
 *     VERIFIED TRAVEL: moved 100/100 blocks ...        <- unprefixed continuation lines
 *
 * A block runs from that header to the next timestamped entry. Nothing outside one can produce
 * a label, which is what makes prompt echo structurally unable to contaminate the result.
 */
const EXEC_LINE = /Agent executed: !(\w+) and got:/;

function loadOneLog(file, defaultBot) {
    if (!existsSync(file)) return [];
    const out = [];
    let curBot = defaultBot, open = null;
    const close = () => { if (open) out.push(open); open = null; };

    for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const m = LOG_LINE.exec(line);
        if (m) {
            close();
            const t = Date.parse(`${m[1]}T${m[2]}Z`);
            if (Number.isNaN(t)) continue;
            if (m[3]) curBot = m[3];        // keep the last known bot across untagged entries
            const e = EXEC_LINE.exec(m[4]);
            if (e) open = { t, bot: m[3] ?? curBot, cmd: e[1], body: [] };
        } else if (open && line.trim()) {
            open.body.push(line);
        }
    }
    close();
    return out;
}

/**
 * Load every service log, not just the shared one.
 *
 * Agents may write to their own file: `logs/service-bob.log` alongside `logs/service.log`.
 * Reading only the shared file silently left every one of bob's turns labelled "unknown",
 * which looks identical to "nothing happened" - so a per-bot log is discovered by filename and
 * its untagged lines default to that bot rather than inheriting another agent's tag.
 */
function loadServiceLogs(primary) {
    const dir = path.dirname(primary);
    const files = new Map();
    files.set(primary, null);
    for (const f of (existsSync(dir) ? readdirSync(dir) : [])) {
        const m = /^service-([A-Za-z0-9_.-]+)\.log$/.exec(f);
        if (m) files.set(path.join(dir, f), m[1]);
    }
    const out = [];
    for (const [file, defaultBot] of files) out.push(...loadOneLog(file, defaultBot));
    out.sort((a, b) => a.t - b.t);
    return out;
}

/**
 * Classify one action-result body.
 *
 * Structured markers only - the skills emit them deliberately (`VERIFIED <X>` on success,
 * `NAV: arrived=true|false` from the navigator). Free-text sentiment is not consulted: it is
 * what produced the 52.7% false-positive rate, and a result body that says nothing recognisable
 * is honestly 'quiet' rather than guessed at.
 *
 * Exported for tests.
 */
export function classifyResult(body) {
    const text = Array.isArray(body) ? body.join('\n') : String(body ?? '');
    const v = /VERIFIED\s+([A-Z]+)/.exec(text);
    if (v) return { outcome: 'verified', verified: v[1] };
    if (/\bNAV: arrived=true\b/.test(text)) return { outcome: 'verified', verified: 'NAV' };
    if (/\bNAV: arrived=false\b/.test(text)) return { outcome: 'failed', verified: null };
    // Explicit, self-reported refusals and dead ends - phrases the skills emit as their whole
    // return value, not words that merely appear somewhere in a paragraph.
    if (/^(Refused:|Failed to |Could not |Unable to |Cannot )/m.test(text)) return { outcome: 'failed', verified: null };
    if (/\b(timed out after|does not exist|Invalid command)\b/.test(text)) return { outcome: 'failed', verified: null };
    return { outcome: 'quiet', verified: null };
}

function labelOutcome(events, rec, windowSec) {
    const t0 = Date.parse(rec.ts);
    if (Number.isNaN(t0) || !events.length) return { outcome: 'unknown', verified: null };
    const t1 = t0 + windowSec * 1000;
    let lo = 0, hi = events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].t < t0) lo = mid + 1; else hi = mid; }

    let saw = false, failed = false, cmd = null;
    for (let i = lo; i < events.length && events[i].t <= t1; i++) {
        const e = events[i];
        if (e.bot !== rec._bot) continue;
        saw = true;
        const c = classifyResult(e.body);
        if (c.outcome === 'verified') return { ...c, cmd: e.cmd };
        if (c.outcome === 'failed') { failed = true; cmd = e.cmd; }
    }
    if (failed) return { outcome: 'failed', verified: null, cmd };
    return { outcome: saw ? 'quiet' : 'unknown', verified: null };
}

// ---------------------------------------------------------------- quality

const BRAIN_DEAD = /my brain disconnected/i;

/**
 * Commands the model may no longer emit, read straight from settings rather than a list kept
 * here - so blocking something in settings.js automatically purges it from the dataset too,
 * and the two can never drift apart.
 *
 * A turn that calls one is worse than useless: the command will not exist at inference time, so
 * the example teaches the model to reach for something it cannot have. That is exactly what the
 * operator/creative block is for - before it, 161 of 589 usable examples (27%) invoked one and
 * !serverSetblock was the second most common command in the whole set.
 */
const BLOCKED = new Set(settings.blocked_actions ?? []);

/** Every command a response tries to call, valid or not. */
function calledCommands(resp) {
    return [...String(resp ?? '').matchAll(/!(\w+)/g)].map(m => '!' + m[1]);
}


/**
 * Collapse a response to a shape key so that near-duplicates group together.
 * Numbers, coordinates and quoted arguments are the parts that vary between otherwise
 * identical replies - "Got it! I'm at x: 4611, y: 111, z: 4702" appears verbatim dozens of
 * times with only the coordinates moving.
 */
export function templateKey(resp) {
    return resp
        .replace(/-?\d+(\.\d+)?/g, '#')      // numbers -> #
        .replace(/"[^"]*"/g, '"S"')          // quoted args -> "S"
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

/** Command names mentioned in a response, for distribution reporting. */
export function commandsIn(resp) {
    return [...resp.matchAll(/!(\w+)/g)].map(m => m[1]);
}

function qualityReject(rec, opt) {
    if (opt.tag !== 'all' && rec.tag !== opt.tag) return 'wrong-tag';
    if (!opt.includeBackup && rec.on_backup) return 'backup-model';
    const r = (rec.response ?? '').trim();
    if (r.length < opt.minResponseChars) return 'empty';
    if (BRAIN_DEAD.test(r)) return 'brain-disconnected';
    if (!Array.isArray(rec.messages) || rec.messages.length === 0) return 'no-messages';
    if (!rec.prompt) return 'no-prompt';

    const called = calledCommands(r);
    if (!opt.keepBlocked && called.some(c => BLOCKED.has(c))) return 'blocked-command';
    // A hallucinated name teaches invalid syntax. Rare (6 of 589 - !serverSeed, !collectBlock)
    // but there is no argument for keeping it.
    if (!opt.keepInvalid && called.some(c => !commandExists(c))) return 'invalid-command';
    return null;
}

// ---------------------------------------------------------------- emit

function toExample(rec, docsMap, form) {
    const docs = form === 'teacher' ? (docsMap.get(rec.docs_sha) ?? '') : '';
    const system = rec.docs_sha ? restoreDocs(rec.prompt, rec.docs_sha, docs) : rec.prompt;
    return {
        messages: [
            { role: 'system', content: system },
            ...rec.messages.map(m => ({ role: m.role, content: m.content })),
            { role: 'assistant', content: rec.response },
        ],
        form,
        meta: {
            ts: rec.ts,
            bot: rec._bot,
            tag: rec.tag,
            model: rec.model,
            outcome: rec._outcome?.outcome,
            verified: rec._outcome?.verified ?? undefined,
        },
    };
}

// ---------------------------------------------------------------- main

async function main() {
    const opt = parseArgs(process.argv);
    const bots = await listBots(opt.bot);
    if (!bots.length) {
        console.error('No corpus found. Set `collect_corpus: true` in settings.js and run the bot.');
        console.error('Expected: bots/<name>/corpus/*.jsonl');
        process.exit(1);
    }

    const events = loadServiceLogs(opt.serviceLog);
    const funnel = { loaded: 0, malformed: 0 };
    const rejects = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

    let kept = [];
    const docsMaps = new Map();

    for (const bot of bots) {
        const { recs, malformed } = await loadCorpus(bot);
        docsMaps.set(bot, await loadDocsMap(bot));
        funnel.loaded += recs.length;
        funnel.malformed += malformed;

        for (const rec of recs) {
            const why = qualityReject(rec, opt);
            if (why) { bump(rejects, why); continue; }
            rec._outcome = labelOutcome(events, rec, opt.outcomeWindowSec);
            kept.push(rec);
        }
    }

    // ---- balance, in two passes.
    //
    // The template cap alone is not enough. It collapses responses that differ only in numbers
    // and quoted args, but `!digDown` called with different arguments survives as distinct
    // rows - and that is exactly the shape of the imbalance here: 169 !digDown and 116 !navTo
    // out of 485, because one bot spent hours in a dig loop (493 identical action results). A
    // model trained on that learns to dig down.
    //
    // Sorted oldest-first so a cap keeps a spread across the whole capture period rather than
    // whatever happened to be captured first in one sitting.
    kept.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    // Pass 1: near-identical responses.
    const seen = new Map();
    const deduped = [];
    let cappedOut = 0;
    for (const rec of kept) {
        const k = templateKey(rec.response);
        const n = seen.get(k) ?? 0;
        if (n >= opt.maxPerTemplate) { cappedOut++; continue; }
        seen.set(k, n + 1);
        deduped.push(rec);
    }

    // Pass 2: per-command cap.
    //
    // When a class is over budget the surplus is dropped by OUTCOME first: a turn whose command
    // demonstrably failed teaches a wrong action, so it is the first thing to go, while a
    // `verified` turn is the last. Within a rank the spread over time is preserved by taking an
    // even stride rather than a prefix.
    const RANK = { verified: 0, quiet: 1, unknown: 2, failed: 3 };
    const byCmd = new Map();
    for (const rec of deduped) {
        const cmds = commandsIn(rec.response);
        const cls = cmds.length ? '!' + cmds[0] : '(chat)';
        if (!byCmd.has(cls)) byCmd.set(cls, []);
        byCmd.get(cls).push(rec);
    }
    const balanced = [];
    let commandCappedOut = 0;
    for (const [, group] of byCmd) {
        if (!Number.isFinite(opt.maxPerCommand) || group.length <= opt.maxPerCommand) {
            balanced.push(...group);
            continue;
        }
        group.sort((a, b) => (RANK[a._outcome.outcome] ?? 9) - (RANK[b._outcome.outcome] ?? 9)
                             || String(a.ts).localeCompare(String(b.ts)));
        const stride = group.length / opt.maxPerCommand;
        const picked = [];
        for (let i = 0; i < opt.maxPerCommand; i++) picked.push(group[Math.floor(i * stride)]);
        commandCappedOut += group.length - picked.length;
        balanced.push(...picked);
    }
    balanced.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    // ---- report
    const dist = new Map();
    for (const rec of balanced) {
        const cs = commandsIn(rec.response);
        if (!cs.length) bump(dist, '(chat, no command)');
        for (const c of new Set(cs)) bump(dist, '!' + c);
    }
    const outcomes = new Map();
    for (const rec of balanced) bump(outcomes, rec._outcome.outcome);

    const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '-';
    console.log(`\nbots            : ${bots.join(', ')}`);
    console.log(`action results  : ${events.length.toLocaleString()} blocks from logs/service*.log`);
    console.log(`\nFUNNEL`);
    console.log(`  loaded        : ${funnel.loaded.toLocaleString()}`);
    if (funnel.malformed) console.log(`  malformed json: ${funnel.malformed}`);
    for (const [k, v] of [...rejects].sort((a, b) => b[1] - a[1])) {
        console.log(`  drop ${k.padEnd(19)}: ${v.toLocaleString()}`);
    }
    console.log(`  after quality : ${kept.length.toLocaleString()}`);
    console.log(`  capped (>${opt.maxPerTemplate}/tpl): ${cappedOut.toLocaleString()}`);
    console.log(`  capped (>${opt.maxPerCommand}/cmd): ${commandCappedOut.toLocaleString()}`);
    console.log(`  KEPT          : ${balanced.length.toLocaleString()}  (${pct(balanced.length, funnel.loaded)} of loaded)`);

    console.log(`\nOUTCOME LABELS (annotation from service.log, not a filter)`);
    for (const [k, v] of [...outcomes].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(10)}: ${String(v).padStart(6)}  ${pct(v, balanced.length)}`);
    }

    console.log(`\nCOMMAND DISTRIBUTION (top 25 of ${dist.size})`);
    for (const [k, v] of [...dist].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        console.log(`  ${k.padEnd(26)}: ${String(v).padStart(6)}`);
    }

    // token estimate for both forms, so the saving is visible before anyone trains
    if (balanced.length) {
        const s = balanced[0];
        const dm = docsMaps.get(s._bot);
        const t = toExample(s, dm, 'teacher').messages[0].content.length;
        const u = toExample(s, dm, 'student').messages[0].content.length;
        console.log(`\nSYSTEM PROMPT (first kept record)`);
        console.log(`  teacher : ${t.toLocaleString()} chars  ~${Math.round(t / 4).toLocaleString()} tok`);
        console.log(`  student : ${u.toLocaleString()} chars  ~${Math.round(u / 4).toLocaleString()} tok`);
        console.log(`  saving  : ${(t - u).toLocaleString()} chars  ~${Math.round((t - u) / 4).toLocaleString()} tok/turn  (${pct(t - u, t)})`);
    }

    if (opt.report) {
        console.log(`\n(report only - nothing written. pass --out <file> to emit)\n`);
        return;
    }

    const forms = opt.form === 'both' ? ['teacher', 'student'] : [opt.form];
    const outPath = path.isAbsolute(opt.out) ? opt.out : path.join(ROOT, opt.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const lines = [];
    for (const rec of balanced) {
        for (const form of forms) lines.push(JSON.stringify(toExample(rec, docsMaps.get(rec._bot), form)));
    }
    await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`\nwrote ${lines.length.toLocaleString()} example(s) -> ${outPath}\n`);
}

// Only run when invoked directly, so templateKey/commandsIn stay importable by tests.
if (import.meta.main) {
    main().catch(e => { console.error(e); process.exit(1); });
}
