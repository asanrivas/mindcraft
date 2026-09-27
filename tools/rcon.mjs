#!/usr/bin/env bun
/**
 * Minimal Minecraft RCON client. No dependencies.
 *
 *   bun tools/rcon.mjs "time set day"
 *   bun tools/rcon.mjs difficulty              # argv is joined, so quotes are optional
 *   printf 'list\ngive andy stone 1\n' | bun tools/rcon.mjs -    # MANY commands, ONE connection
 *   mc "difficulty normal"                     # via the ~/.local/bin/mc wrapper
 *
 * Connection details come from the environment or the defaults below, which match the
 * geyser-minecraftbe-1 container's server.properties. The password is read from
 * ~/.config/mc-rcon.env (RCON_PASSWORD=...) so it never has to appear on a command line
 * or in shell history.
 *
 * Protocol (https://wiki.vg/RCON): little-endian frames
 *   int32 length | int32 requestId | int32 type | body\0 | \0
 * type 3 = login, 2 = command, 0 = response. Auth failure echoes requestId -1.
 *
 * ---------------------------------------------------------------------------------------------
 * NEVER WRITE TWO FRAMES IN ONE EVENT-LOOP TICK. This is the whole reason this file was
 * rewritten, and it is not a style preference.
 *
 * This server reads ONE packet per socket read and discards the rest of the read buffer. Two
 * `sock.write()` calls in the same tick are concatenated by Node into a single TCP segment, so
 * the second frame is silently dropped, its reply never arrives, and the connection is wedged
 * from then on. Measured against the live server, one connection, `list` x5:
 *
 *   write(cmd); write(sentinel)                 -> 1/5 OK, then 6000ms timeouts forever
 *   write(cmd); await 30ms; write(sentinel)     -> 5/5 OK, ~31ms each
 *   write(cmd) only, await reply, then next     -> 8/8 OK, 0-2ms each
 *
 * `setNoDelay(true)` does NOT help: the coalescing happens in Node, above the socket.
 *
 * The old client paired every command with an empty-body sentinel command written in the same
 * tick, to mark the end of a split response. That is what wedged it. The sentinel itself is
 * harmless (measured: a connection still answers 3/3 after one), but pairing it is fatal - so
 * the end of a response is now detected by an IDLE WINDOW instead, and no empty command is ever
 * sent. Commands are strictly serialised: one outstanding frame at a time.
 *
 * The second defect, equally expensive: the old client printed an empty line and exited 0 when
 * no reply came, so a wedged connection was indistinguishable from a command that succeeded
 * quietly. A `give` that never ran reported success. Silence is now an ERROR (exit 1), and a
 * real-but-empty reply says so on stderr.
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULTS = {
    host: process.env.RCON_HOST || '127.0.0.1',
    port: Number(process.env.RCON_PORT || 25575),
    // How long to wait for the FIRST frame of a reply. Healthy replies land in 0-50ms; the
    // margin is for a main thread busy with a chunk save.
    commandTimeoutMs: 10000,
    // After a frame arrives, how long to wait for a continuation before calling the reply
    // complete. Minecraft splits responses over ~4096 bytes into several same-id frames, which
    // is what the sentinel used to delimit. 25ms costs nothing and needs no extra command.
    idleMs: 25,
    connectTimeoutMs: 8000,
};

export function encodeFrame(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    b.copy(buf, 12);
    return buf;
}

/** Pull whole frames out of an accumulating buffer. Returns [frames, remainder]. */
export function decodeFrames(acc) {
    const frames = [];
    while (acc.length >= 4) {
        const len = acc.readInt32LE(0);
        if (len < 10 || acc.length < 4 + len) break;
        frames.push({ id: acc.readInt32LE(4), type: acc.readInt32LE(8), body: acc.toString('utf8', 12, 4 + len - 2) });
        acc = acc.subarray(4 + len);
    }
    return [frames, acc];
}

export function loadPassword(env = process.env, homedir = os.homedir()) {
    if (env.RCON_PASSWORD) return env.RCON_PASSWORD;
    const envFile = path.join(homedir, '.config', 'mc-rcon.env');
    const m = fs.readFileSync(envFile, 'utf8').match(/^RCON_PASSWORD=(.*)$/m);
    if (!m) throw new Error(`No RCON password: set RCON_PASSWORD or put RCON_PASSWORD=... in ${envFile}`);
    return m[1].trim();
}

export class RconError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
}

/**
 * One connection, many commands, strictly one frame in flight.
 *
 * `connect` is injectable so the suite can drive this against a fake socket: it must return
 * something with write/end/destroy and the 'data'/'error'/'close' events.
 */
export class RconClient {
    constructor(opts = {}) {
        this.opts = { ...DEFAULTS, ...opts };
        this.connectFn = opts.connect || ((port, host) => net.connect(port, host));
        this.sock = null;
        this.acc = Buffer.alloc(0);
        this.waiters = [];
        this.nextId = 1;
        this.closed = false;
        // Serialises sends. Two callers must never have frames on the wire at the same time,
        // because the server would drop the coalesced one.
        this.chain = Promise.resolve();
    }

