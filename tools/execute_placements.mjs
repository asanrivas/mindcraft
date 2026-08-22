#!/usr/bin/env bun
/**
 * Streams a placements JSON (from litematic_to_placements.mjs) as /setblock commands
 * via RCON, offset by an origin (world coords of the schematic's local 0,0,0).
 *
 * One short-lived TCP connection per command: this server's RCON drops the connection
 * after 1-2 commands regardless of inter-command delay (tested empirically - a
 * persistent multi-command session is not reliable here), but a fresh connect+auth+
 * command+close cycle (what the single-shot `mc` CLI already does successfully every
 * time) is fast and 100% reliable. Never assume success without checking the response.
 *
 *   bun tools/execute_placements.mjs <placements.json> <originX> <originY> <originZ>
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOST = process.env.RCON_HOST || '127.0.0.1';
const PORT = Number(process.env.RCON_PORT || 25575);

function loadPassword() {
    if (process.env.RCON_PASSWORD) return process.env.RCON_PASSWORD;
    const envFile = path.join(os.homedir(), '.config', 'mc-rcon.env');
    const m = fs.readFileSync(envFile, 'utf8').match(/^RCON_PASSWORD=(.*)$/m);
    return m[1].trim();
}

function frame(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
}

function runCommand(command, pw) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(PORT, HOST);
        let acc = Buffer.alloc(0);
        let stage = 'auth';
        let out = '';
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 8000);
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
        sock.on('connect', () => sock.write(frame(1, 3, pw)));
        sock.on('data', (chunk) => {
            acc = Buffer.concat([acc, chunk]);
            while (acc.length >= 4) {
                const len = acc.readInt32LE(0);
                if (acc.length < 4 + len) break;
                const id = acc.readInt32LE(4);
                const body = acc.toString('utf8', 12, 4 + len - 2);
                acc = acc.subarray(4 + len);
                if (id === -1) { clearTimeout(timer); reject(new Error('auth failed')); sock.end(); return; }
                if (stage === 'auth') {
                    if (id !== 1) continue;
                    stage = 'cmd';
                    sock.write(frame(2, 2, command));
                    sock.write(frame(3, 2, ''));
                } else if (id === 2) {
                    out += body;
                } else if (id === 3) {
                    clearTimeout(timer);
                    resolve(out.replace(/§./g, '').trim());
                    sock.end();
                }
            }
        });
    });
}

const [, , placementsPath, ox, oy, oz] = process.argv;
if (!placementsPath || ox === undefined) {
    console.error('Usage: execute_placements.mjs <placements.json> <originX> <originY> <originZ>');
    process.exit(1);
}
const origin = { x: Number(ox), y: Number(oy), z: Number(oz) };
const { placements } = JSON.parse(fs.readFileSync(placementsPath, 'utf8'));
const pw = loadPassword();

function blockCommand(p) {
    const wx = origin.x + p.x, wy = origin.y + p.y, wz = origin.z + p.z;
    const propKeys = Object.keys(p.properties || {}).sort();
    const propStr = propKeys.length ? `[${propKeys.map(k => `${k}=${p.properties[k]}`).join(',')}]` : '';
    return `setblock ${wx} ${wy} ${wz} minecraft:${p.name}${propStr} replace`;
}

console.log(`${placements.length} blocks to place at origin ${origin.x},${origin.y},${origin.z}`);
const startTime = Date.now();
let ok = 0;
const failed = [];

async function attempt(cmd) {
    for (let tries = 0; tries < 3; tries++) {
        try {
            const resp = await runCommand(cmd, pw);
            if (/^Changed the block|^Block placed/i.test(resp)) return { ok: true, resp };
            if (/not loaded/i.test(resp)) return { ok: false, resp }; // won't fix itself by retrying
            return { ok: false, resp }; // real error (bad property etc) - don't retry either
        } catch (e) {
            if (tries === 2) return { ok: false, resp: `EXCEPTION: ${e.message}` };
            await new Promise(r => setTimeout(r, 200)); // only retry on connection-level exceptions (timeouts)
        }
    }
}

for (let i = 0; i < placements.length; i++) {
    const cmd = blockCommand(placements[i]);
    const { ok: success, resp } = await attempt(cmd);
    if (success) ok++; else failed.push({ cmd, resp });
    if ((i + 1) % 250 === 0) console.log(`... ${i + 1}/${placements.length} (${ok} ok, ${failed.length} failed)`);
}

const secs = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone in ${secs}s: ${ok}/${placements.length} placed.`);
if (failed.length) {
    console.log(`${failed.length} FAILED (showing up to 50):`);
    for (const f of failed.slice(0, 50)) console.log(`  ${f.cmd} => ${f.resp}`);
    fs.writeFileSync(placementsPath + '.failed.json', JSON.stringify(failed, null, 2));
    process.exitCode = 1;
}
