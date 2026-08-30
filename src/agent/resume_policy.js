/**
 * What to tell the agent when it reconnects.
 *
 * Reported as *"after a restart Andy still does the past task even though I asked it to stop
 * before restarting"*. The cause is `settings.init_message`, which said, on every single
 * reconnect:
 *
 *   "Check your MEMORY for an unfinished task: if there is one, resume it right now with
 *    !goal(\"<the task>\") instead of greeting."
 *
 * That asks the MODEL to decide whether a task is outstanding, from `$MEMORY` - a summarised
 * blob full of lines like `Forest target: 4140,111,5132` and `Target dry spot: 4465,62,4685`.
 * A small model told to find an unfinished task in that will always find one. It is the same
 * failure the summariser had (see "Memory summarisation must not mint goals" in CLAUDE.md),
 * arriving through a different door: nothing was *stored* as a goal, one was **invented** from
 * ambient memory, and a person's "stop" a minute earlier had no way to be heard.
 *
 * So the decision is made from STATE here, and handed to the model already made.
 */

/**
 * Did a person just tell the bot to stand down?
 *
 * Deliberately a short, exact-ish list rather than anything clever. A false positive silently
 * drops a task the user still wanted; a false negative merely leaves the old behaviour, which
 * the goal/self-prompt state below usually catches anyway. Matching is on whole words, because
 * "stop" appears inside "stopwatch" and - more to the point here - inside every sentence about
 * a bot that has stopped.
 */
const STAND_DOWN_COMMANDS = /!(stop|endgoal|stfu|stay)\b/i;
const STAND_DOWN_PROSE = [
    /\bstop\b/i, /\bhalt\b/i, /\bcancel\b/i, /\bstand down\b/i,
    /\bforget it\b/i, /\bnever ?mind\b/i, /\bthat'?s enough\b/i, /\bquit\b/i,
];
/** Any command at all, so an instruction can be told apart from a remark. */
const ANY_COMMAND = /!\w+/;

export function isStandDown(text) {
    if (!text || typeof text !== 'string') return false;
    // An explicit stand-down command is unambiguous and outranks everything else in the line.
    if (STAND_DOWN_COMMANDS.test(text)) return true;
    // A message that ISSUES A COMMAND is an instruction, whatever words it happens to contain.
    // Without this, `!goal("count to ten out loud and stop")` reads as a stand-down - the very
    // message that creates the task cancels it. The prose list can only ever be a heuristic, so
    // keep it away from anything the user made explicit.
    if (ANY_COMMAND.test(text)) return false;
    return STAND_DOWN_PROSE.some(re => re.test(text));
}

/**
 * Is there a real, live task to come back to?
 *
 * A GOAL RECORD or a running self-prompt loop - nothing else. Not "something in memory that
 * looks like a task": that is exactly the inference that produced the bug.
 */
export function hasLiveTask({ goal, selfPrompt }) {
    return !!(goal && String(goal).trim()) || !!(selfPrompt && String(selfPrompt).trim());
}

/**
 * The message to hand the model on reconnect.
 *
 * THE LAST THING A PERSON SAID WINS. If they stood the bot down, the reconnect says so
 * explicitly and forbids resuming - a stored goal outliving a spoken "stop" is precisely the
 * complaint. Without a stand-down, a real goal is quoted back verbatim so the model resumes
 * *that* rather than reconstructing something from memory. With no task at all, it is told
 * plainly that there is none, because silence on the point is what let it guess.
 *
 * Pure, so every branch is testable: a live check only ever exercises whichever state the bot
 * happens to have restarted in.
 */
/**
 * Was the stand-down the LAST word, or has the user asked for something since?
 *
 * "Prioritise the last message" has to mean the last one, not the last stand-down. A user who
 * says "stop", then "ok now go mine" and then restarts must come back to the mining - so the
 * stand-down only counts while nothing newer has overwritten it. Timestamps decide, and a goal
 * with no timestamp is treated as older, because the failure we are fixing is a stale goal
 * outliving a fresh "stop".
 */
export function standDownIsCurrent({ lastDirective, goalUpdated = null }) {
    if (!lastDirective || !isStandDown(lastDirective.text)) return false;
    if (goalUpdated == null) return true;
    return (lastDirective.at ?? 0) >= goalUpdated;
}

export function reconnectDirective({ goal = null, selfPrompt = null, lastDirective = null,
                                     goalUpdated = null } = {}) {
    const task = (goal && String(goal).trim()) || (selfPrompt && String(selfPrompt).trim()) || null;
    const said = lastDirective && lastDirective.text ? String(lastDirective.text).trim() : null;
    const who = lastDirective && lastDirective.from ? String(lastDirective.from) : 'someone';

    if (said && standDownIsCurrent({ lastDirective, goalUpdated })) {
        return `You just reconnected. Before the restart, ${who} told you: "${said}". `
            + `That still stands. Do NOT resume or restart any earlier task, and do not set a `
            + `goal. Greet briefly with your name and wait to be asked for something.`;
    }
    if (task) {
        // DO NOT tell the model to `!goal(...)`. For a user-authored goal that command is
        // refused - `Kept the existing goal: ... ` - and the refusal never reaches
        // `self_prompter.start`, so the instruction is guaranteed to fail in precisely the case
        // where resuming matters most. The agent restarts the loop itself (see agent.js); this
        // only has to say what the task is, so the first turn is about the work rather than
        // about reconnecting.
        return `You just reconnected and your unfinished task has been resumed for you: `
            + `"${task}". Carry on with exactly that - do not greet, do not set a goal, and do `
            + `not invent a different task from your memory.`;
    }
    return `You just reconnected. You have NO active task and no goal. `
        + `Do not start one, and do not treat anything in your memory as an outstanding job - `
        + `memory is a record of where things are, not a list of work. `
        + `Greet briefly with your name and wait to be asked for something.`;
}
