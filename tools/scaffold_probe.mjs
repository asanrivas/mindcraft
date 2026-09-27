#!/usr/bin/env bun
/**
 * Does bamboo scaffolding actually work on this server? Measure it, do not assume it.
 *
 *   bun tools/scaffold_probe.mjs --username probe1 --at 4760,68,4650
 *
 * WHY IT MATTERS
 * --------------
 * `blueprint_builder.scaffoldTo` reaches work above walking height by pillaring a DIRT column:
 * one asserted jump per block, then `pillarDown` digs the column out one block at a time. That
 * path is the single most expensive thing in a build, and it is built on the jump - the most
 * fragile primitive in this codebase.
 *
 * Scaffolding is the vanilla answer to exactly this problem, and if it behaves here it is
 * strictly better on three counts. This probe checks each one rather than trusting the wiki:
 *
 *   1. TOWER   - can we stack it upward from where we stand?
 *   2. CLIMB   - can the bot ASCEND inside the column? Vanilla scaffolding is climbable, which
 *                would make vertical access independent of the jump entirely.
 *   3. CHAIN   - does breaking the BOTTOM block remove the whole column in one go? That would
 *                turn pillarDown's per-block dig loop into a single dig.
 *   4. REACH   - scaffolding carries a `distance` state and detaches past 6 from a support;
 *                worth knowing the real limit before relying on horizontal runs.
 */
import { createRequire } from 'module';
import { Vec3 } from 'vec3';
import settings from '../settings.js';

