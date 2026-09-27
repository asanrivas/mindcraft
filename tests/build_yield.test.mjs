/**
 * A build must STOP when it is asked to, inside the ActionManager's ten-second grace.
 *
 *   bun tests/build_yield.test.mjs
 *
 * Why it matters. When a mode interrupts an action, the ActionManager asks it to stop, polls for
 * ten seconds, and then KILLS THE PROCESS. A per-cell loop that notices the interrupt one cell at a
 * time - `goNear` returns false, so `continue` - walks every remaining cell, each failing instantly
 * inside the flight primitives, and on a big footprint that outlasts ten seconds.
 *
 * Measured 2026-09-24, the cathedral (69x110, 35,142 cells), foundation phase:
 *
 *   18:42:54 [bob] mode:drowning firing - ... submerged=true under=10.2s pos=(888, 61, 4734)
 *   18:42:54 action "mode:drowning" trying to interrupt current action "action:buildBlueprint"
 *   18:42:54 [bob] flyNear (888, 60, 4730) failed: interrupted        <- dozens per second
 *   18:42:54 waiting for code to finish executing...                  <- x33, for ten seconds
 *   18:43:04 Agent process exited with code 1 and signal null
 *
 * Then seven hours idle, 2,450 of 35,142 placed. The passes had always checked the interrupt ("Without
 * this the loop walks thousands of remaining cells after a `!stop`"); the terrain clear and the
 * foundation, which run BEFORE the passes, did not. The foundation also wrapped `placeOne` in a
 * catch-and-continue, which would have swallowed an `interrupted` error even had one been thrown.
 *
 * And the interrupt should not have fired: a creative bot takes no drowning damage. The builder
 * already paused `self_preservation` in creative for exactly that reason (a 2026-09-01 incident,
 * ninety-five minutes idle) and missed `drowning`, which is the same kind of mode.
 */
import fs from 'node:fs';
import { Vec3 } from 'vec3';
import { clearTerrainLayers, placeFoundation, CREATIVE_INVULNERABLE_MODES }
    from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}
/** Run `fn`, return {threw, message, ms}. */
async function outcome(fn) {
    const t0 = Date.now();
    try { await fn(); return { threw: false, ms: Date.now() - t0 }; }
    catch (e) { return { threw: true, message: e.message, ms: Date.now() - t0 }; }
}

const agent = { name: '__yield_test_no_such_bot__' };   // writeStatus is best-effort: no dir, no write
const origin = new Vec3(880, 63, 4637);
const size = { width: 20, length: 20, height: 67 };
const quiet = () => { const l = console.log; console.log = () => {}; return () => { console.log = l; }; };

/** A bot over a footprint full of dirt, with its world-touching calls counted. */
function terrainBot() {
    const bot = {
        interrupt_code: null, digs: 0, reads: 0,
        entity: { position: new Vec3(890, 70, 4647) },
        blockAt(v) { this.reads++; return { name: 'dirt', boundingBox: 'block', position: v }; },
        async dig() { this.digs++; },
    };
    return bot;
}

// ======================================================================== the terrain clear
{
    // 1. already interrupted: nothing is scanned, dug or written
    const bot = terrainBot();
    bot.interrupt_code = 'mode:drowning';
    const restore = quiet();
    const r = await outcome(() => clearTerrainLayers(agent, bot, origin, size, { occupied: new Set() }, 35142));
    restore();
    check('clear: an interrupted bot stops with `interrupted`', r.message, 'interrupted');
    check('clear: ...and digs nothing', bot.digs, 0);
    check('clear: ...and does not even scan', bot.reads, 0);
}
{
    // 2. interrupted DURING the layer scan - i.e. with 400 targets queued, the drowning-shaped case.
    // The old loop only noticed per cell via goNear, so it would have walked all of them.
    const bot = terrainBot();
    const read = bot.blockAt.bind(bot);
    bot.blockAt = function (v) { if (this.reads === 100) this.interrupt_code = 'mode:drowning'; return read(v); };
    const restore = quiet();
    const r = await outcome(() => clearTerrainLayers(agent, bot, origin, size, { occupied: new Set() }, 35142));
    restore();
    check('clear: interrupted mid-scan still stops with `interrupted`', r.message, 'interrupted');
    report('clear: ...before digging a single one of the queued cells', bot.digs === 0,
        `${bot.digs} digs, ${bot.reads} reads, ${r.ms}ms`);
}

