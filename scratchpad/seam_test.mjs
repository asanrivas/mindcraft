import { Rcon } from './rcon2.mjs';
const r = await new Rcon().connect();
const sleep = (ms) => new Promise(s => setTimeout(s, ms));
const pos = async () => {
    const m = (await r.send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
await r.send('msg andy !stop'); await sleep(1200);
await r.send('tp andy 4512.5 111 4747.5'); await sleep(2000);
// moveAway -> nav flee directions; exercises the navigator via a mode-style call
console.log('before moveAway:', JSON.stringify(await pos()));
const t0 = Date.now();
await r.send('msg andy !moveAway(8)');
await sleep(14000);
const p = await pos();
const d = Math.hypot(p.x - 4512.5, p.z - 4747.5);
console.log(`after moveAway: ${JSON.stringify(p)}  moved ${d.toFixed(1)} blocks in ${((Date.now()-t0)/1000).toFixed(1)}s`);
r.close(); process.exit(0);
