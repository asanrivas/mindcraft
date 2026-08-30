#!/usr/bin/env bun
/**
 * Survey a world region over ONE persistent RCON connection and print it as ASCII layers.
 *
 *   bun tools/survey.mjs --from 4710,68,4608 --to 4722,73,4620
 *   bun tools/survey.mjs --from 4710,68,4608 --to 4722,73,4620 --match cobblestone
 *
 * Why this exists: reviewing a build needs ground truth, and neither half of what we had
 * gives it. A screenshot shows you the silhouette but not which cells are empty behind the
 * front wall; `!scanArea` reports COMPOSITION (percentages) with no positions, so a ragged
 * 40-block blob and a clean 7x7 floor with a hole in it look the same. This prints the
 * actual occupancy grid, one layer per Y.
 *
 * ONE CONNECTION, deliberately: `mc` opens a socket per command, and this server stalls
 * after ~13 rapid connect/close cycles (CLAUDE.md, "Surveying a route"). A 13x6x13 region is
 * 1,014 probes - a per-command connection would wedge the server long before it finished.
 *
 * Probe form is `execute if block <x> <y> <z> <block>` and we match "Test passed". The
 * tempting `... run say OK` variant is NOT echoed back over RCON, so every column reads as
 * missing and it looks like the terrain was destroyed.
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const triple = (s) => s.split(',').map(Number);

const from = triple(arg('from', ''));
const to = triple(arg('to', ''));
const match = arg('match', 'air');   // cells EQUAL to this render '.', everything else '#'
if (from.length !== 3 || to.length !== 3 || [...from, ...to].some(Number.isNaN)) {
    console.error('usage: survey.mjs --from x,y,z --to x,y,z [--match <block>]');
    process.exit(2);
}
const [x0, y0, z0] = [0, 1, 2].map(i => Math.min(from[i], to[i]));
const [x1, y1, z1] = [0, 1, 2].map(i => Math.max(from[i], to[i]));
const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
if (cells > 20000) { console.error(`region is ${cells} cells - too big, narrow it down`); process.exit(2); }

const HOST = process.env.RCON_HOST || '127.0.0.1';
const PORT = Number(process.env.RCON_PORT || 25575);
function loadPassword() {
    if (process.env.RCON_PASSWORD) return process.env.RCON_PASSWORD;
    const m = fs.readFileSync(path.join(os.homedir(), '.config', 'mc-rcon.env'), 'utf8').match(/^RCON_PASSWORD=(.*)$/m);
    if (!m) { console.error('no RCON password'); process.exit(2); }
    return m[1].trim();
}
function frame(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
}

const sock = net.connect(PORT, HOST);
sock.setTimeout(30000, () => { console.error('rcon: timeout'); process.exit(1); });
sock.on('error', (e) => { console.error(`rcon: ${e.message}`); process.exit(1); });

let acc = Buffer.alloc(0);
const pending = new Map();          // requestId -> resolve
let nextId = 100;
sock.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (acc.length < 4 + len) break;
        const id = acc.readInt32LE(4);
        const body = acc.toString('utf8', 12, 4 + len - 2);
        acc = acc.subarray(4 + len);
        if (id === -1) { console.error('rcon: auth failed'); process.exit(1); }
        const r = pending.get(id);
        if (r) { pending.delete(id); r(body); }
    }
});
const send = (cmd) => new Promise((res) => { const id = nextId++; pending.set(id, res); sock.write(frame(id, 2, cmd)); });

await new Promise((res) => {
    const id = 1; pending.set(id, res);
    sock.on('connect', () => sock.write(frame(id, 3, loadPassword())));
});

await send(`forceload add ${x0} ${z0} ${x1} ${z1}`);
console.log(`survey ${x0},${y0},${z0} -> ${x1},${y1},${z1}  (${cells} cells)  '.' = ${match}, '#' = other\n`);

let other = 0;
for (let y = y1; y >= y0; y--) {
    const rows = [];
    for (let z = z0; z <= z1; z++) {
        let row = '';
        for (let x = x0; x <= x1; x++) {
            const r = await send(`execute if block ${x} ${y} ${z} ${match}`);
            const isMatch = /Test passed/.test(r);
            if (!isMatch) other++;
            row += isMatch ? '.' : '#';
        }
        rows.push(`z=${String(z).padStart(5)} ${row}`);
    }
    console.log(`--- y=${y} ---`);
    console.log(`        x=${x0} -> ${x1}`);
    for (const r of rows) console.log(r);
    console.log('');
}
await send(`forceload remove ${x0} ${z0} ${x1} ${z1}`);
console.log(`${other}/${cells} cells are NOT ${match}`);
sock.end();
process.exit(0);
