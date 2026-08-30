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
await send('msg andy !stop'); await sleep(1200);
await send('msg andy !marathonReset'); await sleep(1200);
// Dry flat pad at y111 with ONE 1-block step at x=4516. No water anywhere.
await send('fill 4510 100 4744 4524 113 4750 air');
await send('fill 4510 100 4744 4524 110 4750 stone');   // pad top = y110, walk at y111
await send('fill 4516 111 4744 4516 111 4750 stone');   // the 1-block step
await sleep(900);
await send('tp andy 4512.5 111 4747.5');
await sleep(2500);
say('start:  ' + JSON.stringify(await pos()));
const t0 = Date.now();
// goToCoordinates drives bot.pathfinder - the SAME executor followPlayer uses.
await send('msg andy !navTo(4521, 112, 4747)');
let p = null, ok = false;
while (Date.now() - t0 < 30000) {
    await sleep(700);
    p = await pos() ?? p;
    if (p && p.x >= 4517) { ok = true; break; }   // got past the step
}
say(`${ok ? 'CLEARED THE STEP' : 'BLOCKED'} in ${((Date.now()-t0)/1000).toFixed(1)}s -> ${JSON.stringify(p)}`);
await send('msg andy !stop');
r.close(); process.exit(0);
