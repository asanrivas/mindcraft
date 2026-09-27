#!/usr/bin/env bun
/**
 * Sit between the real Minecraft client and the server, and record what a HUMAN sends while
 * doing something the bot cannot do.
 *
 *   bun tools/packet_proxy.mjs                    # listens on 25566, forwards to 25565
 *   # then point Prism at localhost:25566, and go climb out of water a few times
 *
 * WHY: every attempt to make the bot climb out of shallow water so far has been an inference
 * about what prismarine-physics ought to do. This replaces inference with ground truth - the
 * exact movement packets, y-trace and onGround flags a working client produces for the move we
 * cannot reproduce. Compare that against the bot's own trace and the difference IS the bug.
 *
 * Writes newline-delimited JSON to recordings/packets-<ts>.ndjson, and prints a live y-trace so
 * you can see the jump register as it happens.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire('/home/asanrivas/mindcraft/');
const mc = require('minecraft-protocol');

const LISTEN = Number(process.env.PROXY_PORT || 25566);
const TARGET_HOST = 'localhost';
const TARGET_PORT = 25565;
const VERSION = '1.21.11';

const outDir = path.resolve('/home/asanrivas/mindcraft/recordings');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `packets-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const out = fs.createWriteStream(outFile);
console.log(`[proxy] recording to ${outFile}`);

// Movement is the only thing we care about, but names differ across protocol versions, so match
// loosely rather than hard-coding a list and silently recording nothing.
const isMovement = (name) => /position|look|flying|move|input|abilities/i.test(name);

const srv = mc.createServer({
    'online-mode': false, host: '0.0.0.0', port: LISTEN, keepAlive: false, version: VERSION,
    motd: 'packet capture proxy',
});
console.log(`[proxy] listening on :${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT} (${VERSION})`);

srv.on('login', (client) => {
    const name = client.username;
    console.log(`[proxy] ${name} connected; opening upstream`);
    const seen = new Set();
    let lastY = null;
    let n = 0;

    const target = mc.createClient({
        host: TARGET_HOST, port: TARGET_PORT, username: name, auth: 'offline',
        version: VERSION, keepAlive: false,
    });

    client.on('packet', (data, meta) => {
        if (meta.state === 'play' && target.state === 'play') {
            if (isMovement(meta.name)) {
                seen.add(meta.name);
                const rec = { t: Date.now(), dir: 'c2s', name: meta.name, ...data };
                out.write(JSON.stringify(rec) + '\n');
                // A jump out of water is a short, sharp y climb - print those, skip the noise.
                if (typeof data.y === 'number') {
                    if (lastY !== null && Math.abs(data.y - lastY) > 0.01) {
                        const dy = data.y - lastY;
                        if (++n % 2 === 0 || Math.abs(dy) > 0.15) {
                            console.log(`  y=${data.y.toFixed(3)} dy=${dy >= 0 ? '+' : ''}${dy.toFixed(3)} onGround=${data.onGround} (${meta.name})`);
                        }
                    }
                    lastY = data.y;
                }
            }
            target.write(meta.name, data);
        }
    });
    target.on('packet', (data, meta) => {
        if (meta.state === 'play' && client.state === 'play') {
            if (isMovement(meta.name)) out.write(JSON.stringify({ t: Date.now(), dir: 's2c', name: meta.name, ...data }) + '\n');
            if (meta.name !== 'compress') { try { client.write(meta.name, data); } catch {} }
        }
    });

    const bye = (who) => () => {
        console.log(`[proxy] ${who} closed. movement packet names seen: ${[...seen].join(', ') || '(none)'}`);
        try { client.end(); } catch {}
        try { target.end(); } catch {}
        out.end();
    };
    client.on('end', bye('client'));
    target.on('end', bye('server'));
    client.on('error', (e) => console.log(`[proxy] client error: ${e.message}`));
    target.on('error', (e) => console.log(`[proxy] server error: ${e.message}`));
});