const require = createRequire('/home/asanrivas/mindcraft/');
const mineflayer = require('mineflayer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const username = arg('username', 'probe1');
const [px, py, pz] = arg('at', '4760,68,4650').split(',').map(Number);
const TOWER = Number(arg('tower', 6));
const log = (m) => console.log(`[scaffold] ${m}`);

const bot = mineflayer.createBot({
    host: arg('host', settings.host), port: Number(arg('port', settings.port)),
    username, version: arg('version', '1.21.11'), auth: 'offline',
});
bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 160)}`); process.exit(1); });
await new Promise((r) => bot.once('spawn', r));

const rcon = async (cmd) => {
    const p = Bun.spawn(['bun', 'tools/rcon.mjs', cmd], { cwd: '/home/asanrivas/mindcraft', stdout: 'pipe' });
    await p.exited;
    return new Response(p.stdout).text();
};

await rcon(`forceload add ${px - 6} ${pz - 6} ${px + 6} ${pz + 6}`);
await rcon(`fill ${px - 4} ${py - 1} ${pz - 4} ${px + 4} ${py - 1} ${pz + 4} stone`);
await rcon(`fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 20} ${pz + 4} air`);
await rcon(`gamemode creative ${username}`);
await rcon(`tp ${username} ${px + 0.5} ${py} ${pz + 0.5}`);
await rcon(`give ${username} scaffolding 64`);
await new Promise((r) => setTimeout(r, 2500));

const blockIO = await import('../src/agent/library/block_io.js');
const nameAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? 'null';

// ---- 1. TOWER: stack scaffolding upward from the ground ----
log('');
log('--- 1. TOWER: stack it upward ---');
const col = { x: px + 2, z: pz };
let built = 0;
for (let i = 0; i < TOWER; i++) {
    const ref = bot.blockAt(new Vec3(col.x, py - 1 + i, col.z));
    if (!ref || ref.boundingBox !== 'block') { log(`  step ${i}: no support (${ref?.name})`); break; }
    const item = bot.inventory.items().find((it) => it.name === 'scaffolding');
    if (!item) { log(`  step ${i}: out of scaffolding`); break; }
    await bot.equip(item, 'hand');
    const r = await blockIO.placeVerified(bot, ref, new Vec3(0, 1, 0), { expectName: 'scaffolding' });
    if (!r.ok) { log(`  step ${i} at y=${py + i}: FAILED (${r.why})`); break; }
    built++;
}
log(`  built ${built}/${TOWER} high from the ground, standing still (no jump needed to PLACE)`);

// ---- 2. CLIMB: ascend inside the column ----
log('');
log('--- 2. CLIMB: hold jump inside the column ---');
await rcon(`tp ${username} ${col.x + 0.5} ${py} ${col.z + 0.5}`);
await new Promise((r) => setTimeout(r, 900));
const y0 = bot.entity.position.y;
bot.setControlState('jump', true);
await new Promise((r) => setTimeout(r, 2500));
bot.setControlState('jump', false);
await new Promise((r) => setTimeout(r, 400));
const y1 = bot.entity.position.y;
log(`  y ${y0.toFixed(2)} -> ${y1.toFixed(2)}  (gained ${(y1 - y0).toFixed(2)} in 2.5s holding jump)`);
log(`  ${y1 - y0 > 1.0 ? 'CLIMBS - vertical access without the jump primitive' : 'DOES NOT CLIMB here'}`);

// ---- 3. CHAIN BREAK: does removing the bottom take the whole column? ----
log('');
log('--- 3. CHAIN BREAK: dig the bottom block ---');
const before = [];
for (let i = 0; i < built; i++) before.push(nameAt(col.x, py + i, col.z));
log(`  column before: ${before.filter((n) => n === 'scaffolding').length} scaffolding`);
await rcon(`tp ${username} ${col.x + 2.5} ${py} ${col.z + 0.5}`);
await new Promise((r) => setTimeout(r, 900));
const bottom = bot.blockAt(new Vec3(col.x, py, col.z));
if (bottom?.name === 'scaffolding') {
    try { await bot.dig(bottom, true); } catch (e) { log(`  dig threw: ${e.message.slice(0, 60)}`); }
    await new Promise((r) => setTimeout(r, 900));
}
const after = [];
for (let i = 0; i < built; i++) after.push(nameAt(col.x, py + i, col.z));
const left = after.filter((n) => n === 'scaffolding').length;
log(`  column after one dig: ${left} scaffolding left`);
log(`  ${left === 0 ? 'CHAIN BREAKS - one dig clears the whole tower' : 'does NOT chain-break; each block needs its own dig'}`);

// ---- 4. REACH: how far can it run horizontally before it detaches? ----
log('');
log('--- 4. REACH: horizontal run from a support ---');
await rcon(`fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 20} ${pz + 4} air`);
await rcon(`tp ${username} ${px + 0.5} ${py} ${pz + 0.5}`);
await new Promise((r) => setTimeout(r, 900));
let base = bot.blockAt(new Vec3(px, py - 1, pz));
const first = bot.inventory.items().find((it) => it.name === 'scaffolding');
if (first) await bot.equip(first, 'hand');
let reach = 0;
let prev = await blockIO.placeVerified(bot, base, new Vec3(0, 1, 0), { expectName: 'scaffolding' });
if (prev.ok) {
    reach = 1;
    for (let i = 1; i < 10; i++) {
        const ref = bot.blockAt(new Vec3(px + i - 1, py, pz));
        if (!ref || ref.name !== 'scaffolding') break;
        const item = bot.inventory.items().find((it) => it.name === 'scaffolding');
        if (!item) break;
        await bot.equip(item, 'hand');
        const r = await blockIO.placeVerified(bot, ref, new Vec3(1, 0, 0), { expectName: 'scaffolding' });
        if (!r.ok) { log(`  detached/refused at distance ${i} (${r.why})`); break; }
        reach = i + 1;
    }
}
log(`  horizontal run reached ${reach} block(s) from the support`);

log('');
log('VERDICT');
log(`  tower ${built}/${TOWER} | climb ${(y1 - y0).toFixed(2)} blocks | chain-break ${left === 0 ? 'YES' : 'NO'} | reach ${reach}`);
await rcon(`fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 20} ${pz + 4} air`);
await rcon(`forceload remove ${px - 6} ${pz - 6} ${px + 6} ${pz + 6}`);
bot.quit();
process.exit(0);
