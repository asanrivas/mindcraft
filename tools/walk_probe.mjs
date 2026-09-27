#!/usr/bin/env bun
/**
 * Can the OWNED client walk and jump? Measured against the mineflayer baseline.
 *
 *   bun tools/walk_probe.mjs --username pfprobe [--version 1.21.11]
 *
 * This is the milestone that turns `observer.js` from read-only into a client: connect with our
 * own stack, run prismarine-physics over our own decoded world, drive control state, and send
 * our own position packets.
 *
 * The numbers to beat are today's, from a clean mineflayer bot on this same server:
 *
 *     onGround true : 60/60 (100%)
 *     PLAIN JUMP APEX: 1.252   (vanilla 1.252)
 *
 * Same measurement, same server, different client. If the owned path produces the same figures,
 * the borrowed layers (codec, chunk decode, physics) are wired correctly and what remains to
 * build is the ACTION surface, not the simulation.
 */
import { Observer } from '../src/mc/observer.js';
import { PlayerController, TICK_MS } from '../src/mc/physics/player.js';
import Vec3 from 'vec3';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const obs = new Observer({
    host: arg('host', 'localhost'),
    port: Number(arg('port', 25565)),
    version: arg('version', '1.21.11'),
    username: arg('username', 'pfprobe'),
});
obs.on('warning', (w) => console.log('[warn]', w));

await new Promise((resolve, reject) => {
    obs.once('spawn', resolve);
    obs.once('error', reject);
    setTimeout(() => reject(new Error('spawn timeout')), 30000);
    obs.connect();
});
console.log(`[walk] spawned at ${obs.position.x.toFixed(1)}, ${obs.position.y.toFixed(1)}, ${obs.position.z.toFixed(1)}`);
await sleep(2500);   // let chunks arrive before physics reads them

const entity = { position: obs.position.clone(), yaw: 0, pitch: 0 };
const pc = new PlayerController({
    connection: obs.connection, world: obs.world, registry: obs.registry, entity,
    version: obs.version,
});
pc.on('physicsError', (e) => console.log('[physics]', e.message));
pc.start();

// --- settle, then measure standing state -------------------------------------------------
for (let i = 0; i < 60 && Math.abs(entity.velocity?.y ?? 0) > 0.01; i++) await sleep(TICK_MS);
await sleep(500);
let ticks = 0, ground = 0;
const t0 = Date.now();
let simMs = 0;
const onTick = () => { ticks++; if (entity.onGround) ground++; };
pc.on('tick', onTick);
await sleep(3000);
pc.removeListener('tick', onTick);
const hz = (ticks / ((Date.now() - t0) / 1000)).toFixed(1);
console.log(`[walk] tick rate ${hz}/s over ${ticks} ticks (target 20/s), avg sim ${(pc.simMs / Math.max(1, pc.ticks)).toFixed(2)}ms`);
// What does OUR world return under the player? prismarine-physics falls through to AIRBORNE
// acceleration when `blockUnder` is null (index.js:546), which looks exactly like a slow walk.
{
    const p = entity.position;
    const under = obs.world.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
    console.log(`[walk] block under feet: ${under ? `${under.name} type=${under.type} bb=${under.boundingBox}` : 'NULL <- airborne accel'}`);
}
const restY = entity.position.y;

// --- a plain jump: no assist, no asserted flag --------------------------------------------
let apex = 0;
const onJump = () => { apex = Math.max(apex, entity.position.y - restY); };
pc.on('tick', onJump);
pc.setControlState('jump', true);
await sleep(300);
pc.setControlState('jump', false);
await sleep(1500);
pc.removeListener('tick', onJump);

// --- walk ---------------------------------------------------------------------------------
const before = entity.position.clone();
pc.setControlState('forward', true);
await sleep(3000);
pc.setControlState('forward', false);
await sleep(400);
const walked = Math.hypot(entity.position.x - before.x, entity.position.z - before.z);

const pct = (x) => `${x}/${ticks} (${((100 * x) / (ticks || 1)).toFixed(0)}%)`;
console.log(`\n=== OWNED CLIENT ===`);
console.log(`  ticks simulated : ${pc.ticks}`);
console.log(`  onGround true   : ${pct(ground)}          (mineflayer: 100%)`);
console.log(`  PLAIN JUMP APEX : ${apex.toFixed(3)}            (mineflayer: 1.252, vanilla 1.252)`);
console.log(`  walked in 3.0s  : ${walked.toFixed(2)} blocks   (vanilla walk ~4.3 b/s)`);
console.log(`  tick rate       : ${hz}/s              (target 20/s)`);
console.log(`  decode errors   : ${obs.connection.decodeErrorSummary?.() ?? 'n/a'}`);
console.log(`  final position  : ${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}, ${entity.position.z.toFixed(1)}`);

pc.stop();
obs.disconnect?.() ?? obs.connection.end('walk probe done');
process.exit(0);
