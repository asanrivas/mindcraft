#!/usr/bin/env bun
/**
 * Is creative flight actually usable on this server? Re-measure, do not trust the note.
 *
 *   bun tools/fly_probe.mjs --username probe1 --at 4760,68,4650
 *
 * `blueprint_builder.js` walks everywhere, and says why:
 *   "Client-driven creative flight is dead on this server: measured 1,870 forcedMove
 *    corrections in one run - the server rejects every flown movement packet and pins the
 *    player, after which all placements fail from range."
 *
 * That was measured before two things changed underneath it: the premise that `onGround` is
 * broken here turned out to be wrong, and placement no longer goes through mineflayer's
 * unsatisfiable blockUpdate await - it writes `block_place` with a real sequence and reads the
 * server's ack. Both were load-bearing for "placements fail from range", so the conclusion is
 * worth re-testing rather than inheriting. The 32.5% blueprint figure was stale the same way.
 *
 * WHAT IT MEASURES
 *   1. LIFT      - does startFlying actually gain height, and hold it?
 *   2. CORRECTIONS - forcedMove events per second while flying. This is the number the old note
 *                  turned on; anti-cheat rejecting flight shows up here and nowhere else.
 *   3. PLACE     - can it place accurately from the air, at height, where a walking bot cannot
 *                  reach at all? Reported with the ack timing, so a refusal is distinguishable
 *                  from a lost packet.
 *   4. DRIFT     - is the bot where it thinks it is after the flight, or has it been pinned back?
 */
import { createRequire } from 'module';
import { Vec3 } from 'vec3';
import settings from '../settings.js';

