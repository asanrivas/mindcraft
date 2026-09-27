#!/usr/bin/env bun
/**
 * Count how much of a blueprint is actually in the world, independently of any builder.
 *
 *   bun tools/verify_blueprint.mjs --file blueprints/wizard_tower.json --at 4570,63,4594
 *
 * WHY A SEPARATE TOOL. `buildBlueprint` verifies at the end of its run, but that report is the
 * LAST thing it does - so a run that ends any other way (a timeout force-stop, a mode interrupt,
 * a crash) leaves the work in the world and no number attached to it. That happened on
 * 2026-09-22: four hours of building force-stopped at the 240-minute ceiling, the throw propagated
 * past the verification block, and the only figures left were the builder's own bookkeeping -
 * which is exactly what this repo says not to trust. Read the world instead.
 *
 * It joins as a spectator-ish probe, waits for the chunks, and compares name AND orientation using
 * the same predicate the builder does, so the numbers are comparable.
 */
import { createRequire } from 'module';
import { Vec3 } from 'vec3';
import fs from 'fs';
import settings from '../settings.js';
import { orientationMismatch } from '../src/agent/library/blueprint_builder.js';

const require = createRequire(import.meta.url);
const mineflayer = require('mineflayer');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const file = arg('file', 'blueprints/wizard_tower.json');
const [ox, oy, oz] = arg('at', '4570,63,4594').split(',').map(Number);
// --below N: only blueprint-local layers y < N - the part a pass has already been over, so what is
// missing there is a FAILURE rather than work not reached yet. --dump F: every wrong cell as JSON.
const below = arg('below', null);
const dumpTo = arg('dump', null);
const cells = JSON.parse(fs.readFileSync(file, 'utf8')).placements
    .filter(p => typeof p.x === 'number' && (below === null || p.y < Number(below)));
const log = (m) => console.log(`[verify] ${m}`);

const xs = cells.map(p => ox + p.x), zs = cells.map(p => oz + p.z);
const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
const cz = Math.round((Math.min(...zs) + Math.max(...zs)) / 2);
const topY = oy + Math.max(...cells.map(p => p.y)) + 4;

const bot = mineflayer.createBot({
    host: arg('host', settings.host), port: Number(arg('port', settings.port)),
    username: arg('username', 'probe1'), version: arg('version', '1.21.11'), auth: 'offline',
});
bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 200)}`); process.exit(1); });
await new Promise((r) => bot.once('spawn', r));
log(`joined; centring on ${cx}, ${topY}, ${cz} and waiting for chunks`);

const rcon = async (cmd) => {
    const p = Bun.spawn(['bun', 'tools/rcon.mjs', cmd], { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe' });
    await p.exited;
    return new Response(p.stdout).text();
};
await rcon(`gamemode spectator ${bot.username}`);
await rcon(`tp ${bot.username} ${cx} ${topY} ${cz}`);

// POLL until the reads stop changing. A fixed sleep reports an unloaded chunk as a missing block,
// which is the "absence of evidence" mistake with a stopwatch attached.
let prev = -1, stable = 0;
for (let i = 0; i < 60 && stable < 3; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let seen = 0;
    for (const p of cells) if (bot.blockAt(new Vec3(ox + p.x, oy + p.y, oz + p.z))) seen++;
    if (seen === prev) stable++; else stable = 0;
    prev = seen;
    if (i % 5 === 0) log(`  ${seen}/${cells.length} cells readable...`);
}

let match = 0, misfacing = 0, wrong = 0, unread = 0;
const byWrong = new Map();
// Misfacings BY BLOCK TYPE and by which property is wrong. The tally alone said "339" and left
// every follow-up question unanswerable: a whole class inverted 180 degrees is one sign error,
// while two classes right and two wrong is the approach point or the clicked face. Without this
// breakdown the only way to tell them apart was to guess.
const byFacing = new Map();
const dumped = [];
for (const p of cells) {
    const b = bot.blockAt(new Vec3(ox + p.x, oy + p.y, oz + p.z));
    if (!b) { unread++; continue; }
    if (b.name !== p.name) {
        wrong++;
        if (dumpTo) dumped.push({ x: ox + p.x, y: oy + p.y, z: oz + p.z, ly: p.y, want: p.name, got: b.name, props: p.properties });
        const k = `${p.name} -> ${b.name}`;
        byWrong.set(k, (byWrong.get(k) || 0) + 1);
        continue;
    }
    const wrongWay = orientationMismatch(p, b);
    if (wrongWay) {
        misfacing++;
        const k = `${p.name}  ${wrongWay}`;
        byFacing.set(k, (byFacing.get(k) || 0) + 1);
        continue;
    }
    match++;
}
const pct = (n) => ((n / cells.length) * 100).toFixed(1);
log('');
log(`BLUEPRINT ${file} at (${ox}, ${oy}, ${oz})`);
log(`  cells          ${cells.length}`);
log(`  CORRECT        ${match}  (${pct(match)}%)`);
log(`  wrong facing   ${misfacing}  (${pct(misfacing)}%)  - right block, wrong way round`);
log(`  wrong/missing  ${wrong}  (${pct(wrong)}%)`);
log(`  unreadable     ${unread}`);
if (byWrong.size) {
    log('  top differences:');
    for (const [k, n] of [...byWrong.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) log(`    ${n}x ${k}`);
}
if (byFacing.size) {
    log('  wrong facing, by block and property:');
    for (const [k, n] of [...byFacing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) log(`    ${n}x ${k}`);
    // Per block type, collapsed, so "which classes are broken" is answerable at a glance.
    const byType = new Map();
    for (const [k, n] of byFacing) {
        const t = k.split('  ')[0];
        byType.set(t, (byType.get(t) || 0) + n);
    }
    log('  wrong facing, by block type:');
    for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) log(`    ${n}x ${k}`);
}
if (dumpTo) { fs.writeFileSync(dumpTo, JSON.stringify(dumped)); log(`  ${dumped.length} wrong cells written to ${dumpTo}`); }
bot.quit();
process.exit(0);
