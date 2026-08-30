import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const d = Number(process.argv[2] || 2);
const z0 = 4701 + (d - 1) * 4, z1 = z0 + 2, zc = z0 + 1;

// One persistent session: single-shot `mc` calls drop silently under load, and a dropped pool
// fill leaves solid ground where the test expects water - which reads as "the bot refused to
// climb" when in fact there was nothing to climb out of.
await r.send(`fill 4501 100 ${z0} 4523 110 ${z1} stone`);
await r.send(`fill 4502 ${111 - d} ${z0} 4508 110 ${z1} water`);
await r.send(`fill 4501 111 ${z0} 4523 113 ${z1} air`);

const is = async (x, y, z, b) => (await r.send(`execute if block ${x} ${y} ${z} ${b}`)) === 'Test passed';
const ok = {
    poolTop: await is(4508, 110, zc, 'water'),
    poolBottom: await is(4508, 111 - d, zc, 'water'),
    floor: await is(4508, 110 - d, zc, 'stone'),
    bank: await is(4509, 110, zc, 'stone'),
    bankAir: await is(4509, 111, zc, 'air'),
};
say(`lane ${d} (z=${zc}): ` + Object.entries(ok).map(([k, v]) => `${k}=${v}`).join(' '));
if (!Object.values(ok).every(Boolean)) { say('SETUP FAILED'); r.close(); process.exit(1); }

await r.send(`tp andy 4508.4 ${111.5 - d} ${zc}.5`);
await new Promise((s) => setTimeout(s, 2500));
const m = (await r.send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
say(`bot at (${(+m[1]).toFixed(2)}, ${(+m[2]).toFixed(2)}, ${(+m[3]).toFixed(2)})`);
r.close(); process.exit(0);
