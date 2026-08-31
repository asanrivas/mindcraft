#!/usr/bin/env bun
/**
 * Controlled comparison: does wetLiftVerdict's 350ms cadence gate (src/agent/library/skills.js)
 * actually reduce server anti-cheat corrections during a wet pillar duty cycle, or is it
 * unnecessary?
 *
 * Uses the REAL exported wetLiftVerdict/WET_LIFT_IMPULSE from skills.js and the REAL
 * JumpAssist/SwimAssist classes, unmodified - only `minGapMs` is overridden per arm, as a
 * function argument (the function already accepts it; the shipped call site just never passes
 * one, so it always defaults to 350). No src/ edits.
 *
 * Runs on a separate whitelisted probe account ("probe1"), NOT andy or bob - reaching the
 * ungated arm on the live andy agent is impossible without editing skills.js or restarting the
 * service, both forbidden for this measurement. Using the same probe harness for BOTH arms
 * keeps the comparison controlled (identical terrain, identical bot, only minGapMs differs).
 *
 *   bun scratchpad/wet_pillar_cadence.mjs --sequence gated,ungated,gated,ungated,gated,ungated
 */
import { createRequire } from 'module';
import { Vec3 } from 'vec3';
import settings from '../settings.js';
import { wetLiftVerdict, WET_LIFT_IMPULSE } from '../src/agent/library/skills.js';
import { inWater, inLava } from '../src/agent/library/swim.js';
import { JumpAssist } from '../src/agent/library/jump_assist.js';
import { SwimAssist } from '../src/agent/library/swim_assist.js';
import { CORRECTION_MIN_BLOCKS, TELEPORT_MIN_BLOCKS } from '../src/agent/library/server_corrections.js';

