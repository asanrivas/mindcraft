/**
 * Does `!followPlayer` get the bot OUT of the water?
 *
 * The gym (`gym_run.mjs`) only ever exercises `!travel`, which reaches the water-exit branch
 * inside `nav.followPath`. `followPlayer` has its own loop and does NOT go through that branch
 * when it is already inside the follow distance - which is the whole bug: a bot treading water
 * three blocks off the bank the player is standing on has "arrived", so navigateTo plans
 * nothing, followPath never runs, and the bot polls in the water forever.
 *
 * Needs a SECOND player. bob is used because he is a real player entity as far as
 * `bot.players` is concerned. Run with bob online.
 *
 *   bun scratchpad/follow_water.mjs [lane] [timeoutMs]
 *
 * Case A is the regression: andy pressed against the bank, INSIDE follow distance of bob.
 * Case B is the ordinary one: andy at the far end, so the walk happens first.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const LANE = Number(process.argv[2] || 3);
const TIMEOUT_MS = Number(process.argv[3] || 30000);
const z = 4702 + (LANE - 1) * 4;
const z0 = 4701 + (LANE - 1) * 4, z1 = z0 + 2;

const posOf = async (who) => {
    const m = (await send(`data get entity ${who} Pos`)).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};

async function command(bot, text) {
    for (let attempt = 0; attempt < 3; attempt++) {
        await send(`msg ${bot} ${text}`);
        await sleep(1200);
        const log = fs.readFileSync('/home/asanrivas/mindcraft/logs/service.log', 'utf8').slice(-200000);
        if (log.includes(`${bot} received message from Rcon : ${text}`)) return true;
    }
    return false;
}

async function repairLane() {
    await send(`fill 4501 100 ${z0} 4523 110 ${z1} stone`);
    await send(`fill 4502 ${111 - LANE} ${z0} 4508 110 ${z1} water`);
    await send(`fill 4501 111 ${z0} 4523 113 ${z1} air`);
    await sleep(800);
}

async function runCase(name, andyX, bobX) {
    await command('andy', '!stop');
    await command('bob', '!stop');
    await sleep(500);
    await repairLane();
    await send(`tp bob ${bobX}.5 111 ${z}.5`);
    await send(`tp andy ${andyX} 110.5 ${z}.5`);
    await sleep(2500);
    const start = await posOf('andy');
    if (!start || start.y < 105) { say(`${name}: TP-FAILED`); return false; }
    const d0 = Math.hypot(bobX + 0.5 - start.x, 0);
    say(`${name}: andy (${start.x.toFixed(1)}, ${start.y.toFixed(2)}) bob x=${bobX}.5  gap=${d0.toFixed(1)} blocks`);

    if (!await command('andy', '!followPlayer("bob", 4)')) { say(`${name}: CMD-DROPPED`); return false; }
    const t0 = Date.now();
    let ok = false, p = start, maxGap = 0;
    while (Date.now() - t0 < TIMEOUT_MS) {
        // PIN BOB. He is a live agent with modes and a model of his own - in the first control
        // run he issued `!navTo(3371, 62, 4845)` four seconds in and walked off, which pushed
        // andy outside the follow distance and so exercised the ORDINARY driving path. The
        // whole point of case A is that andy is INSIDE follow distance and therefore never asks
        // the navigator for anything; a bob who moves silently converts it into case B.
        await send(`tp bob ${bobX}.5 111 ${z}.5`);
        await sleep(500);
        p = await posOf('andy') ?? p;
        maxGap = Math.max(maxGap, Math.hypot(bobX + 0.5 - p.x, 111 - p.y, z + 0.5 - p.z));
        if (p.x >= 4509 && p.y >= 110.9) { ok = true; break; }
    }
    say(`${name}: max andy-bob gap during the run was ${maxGap.toFixed(2)} blocks`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`${name}: ${ok ? 'OUT OF THE WATER' : 'STILL WET'} after ${secs}s at (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`);
    await command('andy', '!stop');
    return ok;
}

say(`follow-water test: lane ${LANE} (depth ${LANE}), z=${z}, timeout ${TIMEOUT_MS / 1000}s`);
await command('andy', '!marathonReset');
// A: already INSIDE follow distance while wet - the case that used to hang forever.
const a = await runCase('A inside-follow-dist', 4508.4, 4511);
// B: a real approach first, then the bank.
const b = await runCase('B walk-then-climb', 4504.5, 4515);
say(`\nRESULT: A=${a ? 'PASS' : 'FAIL'}  B=${b ? 'PASS' : 'FAIL'}`);
r.close(); process.exit(a && b ? 0 : 1);
