#!/usr/bin/env bun
/**
 * Streams a placements JSON (from litematic_to_placements.mjs) as /setblock commands
 * over a single persistent RCON connection, offset by an origin (world coords of the
 * schematic's local 0,0,0). Reports a per-block success/failure summary at the end -
 * never assume success without checking the actual RCON responses.
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

fs.appendFileSync('/tmp/exec_debug.log', `START argv=${JSON.stringify(process.argv)}\n`);
const [, , placementsPath, ox, oy, oz] = process.argv;
if (!placementsPath || ox === undefined) {
    console.error('Usage: execute_placements.mjs <placements.json> <originX> <originY> <originZ>');
    process.exit(1);
}
const origin = { x: Number(ox), y: Number(oy), z: Number(oz) };
const { placements } = JSON.parse(fs.readFileSync(placementsPath, 'utf8'));

function blockCommand(p) {
    const wx = origin.x + p.x, wy = origin.y + p.y, wz = origin.z + p.z;
    const propKeys = Object.keys(p.properties || {}).sort();
    const propStr = propKeys.length ? `[${propKeys.map(k => `${k}=${p.properties[k]}`).join(',')}]` : '';
    return `setblock ${wx} ${wy} ${wz} minecraft:${p.name}${propStr} replace`;
}

const sock = net.connect(PORT, HOST);
let stage = 'auth';
let acc = Buffer.alloc(0);
let out = '';
let idx = 0;
let nextReqId = 100;
let ok = 0, failed = [];
const startTime = Bun.nanoseconds();

sock.setTimeout(120000, () => { console.error('rcon: timeout'); process.exit(1); });
sock.on('error', (e) => { console.error(`rcon: ${e.message}`); process.exit(1); });
sock.on('connect', () => {
    fs.appendFileSync('/tmp/exec_debug.log', 'connected\n');
    try {
        const pw = loadPassword();
        fs.appendFileSync('/tmp/exec_debug.log', `pw loaded len=${pw.length}\n`);
        sock.write(frame(1, 3, pw));
        fs.appendFileSync('/tmp/exec_debug.log', 'auth frame written\n');
    } catch (e) {
        fs.appendFileSync('/tmp/exec_debug.log', `THROW: ${e.stack}\n`);
    }
});
sock.on('close', (hadError) => fs.appendFileSync('/tmp/exec_debug.log', `closed hadError=${hadError}\n`));

function sendNext() {
    if (idx >= placements.length) {
        const secs = ((Bun.nanoseconds() - startTime) / 1e9).toFixed(1);
        console.log(`\nDone in ${secs}s: ${ok}/${placements.length} placed.`);
        if (failed.length) {
            console.log(`${failed.length} FAILED:`);
            for (const f of failed.slice(0, 50)) console.log(`  ${f.cmd} => ${f.resp}`);
            if (failed.length > 50) console.log(`  ...and ${failed.length - 50} more`);
            fs.writeFileSync(placementsPath + '.failed.json', JSON.stringify(failed, null, 2));
        }
        sock.end();
        process.exit(failed.length ? 1 : 0);
    }
    out = '';
    const cmdId = nextReqId++;
    const sentinelId = nextReqId++;
    sock.write(frame(cmdId, 2, blockCommand(placements[idx])));
    sock.write(frame(sentinelId, 2, ''));
    sock._cmdId = cmdId;
    sock._sentinelId = sentinelId;
}

sock.on('data', (chunk) => {
    fs.appendFileSync('/tmp/exec_debug.log', `data chunk len=${chunk.length} hex=${chunk.subarray(0,32).toString('hex')}\n`);
    try {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (acc.length < 4 + len) break;
        const id = acc.readInt32LE(4);
        const body = acc.toString('utf8', 12, 4 + len - 2);
        acc = acc.subarray(4 + len);
        if (id === -1) { console.error('rcon: auth failed'); process.exit(1); }
        if (stage === 'auth') {
            if (id !== 1) continue;
            stage = 'cmd';
            sendNext();
        } else if (id === sock._cmdId) {
            out += body;
        } else if (id === sock._sentinelId) {
            const resp = out.replace(/§./g, '').trim();
            if (/^Changed the block|^Block placed/i.test(resp)) {
                ok++;
            } else {
                failed.push({ cmd: blockCommand(placements[idx]), resp });
            }
            idx++;
            if (idx % 250 === 0) console.log(`... ${idx}/${placements.length} (${ok} ok, ${failed.length} failed)`);
            sendNext();
        }
    }
    } catch (e) {
        fs.appendFileSync('/tmp/exec_debug.log', `DATA THROW: ${e.stack}\n`);
    }
});
