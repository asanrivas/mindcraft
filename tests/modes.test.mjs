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
check('night_safety skips Peaceful worlds', /isPeaceful\(/.test(night), true);
// ...but only AFTER the dawn dig-out, or a bot sealed in on Normal never gets let out.
check('the Peaceful check comes after the dig-out',
    night.indexOf('digOut') < night.indexOf('isPeaceful'), true);

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
    // The rules themselves - 0 is a valid difficulty, the wire form may be a string, and a later
    // `undefined` write must not erase a good value - live in difficulty.js and are covered
    // directly by tests/difficulty.test.mjs. What matters here is that agent.js uses them
    // rather than re-deriving its own version, which is how the bug survived two fixes.
    check('agent.js parses through difficultyName', /difficultyName\(packet\?\.difficulty\)/.test(agentSrc), true);
    check('...and installs the field guard', /installDifficultyField\(this\.bot\.game\)/.test(agentSrc), true);
}

// --- a failed shelter must not become a metronome ----------------------------------------------
// The mode interrupts EVERY action in the agent. A flat 20s cooldown on failure therefore
// cancelled whatever the bot was doing three times a minute, all night, on ground it could never
// shelter on (bare stone, no pickaxe, nothing to place). Nothing about the ground or the
// inventory changes while the bot stands still, so repeated identical failures are evidence.
{
    check('failures are counted', /failures:\s*0/.test(night) && /this\.failures\+\+/.test(night), true);
    check('...and it gives up for the night', /this\.gaveUp = true/.test(night), true);
    check('...and an early return means no further interruptions',
        /if \(this\.gaveUp\) return;/.test(night), true);
    check('the backoff escalates rather than repeating one interval',
        /\[20000, 60000\]/.test(night), true);
    // Both must clear at dawn, or one bad night disables the mode permanently.
    check('dawn resets the failure count', /this\.failures = 0;[\s\S]{0,60}this\.gaveUp = false;/.test(night), true);
    // ...but only in FULL DAYLIGHT. `isNight` starts at 13000 and `isDuskApproaching` 600 ticks
    // earlier, so the dusk window is both "not night" and "time to shelter" - resetting on
    // `!isNight` alone cleared the counter on every tick of the window the mode fails in.
    check('the reset requires daylight, not merely "not night"',
        /const daylight = !night\.isNight\(t\) && !night\.isDuskApproaching\(t\)/.test(night), true);
    // A success has to clear it too, or three bad nights in a row would latch.
    check('a successful shelter resets the count', /else \{\s*this\.failures = 0;/.test(night), true);
}

// --- emergencyShelter must not break ground it cannot finish -----------------------------------
// It used to call digDown and IGNORE ITS RETURN VALUE, then try to seal at y+2 - which, when the
// dig had failed, is the open air above the bot's own head. An open pit is worse than flat
// ground: the bot is cornered in it and the terrain is spent.
{
    const skillsSrc = fs.readFileSync(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const shelter = skillsSrc.slice(skillsSrc.indexOf('async function shelterFeasibility'),
                                   skillsSrc.indexOf('/** Break out of the overnight shelter at dawn. */'));
    check('feasibility is checked before any digging',
        shelter.indexOf('shelterFeasibility(bot)') < shelter.indexOf('digDown(bot, 3)'), true);
    check('digDown\'s return value is used', /const dug = await digDown/.test(shelter), true);
    check('...and the descent is MEASURED, not assumed', /descended < 2\.5/.test(shelter), true);
    // Two blocks puts the seal at the old surface level, whose neighbours are open sky on flat
    // ground - `nothing to place on`. Three puts it one block UNDER the surface, always walled.
    check('digs three so the seal has something to attach to',
        /digDown\(bot, 3\)/.test(shelter), true);
    check('...and the descent is measured after the fall settles',
        /startY - await settleY\(bot\)/.test(shelter), true);
    check('a failed seal climbs back out', /pillarUp\(bot, Math\.round\(descended\)\)/.test(shelter), true);
    check('the tool check asks whether the drop is KEPT, not just whether it is diggable',
        /tools\.canBreak/.test(shelter), true);
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

// A mode whose remedy COMPETES with the navigator's own stall ladder must not be able to
// interrupt a follow. `elbow_room` shuffles half a block away from a nearby player; during a
// follow, being near the person is the goal state, and on 2026-08-30 three interrupts in 16s
// aborted the dig that was freeing a stuck bot and then killed the follow outright. Its own
// description says "when idle" - an empty interrupt set is what makes that true.
{
    // Strip comment lines first: the block carries a write-up of the incident that QUOTES the
    // old `interrupts: ["action:followPlayer"]`, and a naive scan matches its own explanation.
    const elbow = SRC.slice(SRC.indexOf('name: "elbow_room"'), SRC.indexOf('name: "idle_staring"'))
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check('elbow_room does not interrupt anything', /interrupts: \[\]/.test(elbow), true);
    check('elbow_room specifically does not interrupt followPlayer',
        /interrupts: \[[^\]]*followPlayer/.test(elbow), false);
    // The modes that DO interrupt a follow are deliberate: followPlayer pauses them by distance
    // ("these modes slow down the bot, and we want to catch up"). That pairing must survive.
    for (const m of ['hunting', 'torch_placing'])
        check(`${m} still interrupts followPlayer`,
            new RegExp(`name: "${m}"[\\s\\S]*?interrupts: \\[[^\\]]*followPlayer`).test(SRC), true);

    // item_collecting is deliberately NOT in that list any more. It used to interrupt a follow,
    // and its own gate read `agent.isIdle() || is_very_close` - so any item within 3 blocks
    // preempted whatever Andy had been asked to do. Mining drops items constantly, which made
    // the bot interrupt itself on its own output. Both halves have to stay fixed: dropping the
    // interrupt while leaving the proximity bypass would change nothing.
    const collecting = SRC.slice(SRC.indexOf('name: "item_collecting"'))
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    check('item_collecting does not interrupt followPlayer',
        /interrupts: \[[^\]]*followPlayer/.test(collecting.slice(0, 400)), false);
    check('item_collecting still picks up while standing still',
        /interrupts: \[[^\]]*!stayHere/.test(collecting.slice(0, 400)), true);
    check('item_collecting no longer treats proximity as permission',
        /can_interrupt = agent\.isIdle\(\) \|\| is_very_close/.test(collecting), false);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('modes: all checks passed');
