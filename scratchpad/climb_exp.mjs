import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const d = Number(process.argv[2] || 2);
const secs = Number(process.argv[3] || 20);
const z0 = 4701 + (d - 1) * 4, z1 = z0 + 2, zc = z0 + 1;

// Whole experiment in one session: repair, verify, place, command, sample. Racing separate
// `mc` calls has silently dropped fills and left the bot testing the wrong terrain.
await r.send(`msg andy !stop`);
await new Promise((s) => setTimeout(s, 1500));
await r.send(`fill 4501 100 ${z0} 4523 110 ${z1} stone`);
await r.send(`fill 4502 ${111 - d} ${z0} 4508 110 ${z1} water`);
await r.send(`fill 4501 111 ${z0} 4523 113 ${z1} air`);
const is = async (x, y, z, b) => (await r.send(`execute if block ${x} ${y} ${z} ${b}`)) === 'Test passed';
if (!(await is(4508, 110, zc, 'water')) || !(await is(4509, 110, zc, 'stone'))) { say('SETUP FAILED'); process.exit(1); }
say(`lane ${d}: pool ok, bank at x4509 top=y111`);

// Right against the bank face so climbBank's reach-3 cone certainly sees it.
// Start ON the pool floor, not half a block above it - an elevated start silently gave the
// climb a head start and made a 0.4s 'success' that the real approach never reproduces.
await r.send(`tp andy 4508.7 ${111 - d} ${zc}.5`);
await new Promise((s) => setTimeout(s, 2000));
await r.send(`msg andy !climbBankTest("east", ${secs})`);

const t0 = Date.now();
let peak = -1, last = null;
while (Date.now() - t0 < (secs + 4) * 1000) {
    const m = (await r.send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    if (m) {
        const [x, y, z] = [+m[1], +m[2], +m[3]];
        if (y > peak) peak = y;
        const line = `${((Date.now() - t0) / 1000).toFixed(1)}s x=${x.toFixed(2)} y=${y.toFixed(3)}`;
        if (line !== last) { say('  ' + line); last = line; }
        if (x > 4509 && y >= 110.95) { say(`  *** OUT at ${((Date.now() - t0) / 1000).toFixed(1)}s ***`); break; }
    }
    await new Promise((s) => setTimeout(s, 400));
}
say(`peak y = ${peak.toFixed(3)} (needs 111.0 to stand on the bank)`);
r.close(); process.exit(0);
