/**
 * AutoJump's obstacle probe. No server, no bot:
 *   bun tests/auto_jump.test.mjs
 *
 * THE REGRESSION: the probe sampled a single point 0.9 blocks along the bot's CENTRE LINE. The
 * bot is 0.6 blocks wide, so the block that actually stops it is often the one its shoulder is
 * against - and that block was never looked at. Live instrumentation caught it reporting
 * `nothing_ahead` 14-20 times a SECOND while the bot stood face-on to a sandstone step, failed
 * to jump, and fell through to the traveller's dig fallback - mining a step it could have
 * walked up. `nav.js` already learned this for path smoothing (`bodyClear`, r=0.32).
 */
import { AutoJump } from '../src/agent/library/auto_jump.js';
import { Vec3 } from 'vec3';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

/** A bot standing at `pos`, facing +x, on ground, with `solid` naming the solid cells. */
function fakeBot(pos, solid) {
    const key = (v) => `${v.x},${v.y},${v.z}`;
    const set = new Set(solid.map(([x, y, z]) => `${x},${y},${z}`));
    const controlState = { forward: true, jump: false, sprint: false };
    return {
        username: 'test',
        controlState,
        entity: {
            position: pos,
            velocity: new Vec3(0, 0, 0),   // pressed against the obstruction: no speed
            onGround: true,
            isInWater: false,
            yaw: -Math.PI / 2,             // -sin(yaw)=+1 -> facing +x
        },
        blockAt: (v) => (set.has(key(v))
            ? { name: 'sandstone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' }),
        setControlState: (n, v) => { controlState[n] = v; },
        on() {}, removeListener() {},
    };
}

const tick = (bot) => { const aj = new AutoJump(bot); aj._tick(); return bot.controlState.jump; };

// --- the regression: a step under the bot's SHOULDER, not its centre -------------------------
// Bot at x=10.5 facing +x. Its centre line probes column x=11 at z=10. The step is at z=11 -
// still inside the bot's 0.6-wide body, and the thing physically blocking it.
{
    const pos = new Vec3(10.5, 64, 10.72);           // body spans z 10.42..11.02
    const bot = fakeBot(pos, [[11, 64, 11]]);        // one-block step, off-centre
    check('jumps a step under the shoulder', tick(bot), true);
}

// --- straight-ahead steps still work ---------------------------------------------------------
{
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10]]);
    check('jumps a step dead ahead', tick(bot), true);
}

// --- and it must not jump at nothing ----------------------------------------------------------
{
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), []);
    check('open ground: no jump', tick(bot), false);
}

// --- a 2-high wall is not a step; jumping just bumps the bot into it ---------------------------
{
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10], [11, 65, 10]]);
    check('two-high wall: no jump', tick(bot), false);
}

// --- no headroom above the bot means a jump would only hit the ceiling -------------------------
{
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10], [10, 66, 10]]);
    check('no headroom: no jump', tick(bot), false);
}

// --- AutoJump must stand down while a deliberate jump is in flight -----------------------------
// JumpAssist asserts the ground flag and drives the arc; AutoJump's own timing logic would fight
// it for the key mid-flight.
{
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10]]);   // a real step, would normally fire
    check('a step normally fires', tick(bot), true);

    const held = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10]]);
    held.jumpAssist = { active: true };
    check('...but not while a jump is in flight', tick(held), false);
}
{
    // AND IT MUST NOT RELEASE. Pressing `jump` false here would land on the take-off tick - the
    // one tick in the whole flight that matters - and silently cancel every jump. The water bail
    // has the same shape for the same reason: clear `holding`, touch nothing else.
    const bot = fakeBot(new Vec3(10.5, 64, 10.5), [[11, 64, 10]]);
    bot.jumpAssist = { active: true };
    bot.controlState.jump = true;                 // JumpAssist is holding it
    const aj = new AutoJump(bot);
    aj.holding = 2;                               // ...and we believe we are mid-jump
    aj._tick();
    check('stands down without releasing the key', bot.controlState.jump, true);
    check('...and forgets its own hold', aj.holding, 0);
}

// --- the sweep must match nav.js's body radius, or the two disagree about what fits ------------
{
    const src = (await import('fs')).readFileSync(
        new URL('../src/agent/library/auto_jump.js', import.meta.url), 'utf8');
    check('sweeps at the same 0.32 half-width nav.js uses', /const r = 0\.32/.test(src), true);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('auto_jump: all checks passed');