const require = createRequire('/home/asanrivas/mindcraft/');
const mineflayer = require('mineflayer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SEQUENCE = arg('sequence', 'gated,ungated,gated,ungated').split(',');
const DURATION_S = Number(arg('duration', 15));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

// Rig: scratchpad/build_rig.mjs built a dead-end, ceiling-pinned water corridor at z=5200,
// x 5199..5210, ceiling at y=203 (0.2 blocks of headroom over a submerged bot standing on the
// y=200 floor) - the exact "collision zeroes vel.y every tick" condition the gate exists for.
// Staging platform (dry) is x 5193..5197; water now covers x 5198..5209 (it spread 2 blocks past
// the doorway on its own - checked live, not assumed).
const STAGE = { x: 5195, y: 201, z: 5200.5 };
const DEADEND_X = 5209.4; // pinned against the x=5210 wall

const bot = mineflayer.createBot({
    host: arg('host', settings.host),
    port: Number(arg('port', settings.port)),
    username: 'probe1',
    version: '1.21.11',
    auth: 'offline',
});

bot.once('error', (e) => { log(`error: ${e.message}`); process.exit(1); });
bot.once('kicked', (r) => { log(`kicked: ${JSON.stringify(r).slice(0, 300)}`); process.exit(1); });

// ---- correction tracking, replicating SwimAssist._forcedMove's own classification exactly ----
// (compare successive forcedMove-observed positions, band = [CORRECTION_MIN_BLOCKS, TELEPORT_MIN_BLOCKS))
let watching = false;
let lastSeen = null;
let corrections = []; // {t, dist}
let allForcedMoves = 0;
bot.on('forcedMove', () => {
    allForcedMoves++;
    const p = bot.entity?.position;
    if (!p) return;
    const prev = lastSeen;
    lastSeen = p.clone();
    if (!watching) return;
    if (!prev) return;
    const d = p.distanceTo(prev);
    if (d >= CORRECTION_MIN_BLOCKS && d < TELEPORT_MIN_BLOCKS) {
        corrections.push({ t: Date.now(), dist: d });
        log(`  CORRECTION dist=${d.toFixed(3)} (running total ${corrections.length})`);
    } else if (d >= TELEPORT_MIN_BLOCKS) {
        log(`  (ignored: teleport-scale ${d.toFixed(2)}, not evidence either way)`);
    }
});

function recentCorrections(windowMs) {
    const now = Date.now();
    return corrections.filter((c) => now - c.t < windowMs).length;
}

async function runArm(arm, runNum) {
    const minGapMs = arm === 'ungated' ? 0 : 350;
    log(`=== run ${runNum}: arm=${arm} minGapMs=${minGapMs} ===`);

    // Fresh valve instances per run: an independent trial, not contaminated by a previous run's
    // stand-down state.
    const jumpAssist = new JumpAssist(bot);
    const swimAssist = new SwimAssist(bot);
    jumpAssist.enable();
    swimAssist.enable();
    swimAssist.setMode('auto');

    const warnBuf = [];
    const origWarn = console.warn;
    console.warn = (...a) => { warnBuf.push(a.join(' ')); origWarn(...a); };

    // Drive into the wall: forward + sprint, same as a bot wading against a bank it cannot
    // climb. This also makes SwimAssist's own boosted+valve live and comparable, not just ours.
    await bot.lookAt(new Vec3(DEADEND_X + 5, bot.entity.position.y, STAGE.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', false);

    // Wait until genuinely wet AND pinned (x stops advancing) before starting the clock -
    // mitigation #1: never count anything from the approach, only from the first WET tick.
    let pinnedSince = null;
    for (let i = 0; i < 200; i++) {
        await sleep(100);
        const p = bot.entity.position;
        const wet = inWater(bot);
        const pinned = p.x >= DEADEND_X - 0.5;
        if (wet && pinned) { pinnedSince = pinnedSince ?? Date.now(); }
        if (pinnedSince && Date.now() - pinnedSince > 800) break;
    }
    if (!inWater(bot)) { log('  FAILED to reach water - aborting run'); return { arm, runNum, ok: false }; }

    // Assert the valve is clean right now, and clear the ledger so only the measured window
    // below can populate it.
    const priorTotal = corrections.length;
    corrections = [];
    watching = true;
    log(`  in place: pos=${bot.entity.position}, wet=${inWater(bot)}, `
        + `priorCorrectionsDiscarded=${priorTotal}, starting ${DURATION_S}s measured window`);

    const baseY = bot.entity.position.y;
    let lastLift = 0;
    let liftsApplied = 0;
    const wetLift = () => {
        const v = bot.entity.velocity;
        if (!v) return;
        const ok = wetLiftVerdict({
            inWater: inWater(bot), inLava: inLava(bot),
            rise: bot.entity.position.y - baseY, velY: v.y,
            sinceLastMs: Date.now() - lastLift,
            minGapMs,
        });
        if (!ok) return;
        lastLift = Date.now();
        liftsApplied++;
        v.y += WET_LIFT_IMPULSE;
    };
    const iv = setInterval(wetLift, 10);

    const t0 = Date.now();
    await sleep(DURATION_S * 1000);
    clearInterval(iv);
    watching = false;
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);

    const elapsed = (Date.now() - t0) / 1000;
    const finalPos = bot.entity.position.clone();
    const stoodDown = warnBuf.filter((w) => w.includes('stood down for') || w.includes('stood down'));

    console.warn = origWarn;
    jumpAssist.disable();
    swimAssist.disable();

    log(`  RESULT run ${runNum} (${arm}): duration=${elapsed.toFixed(1)}s liftsApplied=${liftsApplied} `
        + `corrections=${corrections.length} valveTrips=${stoodDown.length} finalPos=${finalPos}`);
    for (const w of stoodDown) log(`    VALVE: ${w}`);

    return {
        arm, runNum, ok: true, elapsed, liftsApplied,
        corrections: corrections.length,
        valveTrips: stoodDown.length,
        valveLines: stoodDown,
    };
}

bot.once('spawn', async () => {
    log('spawned - settling before any measurement');
    await sleep(3000);

    // ONE operator teleport, at the very start, well before any wet tick - this is the exact
    // "walked in vs teleported into position" hazard the task calls out. We wait out its
    // forcedMove (and the login/spawn ones) for well over the 10s rubberBandWindowMs before
    // watching starts, and `watching` stays false through the whole approach anyway.
    log(`teleporting to staging platform ${JSON.stringify(STAGE)} (one-time positioning, not measured)`);
    // Use RCON for the teleport so it is a single clean operator action.
    const { Rcon } = await import('./rcon2.mjs');
    const r = await new Rcon().connect();
    await r.send(`tp probe1 ${STAGE.x} ${STAGE.y} ${STAGE.z}`);
    r.close();

    log('waiting 12s for the teleport forcedMove to clear the 10s rubber-band window...');
    await sleep(12000);
    log(`clean before walk-in: correctionsSoFar=${corrections.length} allForcedMoves=${allForcedMoves}`);

    // Walk in normally (control states, not tp) to the dead end. Face due east explicitly -
    // `forward` moves along the bot's current yaw, not a world axis, and a bare teleport does
    // not set a sane yaw.
    await bot.lookAt(new Vec3(DEADEND_X + 5, STAGE.y, STAGE.z), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    let walked = false;
    for (let i = 0; i < 300; i++) {
        await sleep(150);
        const p = bot.entity.position;
        if (i % 10 === 0) log(`  walking... pos=${p}`);
        if (p.x >= DEADEND_X - 0.5) { walked = true; break; }
        if (p.y < 190) { log(`  fell off the rig, aborting walk-in`); break; }
        // Keep facing east - buoyancy/collisions can rotate look target in mineflayer sometimes.
        await bot.lookAt(new Vec3(DEADEND_X + 5, p.y, STAGE.z), true);
    }
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    log(`walk-in ${walked ? 'reached' : 'DID NOT reach'} the dead end: pos=${bot.entity.position}`);
    if (!walked) { log('ABORT: could not reach the rig'); process.exit(1); }

    const results = [];
    for (let i = 0; i < SEQUENCE.length; i++) {
        const r = await runArm(SEQUENCE[i], i + 1);
        results.push(r);
        await sleep(2000);
    }

    log('=== SUMMARY ===');
    for (const r of results) {
        if (!r.ok) { log(`run ${r.runNum} ${r.arm}: FAILED`); continue; }
        log(`run ${r.runNum} ${r.arm}: lifts=${r.liftsApplied} corrections=${r.corrections} valveTrips=${r.valveTrips}`);
    }
    const gated = results.filter((r) => r.ok && r.arm === 'gated');
    const ungated = results.filter((r) => r.ok && r.arm === 'ungated');
    log(`GATED total corrections=${gated.reduce((a, r) => a + r.corrections, 0)} valveTrips=${gated.reduce((a, r) => a + r.valveTrips, 0)}`);
    log(`UNGATED total corrections=${ungated.reduce((a, r) => a + r.corrections, 0)} valveTrips=${ungated.reduce((a, r) => a + r.valveTrips, 0)}`);

    bot.quit();
    process.exit(0);
});
