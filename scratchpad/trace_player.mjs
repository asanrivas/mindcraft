import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const who = process.argv[2] || 'asanrivas';
const secs = Number(process.argv[3] || 120);
const out = `/home/asanrivas/mindcraft/recordings/trace-${who}-${Date.now()}.tsv`;
const fh = fs.createWriteStream(out);
fh.write('ms\tx\ty\tz\tonGround\n');

// Server-side sampling. Needs no protocol support, so the client's version is irrelevant -
// which is why this works where the 1.21.11 proxy could not decode a 26.2 client. We lose
// packet cadence but keep what actually matters: the y-trace and onGround flag of a REAL
// player doing the move the bot cannot.
say(`tracing ${who} for ${secs}s at 20Hz -> ${out}`);
const t0 = Date.now();
let last = null, climbs = 0, samples = 0;
while (Date.now() - t0 < secs * 1000) {
    const pr = await r.send(`data get entity ${who} Pos`);
    const p = pr.match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    if (!p) { await new Promise((s) => setTimeout(s, 250)); continue; }
    const g = (await r.send(`data get entity ${who} OnGround`)).match(/: (\d)b/);
    const [x, y, z] = [+p[1], +p[2], +p[3]];
    const og = g ? g[1] : '?';
    fh.write(`${Date.now() - t0}\t${x.toFixed(3)}\t${y.toFixed(3)}\t${z.toFixed(3)}\t${og}\n`);
    samples++;
    if (last !== null && y - last > 0.4) {
        climbs++;
        say(`  climb ${climbs}: y ${last.toFixed(2)} -> ${y.toFixed(2)} (+${(y - last).toFixed(2)}) onGround=${og}`);
    }
    last = y;
    await new Promise((s) => setTimeout(s, 50));
}
fh.end();
say(`done: ${samples} samples, ${climbs} rises >0.4 blocks. file: ${out}`);
r.close(); process.exit(0);
