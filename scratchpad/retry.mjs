import { Rcon } from './rcon2.mjs';
const r = await new Rcon().connect();
const sleep = (ms) => new Promise(s => setTimeout(s, ms));
await r.send('msg andy !goToCoordinates(4521, 112, 4747, 1)');
await sleep(4000);
console.log(await r.send('data get entity andy Pos'));
r.close(); process.exit(0);
