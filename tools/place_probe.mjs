#!/usr/bin/env bun
/**
 * Does this server acknowledge block placements? Measure it, do not assume it.
 *
 *   bun tools/place_probe.mjs --username probe1 --at 4760,68,4650
 *
 * The question
 * ------------
 * mineflayer confirms a placement by waiting for a `blockUpdate` event at the destination
 * (`lib/plugins/place_block.js:13`, 500ms). On 1.17+ the client PREDICTS the placement
 * locally, so a server whose prediction matches sends no block_change at all - the await is
 * unsatisfiable and the throw is indistinguishable from a genuine refusal. That is the
 * `Event blockUpdate:(x, y, z) did not fire within timeout of 500ms` in our build logs.
 *
 * Since 1.19 the protocol has the right mechanism: every `block_place` carries a monotonic
 * `sequence`, and the server replies `acknowledge_player_digging { sequenceId }` - minecraft-data
 * kept the 1.18 name, but this is "Acknowledge Block Change". mineflayer writes
 * `sequence: 0` hardcoded (`lib/plugins/generic_place.js`) and never listens for the reply.
 *
 * So this probe writes the packet itself with a real sequence and reports, per placement:
 *   ack?      did acknowledge_player_digging arrive, and did sequenceId match what we sent
 *   ackMs     how long the round trip took
 *   landed?   what the world says is actually there afterwards
 *
 * Run it before trusting either mechanism. If the ack arrives reliably, mineflayer's
 * placement path should be replaced rather than tuned.
 */
import { createRequire } from 'module';
import { Vec3 } from 'vec3';
import settings from '../settings.js';

