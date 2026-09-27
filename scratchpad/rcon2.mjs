import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOST = process.env.RCON_HOST || '127.0.0.1';
const PORT = Number(process.env.RCON_PORT || 25575);
function pw() {
    if (process.env.RCON_PASSWORD) return process.env.RCON_PASSWORD;
    return fs.readFileSync(path.join(os.homedir(), '.config', 'mc-rcon.env'), 'utf8').match(/^RCON_PASSWORD=(.*)$/m)[1].trim();
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

/** A persistent RCON session: one socket, many commands, id-matched replies. */
export class Rcon {
    constructor() { this.sock = null; this.nextId = 10; this.pending = new Map(); this.acc = Buffer.alloc(0); }
    connect() {
        return new Promise((resolve, reject) => {
            const sock = net.connect(PORT, HOST);
            this.sock = sock;
            let authed = false;
            const t = setTimeout(() => reject(new Error('auth timeout')), 8000);
            sock.on('error', (e) => { clearTimeout(t); for (const p of this.pending.values()) p.reject(e); reject(e); });
            sock.on('close', () => { const e = new Error('rcon closed'); for (const p of this.pending.values()) p.reject(e); });
            sock.on('connect', () => sock.write(frame(1, 3, pw())));
            sock.on('data', (chunk) => {
                this.acc = Buffer.concat([this.acc, chunk]);
                while (this.acc.length >= 4) {
                    const len = this.acc.readInt32LE(0);
                    if (this.acc.length < 4 + len) break;
                    const id = this.acc.readInt32LE(4);
                    const body = this.acc.toString('utf8', 12, 4 + len - 2);
                    this.acc = this.acc.subarray(4 + len);
                    if (id === -1) { clearTimeout(t); return reject(new Error('auth failed')); }
                    if (!authed) { if (id !== 1) continue; authed = true; clearTimeout(t); resolve(this); continue; }
                    const p = this.pending.get(id);
                    if (p) { this.pending.delete(id); clearTimeout(p.timer); p.resolve(body.replace(/§./g, '').trim()); }
                }
            });
        });
    }
    send(command) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rcon timeout: ${command}`)); }, 15000);
            this.pending.set(id, { resolve, reject, timer });
            this.sock.write(frame(id, 2, command));
        });
    }
    close() { try { this.sock.end(); } catch {} }
}
