import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";
import { LearnedSkills, FailureLog } from './library/learned_skills.js';
import { validateGeneratedCode, failureSignature, shouldRetry } from './library/code_guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// How many prior failures for this same intent get surfaced to the model, at most. Bounded for
// the same reason `steering.js` caps directives at 8: an unbounded list injected into every
// prompt is a token cost that grows forever, and a small model sits on the exponential-decay
// branch of instruction following anyway - more than a handful buys nothing.
const MAX_PRIOR_FAILURES_SHOWN = 3;

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';
        this.learned = new LearnedSkills(agent.name);
        // Cross-invocation half of the failure-memory gap: `priorSignatures` below only lives
        // for one generateCode() call, so nothing previously carried a failure from one
        // !newAction to the next. See learned_skills.js's FailureLog header.
        this.failureLog = new FailureLog(agent.name);

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    /**
     * Derive what the code was FOR from the most recent human/system request.
     *
     * Voyager keys its skill library on a natural-language description rather than on the
     * code, because a future query ("build me a wall") looks like the description and nothing
     * like the source. Using the triggering request keeps that property without spending an
     * extra LLM call on a 9B model that is not reliable at naming its own work.
     * @param {History} agent_history
     * @returns {string|null}
     */
    _describeIntent(agent_history) {
        const turns = agent_history.getHistory();
        for (let i = turns.length - 1; i >= 0; i--) {
            const t = turns[i];
            if (t.role !== 'user' && t.role !== 'system') continue;
            let text = String(t.content || '').trim();
            if (!text) continue;
            // skip the self-prompt scaffolding and command-output echoes
            if (text.startsWith('You are self-prompting')) continue;
            if (text.startsWith('Code Output:')) continue;
            if (text.startsWith('Agent wrote this code')) continue;
            text = text.replace(/^[^:]{1,20}:\s*/, ''); // strip "player: " prefix
            // Unwrap !newAction("...") so the stored description is the actual intent -
            // that string is what gets embedded and matched against future requests.
            const wrapped = text.match(/^!newAction\(\s*"([\s\S]*?)"\s*\)\s*$/);
            if (wrapped) text = wrapped[1].trim();
            if (text.length < 4) continue;
            return text.slice(0, 200);
        }
        return null;
    }

    async generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory();
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        // Read-back half of the failure-memory gap (docs/gaps - the KNOWN LIMITATION in
        // tests/code_guard.test.mjs): surface failures recorded against this SAME intent by an
        // EARLIER !newAction call, so a model that keeps reaching for the same invented API
        // across separate invocations finally sees that history. This INFORMS - it is fed in as
        // context on the same feedback path lint/guard errors already use, and never refuses
        // generation; see FailureLog's header for why a hard block here would be wrong (folding
        // `bot.setBlock` -> `bot.placeBlock` arrives as a DIFFERENT error and must be allowed to
        // retry). Fails open: any error here is swallowed and generation proceeds uninformed,
        // exactly as if the store were empty.
        try {
            const intent = this._describeIntent(agent_history);
            if (intent) {
                const key = this.learned._makeKey(intent);
                const priorFailures = this.failureLog.getTop(key, MAX_PRIOR_FAILURES_SHOWN);
                if (priorFailures.length) {
                    const lines = priorFailures.map((f, i) => `${i + 1}. (seen ${f.count}x before) ${f.message}`);
                    messages.push({
                        role: 'system',
                        content: 'Note: earlier attempts at this same request failed, in previous '
                            + 'action(s):\n' + lines.join('\n')
                            + '\nThese are known dead ends - do not repeat them; try a different approach.'
                    });
                }
            }
        } catch (err) {
            console.warn('[Coder] Could not read failure history:', err.message);
        }

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        // Failure memory: "have I already failed this exact way." Without this, nothing stops
        // attempt 4 from being byte-identical to attempt 2's crash - docs/gaps/playbooks.exec.md
        // task 2. Coordinates/ids are folded out by failureSignature, so the same crash at a
        // different position still counts as a repeat.
        let priorSignatures = [];
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = this._sanitizeCode(res.substring(res.indexOf('```')+3, res.lastIndexOf('```')));
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            // Static guard, before this code ever runs (docs/gaps/playbooks.exec.md task 2):
            // generated code receives the FULL bot object, so an unbounded loop, a raw chat
            // command or a listener registration reaches straight past world_guard and the
            // ALLOW_RESCUE_TP marker. validateGeneratedCode names the rule, the line, the
            // mechanism and the working alternative - feed that back exactly like a lint error
            // so the model can correct itself, rather than silently dropping the code.
            //
            // FAIL OPEN: `parsed:false` (no parser, or a shape the wrapper can't parse) still
            // reports `ok:true` - see code_guard.js's header note. Do not turn that into a
            // refusal here; a guard that blocks legitimate code it merely couldn't read is worse
            // than the status quo, same rule as `openObstruction()`.
            const guardResult = validateGeneratedCode(code);
            if (!guardResult.ok) {
                console.warn('Code guard refused:\n' + guardResult.reason);
                messages.push({
                    role: 'system',
                    content: `Error: ${guardResult.reason}\nPlease try again.`
                });
                continue;
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();

                // Verified-write gate: the code ran to completion without throwing, so it is
                // worth keeping. Anything that errored falls through to the catch below and is
                // never stored - the store only ever contains code that has actually worked.
                try {
                    const intent = this._describeIntent(agent_history);
                    if (intent) this.learned.add(intent, this._sanitizeCode(code));
                } catch (storeErr) {
                    console.warn('[Coder] Could not store learned skill:', storeErr.message);
                }

                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                // Same failure memory as above, now consulted: fold out coordinates/ids and
                // check whether this exact crash already happened. A NEW failure always retries
                // (fail open); a repeat ends the loop instead of burning the remaining attempts
                // regenerating the same dead end. This is recordFailure's first caller - it had
                // zero callers before this wiring.
                const sig = failureSignature(code, e.toString());
                const retryVerdict = shouldRetry(sig, priorSignatures);
                priorSignatures.push(sig);
                try {
                    const intent = this._describeIntent(agent_history);
                    if (intent) {
                        const key = this.learned._makeKey(intent);
                        this.learned.recordFailure(key);
                        // The read-back half: recordFailure above only affects a skill that has
                        // already succeeded once (the write gate learned_skills.js documents), so
                        // an intent that has NEVER worked - the reported incident - would
                        // otherwise leave no trace anywhere. FailureLog is keyed the same way but
                        // has no such gate; it exists purely to be read back at the top of the
                        // NEXT generateCode call for this intent.
                        this.failureLog.record(key, sig, e.toString());
                    }
                } catch (recordErr) {
                    console.warn('[Coder] Could not record learned-skill failure:', recordErr.message);
                }
                if (!retryVerdict.retry) {
                    console.warn('Code generation stopped early: ' + retryVerdict.reason);
                    return `Code generation failed: ${retryVerdict.reason}`;
                }

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        const compartment = makeCompartment({
            skills,
            log: skills.log,
            world,
            Vec3,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}