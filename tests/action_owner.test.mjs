/**
 * Who owns the running action. No server, no bot:
 *   bun tests/action_owner.test.mjs
 *
 * The regression: a long action a PERSON started was cancelled by the model's own next turn.
 * Observed live - a user typed !marathonRun, and six seconds later the model emitted
 * `!travel("west", 500)` from a stale conversational thread. The travel command interrupted
 * the marathon, and the run silently became a walk in the opposite direction, with nothing in
 * the log naming what had been cancelled.
 *
 * The guard is `actions.isUserOwned()`, and its two failure modes are equally bad:
 *   - forgetting to set the author, so nothing is ever protected;
 *   - leaking the author, so a MODE action inherits "user" and safety becomes uninterruptible.
 */
import { ActionManager } from '../src/agent/action_manager.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

function fakeAgent() {
    const listeners = {};
    const agent = {
        command_author: null,
        bot: {
            interrupt_code: false,
            output: '',
            emit(ev) { (listeners[ev] || []).forEach(f => f()); },
            on(ev, f) { (listeners[ev] ||= []).push(f); },
        },
        requestInterrupt() { agent.bot.interrupt_code = true; },
        cleanKill() { throw new Error('cleanKill should not fire in these tests'); },
        // Must match the real Agent: it clears interrupt_code too. Without that, every
        // action started after an interrupt reads as "interrupted" itself and keeps resume
        // state it should have dropped.
        clearBotLogs() { agent.bot.output = ''; agent.bot.interrupt_code = false; },
        isIdle: () => true,
        self_prompter: { isActive: () => false },
    };
    return agent;
}

const idle = () => new Promise(r => setTimeout(r, 0));

// --- a user-issued action is user-owned while it runs -------------------------------------------
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);
    check('nothing running is not user-owned', am.isUserOwned(), false);

    let release;
    const held = new Promise(r => { release = r; });
    agent.command_author = 'user';
    const running = am.runAction('action:marathonRun', async () => { await held; return 'done'; },
                                 { timeout: -1, resume: true });
    await idle();
    check('a user action is user-owned while running', am.isUserOwned(), true);
    check('the label is recorded', am.currentActionLabel, 'action:marathonRun');
    release();
    await running;
    check('ownership is released when it finishes', am.isUserOwned(), false);
    check('the author is cleared', am.action_author, null);
}

// --- a model-issued action is NOT protected ------------------------------------------------------
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);
    let release;
    const held = new Promise(r => { release = r; });
    agent.command_author = 'model';
    const running = am.runAction('action:travel', async () => { await held; }, { timeout: -1 });
    await idle();
    check('a model action is not user-owned', am.isUserOwned(), false);
    release();
    await running;
}

// --- a MODE action must never inherit the last command's author ---------------------------------
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);
    // The user issued something a moment ago, so command_author is still 'user'...
    agent.command_author = 'user';
    let release;
    const held = new Promise(r => { release = r; });
    // ...but the mode passes its own author, exactly as modes.js execute() does.
    const running = am.runAction('mode:drowning', async () => { await held; },
                                 { timeout: -1, author: 'mode' });
    await idle();
    check('a mode action is not user-owned', am.isUserOwned(), false);
    check('the mode author is recorded as such', am.action_author, 'mode');
    release();
    await running;
}

// --- a resumed leg keeps the original author ----------------------------------------------------
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);
    agent.command_author = 'user';
    // An interrupted resume action keeps its resume_func, so the idle handler can replay it.
    // The interrupt has to land WHILE the action runs: _executeAction calls clearBotLogs()
    // right after stop(), which resets interrupt_code, so a flag set beforehand is gone by the
    // time the completion path reads it. (Setting it early passed only against a fake that
    // did not clear it - the real Agent does.)
    await am.runAction('action:marathonRun', async () => { agent.bot.interrupt_code = true; },
                       { timeout: -1, resume: true });
    agent.bot.interrupt_code = false;
    check('the resume survives the interrupt', typeof am.resume_func, 'function');
    check('and remembers who asked', am.resume_author, 'user');

    // The idle handler calls resumeAction() with NO arguments and no command_author context.
    agent.command_author = 'model';
    let release;
    const held = new Promise(r => { release = r; });
    am.resume_func = async () => { await held; };
    const running = am.resumeAction();
    await idle();
    check('the replayed leg is still the user\'s', am.isUserOwned(), true);
    release();
    await running;
}

