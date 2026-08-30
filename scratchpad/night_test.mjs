/**
 * Does `night_safety` behave at nightfall?
 *
 *   bun scratchpad/night_test.mjs bare      no tools, no blocks, bare stone -> refuse and STOP
 *   bun scratchpad/night_test.mjs equipped  pickaxe + dirt                  -> shelter, then dig out
 *
 * The failing case matters more than the working one: the mode interrupts every action in the
 * agent, so a shelter it can never build used to cancel whatever the bot was doing three times a
 * minute until dawn.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';

function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}

const mode = process.argv[2] || 'bare';
const WATCH_MS = Number(process.argv[3] || 150000);

// A clean, flat, roofless stone pad well away from the chest rig, so `hasRoofOverhead` and the
// "already underground" check cannot mask the behaviour under test.
await send('forceload add 4560 4700');
await send('fill 4556 100 4696 4576 120 4716 air');
await send('fill 4556 100 4696 4576 110 4716 stone');
await send('msg andy !stop');
await sleep(800);
// The model self-prompts, and a goal like "get a stone pickaxe" makes the bot walk off the test
// pad onto different ground between attempts - so each attempt measures a different place. End
// the goal, or the run measures wandering rather than the mode.
await send('msg andy !endGoal');
await sleep(1200);
await send('tp andy 4566.5 111 4706.5');
await send('clear andy');
if (mode === 'equipped') {
    await send('give andy iron_pickaxe 1');
    await send('give andy dirt 64');
}
// Hostile mobs must be POSSIBLE, or the mode correctly stands down before it ever gets going.
// But they must not actually reach the bot: `night_safety` defers to `self_defense` while
// something hostile is within 12 blocks (correctly), and a bot with no tools and no armour on an
// open pad simply dies - the first run ended with it respawning 1180 blocks away, which measures
// nothing. `gamerule doMobSpawning` is not usable here (the server's RCON command parser rejects
// every gamerule name), so the watch loop sweeps instead.
await send('difficulty normal');
await send('effect give andy minecraft:resistance 3600 4 true');
await sleep(1500);

const start = fs.statSync(LOG).size;
await send('time set 12800');          // just before dusk
say(`=== night_safety: ${mode} === (watching ${WATCH_MS / 1000}s)`);

const t0 = Date.now();
let lastPrinted = 0;
while (Date.now() - t0 < WATCH_MS) {
    await sleep(5000);
    await send('execute positioned 4566 111 4706 run kill @e[type=!player,distance=..40]');
    // PIN THE BOT TO THE PAD. This is a test of the mode, not of the model: left alone the agent
    // picks up a goal ("get a stone pickaxe"), walks off into terrain that is already sheltered,
    // and the mode correctly never fires - which measures nothing. Only re-teleport when it has
    // actually strayed, so a shelter dig in progress is not yanked out from under itself.
    const m = (await send('data get entity andy Pos')).match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    if (m && Math.hypot(+m[1] - 4566.5, +m[3] - 4706.5) > 6) {
        await send('tp andy 4566.5 111 4706.5');
    }
    const buf = since(start);
    const lines = buf.split('\n').filter(l => /\[andy\]/.test(l)
        && !/torch_placing|IdleBehavior|item_collecting/.test(l));
    for (const l of lines.slice(lastPrinted)) say('   ' + l.replace(/^\[[^\]]+\] /, '').trim());
    lastPrinted = lines.length;
}

const buf = since(start);
const fires = (buf.match(/Mode night_safety finished executing/g) || []).length;
const gaveUp = /night_safety: giving up for tonight/.test(buf);
const sealed = /VERIFIED SHELTER/.test(buf);
const openPit = /but could not seal the roof/.test(buf);
say(`\nnight_safety executions: ${fires}`);
say(`gave up for the night:   ${gaveUp}`);
say(`verified shelter:        ${sealed}`);
say(`left an open pit:        ${openPit}`);
await send('difficulty peaceful');
r.close(); process.exit(0);
