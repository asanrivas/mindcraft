#!/usr/bin/env bun
/**
 * The live build, in a terminal: the same snapshot the web UI's build panel draws.
 *
 *   bun tools/build_status.mjs            # one screen and exit
 *   bun tools/build_status.mjs --watch    # refresh every 5s
 *   bun tools/build_status.mjs --json     # the raw snapshot
 *   bun tools/build_status.mjs --bot andy
 *
 * Reads bots/<bot>/BUILD_STATUS.json (the current snapshot, rewritten at most once a second while a
 * build runs) and bots/<bot>/BUILD_METRICS.jsonl (a sample every 30s). Both are written by
 * blueprint_builder.js through build_telemetry.js.
 *
 * STALENESS IS MEASURED FROM THE FILE'S MTIME, never from a timestamp compared to a wall clock read
 * some other way. Log lines here are UTC on a +0800 host, and a stale-looking gap has been misread as
 * eight hours of silence before (CLAUDE.md). The status file is rewritten continuously while a build
 * runs, so an old mtime means nothing is running - which this says outright rather than printing an
 * old snapshot as if it were current.
 */
import fs from 'node:fs';
import { formatDuration as dur } from '../src/agent/library/build_telemetry.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const bot = arg('bot', 'bob');
const STATUS = `bots/${bot}/BUILD_STATUS.json`;
const METRICS = `bots/${bot}/BUILD_METRICS.jsonl`;
const n = (x) => (x === null || x === undefined) ? '-' : Number(x).toLocaleString('en-US');
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (xs) => { const m = Math.max(1, ...xs); return xs.map(v => SPARK[Math.min(7, Math.round((v / m) * 7))]).join(''); };

function trend(limit = 24) {
    try {
        const lines = fs.readFileSync(METRICS, 'utf8').trim().split('\n').slice(-limit);
        return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

function screen() {
    let b, age;
    try {
        b = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
        age = (Date.now() - fs.statSync(STATUS).mtimeMs) / 1000;
    } catch (e) { return `no build status for ${bot} (${STATUS}): ${e.message}`; }
    if (flag('json')) return JSON.stringify(b, null, 2);

    const out = [];
    const live = age < 30;
    const file = String(b.file || '?').split('/').pop();
    const o = b.origin ? `(${b.origin.x}, ${b.origin.y}, ${b.origin.z})` : '';
    out.push(`${bot}: ${file} ${o}`);
    out.push(`  phase   ${b.phase}${b.phaseElapsedMs !== undefined ? ` for ${dur(b.phaseElapsedMs)}` : ''}   `
        + `running ${dur(b.elapsedMs)}   status ${live ? `live (${Math.round(age)}s old)` : `STALE - last written ${dur(age * 1000)} ago; nothing is updating it`}`);
    if (b.counts) {
        const c = b.counts, standing = c.placed + c.skipped;
        out.push(`  standing ${n(standing)} / ${n(b.total)} (${b.standingPct}%)   placed ${n(c.placed)}   `
            + `already there ${n(c.skipped)}   failed ${n(c.failed)}   waiting ${n(c.waiting)} (released ${n(c.released)})`);
        const pass = b.pass ? `${b.pass.name} ${n(b.pass.planned)}/${n(b.pass.length)}` : '-';
        out.push(`  rate    ${b.perMin}/min placed, ${b.attemptsPerMin}/min attempted   pass ${pass}   ETA this pass ${dur(b.passEtaMs)}`);
        out.push(`  layer   ${b.layer ?? '-'} of ${b.maxLayer ?? '-'}   at ${b.target ? `${b.target.x}, ${b.target.y}, ${b.target.z}` : '-'}   `
            + `since last placed ${n(b.sinceLastPlaced)} (watchdog stops at 200)`);
        const h = b.health || {};
        out.push(`  health  rescues ${n(h.rescues)}  recentres ${n(h.recentres)}  walked back ${n(h.leashed)}  `
            + `supports ${n(h.supportsUsed)}/${n(h.supportsBuilt)}  yaw aimed ${n(h.yawAimed)}  re-faced ${n(h.refacing)}`);
        if (b.clear?.targets) out.push(`  clear   layer ${b.clear.layer} ${n(b.clear.visited)}/${n(b.clear.targets)}`);
        if (b.foundation && (b.foundation.placed || b.foundation.tooDeep))
            out.push(`  found.  ${n(b.foundation.placed)} placed, ${n(b.foundation.tooDeep)} columns too deep, ${n(b.foundation.unread)} unread`);
    } else {
        out.push(`  (old-format status: ${JSON.stringify(b)})`);
    }
    if (b.topFailures?.length) {
        out.push('  failing:');
        for (const f of b.topFailures) out.push(`    ${String(n(f.n)).padStart(6)}  ${f.why}`
            + (f.blocks?.length ? `  - ${f.blocks.map(x => `${x.name} ${n(x.n)}`).join(', ')}` : ''));
    }
    const t = trend();
    if (t.length) out.push(`  trend   placed/min ${spark(t.map(s => s.perMin))}  (last ${t.length} samples, 30s apart; now ${t[t.length - 1].perMin})`);
    if (b.verified) out.push(`  VERIFIED ${n(b.verified.match)} / ${n(b.verified.total)} (${b.verified.pct}%)`);
    if (b.stopped) out.push(`  STOPPED ${b.stopped}`);
    if (b.ended) out.push(`  ENDED   ${b.ended}`);
    if (b.site?.notes?.length) out.push(...b.site.notes.map(s => `  site    ${s}`));
    return out.join('\n');
}

if (flag('watch')) {
    const draw = () => { process.stdout.write('\x1b[2J\x1b[H' + screen() + `\n\n  (refreshing every 5s - ctrl-c to quit)\n`); };
    draw(); setInterval(draw, 5000);
} else {
    console.log(screen());
}