    _deliver(frame) {
        for (const w of [...this.waiters]) w(frame);
    }

    _drop(w) {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
    }

    async connect(password) {
        const { port, host, connectTimeoutMs } = this.opts;
        this.sock = this.connectFn(port, host);
        this.sock.on('data', (chunk) => {
            const [frames, rest] = decodeFrames(Buffer.concat([this.acc, chunk]));
            this.acc = rest;
            for (const f of frames) this._deliver(f);
        });
        this.sock.on('close', () => {
            this.closed = true;
            this._deliver({ id: null, type: null, body: '', closed: true });
        });

        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new RconError('connect/auth timed out', 'timeout')), connectTimeoutMs);
            const fail = (e) => { clearTimeout(t); this._drop(w); reject(e instanceof RconError ? e : new RconError(e.message, 'network')); };
            this.sock.on('error', fail);
            // Gate on the ECHOED REQUEST ID, not on "first packet seen". Some servers emit an
            // empty SERVERDATA_RESPONSE_VALUE before the auth reply; treating that as the auth
            // response flipped us to 'authenticated' and sent the command unauthenticated, and
            // the real auth-failure packet (id -1) then matched no branch and was dropped - so a
            // wrong password produced an 8s timeout instead of "auth failed".
            const w = (f) => {
                if (f.closed) return fail(new RconError('server closed the connection during auth', 'network'));
                if (f.id === -1) return fail(new RconError('auth failed (wrong RCON_PASSWORD)', 'auth'));
                if (f.id !== 1) return;                     // pre-auth chatter; keep waiting
                clearTimeout(t); this._drop(w); resolve();
            };
            this.waiters.push(w);
            const go = () => this.sock.write(encodeFrame(1, 3, password));
            if (this.sock.connecting === false) go(); else this.sock.on('connect', go);
        });
        return this;
    }

    /**
     * Run one command and resolve with its text.
     *
     * Resolves only on a frame actually echoing our request id. If nothing comes back it
     * REJECTS - it must never resolve empty, because a caller cannot tell that apart from a
     * command that legitimately printed nothing, and that is how a `give` that never ran got
     * reported as done.
     */
    send(command) {
        const run = async () => {
            if (this.closed) throw new RconError('connection is closed', 'network');
            const id = ++this.nextId;
            return await new Promise((resolve, reject) => {
                let out = '';
                let seen = false;
                let idle = null;
                const overall = setTimeout(() => finish(null), this.opts.commandTimeoutMs);
                const finish = (err) => {
                    clearTimeout(overall); clearTimeout(idle); this._drop(w);
                    if (err) return reject(err);
                    if (!seen) {
                        return reject(new RconError(
                            `no response to "${command}" after ${this.opts.commandTimeoutMs}ms - it may or may not have run`,
                            'timeout'));
                    }
                    resolve(out.replace(/§./g, '').trim());
                };
                const w = (f) => {
                    if (f.closed) return finish(new RconError('server closed the connection', 'network'));
                    if (f.id !== id) return;
                    seen = true;
                    out += f.body;
                    // A split reply arrives as several same-id frames back to back. Wait a beat
                    // for a continuation rather than sending an empty command to delimit it.
                    clearTimeout(idle);
                    idle = setTimeout(() => finish(null), this.opts.idleMs);
                };
                this.waiters.push(w);
                // ONE frame, alone in this tick. Nothing else may be written until this resolves.
                this.sock.write(encodeFrame(id, 2, command));
            });
        };
        const result = this.chain.then(run, run);
        this.chain = result.then(() => {}, () => {});
        return result;
    }

    close() {
        this.closed = true;
        if (this.sock) this.sock.end();
    }
}

export async function openRcon(opts = {}) {
    const client = new RconClient(opts);
    await client.connect(opts.password ?? loadPassword());
    return client;
}

// --- CLI ---------------------------------------------------------------------------------------
const isMain = import.meta.main ?? (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])));
if (isMain) {
    const argv = process.argv.slice(2);
    let commands;
    if (argv.length === 1 && argv[0] === '-') {
        commands = fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    } else {
        // Joined, not one-command-per-arg, so `rcon.mjs give andy stone 1` keeps working.
        const joined = argv.join(' ').trim();
        commands = joined ? [joined] : [];
    }
    if (!commands.length) {
        console.error('usage: rcon.mjs "<command>"   |   rcon.mjs -   (commands on stdin, one per line)');
        process.exit(2);
    }

    let client;
    try {
        client = await openRcon();
    } catch (e) {
        console.error(`rcon: ${e.message}`);
        process.exit(1);
    }

    let failed = 0;
    for (const cmd of commands) {
        try {
            const out = await client.send(cmd);
            if (out) console.log(out);
            // An empty body still means the server ANSWERED, so the command ran. Say so on
            // stderr rather than letting a blank stdout read as "nothing happened".
            else console.error(`rcon: "${cmd}" ran and returned no output`);
        } catch (e) {
            console.error(`rcon: ${e.message}`);
            failed++;
            if (e.kind === 'network') break;
        }
    }
    client.close();
    process.exit(failed ? 1 : 0);
}
