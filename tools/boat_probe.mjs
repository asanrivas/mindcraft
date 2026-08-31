#!/usr/bin/env bun
/**
 * STAGE 0 BOAT PROBE — docs/gaps/boats.exec.md §2. DO NOT run against andy or bob.
 *
 *   bun tools/boat_probe.mjs --username probe1 --at 3520,63,6171
 *
 * The question, and it is the only thing this measures
 * ------------------------------------------------------
 * mineflayer sends neither serverbound `vehicle_move` nor `steer_boat`, and has no handler
 * for the clientbound correction either (grep confirms zero hits either direction). So does
 * this server move a boat from `player_input` alone (server-authoritative movement), or does
 * it still expect the driver's client to stream serverbound `vehicle_move` the way a vanilla
 * <=1.21.x client does? That is undecidable from code — it depends on what Purpur's vehicle
 * movement handler actually does — so this probe measures it directly.
 *
 * Style is `tools/place_probe.mjs`: a standalone mineflayer bot, no agent, no assists, raw
 * `bot._client` listeners registered at connect (before any write, to avoid racing the
 * reply), one persistent RCON connection (the `tools/survey.mjs` pattern — reconnecting per
 * command stalls this server after ~13 rapid cycles).
 *
 * Procedure (docs/gaps/boats.exec.md §2, phases A1/A2/B):
 *   A1  player_input{forward:true} alone, resent 1/s, 5s.
 *   A2  same + steer_boat{leftPaddle,rightPaddle} at 10Hz, 5s.
 *   B@2/4/8   we stream serverbound vehicle_move ourselves at 20Hz, stepping a pure XZ
 *             kinematic sim at the given blocks/s along the chosen heading, 5s each.
 * Ground truth for every phase is the SAME: dismount, await `dismount` + the following
 * `forcedMove`, then read `bot.entity.position` — the server seats us at ITS boat position,
 * which is the one number that cannot lie (mineflayer never echoes vehicle position back to
 * the driver in the client-authoritative regime). The rig is reset to the same water cell
 * between phases (RCON re-teleports both the boat and the player) so each phase's
 * displacement is independent, not cumulative.
 *
 * Numeric verdict (exact thresholds from the plan):
 *   INPUT-DRIVEN  iff A1 or A2 disp >= 4.0 blocks over 5s.
 *   CLIENT-SIM    iff every A disp < 4.0 AND B@2 disp >= 8.0 (of 10.0 simulated) AND
 *                 simErr <= 2.0 at B@2.
 *   INFEASIBLE    otherwise.
 */
import { createRequire } from 'module';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import settings from '../settings.js';

const require = createRequire('/home/asanrivas/mindcraft/');
const mineflayer = require('mineflayer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const username = arg('username', 'probe1');
if (username === 'andy' || username === 'bob') {
    console.error(`refusing: ${username} is a live agent account, not a probe account`);
    process.exit(2);
}
const at = arg('at', '3520,63,6171').split(',').map(Number);
const [TX, TY, TZ] = at;
const log = (m) => console.log(`[boat-probe] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- one persistent RCON connection for the whole run ----------------
function loadRconPassword() {
    if (process.env.RCON_PASSWORD) return process.env.RCON_PASSWORD;
    const m = fs.readFileSync(path.join(os.homedir(), '.config', 'mc-rcon.env'), 'utf8').match(/^RCON_PASSWORD=(.*)$/m);
    if (!m) throw new Error('no RCON password configured');
    return m[1].trim();
}
function rconFrame(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
}
async function openRcon() {
    const sock = net.connect(Number(process.env.RCON_PORT || 25575), process.env.RCON_HOST || '127.0.0.1');
    sock.setTimeout(30000, () => { console.error('rcon: timeout'); process.exit(1); });
    sock.on('error', (e) => { console.error(`rcon: ${e.message}`); process.exit(1); });
    let acc = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 100;
    sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 4) {
            const len = acc.readInt32LE(0);
            if (acc.length < 4 + len) break;
            const id = acc.readInt32LE(4);
            const body = acc.toString('utf8', 12, 4 + len - 2);
            acc = acc.subarray(4 + len);
            if (id === -1) { console.error('rcon: auth failed'); process.exit(1); }
            const r = pending.get(id);
            if (r) { pending.delete(id); r(body); }
        }
    });
    const send = (cmd) => new Promise((res) => { const id = nextId++; pending.set(id, res); sock.write(rconFrame(id, 2, cmd)); });
    await new Promise((res) => {
        const id = 1; pending.set(id, res);
        sock.on('connect', () => sock.write(rconFrame(id, 3, loadRconPassword())));
    });
    return { send, close: () => sock.end() };
}

// ---------------- bot ----------------
const bot = mineflayer.createBot({
    host: arg('host', settings.host),
    port: Number(arg('port', settings.port)),
    username,
    version: arg('version', '1.21.11'),
    auth: 'offline',
});

let vehicleMoveCount = 0;
let lastVehicleMove = null;
bot._client.on('vehicle_move', (p) => { vehicleMoveCount++; lastVehicleMove = p; });

let forcedMoveCount = 0;
bot.on('forcedMove', () => { forcedMoveCount++; });

bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 300)}`); process.exit(1); });

