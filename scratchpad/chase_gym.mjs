/**
 * Can Andy CATCH a player who keeps teleporting away?
 *
 *   bun scratchpad/chase_gym.mjs [target] [hops] [--ranges 20,40,60] [--catch 5] [--timeout 60000]
 *
 * `!followPlayer` is normally tested against a target that stands still, or against bob, who
 * wanders off on his own model's whim. Neither exercises the case a person actually creates:
 * the target MOVES, repeatedly, by a lot, and the bot has to re-acquire it every time.
 *
 * WHAT THIS IS LOOKING FOR
 * ------------------------
 * `followPlayer` captures the entity ONCE, before its loop:
 *
 *     let playerObj = bot.players[username];
 *     let player = playerObj.entity;          // skills.js:3079
 *     while (!bot.interrupt_code) { ... player.position ... }
 *
 * mineflayer destroys and RECREATES the entity object when a player leaves and re-enters
 * render distance. The captured reference then points at a dead entity whose `position` is
 * frozen wherever it was last seen - so the bot would chase a ghost, confidently, forever.
 * That is the same shape as the `GoalFollow` bug `navToGoal` already had to fix (it cached
 * x/y/z at construction while the target moved).
 *
 * So every hop is scored TWICE: distance to where the target IS, and distance to where the
 * target WAS. A run that converges on the old position has found that bug; a run that simply
 * fails to arrive has found a navigation problem instead. They look identical in chat.
 *
 * WHY `spreadplayers` AND NOT `tp`
 * --------------------------------
 * A random (x, z) needs a surface Y, and probing for one over RCON means a downward column
 * scan per hop - bisection does not work here, since caves and ravines put air under stone
 * (see CLAUDE.md). `spreadplayers` already does exactly this server-side: it drops the target
 * on the topmost safe block within `maxRange`. It is also, literally, "move them randomly".
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';

const say = (s) => fs.writeSync(1, s + '\n');
const sleep = (ms) => new Promise(s => setTimeout(s, ms));
const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? dflt : process.argv[i + 1];
};

const TARGET     = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'asanrivas';
const BOT        = arg('--bot', 'andy');
const RANGES     = String(arg('--ranges', '20,35,50,70,90')).split(',').map(Number);
const CATCH      = Number(arg('--catch', 5));
const HOP_MS     = Number(arg('--timeout', 60000));
const FOLLOW_D   = Number(arg('--dist', 3));
const LOG        = '/home/asanrivas/mindcraft/logs/service.log';

const r = await new Rcon().connect();
const send = (c) => r.send(c);

const posOf = async (who) => {
    const m = (await send(`data get entity ${who} Pos`))
        .match(/\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
};
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Send a chat command and CONFIRM IT ARRIVED. A dropped command is indistinguishable from a
 * bot that ignored it, and silently turns a failed run into a meaningless one.
 */
async function command(bot, text) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const size = fs.statSync(LOG).size;
        await send(`msg ${bot} ${text}`);
        await sleep(1200);
        const fd = fs.openSync(LOG, 'r');
        const buf = Buffer.alloc(Math.max(0, fs.statSync(LOG).size - size));
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        if (buf.toString('utf8').includes(`${bot} received message from Rcon : ${text}`)) return true;
    }
    return false;
}

/** Wait for the target to actually be on the server - we cannot teleport someone who is not. */
async function waitForTarget(timeoutMs = Number(arg("--wait", 600000))) {
    const t0 = Date.now();
    let announced = false;
    while (Date.now() - t0 < timeoutMs) {
        const list = await send('list');
        if (new RegExp(`\\b${TARGET}\\b`).test(list)) return true;
        if (!announced) { say(`waiting for ${TARGET} to join... (online: ${list.split(':').pop().trim() || 'nobody'})`); announced = true; }
        await sleep(3000);
    }
    return false;
}

/**
 * Move the target randomly, at least `min` blocks from the bot. spreadplayers picks its own
 * spot, so the distance is a roll - re-roll rather than accept a hop that does not test
 * anything. Returns the landing position.
 */