// Resolve from THIS checkout: the pinned /home/asanrivas/mindcraft does not exist on every host.
const require = createRequire(import.meta.url);
const mineflayer = require('mineflayer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const username = arg('username', 'probe1');
const [px, py, pz] = arg('at', '4760,68,4650').split(',').map(Number);
const HEIGHT = Number(arg('height', 10));
const log = (m) => console.log(`[fly] ${m}`);

const bot = mineflayer.createBot({
    host: arg('host', settings.host), port: Number(arg('port', settings.port)),
    username, version: arg('version', '1.21.11'), auth: 'offline',
});
bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 160)}`); process.exit(1); });
await new Promise((r) => bot.once('spawn', r));

// forcedMove fires on EVERY server position packet - login and teleports included - so count
// only what arrives inside the measured window, or spawn alone poisons the number.
let corrections = 0, counting = false;
const jumps = [];
let lastPos = bot.entity.position.clone();
bot.on('forcedMove', () => {
    if (!counting) return;
    corrections++;
    jumps.push(bot.entity.position.distanceTo(lastPos));
    lastPos = bot.entity.position.clone();
});

const rcon = async (cmd) => {
    // Repo root derived from this file, not pinned to one host's home directory.
    const root = new URL('..', import.meta.url).pathname;
    const p = Bun.spawn(['bun', 'tools/rcon.mjs', cmd], { cwd: root, stdout: 'pipe' });
    await p.exited;
    return new Response(p.stdout).text();
};

await rcon(`forceload add ${px - 6} ${pz - 6} ${px + 6} ${pz + 6}`);
await rcon(`fill ${px - 4} ${py - 1} ${pz - 4} ${px + 4} ${py - 1} ${pz + 4} stone`);
await rcon(`fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 24} ${pz + 4} air`);
await rcon(`gamemode creative ${username}`);
await rcon(`tp ${username} ${px + 0.5} ${py} ${pz + 0.5}`);
await rcon(`give ${username} cobblestone 64`);
await new Promise((r) => setTimeout(r, 2500));

const blockIO = await import('../src/agent/library/block_io.js');

// ---- 1 + 2. LIFT and CORRECTIONS ----
log('');
log(`--- 1/2. LIFT to +${HEIGHT} and count forcedMove while flying ---`);
const y0 = bot.entity.position.y;
lastPos = bot.entity.position.clone();
counting = true;
const t0 = Date.now();
try { bot.creative.startFlying(); } catch (e) { log(`startFlying threw: ${e.message}`); }
// Drive the climb ourselves; creative.flyTo fights anti-cheat with big jumps.
const target = new Vec3(px + 0.5, py + HEIGHT, pz + 0.5);
// Fly by POSITION only, and zero the velocity every step. Setting position AND velocity makes
// the engine keep integrating the velocity after the loop ends, so the bot sails past the
// target - measured overshooting +10 to y=90 and then failing every placement from 15 blocks
// out of reach, which reads exactly like "flight breaks placement" and is nothing of the kind.
const flyTo = async (dest, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const p = bot.entity.position;
        const d = dest.minus(p);
        if (d.norm() < 0.35) break;
        const step = Math.min(0.35, d.norm());
        const u = d.normalize();
        bot.entity.position.set(p.x + u.x * step, p.y + u.y * step, p.z + u.z * step);
        bot.entity.velocity.set(0, 0, 0);
        await new Promise((r) => setTimeout(r, 50));
    }
    bot.entity.velocity.set(0, 0, 0);
    return bot.entity.position.distanceTo(dest);
};
const missBy = await flyTo(target);
const reached = missBy < 0.6;
const climbMs = Date.now() - t0;
await new Promise((r) => setTimeout(r, 1500));   // hold, and see if we are pushed back down
const yTop = bot.entity.position.y;
log(`  y ${y0.toFixed(2)} -> ${yTop.toFixed(2)} (target ${target.y}) in ${climbMs}ms, reached=${reached}, missed by ${missBy.toFixed(2)}`);
log(`  held for 1.5s at y=${bot.entity.position.y.toFixed(2)}`);

// ---- 3. PLACE from the air ----
log('');
log('--- 3. PLACE from the air, at a height no walking bot can reach ---');
// a pillar to click: one column of stone up to our altitude, set by the server so the test is
// about PLACING FROM FLIGHT and not about building the reference
await rcon(`fill ${px + 2} ${py} ${pz} ${px + 2} ${py + HEIGHT} ${pz} stone`);
await new Promise((r) => setTimeout(r, 700));
let ok = 0, tries = 0;
for (let i = 0; i < 4; i++) {
    const refY = py + HEIGHT - i;
    const ref = bot.blockAt(new Vec3(px + 2, refY, pz));
    if (!ref || ref.boundingBox !== 'block') { log(`  y=${refY}: no reference (${ref?.name})`); continue; }
    const item = bot.inventory.items().find((it) => it.name === 'cobblestone');
    if (!item) { log('  out of cobblestone'); break; }
    await bot.equip(item, 'hand');
    // Hover within reach of the cell being filled - a flying builder still has to respect the
    // same ~4.5 block interaction range a walking one does.
    await flyTo(new Vec3(px - 0.5, refY + 0.2, pz + 0.5), 3000);
    tries++;
    const t = Date.now();
    const r = await blockIO.placeVerified(bot, ref, new Vec3(-1, 0, 0), { expectName: 'cobblestone' });
    if (r.ok) ok++;
    log(`  place beside y=${refY} from y=${bot.entity.position.y.toFixed(1)}: ${r.ok ? 'OK' : 'FAIL'} (${r.why}) ${Date.now() - t}ms`);
}

// ---- 4. DRIFT ----
counting = false;
const secs = (Date.now() - t0) / 1000;
const maxJump = jumps.length ? Math.max(...jumps).toFixed(2) : '0';
log('');
log('--- 4. DRIFT ---');
log(`  final position y=${bot.entity.position.y.toFixed(2)} (started ${y0.toFixed(2)})`);
log('');
log('VERDICT');
log(`  lift: ${(yTop - y0).toFixed(2)} blocks in ${climbMs}ms`);
log(`  corrections: ${corrections} in ${secs.toFixed(1)}s = ${(corrections / secs).toFixed(1)}/s, biggest snap ${maxJump} blocks`);
log(`  placement from the air: ${ok}/${tries}`);
try { bot.creative.stopFlying(); } catch (e) { /* see blueprint_builder's note on gravity */ }
await rcon(`fill ${px - 4} ${py} ${pz - 4} ${px + 4} ${py + 24} ${pz + 4} air`);
await rcon(`forceload remove ${px - 6} ${pz - 6} ${px + 6} ${pz + 6}`);
bot.quit();
process.exit(0);