// ======================================================================== the foundation
{
    // 3. already interrupted
    const bot = { interrupt_code: 'mode:drowning', reads: 0, blockAt() { this.reads++; return null; } };
    const cells = Array.from({ length: 500 }, (_, i) => ({ x: i % 20, y: 0, z: Math.floor(i / 20) }));
    const r = await outcome(() => placeFoundation(agent, bot, origin, cells, { occupied: new Set() }, 35142));
    check('foundation: an interrupted bot stops with `interrupted`', r.message, 'interrupted');
    check('foundation: ...having read nothing', bot.reads, 0);
}
{
    // 4. interrupted during a column's depth scan: stops before the placement in that column
    const top = origin.y - 1;
    const bot = {
        interrupt_code: null, reads: 0,
        blockAt(v) {
            this.reads++;
            this.interrupt_code = 'mode:drowning';             // raised while scanning down
            return v.y === top ? { name: 'water', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' };
        },
    };
    const r = await outcome(() => placeFoundation(agent, bot, origin, [{ x: 0, y: 0, z: 0 }], { occupied: new Set() }, 35142));
    check('foundation: interrupted mid-column stops with `interrupted`', r.message, 'interrupted');
    report('foundation: ...without reaching placeOne', bot.reads === 2,
        `${bot.reads} reads: the depth scan and nothing after it`);
}
{
    // 5. THE CATCH. placeOne throws while the bot is interrupted, on the LAST placement of the
    // phase - so there is no later iteration whose own check could rescue it, and only the catch
    // stands between the error and the caller. The old catch logged and `continue`d, the loop
    // ended, and placeFoundation RETURNED NORMALLY with the interrupt swallowed.
    const top = origin.y - 1;
    let topReads = 0;
    const bot = {
        interrupt_code: null,
        blockAt(v) {
            if (v.y === top) {
                topReads++;
                if (topReads === 1) return { name: 'water', boundingBox: 'empty' };   // depth scan: not ground
                this.interrupt_code = 'mode:drowning';                               // inside placeOne
                throw new Error('boom: a flight primitive failing under the interrupt');
            }
            return { name: 'stone', boundingBox: 'block' };                          // ground one below
        },
    };
    const restore = quiet();
    const r = await outcome(() => placeFoundation(agent, bot, origin, [{ x: 0, y: 0, z: 0 }], { occupied: new Set() }, 35142));
    restore();
    report('foundation: an interrupt inside placeOne is NOT swallowed by the catch', r.threw,
        r.threw ? `threw "${r.message}"` : 'returned normally - the catch ate the interrupt');
    check('foundation: ...and it surfaces as `interrupted`, not as the incidental error', r.message, 'interrupted');
}
{
    // 6. the control: a NON-interrupt error in placeOne is still logged and skipped, which is what
    // the catch was added for ("one bad column must not abort the whole run"). Keeping that is
    // the reason the fix rethrows only on an interrupt rather than removing the catch.
    const top = origin.y - 1;
    let topReads = 0;
    const bot = {
        interrupt_code: null,
        blockAt(v) {
            if (v.y === top) {
                topReads++;
                if (topReads === 1) return { name: 'water', boundingBox: 'empty' };
                throw new Error('boom: one bad column');
            }
            return { name: 'stone', boundingBox: 'block' };
        },
    };
    const restore = quiet();
    const r = await outcome(() => placeFoundation(agent, bot, origin, [{ x: 0, y: 0, z: 0 }], { occupied: new Set() }, 35142));
    restore();
    check('foundation: a bad column without an interrupt is still survived', r.threw, false);
}

// ======================================================================== the foundation must SAY what it skips
{
    // A column with no ground in reach used to be a bare `continue`, so `foundation: 2607 support
    // blocks placed` was true while 617 columns over a lake went unsupported and unmentioned.
    const bot = { interrupt_code: null, blockAt: () => ({ name: 'water', boundingBox: 'empty' }) };
    const cells = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
    const lines = []; const l = console.log; console.log = (m) => lines.push(String(m));
    await placeFoundation(agent, bot, origin, cells, { occupied: new Set() }, 35142);
    console.log = l;
    report('foundation: out-of-reach columns are reported, not skipped silently',
        lines.some(m => /3 of 3 columns have no ground within 8 blocks/.test(m)), lines.join(' | ') || '(said nothing)');
}
{
    // ...and an unloaded column is reported as unreadable, NOT as out of reach
    const bot = { interrupt_code: null, blockAt: () => null };
    const lines = []; const l = console.log; console.log = (m) => lines.push(String(m));
    await placeFoundation(agent, bot, origin, [{ x: 0, y: 0, z: 0 }], { occupied: new Set() }, 35142);
    console.log = l;
    check('foundation: unreadable is not reported as too deep', lines.some(m => /no ground within/.test(m)), false);
    check('foundation: ...it is reported as unreadable', lines.some(m => /unreadable/.test(m)), true);
}

// ======================================================================== creative: nothing to preserve
check('drowning is paused in creative', CREATIVE_INVULNERABLE_MODES.includes('drowning'), true);
check('self_preservation still is',     CREATIVE_INVULNERABLE_MODES.includes('self_preservation'), true);
{
    // and the list is actually used, only under creative - a survival bot must keep both
    const src = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    report('the creative branch pauses the whole list',
        /gameMode === 'creative'\) \{\s*for \(const m of CREATIVE_INVULNERABLE_MODES\)/.test(src),
        'pauses happen only inside `if (bot.game?.gameMode === \'creative\')`');
    // Pausing drowning in SURVIVAL would be dangerous: it is a real safety mode there. So it must
    // never appear in the unconditional PAUSABLE_MODES list.
    const pausable = src.match(/const PAUSABLE_MODES = \[([^\]]*)\]/)[1];
    check('drowning is NOT unconditionally pausable', /'drowning'/.test(pausable), false);
}

console.log(failures === 0 ? 'build_yield: all checks passed' : `build_yield: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
