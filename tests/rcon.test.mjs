/**
 * The RCON client:
 *   bun tests/rcon.test.mjs
 *
 * Two defects, both paid for in a live session that believed it had given a player 192 grass
 * blocks and had not.
 *
 * 1. THE CLIENT PIPELINED TWO FRAMES. Every command was written together with an empty-body
 *    "sentinel" command, in the same event-loop tick, to delimit a split reply. Node concatenates
 *    same-tick writes into one TCP segment and this server reads ONE packet per socket read,
 *    discarding the rest - so the sentinel was dropped, its reply never came, and the connection
 *    was wedged from then on. Measured on the live server, one connection, `list` x5:
 *      pipelined 1/5 OK then 6000ms timeouts; spaced 30ms 5/5 OK; one-frame-at-a-time 8/8 OK.
 *    So: one frame in flight, always. That is what `writes never overlap` below pins down.
 *
 * 2. SILENCE READ AS SUCCESS. On no reply the old client printed an empty line and exited 0,
 *    which is indistinguishable from a command that quietly worked. A `give` that never ran was
 *    reported as done. `send` must REJECT on silence, never resolve empty.
 */
import { EventEmitter } from 'events';
import { RconClient, encodeFrame, decodeFrames } from '../tools/rcon.mjs';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};
const ok = (label, cond) => check(label, !!cond, true);

/** A socket that records every frame written and never answers unless the test says so. */
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.connecting = false;
        this.frames = [];        // every frame this client wrote
        this.outstanding = 0;    // command frames written but not yet answered
        this.maxOutstanding = 0;
        this.ended = false;
    }
    write(buf) {
        const [frames] = decodeFrames(buf);
        // More than one frame in a single write() IS the bug: they share a TCP segment.
        if (frames.length > 1) { this.coalesced = true; }
        for (const f of frames) {
            this.frames.push(f);
            if (f.type === 2) {
                this.outstanding++;
                this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
            }
        }
        return true;
    }
    end() { this.ended = true; }
    destroy() { this.ended = true; }
    /** Server answers a command frame. */
    reply(id, body) { this.outstanding--; this.emit('data', encodeFrame(id, 0, body)); }
    /** Answers without clearing `outstanding` - for split replies, where more frames follow. */
    part(id, body) { this.emit('data', encodeFrame(id, 0, body)); }
    authOk() { this.emit('data', encodeFrame(1, 2, '')); }
    authFail() { this.emit('data', encodeFrame(-1, 2, '')); }
    cmds() { return this.frames.filter(f => f.type === 2).map(f => f.body); }
}

const newClient = (opts = {}) => {
    const sock = new FakeSocket();
    const client = new RconClient({ connect: () => sock, idleMs: 5, commandTimeoutMs: 120, ...opts });
    return { sock, client };
};
const connected = async (opts) => {
    const { sock, client } = newClient(opts);
    const p = client.connect('pw');
    sock.authOk();
    await p;
    return { sock, client };
};
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// --- frame codec -------------------------------------------------------------------------------
{
    const [frames, rest] = decodeFrames(Buffer.concat([encodeFrame(7, 2, 'list'), encodeFrame(8, 0, 'hi')]));
    check('decodes two concatenated frames', frames.map(f => [f.id, f.type, f.body]), [[7, 2, 'list'], [8, 0, 'hi']]);
    check('no remainder', rest.length, 0);
}
{
    const whole = encodeFrame(9, 0, 'abc');
    const [frames, rest] = decodeFrames(whole.subarray(0, 7));
    check('a partial frame is held back, not mis-parsed', frames.length, 0);
    check('partial bytes kept as remainder', rest.length, 7);
}

// --- defect 1: one frame in flight, always -----------------------------------------------------
{
    const { sock, client } = await connected();
    const p = client.send('list');
    await tick();
    check('writes exactly one command frame', sock.cmds(), ['list']);
    ok('never two frames in one write() - that is the segment that gets truncated', !sock.coalesced);
    sock.reply(2, 'there are 2 players');
    check('reply returned', await p, 'there are 2 players');
    check('one command in flight at a time', sock.maxOutstanding, 1);
    // The old client sent `frame(3, 2, '')` alongside every command. Nothing may do that again.
    check('no empty-body command is ever sent', sock.cmds().filter(c => c === ''), []);
}
{
    // Concurrent callers must queue, not pipeline. This is the multi-command path that replaced
    // reconnecting once per command.
    const { sock, client } = await connected();
    const a = client.send('list');
    const b = client.send('seed');
    await tick();
    check('second command withheld until the first is answered', sock.cmds(), ['list']);
    sock.reply(2, 'A');
    await tick(15);   // the first reply completes only after its idle window closes
    check('second command sent only after the first reply', sock.cmds(), ['list', 'seed']);
    sock.reply(3, 'B');
    check('both resolve to their own reply', [await a, await b], ['A', 'B']);
    check('still only one in flight across concurrent callers', sock.maxOutstanding, 1);
}

// --- defect 2: silence is an error, never an empty success -------------------------------------
{
    const { client } = await connected();
    let err = null;
    await client.send('give .CikPink minecraft:grass_block 192').catch(e => { err = e; });
    ok('no reply REJECTS rather than resolving empty', err !== null);
    check('and is classified as a timeout', err?.kind, 'timeout');
    ok('the message admits the command may have run', /may or may not have run/.test(err?.message || ''));
    ok('the message names the command', /grass_block/.test(err?.message || ''));
}
{
    // A reply that genuinely carries no text is NOT silence: the server answered, so the command
    // ran. It must resolve, so callers can tell the two apart.
    const { sock, client } = await connected();
    const p = client.send('difficulty');
    await tick();
    sock.reply(2, '');
    check('an empty-but-present reply resolves', await p, '');
}
{
    const { sock, client } = await connected();
    const p = client.send('list');
    await tick();
    sock.emit('close');
    let err = null;
    await p.catch(e => { err = e; });
    check('a dropped connection is a network error, not an empty result', err?.kind, 'network');
}

// --- split replies, without an empty sentinel to delimit them ----------------------------------
{
    const { sock, client } = await connected();
    const p = client.send('help');
    await tick();
    sock.part(2, 'first-half ');
    await tick(1);
    sock.reply(2, 'second-half');
    check('same-id frames are reassembled by the idle window', await p, 'first-half second-half');
}
{
    const { sock, client } = await connected();
    const p = client.send('list');
    await tick();
    sock.reply(2, '§aGreen §cRed');
    check('section-sign colour codes are stripped', await p, 'Green Red');
}

// --- auth --------------------------------------------------------------------------------------
{
    const { sock, client } = newClient();
    const p = client.connect('wrong');
    sock.authFail();
    let err = null;
    await p.catch(e => { err = e; });
    check('a wrong password fails fast as auth, not as a timeout', err?.kind, 'auth');
}
{
    // Some servers emit an empty RESPONSE_VALUE before the auth reply. Gating on "first packet
    // seen" instead of the echoed id once sent the command unauthenticated.
    const { sock, client } = newClient();
    const p = client.connect('pw');
    sock.emit('data', encodeFrame(0, 0, ''));   // pre-auth chatter
    await tick();
    check('pre-auth chatter does not complete the login', sock.frames.filter(f => f.type === 2).length, 0);
    sock.authOk();
    await p;
    ok('login completes on the echoed id', true);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('rcon.test.mjs: all checks passed');