// --- the guard is actually wired into agent.js --------------------------------------------------
{
    const src = await (await import('fs')).promises.readFile(
        new URL('../src/agent/agent.js', import.meta.url), 'utf8');
    check('agent.js consults isUserOwned before running a model command',
        /takesOverBot\(command_name\) && this\.actions\.isUserOwned\(\)/.test(src), true);
    check('and it sits BEFORE the model command is executed',
        src.indexOf('isUserOwned()') < src.indexOf("this.command_author = 'model'"), true);
    const modes = await (await import('fs')).promises.readFile(
        new URL('../src/agent/modes.js', import.meta.url), 'utf8');
    check('modes declare themselves as mode-authored', /author: 'mode'/.test(modes), true);
}

// --- the guard blocks only commands that TAKE THE BOT OVER -------------------------------------
// It first used `isAction`, which is "is it in the action list" - and that includes read-only
// commands. The model asked !marathonStatus to find out what was happening and was told it
// could not, which is the opposite of the point: the guard exists to stop the model CANCELLING
// a user's work, not to stop it looking.
{
    const { takesOverBot } = await import('../src/agent/commands/index.js');
    check('!marathonRun takes the bot over', takesOverBot('!marathonRun'), true);
    check('!travel takes the bot over', takesOverBot('!travel'), true);
    check('!marathonStatus does not', takesOverBot('!marathonStatus'), false);
    check('!marathonPlan does not', takesOverBot('!marathonPlan'), false);
    check('a query does not', takesOverBot('!stats'), false);
    check('an unknown command does not', takesOverBot('!nonsense'), false);
}


// --- a mode must not cancel the resume of the action it interrupted ----------------------------
// The regression: `mode:torch_placing` lists `action:followPlayer` in its `interrupts`, so it
// stops the follow, places one torch, and completes CLEANLY. The clean-completion branch of
// _executeAction then called cancelResume() unconditionally - wiping the resume state that
// belonged to followPlayer, not to the mode. The follow therefore ENDED rather than pausing,
// and the model was handed an "(AUTO MESSAGE) your previous action was interrupted" to guess
// from. Observed every ~5s in daylight until the user gave up.
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);

    let release;
    const held = new Promise(r => { release = r; });
    agent.command_author = 'user';
    const follow = am.runAction('action:followPlayer', async () => { await held; },
                                { timeout: -1, resume: true });
    await idle();
    check('follow registered a resume', am.resume_name, 'action:followPlayer');

    // The mode interrupts. runAction -> stop() -> requestInterrupt sets interrupt_code, which
    // is followPlayer's own loop condition, so the follow returns.
    const mode = am.runAction('mode:torch_placing', async () => 'placed',
                              { timeout: -1, author: 'mode' });
    release();
    await follow;
    await mode;

    check('the mode left follow\'s resume intact', am.resume_name, 'action:followPlayer');
    check('the resume function survived', typeof am.resume_func, 'function');
    check('the resume is still the user\'s', am.resume_author, 'user');
}

// --- ...but an action DOES clear its own resume on clean completion ----------------------------
// The opposite failure, and the reason the unconditional cancel existed: a finished action that
// leaves resume state behind is re-run by the idle handler on every tick. A `!navTo` to the
// bot's own position re-ran every second for hours.
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);
    agent.command_author = 'user';
    await am.runAction('action:navTo', async () => 'arrived', { timeout: -1, resume: true });
    check('a completed action clears its own resume', am.resume_func, null);
}

// --- a non-mode action replacing another still clears the resume -------------------------------
// A new user or model command is a change of intent, not a transient interruption.
{
    const agent = fakeAgent();
    const am = new ActionManager(agent);

    let release;
    const held = new Promise(r => { release = r; });
    agent.command_author = 'user';
    const follow = am.runAction('action:followPlayer', async () => { await held; },
                                { timeout: -1, resume: true });
    await idle();
    const other = am.runAction('action:travel', async () => 'went', { timeout: -1 });
    release();
    await follow;
    await other;
    check('a new command clears the old resume', am.resume_func, null);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('action ownership: all checks passed');
