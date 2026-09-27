#!/usr/bin/env bun
/**
 * Does client-driven flight move this bot HORIZONTALLY? Measure it in empty air, change nothing.
 *
 *   bun tools/flight_check.mjs --at 4683,120,4571
 *
 * Why this exists rather than `tools/fly_probe.mjs`: that probe answers a related question (are
 * flown movements rejected - forcedMove corrections) but it `fill`s a 9x25x9 pocket and a stone
 * floor to do it, which is a world edit needing an announcement, and it needs six rapid RCON
 * commands on a server that stops accepting connections after about a dozen. This one edits
 * nothing: it teleports ITSELF high into open air (probe1 is an operator) and flies.
 *
 * THE QUESTION IT SETTLES. During the 2026-09-22 build, every route leg reported `made no
 * progress` while `freeSelf` rose 1.9-2.0 blocks on the same bot, in the same tick window. Vertical
 * writes landing while horizontal writes did nothing is the signature of a body embedded in
 * geometry - prismarine-physics resolves an intersection along the axis of least penetration, which
 * is usually vertical - but it is ALSO what a server that rejects horizontal movement would look
 * like. Those need opposite fixes, and the difference is only visible in air where nothing can be
 * embedded in anything.
 */
import { Vec3 } from 'vec3';
import real from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import * as mc from '../src/utils/mcdata.js';
import * as flight from '../src/agent/library/flight.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const log = (m) => console.log(`[flightcheck] ${m}`);
const [ax, ay, az] = (arg('at', '4683,120,4571')).split(',').map(Number);

setSettings({ ...real, minecraft_version: arg('version', '1.21.11') });
const bot = mc.initBot(arg('username', 'probe1'));
bot.on('kicked', (r) => { log(`kicked: ${r}`); process.exit(1); });
bot.on('error', (e) => log(`error: ${e.message}`));
let corrections = 0;
bot.on('forcedMove', () => corrections++);

/**
 * `--from x,y,z --to x,y,z` asks a different question: is there a body-sized route between two
 * points in the LIVE world? It runs the same `planFlight` the builder uses, from a bot standing
 * next to the geometry, and places nothing. Written because "bob is sealed inside its own build"
 * was a guess, and the alternative ways to check it were a restart (to pick up a new log line) or
 * an operator edit to the build itself.
 */
async function routeCheck(bot) {
    const [fx, fy, fz] = (arg('from', '')).split(',').map(Number);
    const [tx, ty, tz] = (arg('to', '')).split(',').map(Number);
    bot.chat(`/tp ${bot.username} ${fx} ${fy + 3} ${fz}`);
    for (let i = 0; i < 40 && bot.entity.position.distanceTo(new Vec3(fx, fy, fz)) > 12; i++)
        await new Promise(r => setTimeout(r, 500));
    // Stand exactly where the subject is, so the plan starts from its cell.
    bot.entity.position.set(fx + 0.5, fy, fz + 0.5);
    await new Promise(r => setTimeout(r, 200));
    const route = flight.planFlight(bot, new Vec3(tx, ty, tz), { maxRange: 128 });
    log(`from (${fx},${fy},${fz}) to (${tx},${ty},${tz}): `
        + (route ? `ROUTE EXISTS, ${route.length} legs: ${route.map(w => `(${w.x.toFixed(0)},${w.y},${w.z.toFixed(0)})`).join(' -> ')}`
                 : 'NO ROUTE for a 0.6x1.8 body - sealed, or no body-sized opening'));
    // And the immediate neighbourhood, because "sealed" should be visible, not inferred.
    for (const [dx, dy, dz, name] of [[0, 1, 0, 'above'], [0, -1, 0, 'below'], [1, 0, 0, 'east'],
        [-1, 0, 0, 'west'], [0, 0, 1, 'south'], [0, 0, -1, 'north']]) {
        const b = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz));
        log(`  ${name.padEnd(6)} ${b ? b.name : 'unloaded'}`);
    }
}

bot.once('spawn', async () => {
    if (bot.game?.gameMode !== 'creative') { log('REFUSING: not creative'); return bot.quit(); }
    if (arg('from', null)) { await routeCheck(bot); return bot.quit(); }
    bot.chat(`/tp ${bot.username} ${ax} ${ay} ${az}`);
    for (let i = 0; i < 40 && bot.entity.position.distanceTo(new Vec3(ax, ay, az)) > 8; i++)
        await new Promise(r => setTimeout(r, 500));
    const start = bot.entity.position.clone();
    log(`at ${start.floored()}, gameMode=${bot.game.gameMode}`);

    const started = flight.beginFlight(bot);
    log(`beginFlight -> ${started}, gravity=${bot.physics?.gravity}`);
    const leg = async (label, dest) => {
        const from = bot.entity.position.clone();
        const before = corrections;
        const t = Date.now();
        const short = await flight.flyTo(bot, dest, { timeoutMs: 6000, noDetour: true });
        const moved = from.distanceTo(bot.entity.position);
        log(`${label}: wanted ${from.distanceTo(dest).toFixed(1)}, moved ${moved.toFixed(1)}, `
            + `${short.toFixed(1)} short, ${Date.now() - t}ms, forcedMove +${corrections - before}`);
        return moved;
    };
    // Horizontal, vertical, and back - in air, so anything that fails here is the mechanism and
    // not the geometry.
    const h = await leg('horizontal +20x', start.offset(20, 0, 0));
    const v = await leg('vertical +10y', bot.entity.position.offset(0, 10, 0));
    const h2 = await leg('horizontal +20z', bot.entity.position.offset(0, 0, 20));
    flight.endFlight(bot, started);
    log(`VERDICT: horizontal ${h > 15 && h2 > 15 ? 'WORKS' : 'BROKEN'} (${h.toFixed(1)}, ${h2.toFixed(1)} of 20), `
        + `vertical ${v > 8 ? 'works' : 'broken'} (${v.toFixed(1)} of 10), ${corrections} forcedMove corrections total`);
    bot.quit();
});
