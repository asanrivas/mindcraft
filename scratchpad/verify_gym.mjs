import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const is = async (x,y,z,b) => (await r.send(`execute if block ${x} ${y} ${z} ${b}`)) === 'Test passed';
say('lane  depth  pool-surface  pool-floor  bank@y110  bank-air@111');
for (let i = 0; i < 10; i++) {
    const d = i + 1, z = 4702 + i * 4;
    const surf  = await is(4505, 110, z, 'water');          // top water block
    const floorY = 110 - d;                                  // first solid under the pool
    const floor = await is(4505, floorY, z, 'stone');
    const bank  = await is(4509, 110, z, 'stone');           // the block to climb onto
    const above = await is(4509, 111, z, 'air');             // headroom on the bank
    say(`${String(d).padStart(4)}  ${String(d).padStart(5)}  ${String(surf).padStart(12)}  ${String(floor).padStart(10)}  ${String(bank).padStart(9)}  ${String(above).padStart(12)}`);
}
r.close(); process.exit(0);
