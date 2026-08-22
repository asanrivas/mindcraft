#!/usr/bin/env bun
/**
 * Minimal Minecraft RCON client. No dependencies.
 *
 *   bun tools/rcon.mjs "time set day"
 *   mc "difficulty normal"              # via the ~/.local/bin/mc wrapper
 *
 * Connection details come from the environment or the defaults below, which match the
 * geyser-minecraftbe-1 container's server.properties. The password is read from
 * ~/.config/mc-rcon.env (RCON_PASSWORD=...) so it never has to appear on a command line
 * or in shell history.
 *
 * Protocol (https://wiki.vg/RCON): little-endian frames
 *   int32 length | int32 requestId | int32 type | body\0 | \0
 * type 3 = login, 2 = command, 0 = response. Auth failure echoes requestId -1.
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
    try {
        const m = fs.readFileSync(envFile, 'utf8').match(/^RCON_PASSWORD=(.*)$/m);
        if (m) return m[1].trim();
    } catch { /* fall through */ }
    console.error(`No RCON password: set RCON_PASSWORD or create ${envFile}`);
    process.exit(2);
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

const command = process.argv.slice(2).join(' ').trim();
if (!command) { console.error('usage: rcon.mjs "<command>"'); process.exit(2); }

const sock = net.connect(PORT, HOST);
let stage = 'auth';
let acc = Buffer.alloc(0);
let out = '';

sock.setTimeout(8000, () => { console.error('rcon: timeout'); process.exit(1); });
sock.on('error', (e) => { console.error(`rcon: ${e.message}`); process.exit(1); });
sock.on('connect', () => sock.write(frame(1, 3, loadPassword())));

sock.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (acc.length < 4 + len) break;
        const id = acc.readInt32LE(4);
        const body = acc.toString('utf8', 12, 4 + len - 2);
        acc = acc.subarray(4 + len);

        // Gate on the ECHOED REQUEST ID, not on "first packet seen". Some servers emit an empty
        // SERVERDATA_RESPONSE_VALUE before the auth reply; treating that as the auth response
        // flipped stage to 'cmd' and sent the command unauthenticated, and the real auth-failure
        // packet (id -1) then matched no branch and was dropped - so a wrong password produced
        // an 8s timeout instead of "auth failed".
        if (id === -1) { console.error('rcon: auth failed'); process.exit(1); }
        if (stage === 'auth') {
            if (id !== 1) continue;   // pre-auth chatter; keep waiting for our login echo
            stage = 'cmd';
            sock.write(frame(2, 2, command));
            // Sentinel: servers may split long responses across packets; an empty follow-up
            // command's response marks the end of ours.
            sock.write(frame(3, 2, ''));
        } else if (id === 2) {
            out += body;
        } else if (id === 3) {
            // strip the section-sign colour codes Minecraft embeds
            console.log(out.replace(/§./g, '').trim());
            sock.end();
            process.exit(0);
        }
    }
});
