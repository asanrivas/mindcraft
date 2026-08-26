import assert from 'assert';
import { getBudget } from '../utils/context_budget.js';

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        // Who asked for the action currently running: 'user', 'model' or 'mode'. A long action
        // a person started must not be cancelled by the model's next turn - see isUserOwned().
        this.action_author = null;
        this.resume_author = null;
        this.last_action_time = 0;
        this.recent_action_counter = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false, author = null } = {}) {
        // Fall back to the author of the command being handled right now. Modes pass 'mode'
        // explicitly, because command_author still holds whoever issued the LAST command and
        // would otherwise make a safety interrupt look user-initiated.
        const who = author ?? this.agent.command_author ?? null;
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout, who);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout, who);
        }
    }

    /**
     * Is a person waiting on the action that is running right now?
     *
     * The model gets its own turn while a long action is in flight, and any action command in
     * that turn cancels it. Observed live: a user-issued marathon was killed six seconds in by
     * `!travel("west", 500)` from a stale conversational thread, and the run silently became a
     * walk in the opposite direction. Modes are deliberately NOT covered - drowning and
     * self-defence must still interrupt anything.
     */
    isUserOwned() {
        return this.executing && this.action_author === 'user';
    }

    async stop() {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
        this.resume_author = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10, author = null) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
            // Remember who asked, so a resumed leg is still theirs. `resumeAction()` is called
            // from the idle handler with no author at all.
            this.resume_author = author;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout, this.resume_author);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10, author = null) {
        let TIMEOUT;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            this.action_author = author;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action, keeping whatever it returns. Skills return machine-checkable
            // outcomes (e.g. fill() returns the number of blocks actually placed); these used
            // to be discarded, leaving the model with only free-text log prose to judge
            // success by - the direct enabler of hallucinated task completion.
            const result = await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.action_author = null;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // Clean completion must not leave resume state behind. The idle handler
            // re-runs the stored resume action on every idle tick, so a stale,
            // already-finished action gets re-executed forever (observed: a `!navTo`
            // to the bot's own position re-ran every second for hours, hammering the
            // LLM and filling GPU VRAM). Interrupted/timed-out actions keep their
            // resume state so the intended resume-after-disruption still works.
            //
            // BUT THE RESUME BELONGS TO WHOEVER REGISTERED IT, and a mode is a transient
            // interruption rather than a new intent - that is the entire reason `resume`
            // exists. Cancelling it here unconditionally meant a mode's own clean completion
            // wiped the resume state of the action it had just interrupted. Observed live:
            // `mode:torch_placing` interrupts `action:followPlayer` (it lists it in
            // `interrupts`), places one torch, completes cleanly, and clears follow's resume
            // - so the follow ENDED instead of pausing. `should_reprompt` then fired an
            // "(AUTO MESSAGE) your previous action was interrupted" at the model, which
            // guessed its way through !goToPlayer / !navTo / !entities / !lookAtPlayer
            // instead. From the user's side the bot simply stopped following, every ~5s,
            // in daylight, forever.
            const ownsResume = this.resume_name === actionLabel;
            if (!interrupted && !timedout && (ownsResume || author !== 'mode')) {
                this.cancelResume();
            }

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, result, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.action_author = null;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            // Same rule as the clean-completion path above: a mode that throws must not take
            // the interrupted action's resume down with it. `torch_placing` calling
            // `placeBlock` into an occupied cell throws routinely.
            if (this.resume_name === actionLabel || author !== 'mode') this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = getBudget().action_output_chars;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}