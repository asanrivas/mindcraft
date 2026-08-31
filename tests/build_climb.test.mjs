/**
 * The climbing primitives must not pillar or tunnel through the build:
 *   bun tests/build_climb.test.mjs
 *
 * `build_guard` covered the planner, `nav.digAhead` and `nav.bridgeAhead`. It did NOT cover
 * `climbShaftUp` (breaks the block above its head, places one under its feet) or
 * `climbLedgeByPlacing` (pillars), so both could still leave a cobblestone spike standing in a
 * room the blueprint owns, or mine straight through a finished wall - the same litter as the
 * measured `bridge: laid dirt at (4716, 67, 4614)`, from a different rung of the same ladder.
 *
 * The half that matters most here is LAYER 3, the relent. A refusal that cannot be relented
 * seals the bot inside its own house: the better the builder gets at walls, the more reliably
 * it entombs itself. And the relent has to be measured with `trappedByBuild`, never `enclosed`
 * - `enclosed` is true of any bot standing in a room, so a valve gated on it can only fire in a
 * literal one-cell pocket, which is exactly the state a finished building never produces. That
 * mistake made the guard decorative once already.
 */
import { buildGate } from '../src/agent/library/skills.js';
import { protectBuild, clearProtectedBuild, isProtecting } from '../src/agent/library/build_guard.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

const lines = [];
const realLog = console.log;
console.log = (...a) => { lines.push(a.join(' ')); };
const drain = () => { const l = lines.join('\n'); lines.length = 0; return l; };

const bot = { username: 'andy' };

// --- NO BUILD REGISTERED: a complete no-op -----------------------------------------------------
// This is the state the bot is in almost all of the time, so the gate must cost nothing and must
// not touch the bot, the world, or the (expensive) trapped measurement. The bot below throws if
// anything reads it, and `neverCalled` fails the suite if the flood fill is even attempted.
clearProtectedBuild();
let measured = 0;
const neverCalled = () => { measured++; return false; };
const trapBot = new Proxy({}, { get() { throw new Error('the gate touched the bot with no build registered'); } });
{
    const gate = buildGate(trapBot, 'shaftUp', neverCalled);
    check('nothing registered: every cell is allowed', gate(10, 20, 30), true);
    check('nothing registered: still allowed elsewhere', gate(-4, 0, 900), true);
    check('nothing registered: the trapped measure is never taken', measured, 0);
    check('nothing registered: nothing is logged', drain(), '');
}

// --- A BUILD IS REGISTERED ----------------------------------------------------------------------
protectBuild([
    { x: 100, y: 64, z: 100 },
    { x: 100, y: 65, z: 100 },
    { x: 101, y: 64, z: 100 },
]);
check('the guard is live', isProtecting(), true);

// Cells the build does not own are untouched by any of this.
{
    measured = 0;
    const gate = buildGate(bot, 'shaftUp', neverCalled);
    check('a cell outside the build is allowed', gate(200, 64, 200), true);
    check('a neighbour of the build is allowed', gate(102, 64, 100), true);
    check('an unprotected cell never pays for the flood fill', measured, 0);
    check('an unprotected cell logs nothing', drain(), '');
}

// LAYER 2: refuse. Not trapped, so there is somewhere else to climb - go round.
{
    measured = 0;
    const gate = buildGate(bot, 'shaftUp', () => { measured++; return false; });
    check('a protected cell is refused', gate(100, 64, 100), false);
    const out = drain();
    check('the refusal names itself', /refusing \(100, 64, 100\)/.test(out), true);
    check('the refusal says why', /belongs to the build/.test(out), true);
    // Memoised: the flood fill is not free and a tower revisits the same few cells many times.
    check('a second protected cell is also refused', gate(100, 65, 100), false);
    check('the trapped measure is taken at most once per gate', measured, 1);
    drain();
}

// LAYER 3: relent. Sealed in by the build, digging out beats standing still until the watchdog
// kills the process - the builder repairs whatever is removed.
{
    const gate = buildGate(bot, 'ledgeClimb', () => true);
    check('a trapped bot may breach the build', gate(100, 64, 100), true);
    const out = drain();
    // BREACHING MUST NEVER BE SILENT. Doing it quietly is why the original bug hid so long.
    check('the breach is logged', /breaching the build at \(100, 64, 100\)/.test(out), true);
    check('the breach says it was a relent', /walled in/.test(out), true);
    check('the breach carries the caller label', /ledgeClimb/.test(out), true);
}

// The two callers are distinguishable in the log - one places under its feet, the other pillars,
// and a shared prefix would make a live log impossible to attribute.
{
    const gate = buildGate(bot, 'shaftUp', () => false);
    gate(100, 64, 100);
    check('the label identifies the caller', /shaftUp/.test(drain()), true);
}

// --- STANDING DOWN --------------------------------------------------------------------------
// `clearProtectedBuild` MUST run in the builder's `finally`, or the next task inherits a build
// that ended. Assert the gate really does go inert again.
clearProtectedBuild();
{
    measured = 0;
    const gate = buildGate(trapBot, 'shaftUp', neverCalled);
    check('after the build ends the cell is allowed again', gate(100, 64, 100), true);
    check('after the build ends nothing is measured', measured, 0);
    drain();
}

console.log = realLog;
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('build_climb: the climbing primitives respect the build, and relent when trapped');
