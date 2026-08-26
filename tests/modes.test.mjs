/**
 * Structural guards on modes.js. No server, no bot:
 *   bun tests/modes.test.mjs
 *
 * These are regressions for two failures that both look like "the bot froze" from outside:
 *
 *   - A mode calling `execute()` without a timeout. The parameter defaults to -1, which means
 *     no timeout at all, so an action that never returns pins `currentActionLabel` and nothing
 *     can ever run again. One `self_preservation` trigger froze the agent for 11 minutes at
 *     full health. This test reads the source because there is no runtime hook to check: the
 *     bad call is indistinguishable from a good one until the day it hangs.
 *   - `drowning` must stay first in the list and must keep `action:surface` out of its
 *     interrupt set, or it and !surface trade interrupts while the bot drowns.
 */
import fs from 'fs';

const SRC = fs.readFileSync(new URL('../src/agent/modes.js', import.meta.url), 'utf8');

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- every execute() call site passes a timeout ------------------------------------------------
const untimed = [];
let calls = 0;
for (const m of SRC.matchAll(/execute\(this, agent,/g)) {
    calls++;
    const open = SRC.indexOf('(', m.index);
    let depth = 0, k = open;
    for (; k < SRC.length; k++) {
        if (SRC[k] === '(') depth++;
        else if (SRC[k] === ')' && --depth === 0) break;
    }
    const call = SRC.slice(open, k + 1).trim();
    if (!/\}\s*,\s*[\d.]+\s*\)$/.test(call)) untimed.push(SRC.slice(0, m.index).split('\n').length);
}
check('found the execute() call sites at all', calls > 5, true);
check(`every execute() has a timeout (untimed at lines ${untimed.join(', ')})`, untimed.length, 0);

// --- drowning's invariants ---------------------------------------------------------------------
const firstMode = SRC.slice(SRC.indexOf('const modes_list = [')).match(/name: "([a-z_]+)"/);
check('drowning is first in modes_list', firstMode && firstMode[1], 'drowning');

const drowning = SRC.slice(SRC.indexOf('name: "drowning"'), SRC.indexOf('name: "self_preservation"'));
check('drowning does not interrupt an in-flight !surface',
    /excludeFromInterrupt:\s*\[[^\]]*"action:surface"/.test(drowning), true);
check('drowning still requires an actual submerged head',
    /isSubmerged\(bot\)/.test(drowning), true);
check('drowning still has a cooldown after a successful surface',
    /cooldownUntil = Date\.now\(\) \+/.test(drowning), true);
// The safety net must not depend on a packet that may never arrive. `bot.oxygenLevel` comes
// from `air_supply` entity metadata, and on this server that does not reliably reach the client
// for its own entity: !stats reported "Air: 20 / 20" while the SERVER had 13 ticks left, the
// oxygen guard never tripped, and the bot drowned at (4322.60, 61.00, 5034.30) in silence.
check('drowning also fires on measured submersion time',
    /maxSubmergedMs/.test(drowning) && /submergedSince/.test(drowning), true);
check('...and that backstop is under the 15s vanilla air budget',
    Number((drowning.match(/maxSubmergedMs:\s*(\d+)/) || [])[1]) < 15000, true);
check('submersion timing resets when the head comes up',
    /if \(!submerged\) this\.submergedSince = 0;/.test(drowning), true);

// --- night_safety must not tax a Peaceful world -------------------------------------------------
const night = SRC.slice(SRC.indexOf('name: "night_safety"'), SRC.indexOf('name: "hunting"'));
check('night_safety skips Peaceful worlds', /peaceful/.test(night), true);
// ...but only AFTER the dawn dig-out, or a bot sealed in on Normal never gets let out.
check('the Peaceful check comes after the dig-out',
    night.indexOf('digOut') < night.indexOf('peaceful'), true);

// --- mode logs name the agent -------------------------------------------------------------------
check('mode completion logs are attributed to an agent',
    /Mode \$\{mode\.name\} finished executing/.test(SRC) && /\[\$\{agent\.name\}\] Mode/.test(SRC), true);

// --- unstuck must not cancel actions that manage their own stalls ---------------------------
// `unstuck` interrupts "all" and then runs its own moveAway. For an action that already detects
// a stall and recovers - travel, navTo, marathonRun - that is a second recovery on top of the
// first, and it CANCELS the action outright. Observed twice in one race: bob lost a checkpoint's
// progress each time, having been "rescued" from a stall it was already handling.
{
    const unstuck = SRC.slice(SRC.indexOf('name: "unstuck"'), SRC.indexOf('name: "cowardice"'));
    for (const a of ['action:travel', 'action:navTo', 'action:marathonRun']) {
        check(`unstuck excludes ${a}`, unstuck.includes(`"${a}"`), true);
    }
}

// --- difficulty must survive PEACEFUL being zero ------------------------------------------------
// mineflayer's game plugin assigns the field with `if (packet.difficulty)`, and peaceful is 0 -
// falsy - so on a Peaceful server `bot.game.difficulty` is never set and reads `undefined`.
// Every guard written against it then fails OPEN: night_safety decided the world was dangerous
// and dug a bot in for the night, cancelling a running marathon 12 seconds after it started.
{
    const agentSrc = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    check('agent.js repairs difficulty reporting', /_client\.on\('login', setDifficulty\)/.test(agentSrc), true);
    check('...and on later difficulty changes', /_client\.on\('difficulty', setDifficulty\)/.test(agentSrc), true);
    // The whole point is that 0 must pass, so the guard has to be a null check, not truthiness.
    check('uses a null check so peaceful (0) is accepted',
        /packet\?\.difficulty == null/.test(agentSrc), true);
}

// --- night_safety stands down when sheltering cannot pay for itself ---------------------------
// Three cases where digging in costs a whole night and buys nothing:
//   - a person is online and awake: the bot cannot skip the night alone (vanilla needs every
//     player asleep), so it just stops working while morning arrives at the same time anyway;
//   - it is already deep underground;
//   - it is already under a roof - a dungeon, a building, a shallow cave. The depth test only
//     catches >8 blocks down, so without this a bot digs a hole in the floor of a building.
{
    check('night_safety consults humanAwakeOnline', /humanAwakeOnline\(bot\)/.test(night), true);
    check('night_safety consults hasRoofOverhead', /hasRoofOverhead\(bot\)/.test(night), true);
    // Other agents must NOT count as people, or two bots each stop because the other is online.
    check('other agents do not count as people',
        /isOtherAgent\(name\)/.test(SRC), true);
    // Unknown chunks must not read as cover.
    const roof = SRC.slice(SRC.indexOf('function hasRoofOverhead'), SRC.indexOf('function humanAwakeOnline'));
    check('an unloaded chunk is not a roof', /b && b\.boundingBox === 'block'/.test(roof), true);
    // All of these must sit AFTER the dawn dig-out, or a sheltered bot never gets let out.
    check('the new guards come after the dig-out',
        night.indexOf('digOut') < night.indexOf('humanAwakeOnline'), true);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('modes: all checks passed');
