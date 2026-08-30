/**
 * Can the bot actually jump a gap on the live server?
 *
 *   bun scratchpad/jump_gym.mjs [widths] [timeoutMs] [flags]
 *     --noblocks   clear the inventory: a crossing can then ONLY be a jump
 *     --rise N     far side N blocks higher   (--rise 2 must be REFUSED)
 *     --drop N     far side N blocks lower
 *     --lethal     no floor under the gap at all
 *     --lava       lava floor under the gap
 *     --void       no far side at all
 *     --repeat N   run each width N times and report the rate
 *
 * `scratchpad/sim/` calibrated the constants against the real physics engine in milliseconds.
 * This is the half the sim CANNOT do: whether the server accepts the movement. Built on
 * `gap_gym.mjs` - same lanes, same RCON helpers, same confirm-the-command-arrived loop.
 *
 * `--noblocks` is the essential arm. With dirt in the bag a crossing might be the bridge; with an
 * empty bag it can only be the jump.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i < 0 ? d : Number(args[i + 1]); };
const WIDTHS = (args[0] && !args[0].startsWith('--') ? args[0] : '1,2,3,4').split(',').map(Number);
const TIMEOUT = (args[1] && !args[1].startsWith('--')) ? Number(args[1]) : 35000;
const RISE = num('--rise', 0), DROP = num('--drop', 0), REPEAT = num('--repeat', 1);
const X0 = 4660, X1 = 4700, Z0 = 4700;

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
const health = async () => {
    const m = (await send('data get entity andy Health')).match(/([\d.]+)f/);
    return m ? +m[1] : null;
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

for (let x = X0; x <= X1 + 16; x += 16)
    for (let z = Z0; z <= Z0 + WIDTHS.length * 4 + 16; z += 16) await send(`forceload add ${x} ${z}`);

say(`jump gym: widths ${WIDTHS.join(',')} rise=${RISE} drop=${DROP}`
    + `${has('--noblocks') ? ' NOBLOCKS' : ''}${has('--lethal') ? ' LETHAL' : ''}`
    + `${has('--lava') ? ' LAVA' : ''}${has('--void') ? ' VOID' : ''} x${REPEAT}`);
say('width  outcome    secs   jumps  bridged  hp     final position');

const results = [];
for (let i = 0; i < WIDTHS.length; i++) {
    const w = WIDTHS[i];
    const z = Z0 + 1 + i * 4;
    let crossed = 0;
    let last = null;
    for (let rep = 0; rep < REPEAT; rep++) {
        const farY = 110 + RISE - DROP;
        await send(`fill ${X0} 90 ${z - 1} ${X1} 125 ${z + 1} air`);
        await send(`fill ${X0} 100 ${z - 1} 4674 110 ${z + 1} stone`);            // take-off side
        if (!has('--void'))
            await send(`fill ${4675 + w} ${farY - 10} ${z - 1} ${X1} ${farY} ${z + 1} stone`);
        // The default floor sits THREE blocks down, not ten. A gap over a 10-block drop is
        // `lethalFall` by design (no floor within JUMP_FALL_SAFE), so the safety rule correctly
        // refused every width above 2 and the first run measured the rule rather than the jump.
        // `--lethal` is how you ask for the deep version.
        // The floor sits SEVEN blocks down: deep enough that the planner will not route into the
        // trench (`maxDrop` is 3, and it cannot climb the far side back out), shallow enough to
        // be a survivable miss. At three blocks down the bot just walked in and got stuck at the
        // bottom - the run measured the planner, not the jump.
        if (has('--lava')) await send(`fill 4675 104 ${z - 1} ${4674 + w} 104 ${z + 1} lava`);
        else if (!has('--lethal')) await send(`fill 4675 104 ${z - 1} ${4674 + w} 104 ${z + 1} stone`);
        await sleep(700);

        await command('!stop');
        await send('clear andy');
        if (!has('--noblocks')) await send('give andy dirt 64');
        await send(`tp andy 4668.5 111 ${z}.5`);
        await sleep(2200);

        const start = await pos();
        const { ok, before } = await command(`!navTo(${4680 + w}, ${farY + 1}, ${z})`);
        if (!ok || !start) { say(`${String(w).padStart(5)}  CMD-DROPPED`); continue; }

        const t0 = Date.now();
        let done = false, p = start;
        while (Date.now() - t0 < TIMEOUT) {
            await sleep(1000);
            p = await pos() ?? p;
            if (p.x >= 4676 + w && p.y >= farY - 0.5) { done = true; break; }
        }
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const buf = since(before);
        const jumps = (buf.match(/jump: span=/g) || []).length;
        const bridged = (buf.match(/bridge: laid/g) || []).length;
        const hp = await health();
        if (done) crossed++;
        last = { secs, jumps, bridged, hp, p };
        say(`${String(w).padStart(5)}  ${(done ? 'CROSSED' : 'STUCK').padEnd(9)} ${secs.padStart(5)}`
            + `  ${String(jumps).padStart(5)}  ${String(bridged).padStart(7)}  ${String(hp).padStart(4)}`
            + `   (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
    }
    results.push({ w, crossed, of: REPEAT, last });
}
await command('!stop');
say(`\nRESULT: ${results.filter(x => x.crossed > 0).length}/${results.length} widths crossed`
    + (REPEAT > 1 ? `  rates: ${results.map(x => `w${x.w} ${x.crossed}/${x.of}`).join('  ')}` : ''));
r.close(); process.exit(0);