await new Promise((r) => bot.once('spawn', r));
log(`spawned as ${username} at ${bot.entity.position.floored()}`);

const rcon = await openRcon();

async function cleanup(extra) {
    try { await rcon.send(`kill @e[type=oak_boat,limit=1,distance=..40,x=${TX},y=${TY},z=${TZ}]`); } catch { /* best effort */ }
    try { await rcon.send(`forceload remove ${TX - 12} ${TZ - 12} ${TX + 12} ${TZ + 12}`); } catch { /* best effort */ }
    rcon.close();
    if (extra) log(extra);
    bot.quit();
}

// ---------------- rig setup ----------------
await rcon.send(`forceload add ${TX - 12} ${TZ - 12} ${TX + 12} ${TZ + 12}`);
await rcon.send(`tp ${username} ${TX} ${TY} ${TZ}`);
await sleep(400);
await rcon.send(`summon minecraft:oak_boat ${TX} ${TY} ${TZ} {Persistent:1b}`);
await sleep(700);

function findBoat() {
    return Object.values(bot.entities).find((e) => e.name && e.name.endsWith('_boat') && bot.entity.position.distanceTo(e.position) < 12);
}
let boatEntity = findBoat();
if (!boatEntity) { await sleep(800); boatEntity = findBoat(); }
if (!boatEntity) {
    await cleanup('no boat entity found near the probe after summon — aborting. VERDICT=INFEASIBLE (could not measure: rig failed)');
    process.exit(2);
}
log(`found boat entity id=${boatEntity.id} name=${boatEntity.name} at ${boatEntity.position.floored()}`);

async function resetRig() {
    await rcon.send(`tp @e[type=oak_boat,limit=1,distance=..40,x=${TX},y=${TY},z=${TZ}] ${TX} ${TY} ${TZ}`);
    await rcon.send(`tp ${username} ${TX} ${TY} ${TZ}`);
    await sleep(700);
}

async function mountWithRetry() {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const t0 = Date.now();
        const p = new Promise((res) => bot.once('mount', res));
        bot.mount(boatEntity);
        const ok = await Promise.race([p.then(() => true), sleep(3000).then(() => false)]);
        if (ok) return Date.now() - t0;
        log(`  mount attempt ${attempt} timed out`);
    }
    return null;
}

async function dismountAndGroundTruth() {
    const dismountP = new Promise((res) => bot.once('dismount', res));
    const forcedMoveP = new Promise((res) => bot.once('forcedMove', res));
    bot.dismount();
    const both = Promise.all([dismountP, forcedMoveP]).then(() => 'both');
    const dismountOnly = dismountP.then(() => 'dismount_only');
    const outcome = await Promise.race([both, sleep(4000).then(() => 'timeout'), dismountOnly.then(async (v) => { await sleep(1500); return v; })]);
    await sleep(200);
    return { outcome, pos: bot.entity.position.clone() };
}

// heading: +X, open water in every direction here so the choice is arbitrary
const HEADING = { dx: 1, dz: 0 };
const headingYaw = Math.atan2(-HEADING.dx, -HEADING.dz);

async function runInputPhase(label, { paddles }) {
    let paddleInterval = null;
    if (paddles) {
        paddleInterval = setInterval(() => {
            bot._client.write('steer_boat', { leftPaddle: true, rightPaddle: true });
        }, 100);
    }
    const t0 = Date.now();
    let lastSend = 0;
    const startVm = vehicleMoveCount;
    const track = [];
    while (Date.now() - t0 < 5000) {
        if (Date.now() - lastSend >= 1000) {
            bot.moveVehicle(0, 1); // forward, per docs: forward>0 => forward:true
            lastSend = Date.now();
        }
        if (bot.vehicle) track.push([bot.vehicle.position.x, bot.vehicle.position.z]);
        await sleep(100);
    }
    if (paddleInterval) clearInterval(paddleInterval);
    const vmDuring = vehicleMoveCount - startVm;
    log(`${label}: vehicle.position samples=${track.length} first=${track[0]} last=${track.at(-1)} clientbound vehicle_move packets seen=${vmDuring}`);
    return { vmDuring };
}

