#!/usr/bin/env bun
/**
 * Does mineflayer-pathfinder actually work on this server?
 *
 *   bun tools/pathfinder_probe.mjs 4300 65 4910
 *
 * CLAUDE.md records that pathfinder "will not even PLAN a route over a 1-block step here", and
 * the whole nav.js/auto_jump.js stack was built on that. But the reason given for it - a client
 * /server version mismatch - has since been disproven in this same codebase, so the claim is
 * standing on a dead explanation and is worth re-testing rather than inheriting.
 *
 * Joins as a throwaway bot, walks a short goal, and reports separately:
 *   - whether a PATH IS FOUND (planning), and
 *   - whether the bot actually MOVES along it (execution).
 * Those are different failures with different fixes, and conflating them is how the original
 * diagnosis went wrong.
 */
import { createRequire } from 'module';
const require = createRequire('/home/asanrivas/mindcraft/');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const settings = (await import('/home/asanrivas/mindcraft/settings.js')).default;

// No coordinates: the probe finds its OWN target - the nearest column exactly ONE block higher
// than where it stands. That is the specific claim on trial ("will not even plan a route over a
// 1-block step"), and a far-away goal cannot test it: pathfinder returns `partial` simply for
// exceeding its search budget, which looks like failure and is not.
const bot = mineflayer.createBot({
    host: settings.host, port: settings.port, username: 'pfprobe',
    auth: 'offline', version: '1.21.11',
});
bot.loadPlugin(pathfinder);

const log = (m) => console.log(`[pfprobe] ${m}`);
const done = (code) => { try { bot.quit(); } catch {} setTimeout(() => process.exit(code), 800); };

bot.once('spawn', async () => {
    log(`spawned at ${bot.entity.position.floored()}  version=${bot.version}`);
    await new Promise((r) => setTimeout(r, 4000));   // let chunks arrive

    const moves = new Movements(bot);
    bot.pathfinder.setMovements(moves);
    const start = bot.entity.position.clone();

    // Find a real 1-block step within a short radius.
    const base = start.floored();
    const solid = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block'; };
    const air = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox !== 'block'; };
    let target = null;
    outer:
    for (let rad = 2; rad <= 8 && !target; rad++) {
        for (let dx = -rad; dx <= rad; dx++) {
            for (let dz = -rad; dz <= rad; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
                const c = base.offset(dx, 1, dz);            // standing cell one block UP
                if (!solid(c.offset(0, -1, 0))) continue;    // must have floor
                if (!air(c) || !air(c.offset(0, 1, 0))) continue;  // room for the body
                target = c; break outer;
            }
        }
    }
    if (!target) { log('no 1-block step found nearby; move the probe and retry'); return done(0); }
    log(`testing a 1-block step: ${base} -> ${target}`);
    const goal = new goals.GoalBlock(target.x, target.y, target.z);

    // PLANNING: ask for a path without executing it.
    const t0 = Date.now();
    let plan;
    try {
        plan = await bot.pathfinder.getPathTo(moves, goal, 10000);
    } catch (e) {
        log(`getPathTo threw: ${e.message}`);
        return done(1);
    }
    log(`plan: status=${plan?.status} nodes=${plan?.path?.length ?? 0} in ${Date.now() - t0}ms`);
    if (!plan || plan.status !== 'success') {
        log('VERDICT: planning FAILED - pathfinder cannot find a route here.');
        return done(0);
    }

    // EXECUTION: does the bot actually move along it?
    const t1 = Date.now();
    let moved = 0;
    const timer = setInterval(() => { moved = bot.entity.position.distanceTo(start); }, 250);
    try {
        await Promise.race([
            bot.pathfinder.goto(goal),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
        ]);
        clearInterval(timer);
        const p = bot.entity.position;
        log(`goto finished in ${((Date.now() - t1) / 1000).toFixed(1)}s, moved ${p.distanceTo(start).toFixed(1)} blocks to ${p.floored()}`);
        log('VERDICT: planning OK, execution OK.');
    } catch (e) {
        clearInterval(timer);
        const p = bot.entity.position;
        log(`goto ${e.message} after ${((Date.now() - t1) / 1000).toFixed(1)}s, moved ${p.distanceTo(start).toFixed(1)} blocks`);
        log(`VERDICT: planning OK (${plan.path.length} nodes) but execution ${moved > 2 ? 'PARTIAL' : 'FAILED'} - onGround=${bot.entity.onGround}`);
    }
    done(0);
});
bot.on('error', (e) => { log(`error: ${e.message}`); done(1); });
bot.on('kicked', (r) => { log(`kicked: ${r}`); done(1); });