async function randomHop(botPos, maxRange, min) {
    for (let tries = 0; tries < 8; tries++) {
        await send(`forceload add ${Math.round(botPos.x)} ${Math.round(botPos.z)}`);
        const out = await send(
            `spreadplayers ${botPos.x.toFixed(0)} ${botPos.z.toFixed(0)} 0 ${maxRange} false ${TARGET}`);
        await sleep(600);
        const p = await posOf(TARGET);
        if (!p) { say(`  spreadplayers: ${out}`); continue; }
        if (dist2d(p, botPos) >= min) return p;
    }
    return await posOf(TARGET);
}

// ------------------------------------------------------------------------------------------
if (!await waitForTarget()) {
    say(`${TARGET} never joined - nothing to chase. Log in and re-run.`);
    r.close(); process.exit(2);
}

say(`chase gym: ${BOT} follows ${TARGET} at ${FOLLOW_D}, caught = within ${CATCH} blocks, `
    + `${HOP_MS / 1000}s per hop\n`);

await command(BOT, '!stop');
await sleep(1000);
if (!await command(BOT, `!followPlayer("${TARGET}", ${FOLLOW_D})`)) {
    say('follow command never arrived - aborting'); r.close(); process.exit(2);
}
await sleep(2000);

const results = [];
for (let hop = 0; hop < RANGES.length; hop++) {
    const range = RANGES[hop];
    const botPos = await posOf(BOT);
    const wasAt = await posOf(TARGET);
    if (!botPos || !wasAt) { say(`hop ${hop + 1}: could not read positions, skipping`); continue; }

    const now = await randomHop(botPos, range, Math.min(range * 0.6, range - 5));
    const startGap = dist2d(now, botPos);
    say(`hop ${hop + 1}: ${TARGET} -> (${now.x.toFixed(0)}, ${now.y.toFixed(0)}, ${now.z.toFixed(0)}), `
        + `${startGap.toFixed(1)} blocks away`);

    const t0 = Date.now();
    let caught = null, minGap = startGap, minToOld = dist2d(wasAt, botPos), moved = 0, last = botPos;
    let stillThere = true;
    while (Date.now() - t0 < HOP_MS) {
        await sleep(500);
        const b = await posOf(BOT);
        const t = await posOf(TARGET);
        if (!b) continue;
        if (!t) { stillThere = false; break; }        // target logged out mid-hop
        moved += dist2d(b, last); last = b;
        const gap = dist2d(b, t);
        minGap = Math.min(minGap, gap);
        // The ghost test: is the bot converging on where the target USED to be?
        minToOld = Math.min(minToOld, dist2d(b, wasAt));
        if (gap <= CATCH) { caught = Date.now() - t0; break; }
    }
    if (!stillThere) { say(`  ${TARGET} left the server - stopping`); break; }

    const verdict = caught !== null
        ? `CAUGHT in ${(caught / 1000).toFixed(1)}s`
        : (minToOld < CATCH && minGap > CATCH
            ? `GHOST - reached the OLD position (${minToOld.toFixed(1)}) but not the new one (${minGap.toFixed(1)})`
            : `TIMEOUT - closest ${minGap.toFixed(1)} blocks`);
    say(`  ${verdict}; walked ${moved.toFixed(0)} blocks, closest-to-old ${minToOld.toFixed(1)}\n`);
    results.push({ hop: hop + 1, range, startGap, caught, minGap, minToOld, moved });
}

say('--- summary ---');
say('hop  range  start   result           closest  toOld  walked');
for (const x of results) {
    say(`${String(x.hop).padStart(3)}  ${String(x.range).padStart(5)}  `
        + `${x.startGap.toFixed(1).padStart(5)}   `
        + `${(x.caught !== null ? `caught ${(x.caught / 1000).toFixed(1)}s` : 'MISSED').padEnd(16)} `
        + `${x.minGap.toFixed(1).padStart(6)}  ${x.minToOld.toFixed(1).padStart(5)}  ${x.moved.toFixed(0).padStart(6)}`);
}
const won = results.filter(x => x.caught !== null).length;
say(`\n${won}/${results.length} caught`);
await command(BOT, '!stop');
r.close();