const require = createRequire('/home/asanrivas/mindcraft/');
const mineflayer = require('mineflayer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const username = arg('username', 'probe1');
const at = arg('at', '4760,68,4650').split(',').map(Number);
const rounds = Number(arg('rounds', 6));
const log = (m) => console.log(`[probe] ${m}`);

const bot = mineflayer.createBot({
    host: arg('host', settings.host),
    port: Number(arg('port', settings.port)),
    username,
    version: arg('version', '1.21.11'),
    auth: 'offline',
});

// Watch the ack channel from the moment we connect - registering after the write would race.
let lastAck = null, ackCount = 0;
bot._client.on('acknowledge_player_digging', (p) => { lastAck = { seq: p.sequenceId, at: Date.now() }; ackCount++; });
// Does the server ALSO send a block_change for our own placement? If it does, mineflayer's
// mechanism would work and the diagnosis is wrong - so count these too.
let blockChanges = 0;
bot._client.on('block_change', () => { blockChanges++; });
bot._client.on('multi_block_change', () => { blockChanges++; });

bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 200)}`); process.exit(1); });

await new Promise((r) => bot.once('spawn', r));
log(`spawned as ${username} at ${bot.entity.position.floored()}`);

const rcon = async (cmd) => {
    const p = Bun.spawn(['bun', 'tools/rcon.mjs', cmd], { cwd: '/home/asanrivas/mindcraft', stdout: 'pipe' });
    await p.exited;
    return new Response(p.stdout).text();
};

// Stand the probe on a known platform of its own, clear of anything else being built.
const [px, py, pz] = at;
await rcon(`forceload add ${px - 4} ${pz - 4} ${px + 4} ${pz + 4}`);
await rcon(`fill ${px - 3} ${py - 1} ${pz - 3} ${px + 3} ${py - 1} ${pz + 3} stone`);
await rcon(`fill ${px - 3} ${py} ${pz - 3} ${px + 3} ${py + 3} ${pz + 3} air`);
await rcon(`gamemode creative ${username}`);
await rcon(`tp ${username} ${px + 0.5} ${py} ${pz + 0.5}`);
await rcon(`give ${username} cobblestone 64`);
await new Promise((r) => setTimeout(r, 2500));

const cobble = bot.inventory.items().find((i) => i.name === 'cobblestone');
if (!cobble) { log('no cobblestone in inventory - /give did not land'); process.exit(2); }
await bot.equip(cobble, 'hand');
log(`held: ${bot.heldItem?.name} x${bot.heldItem?.count}`);

const Item = require('prismarine-item')(bot.registry);
const DIRECTION = { '0,-1,0': 0, '0,1,0': 1, '0,0,-1': 2, '0,0,1': 3, '-1,0,0': 4, '1,0,0': 5 };

let sequence = 1;   // OUR counter. mineflayer sends 0 forever.
async function placeWithSequence(refBlock, faceVec) {
    const seq = sequence++;
    const dest = refBlock.position.plus(faceVec);
    const before = bot.blockAt(dest)?.name;
    lastAck = null;
    const sentAt = Date.now();
    const dx = 0.5 + faceVec.x * 0.5, dy = 0.5 + faceVec.y * 0.5, dz = 0.5 + faceVec.z * 0.5;
    await bot.lookAt(refBlock.position.offset(dx, dy, dz), true);
    bot.swingArm('right');
    bot._client.write('block_place', {
        hand: 0,
        location: refBlock.position,
        direction: DIRECTION[`${faceVec.x},${faceVec.y},${faceVec.z}`],
        cursorX: dx, cursorY: dy, cursorZ: dz,
        insideBlock: false,
        worldBorderHit: false,
        sequence: seq,
    });
    // Wait for OUR sequence, up to 1s. A matching ack is a completed round trip.
    let ackMs = null, ackSeq = null;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
        if (lastAck && lastAck.seq >= seq) { ackMs = lastAck.at - sentAt; ackSeq = lastAck.seq; break; }
        await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 150));
    const after = bot.blockAt(dest)?.name;
    return { seq, ackSeq, ackMs, before, after, landed: after === 'cobblestone' };
}

log('');
log('--- OUR path: real sequence + acknowledge_player_digging ---');
let ours = { ok: 0, acked: 0, n: 0 }, ackTimes = [];
for (let i = 0; i < rounds; i++) {
    const ref = bot.blockAt(new Vec3(px - 2 + i, py - 1, pz));
    if (!ref || ref.boundingBox !== 'block') { log(`round ${i}: no reference block`); continue; }
    const r = await placeWithSequence(ref, new Vec3(0, 1, 0));
    ours.n++;
    if (r.landed) ours.ok++;
    if (r.ackMs !== null) { ours.acked++; ackTimes.push(r.ackMs); }
    log(`  seq=${r.seq} ack=${r.ackSeq ?? 'NONE'} ${r.ackMs !== null ? r.ackMs + 'ms' : '-'} ${r.before} -> ${r.after} ${r.landed ? 'LANDED' : 'MISSING'}`);
    await new Promise((r) => setTimeout(r, 250));
}

log('');
log('--- MINEFLAYER path: bot.placeBlock (sequence 0, waits on blockUpdate) ---');
let mf = { ok: 0, threw: 0, n: 0 };
for (let i = 0; i < rounds; i++) {
    const ref = bot.blockAt(new Vec3(px - 2 + i, py - 1, pz + 2));
    if (!ref || ref.boundingBox !== 'block') { log(`round ${i}: no reference block`); continue; }
    const dest = ref.position.offset(0, 1, 0);
    mf.n++;
    const t0 = Date.now();
    let err = null;
    try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); } catch (e) { err = e.message; mf.threw++; }
    await new Promise((r) => setTimeout(r, 150));
    const landed = bot.blockAt(dest)?.name === 'cobblestone';
    if (landed) mf.ok++;
    log(`  ${Date.now() - t0}ms ${landed ? 'LANDED' : 'MISSING'}${err ? ` THREW: ${err.slice(0, 60)}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
}

log('');
log('--- SHIPPED path: block_io.placeVerified (what the bots actually call) ---');
const blockIO = await import('../src/agent/library/block_io.js');
let shipped = { ok: 0, n: 0 };
const shippedT0 = Date.now();
for (let i = 0; i < rounds; i++) {
    const ref = bot.blockAt(new Vec3(px - 2 + i, py - 1, pz - 2));
    if (!ref || ref.boundingBox !== 'block') { log(`round ${i}: no reference block`); continue; }
    shipped.n++;
    const t0 = Date.now();
    const r = await blockIO.placeVerified(bot, ref, new Vec3(0, 1, 0), { pace: false });
    if (r.ok) shipped.ok++;
    log(`  ${Date.now() - t0}ms ok=${r.ok} why="${r.why}"`);
    await new Promise((r) => setTimeout(r, 250));
}
const shippedMs = ((Date.now() - shippedT0) / Math.max(1, shipped.n)).toFixed(0);

const avg = ackTimes.length ? (ackTimes.reduce((a, b) => a + b, 0) / ackTimes.length).toFixed(0) : 'n/a';
log('');
log(`VERDICT`);
log(`  ours:       ${ours.ok}/${ours.n} landed, ${ours.acked}/${ours.n} acknowledged, avg ack ${avg}ms`);
log(`  mineflayer: ${mf.ok}/${mf.n} landed, ${mf.threw}/${mf.n} THREW for a block that may have landed`);
log(`  shipped:    ${shipped.ok}/${shipped.n} ok via block_io.placeVerified, ${shippedMs}ms/place incl. 250ms spacing`);
log(`  acks seen total: ${ackCount}   block_change packets seen: ${blockChanges}`);
await rcon(`fill ${px - 3} ${py} ${pz - 3} ${px + 3} ${py + 3} ${pz + 3} air`);
await rcon(`forceload remove ${px - 4} ${pz - 4} ${px + 4} ${pz + 4}`);
bot.quit();
process.exit(0);
