/**
 * Can the bot escape STRAIGHT UP out of solid ground?
 *
 *   bun scratchpad/updig_gym.mjs [timeoutMs] [caseFilter]
 *
 * boxed_gym asks for a HORIZONTAL escape (walk 12 east). This asks the other question: sealed
 * under a plug of solid ground, can the bot break the block above its head, place a block under
 * its feet, and repeat until it is out? That is what a human player does, and it is the only
 * escape available when the bot is deep rather than merely walled in.
 *
 * The plug is anchored to the REAL surface (top solid block y=66 here) rather than built inside
 * an artificial air pocket. The first version cut a 40x25x40 hole out of badlands and the
 * natural sand above collapsed into it, so every case was secretly a falling-block case -
 * `mode:self_preservation` fired with `Dug out 1 falling block(s) above me` before the climb had
 * moved a metre. Anchoring to the surface means nothing above the plug is unsupported.
 *
 * Falling materials are still separate cases on purpose: sand and gravel do not stay where they
 * are mined, so each cleared cell refills from the column above it.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';

const TIMEOUT = Number(process.argv[2] || 120000);
const ONLY = process.argv[3];
const DRIVER = process.argv[4] || 'climbout';   // 'climbout' | 'navto'
const X = 4740, Z = 4640;
const SURFACE = 66;            // top solid block; open air begins at SURFACE+1
const FLOOR = 40;              // bottom of the rebuilt arena

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

// plug   = blocks of solid ground between the bot's head and open sky
// mat    = what the plug is made of
// blocks = what the bot carries to pillar with (null = nothing, so digging is the only option)
//
// There is deliberately no "narrow shaft" case: the arena is rebuilt as SOLID stone, so the bot
// is already sealed on all six sides in every case. Carving a 1-wide shaft would change nothing.
const CASES = {
    'stone 3':          { plug: 3,  mat: 'stone',  blocks: 'cobblestone 64' },
    'stone 6':          { plug: 6,  mat: 'stone',  blocks: 'cobblestone 64' },
    'stone 12':         { plug: 12, mat: 'stone',  blocks: 'cobblestone 64' },
    'stone 6, no blox': { plug: 6,  mat: 'stone',  blocks: null },
    'SAND 6':           { plug: 6,  mat: 'sand',   blocks: 'cobblestone 64' },
    'GRAVEL 6':         { plug: 6,  mat: 'gravel', blocks: 'cobblestone 64' },
};

for (let x = X - 32; x <= X + 32; x += 16)
    for (let z = Z - 32; z <= Z + 32; z += 16) await send(`forceload add ${x} ${z}`);

// QUIESCE THE AGENT FIRST. Andy reacts to every command result with a turn of his own, and the
// first run measured him issuing !navTo mid-climb: the `pinned` lines in the log came from the
// navigator, not from the routine under test. `!climbOut` also carries a 15 MINUTE action
// timeout, so a climb left running by an aborted run is still live when the next case starts -
// seen as `action:climbOut trying to interrupt current action:climbOut`.
await command('!stop');
await command('!endGoal');
await command('!steer("Never call a command. Reply with at most five words.")');
await sleep(3000);

say(`updig gym: escape upward past y=${SURFACE + 1}, timeout ${TIMEOUT / 1000}s, driver ${DRIVER}`);
say('case               outcome    secs    dY   final position');
const results = [];
for (const [name, c] of Object.entries(CASES)) {
    if (ONLY && !name.includes(ONLY)) continue;

    const feetY = SURFACE - c.plug - 1;        // head at feetY+1, plug feetY+2 .. SURFACE
    // Rebuild the arena solid every time: a previous case's shaft is a free escape route.
    // SPLIT INTO SLABS. One 41x27x41 fill is 45,387 blocks against a vanilla limit of 32,768,
    // and the server answers "Too many blocks in the specified area" over RCON without the
    // harness noticing - so the arena silently kept the previous case's tunnels and the bot
    // was measured escaping through a hole the last run had left it.
    for (let y0 = FLOOR; y0 <= SURFACE; y0 += 8) {
        const y1 = Math.min(y0 + 7, SURFACE);
        await send(`fill ${X - 20} ${y0} ${Z - 20} ${X + 20} ${y1} ${Z + 20} stone`);
    }
    await sleep(400);

    await command('!stop');
    await sleep(2500);          // let the aborted action actually unwind before rebuilding
    await send('clear andy');
    await send('give andy diamond_pickaxe 1');
    await send('give andy diamond_shovel 1');   // sand/gravel bare-handed is a different question
    if (c.blocks) await send(`give andy ${c.blocks}`);

    // Carve the pocket BEFORE teleporting in, or the tp lands inside stone and the server
    // shoves the bot somewhere of its own choosing.
    await send(`fill ${X} ${feetY} ${Z} ${X} ${feetY + 1} ${Z} air`);
    await send(`setblock ${X} ${feetY - 1} ${Z} stone`);
    if (c.mat !== 'stone') {
        const rr = 12;
        await send(`fill ${X - rr} ${feetY + 2} ${Z - rr} ${X + rr} ${SURFACE} ${Z + rr} ${c.mat}`);
    }
    await sleep(600);
    await send(`tp andy ${X}.5 ${feetY} ${Z}.5`);
    await sleep(2500);

    // Which command drives the escape. `!climbOut` exercises climbToSurface; `navTo` exercises
    // the navigator's own ladder, which is the path !followPlayer takes as well - and that is a
    // different code path entirely, reached only when a leg goes nowhere with the goal ahead.
    const start = await pos();
    const drive = DRIVER === 'navto' ? `!navTo(${X}, ${SURFACE + 1}, ${Z})` : '!climbOut';
    const { ok } = await command(drive);
    if (!ok || !start) { say(`${name.padEnd(18)} CMD-DROPPED`); continue; }

    const t0 = Date.now();
    let done = false, p = start;
    while (Date.now() - t0 < TIMEOUT) {
        await sleep(1000);
        p = await pos() ?? p;
        if (p.y >= SURFACE + 1) { done = true; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`${name.padEnd(18)} ${(done ? 'OUT' : 'STUCK').padEnd(9)} ${secs.padStart(5)} ${(p.y - start.y).toFixed(1).padStart(5)}`
        + `   (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})  from y=${start.y.toFixed(0)}, needed y>=${SURFACE + 1}`);
    results.push({ name, done });
}
await command('!stop');
say(`\nRESULT: ${results.filter(x => x.done).length}/${results.length} escaped upward`);
r.close(); process.exit(0);
