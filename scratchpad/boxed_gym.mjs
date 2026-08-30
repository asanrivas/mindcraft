/**
 * Can the bot get out of an enclosure and reach a target?
 *
 *   bun scratchpad/boxed_gym.mjs [timeoutMs] [cases]
 *
 * Reported as "Andy can't reach me with blocks surrounding him". The PLANNER is not the problem -
 * `scratchpad/sim/boxed.mjs` shows it routes a dig through the wall in every configuration,
 * offline, in 1ms. So this drives the executor.
 *
 * Each case seals the bot in a different way and asks it to walk to a point 12 blocks east.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';

const TIMEOUT = Number(process.argv[2] || 45000);
const ONLY = process.argv[3];
const X = 4740, Y = 110, Z = 4700;     // floor block at Y; feet at Y+1

function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}
const pos = async () => {
    const m = (await send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
async function command(text) {
    const before = fs.statSync(LOG).size;
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
        await send(`msg andy ${text}`);
        for (let p = 0; p < 10 && !ok; p++) {
            await sleep(400);
            ok = since(before).includes(`received message from Rcon : ${text}`);
        }
    }
    return { ok, before };
}

const CASES = {
    'walls 2 high':      { wallH: 2, roof: false, thick: 1 },
    'walls + roof':      { wallH: 2, roof: true,  thick: 1 },
    'walls 3 high':      { wallH: 3, roof: false, thick: 1 },
    'walls 2 thick':     { wallH: 2, roof: false, thick: 2 },
    'buried (solid)':    { buried: true },
    'no tools, walls':   { wallH: 2, roof: false, thick: 1, noTools: true },
    'FOLLOW walls':      { wallH: 2, roof: false, thick: 1, follow: true },
    'FOLLOW walls+roof': { wallH: 2, roof: true,  thick: 1, follow: true },
};

for (let x = X - 32; x <= X + 32; x += 16)
    for (let z = Z - 32; z <= Z + 32; z += 16) await send(`forceload add ${x} ${z}`);

say(`boxed gym: goal is 12 blocks east, timeout ${TIMEOUT / 1000}s`);
say('case               outcome   secs   moved   final position');
const results = [];
for (const [name, c] of Object.entries(CASES)) {
    if (ONLY && !name.includes(ONLY)) continue;
    // Clear a generous arena and lay a floor.
    await send(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y + 20} ${Z + 20} air`);
    await send(`fill ${X - 20} ${Y - 3} ${Z - 20} ${X + 20} ${Y} ${Z + 20} stone`);
    await sleep(500);

    await command('!stop');
    await send('clear andy');
    if (!c.noTools) await send('give andy iron_pickaxe 1');
    await send(`tp andy ${X}.5 ${Y + 1} ${Z}.5`);
    await sleep(2000);

    if (c.buried) {
        // Every cell the body does not occupy is stone: the hardest case.
        await send(`fill ${X - 2} ${Y + 1} ${Z - 2} ${X + 2} ${Y + 3} ${Z + 2} stone`);
        await send(`fill ${X} ${Y + 1} ${Z} ${X} ${Y + 2} ${Z} air`);
    } else {
        for (let t = 0; t < c.thick; t++) {
            const rr = 1 + t;
            await send(`fill ${X - rr} ${Y + 1} ${Z - rr} ${X + rr} ${Y + c.wallH} ${Z + rr} stone hollow`);
        }
        await send(`fill ${X} ${Y + 1} ${Z} ${X} ${Y + c.wallH} ${Z} air`);
        if (c.roof) await send(`fill ${X - 2} ${Y + c.wallH + 1} ${Z - 2} ${X + 2} ${Y + c.wallH + 1} ${Z + 2} stone`);
    }
    await sleep(800);

    // Reaching a PLAYER is the case actually reported, and it is not the same code path:
    // `followPlayer` passes `waypointMs: 1500` and `maxReplans: 2`, where `!navTo` takes the
    // defaults (6000 / 6). Run both so the difference is visible rather than assumed.
    const start = await pos();
    const cmd = c.follow ? `!followPlayer("bob", 2)` : `!navTo(${X + 12}, ${Y + 1}, ${Z})`;
    if (c.follow) { await send(`tp bob ${X + 12}.5 ${Y + 1} ${Z}.5`); await sleep(800); }
    const { ok, before } = await command(cmd);
    if (!ok || !start) { say(`${name.padEnd(18)} CMD-DROPPED`); continue; }

    const t0 = Date.now();
    let done = false, p = start;
    while (Date.now() - t0 < TIMEOUT) {
        await sleep(1000);
        if (c.follow) await send(`tp bob ${X + 12}.5 ${Y + 1} ${Z}.5`);
        p = await pos() ?? p;
        if (p.x >= X + 10) { done = true; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const moved = Math.hypot(p.x - start.x, p.z - start.z);
    say(`${name.padEnd(18)} ${(done ? 'OUT' : 'STUCK').padEnd(8)} ${secs.padStart(5)}  ${moved.toFixed(1).padStart(5)}`
        + `   (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
    results.push({ name, done });
}
await command('!stop');
say(`\nRESULT: ${results.filter(x => x.done).length}/${results.length} escaped`);
r.close(); process.exit(0);
