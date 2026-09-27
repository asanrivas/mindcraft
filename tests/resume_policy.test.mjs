/**
 * What the agent is told when it reconnects:
 *   bun tests/resume_policy.test.mjs
 *
 * Reported as "after a restart Andy still does the past task even though I asked it to stop
 * before restarting". The old `settings.init_message` asked the MODEL whether a task was
 * outstanding, and pointed it at `$MEMORY` - a blob of location notes like
 * `Forest target: 4140,111,5132`. A small model told to find an unfinished task in that will
 * always find one, and a person's "stop" had no way to be heard at all.
 */
import { isStandDown, hasLiveTask, standDownIsCurrent, reconnectDirective }
    from '../src/agent/resume_policy.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};
const has = (label, text, needle) => check(label, text.includes(needle), true);

// --- recognising a stand-down -------------------------------------------------------------------
for (const t of ['stop', 'Stop!', '!stop', '!endGoal', '!stfu', 'stop following me',
                 'halt', 'cancel that', 'stand down', 'forget it', 'nevermind',
                 "that's enough", 'quit digging'])
    check(`stand-down: ${t}`, isStandDown(t), true);

// A false positive silently drops work the user still wants, so ordinary instructions must not
// match. "stop" inside a longer word is the classic way that happens.
for (const t of ['go mine some iron', 'follow me', 'build a stopwatch shaped house',
                 'come here', 'what are you doing', '', null, undefined])
    check(`not a stand-down: ${JSON.stringify(t)}`, isStandDown(t), false);

// A message that ISSUES a command is an instruction, whatever words it contains. Without this
// rule the very message that creates a task also cancels it - caught live, with a test goal
// that happened to read "count to ten out loud and stop".
check('!goal whose text contains "stop" is NOT a stand-down',
    isStandDown('!goal("count to ten out loud and stop")'), false);
check('an instruction mentioning stopping is not a stand-down',
    isStandDown('!travel("west", 50) then stop'), false);
// ...but an explicit stand-down command still outranks the rest of the line.
check('!stop alongside other text is still a stand-down',
    isStandDown('ok !stop for now'), true);
check('!endGoal is a stand-down even with a command in the line',
    isStandDown('!endGoal'), true);

// --- a live task is a RECORD, never an inference ------------------------------------------------
check('a goal record is a task', hasLiveTask({ goal: 'mine iron' }), true);
check('a running self-prompt is a task', hasLiveTask({ selfPrompt: 'get a pickaxe' }), true);
check('neither is not a task', hasLiveTask({}), false);
check('whitespace is not a task', hasLiveTask({ goal: '   ' }), false);

// --- the last message wins, but only while it IS the last ---------------------------------------
{
    const stop = { from: 'asanrivas', text: 'stop', at: 1000 };
    check('a stand-down with no goal at all stands',
        standDownIsCurrent({ lastDirective: stop }), true);
    check('a stand-down newer than the goal stands',
        standDownIsCurrent({ lastDirective: stop, goalUpdated: 500 }), true);
    // "Prioritise the last message" means the LAST one, not the last stand-down: someone who
    // says "stop", then "now go mine", then restarts must come back to the mining.
    check('a goal set AFTER the stand-down wins',
        standDownIsCurrent({ lastDirective: stop, goalUpdated: 2000 }), false);
    check('an ordinary message is not a stand-down at any time',
        standDownIsCurrent({ lastDirective: { text: 'go mine', at: 9000 }, goalUpdated: 1 }), false);
}

// --- the message handed to the model ------------------------------------------------------------
{
    const d = reconnectDirective({
        goal: 'mine iron below the base',
        lastDirective: { from: 'asanrivas', text: 'stop', at: 5000 },
        goalUpdated: 1000,
    });
    has('a stand-down forbids resuming', d, 'Do NOT resume');
    has('...and quotes the person back to themselves', d, '"stop"');
    has('...and names them', d, 'asanrivas');
    check('...and does not hand over the goal to resume', d.includes('!goal('), false);
}
{
    const d = reconnectDirective({ goal: 'mine iron below the base' });
    has('a real goal is quoted verbatim', d, '"mine iron below the base"');
    // The whole bug: the model reconstructing a task from ambient memory.
    has('...with memory explicitly ruled out as a source', d, 'do not invent a different task');
    // MUST NOT tell the model to !goal(...). For a user-authored goal that command is refused
    // ("Kept the existing goal") and the refusal never reaches self_prompter.start - so the
    // instruction is guaranteed to fail in exactly the case where resuming matters most. The
    // agent restarts the loop itself.
    check('does not ask the model to re-issue !goal', d.includes('!goal('), false);
    has('...it says the loop is already running', d, 'resumed for you');
}
{
    const d = reconnectDirective({});
    has('no task: says so plainly', d, 'NO active task');
    has('...and tells it memory is not a to-do list', d, 'not a list of work');
    check('...and offers nothing to resume', d.includes('!goal('), false);
}
{
    // A self-prompt loop with no goal record is still a real, live task.
    const d = reconnectDirective({ selfPrompt: 'get a stone pickaxe' });
    has('a live self-prompt is resumed', d, '"get a stone pickaxe"');
    check('...also without asking for !goal', d.includes('!goal('), false);
}

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('resume_policy: all checks passed');