async function runClientDrivenPhase(label, speedBps) {
    const startPos = bot.vehicle.position.clone();
    const simPos = { x: startPos.x, y: startPos.y, z: startPos.z };
    const dt = 0.05; // 20Hz
    let corrections = 0;
    let maxDeviation = 0;
    const vmHandler = (p) => {
        corrections++;
        const dev = Math.hypot(p.x - simPos.x, p.z - simPos.z);
        if (dev > maxDeviation) maxDeviation = dev;
    };
    bot._client.on('vehicle_move', vmHandler);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
        simPos.x += HEADING.dx * speedBps * dt;
        simPos.z += HEADING.dz * speedBps * dt;
        bot._client.write('vehicle_move', { x: simPos.x, y: simPos.y, z: simPos.z, yaw: headingYaw, pitch: 0, onGround: false });
        await sleep(50);
    }
    bot._client.removeListener('vehicle_move', vmHandler);
    const simDisp = Math.hypot(simPos.x - startPos.x, simPos.z - startPos.z);
    log(`${label}: sim end=(${simPos.x.toFixed(2)},${simPos.z.toFixed(2)}) simDisp=${simDisp.toFixed(2)} corrections=${corrections} maxDeviation=${maxDeviation.toFixed(2)}`);
    return { startPos, simPos, simDisp, corrections, maxDeviation };
}

async function runPhase(label, driveFn) {
    await resetRig();
    const mountMs = await mountWithRetry();
    if (mountMs == null) {
        log(`${label}: MOUNT FAILED — skipping`);
        return { label, ok: false, reason: 'mount_failed' };
    }
    log(`${label}: mounted after ${mountMs}ms`);
    await bot.look(headingYaw, 0, true);
    await sleep(150);
    const startPos = (bot.vehicle ? bot.vehicle.position : bot.entity.position).clone();
    const driveResult = await driveFn();
    const gt = await dismountAndGroundTruth();
    const disp = Math.hypot(gt.pos.x - startPos.x, gt.pos.z - startPos.z);
    log(`${label}: start=(${startPos.x.toFixed(2)},${startPos.z.toFixed(2)}) groundTruth=(${gt.pos.x.toFixed(2)},${gt.pos.z.toFixed(2)}) disp=${disp.toFixed(2)} dismountHandshake=${gt.outcome}`);
    return { label, ok: true, startPos, groundTruth: gt.pos, disp, dismountHandshake: gt.outcome, ...driveResult };
}

const results = {};
results.A1 = await runPhase('A1 (input only)', () => runInputPhase('A1', { paddles: false }));
results.A2 = await runPhase('A2 (input + steer_boat)', () => runInputPhase('A2', { paddles: true }));
results.B2 = await runPhase('B@2 b/s (client vehicle_move)', () => runClientDrivenPhase('B@2', 2.0));
results.B4 = await runPhase('B@4 b/s (client vehicle_move)', () => runClientDrivenPhase('B@4', 4.0));
results.B8 = await runPhase('B@8 b/s (client vehicle_move)', () => runClientDrivenPhase('B@8', 8.0));

// physics resumption check after the very last dismount
let physicsResumed = false;
{
    const p = new Promise((res) => bot.once('physicsTick', () => res(true)));
    physicsResumed = await Promise.race([p, sleep(2000).then(() => false)]);
}

// ---------------- verdict ----------------
const a1disp = results.A1.ok ? results.A1.disp : 0;
const a2disp = results.A2.ok ? results.A2.disp : 0;
const b2 = results.B2;
const simErrB2 = b2.ok ? Math.hypot(b2.groundTruth.x - b2.simPos.x, b2.groundTruth.z - b2.simPos.z) : Infinity;

let verdict;
if (a1disp >= 4.0 || a2disp >= 4.0) verdict = 'INPUT-DRIVEN';
else if (b2.ok && b2.disp >= 8.0 && simErrB2 <= 2.0) verdict = 'CLIENT-SIM';
else verdict = 'INFEASIBLE';

function fmt(r) { return r && r.ok ? r.disp.toFixed(2) : 'FAIL'; }
function fmtB(r) {
    if (!r || !r.ok) return 'FAIL';
    const simErr = Math.hypot(r.groundTruth.x - r.simPos.x, r.groundTruth.z - r.simPos.z);
    return `disp=${r.disp.toFixed(2)} simErr=${simErr.toFixed(2)} corr=${r.corrections}`;
}

const line = `VERIFIED BOAT PROBE: A1=${fmt(results.A1)} A2=${fmt(results.A2)} blocks/5s | B@2 ${fmtB(results.B2)} | B@4 ${fmtB(results.B4)} | B@8 ${fmtB(results.B8)} | dismount=${physicsResumed ? 'physics_resumed' : 'physics_NOT_resumed'} | VERDICT=${verdict}`;
log('');
log(line);

await cleanup();
process.exit(0);
