/**
 * Can the bot cross a gap by building across it?
 *
 *   bun scratchpad/gap_gym.mjs [widths] [timeoutMs]      default "1,2,3,4"
 *
 * mineflayer-pathfinder used to do this - scaffolding was part of its movement generator, so
 * every `goto` could span a gap. Our planner's moves are all cell-to-adjacent-cell, so it cannot
 * express crossing even a ONE-block gap and the search fails outright.
 *
 * A separate walkway per width, well above the desert like the swim gym, so nothing existing is
 * touched. Walking surface y=111; the bot starts west of the gap and is sent east across it.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';

const WIDTHS = (process.argv[2] || '1,2,3,4').split(',').map(Number);
const TIMEOUT = Number(process.argv[3] || 40000);
const X0 = 4600, X1 = 4640, Z0 = 4700;

function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}
const pos = async () => {
    const m = (await send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
async function command(text) {
    const before = fs.statSync(LOG).size;
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
        await send(`msg andy ${text}`);
        for (let p = 0; p < 10 && !ok; p++) {
            await sleep(400);
            ok = since(before).includes(`received message from Rcon : ${text}`);
        }
    }
    return { ok, before };
}

for (let x = X0; x <= X1 + 16; x += 16)
    for (let z = Z0; z <= Z0 + WIDTHS.length * 4 + 16; z += 16) await send(`forceload add ${x} ${z}`);

say(`gap gym: widths ${WIDTHS.join(',')}, timeout ${TIMEOUT / 1000}s`);
say('width  outcome     secs   blocks laid   final position');
const results = [];
for (let i = 0; i < WIDTHS.length; i++) {
    const w = WIDTHS[i];
    const z = Z0 + 1 + i * 4;
    // Rebuild the lane: solid walkway, then knock a `w`-wide gap out of the middle of it. The
    // gap goes all the way down, so there is nothing to drop onto and walk along - the bot must
    // build or fail.
    await send(`fill ${X0} 100 ${z - 1} ${X1} 120 ${z + 1} air`);
    await send(`fill ${X0} 100 ${z - 1} ${X1} 110 ${z + 1} stone`);
    await send(`fill 4615 90 ${z - 1} ${4614 + w} 110 ${z + 1} air`);   // the gap
    // `--void` removes the far side entirely: there is nothing to bridge TO, and the bot must
    // refuse rather than spend its inventory into the drop.
    if (process.argv.includes('--void')) await send(`fill 4615 90 ${z - 1} ${X1} 110 ${z + 1} air`);
    await sleep(600);

    await command('!stop');
    await send('clear andy');
    // `--noblocks` proves the REFUSAL: with nothing to build, the bot must stop at the lip
    // rather than mine the walkway apart looking for material.
    if (!process.argv.includes('--noblocks')) await send('give andy dirt 64');
    await send(`tp andy 4610.5 111 ${z}.5`);
    await sleep(2500);

    const start = await pos();
    const { ok, before } = await command(`!navTo(4625, 111, ${z})`);
    if (!ok || !start) { say(`${String(w).padStart(5)}  CMD-DROPPED`); results.push({ w, ok: false }); continue; }

    const t0 = Date.now();
    let done = false, p = start;
    while (Date.now() - t0 < TIMEOUT) {
        await sleep(1000);
        p = await pos() ?? p;
        if (p.x >= 4620) { done = true; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const laid = (since(before).match(/bridge: laid/g) || []).length;
    say(`${String(w).padStart(5)}  ${(done ? 'CROSSED' : 'STUCK').padEnd(10)} ${secs.padStart(5)}   ${String(laid).padStart(11)}   (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
    results.push({ w, ok: done, laid });
}
await command('!stop');
say(`\nRESULT: ${results.filter(x => x.ok).length}/${results.length} gaps crossed`);
r.close(); process.exit(0);
