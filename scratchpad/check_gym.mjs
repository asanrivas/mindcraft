import { Rcon } from './rcon2.mjs';
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const p = await send('data get entity andy Pos');
console.log('andy Pos:', p.trim());
// bank block (x4509, y110) must be stone, and pool (x4505, y110) water, for each lane
for (let d = 1; d <= 10; d++) {
    const z = 4702 + (d - 1) * 4;
    const bank = await send(`execute if block 4509 110 ${z} stone`);
    const pool = await send(`execute if block 4505 110 ${z} water`);
    const walk = await send(`execute if block 4509 111 ${z} air`);
    console.log(`lane ${String(d).padStart(2)} z=${z}  bank=${/passed/i.test(bank)?'stone':'BROKEN'}  pool=${/passed/i.test(pool)?'water':'BROKEN'}  above-bank=${/passed/i.test(walk)?'air':'BLOCKED'}`);
}
r.close(); process.exit(0);
