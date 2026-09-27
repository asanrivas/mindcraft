import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise(s => setTimeout(s, ms));
const pos = async () => {
    const m = (await send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
await send('msg andy !stop'); await sleep(1500);
await send('msg andy !marathonReset'); await sleep(1500);
// lane 3: repair, then drop him in the pool at the west end
await send('fill 4501 100 4709 4523 110 4711 stone');
await send('fill 4502 108 4709 4508 110 4711 water');
await send('fill 4501 111 4709 4523 113 4711 air');
await sleep(800);
await send('tp andy 4504.5 110.5 4710.5');
await sleep(2500);
say('start: ' + JSON.stringify(await pos()));
const t0 = Date.now();
await send('msg andy !travel("east", 10)');
let out = false, p = null;
while (Date.now() - t0 < 40000) {
    await sleep(700);
    p = await pos() ?? p;
    if (p && p.x >= 4509 && p.y >= 110.9) { out = true; break; }
}
say(`${out ? 'CLIMBED OUT' : 'STUCK'} in ${((Date.now()-t0)/1000).toFixed(1)}s -> ${JSON.stringify(p)}`);
await send('msg andy !stop');
r.close(); process.exit(0);
