import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const BOT = process.argv[2] || 'andy';
const TIMEOUT_MS = Number(process.argv[3] || 45000);
const LANES = (process.argv[4] || '1,2,3,4,5,6,7,8,9,10').split(',').map(Number);

const pos = async () => {
    const m = (await send(`data get entity ${BOT} Pos`)).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};

/** Send a chat command and CONFIRM the agent logged receipt - RCON drops sends under load. */
async function command(text) {
    for (let attempt = 0; attempt < 3; attempt++) {
        await send(`msg ${BOT} ${text}`);
        await sleep(1200);
        const log = fs.readFileSync('/home/asanrivas/mindcraft/logs/service.log', 'utf8').slice(-200000);
        if (log.includes(`${BOT} received message from Rcon : ${text}`)) return true;
    }
    return false;
}

// Clear the marathon FIRST. `!stop` interrupts the running action but leaves `resume_func`
// set, so the agent's idle handler re-runs `marathonRun` and the bot walks off toward its next
// checkpoint mid-test - mining through the rig on the way. Every earlier gym result where the
// bot finished in the wrong lane was this, not a navigation failure.
say(`gym: bot=${BOT} timeout=${TIMEOUT_MS / 1000}s`);
await (async () => {
    for (let i = 0; i < 3; i++) {
        await send(`msg ${BOT} !marathonReset`);
        await sleep(1500);
        const log = fs.readFileSync('/home/asanrivas/mindcraft/logs/service.log', 'utf8').slice(-200000);
        if (log.includes(`${BOT} received message from Rcon : !marathonReset`)) { say('marathon cleared'); return; }
    }
    say('WARNING: could not confirm marathon reset - results may be contaminated');
})();
say('depth  outcome        secs   final position');
const results = [];
for (const d of LANES) {
    const z = 4702 + (d - 1) * 4;
    await command('!stop');
    await sleep(500);
    // REPAIR THE LANE FIRST. The bot mines through the bank when it cannot climb it, and
    // without this every later run is scored against a bank an earlier run already breached -
    // the bot then swims the pre-made tunnel in one 9-block leg, never stalls, and the whole
    // recovery ladder we are trying to exercise is unreachable. Every result before this was
    // measuring the damage, not the behaviour.
    const z0 = 4701 + (d - 1) * 4, z1 = z0 + 2;
    await send(`fill 4501 100 ${z0} 4523 110 ${z1} stone`);              // rebuild slab + bank
    await send(`fill 4502 ${111 - d} ${z0} 4508 110 ${z1} water`);       // re-carve the pool
    await send(`fill 4501 111 ${z0} 4523 113 ${z1} air`);                // clear the walkway
    await sleep(600);
    await sleep(800);
    // Drop the bot into the pool at the west end. Water top block is y110, so float at ~110.
    await send(`tp ${BOT} 4504.5 110.5 ${z}.5`);
    await sleep(2500);
    const start = await pos();
    if (!start || start.y < 105) { say(`${String(d).padStart(5)}  TP-FAILED`); results.push({ d, ok: false, why: 'tp' }); continue; }

    const delivered = await command('!travel("east", 10)');
    if (!delivered) { say(`${String(d).padStart(5)}  CMD-DROPPED`); results.push({ d, ok: false, why: 'cmd' }); continue; }

    const t0 = Date.now();
    let ok = false, p = start;
    while (Date.now() - t0 < TIMEOUT_MS) {
        await sleep(1000);
        p = await pos() ?? p;
        // Success = standing ON the bank: east of the pool and above the water surface.
        if (p.x >= 4509 && p.y >= 110.9) { ok = true; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`${String(d).padStart(5)}  ${(ok ? 'CLIMBED OUT' : 'STUCK').padEnd(13)} ${secs.padStart(5)}   (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`);
    results.push({ d, ok, secs: +secs });
}
await command('!stop');
const passed = results.filter((x) => x.ok).length;
say(`\nRESULT: ${passed}/${results.length} depths climbed out`);
say('failed depths: ' + (results.filter((x) => !x.ok).map((x) => x.d).join(', ') || 'none'));
r.close(); process.exit(0);
