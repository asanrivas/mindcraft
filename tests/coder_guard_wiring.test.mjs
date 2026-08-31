/**
 * Wiring test for docs/gaps/playbooks.exec.md task 2: code_guard.js's `validateGeneratedCode`
 * and the failureSignature/shouldRetry dedupe were pure and had ZERO callers. This drives the
 * real `Coder.generateCode` loop end to end with a fake prompter/bot (no server, no network,
 * no live bot process) and asserts the wiring actually fires:
 *
 *   1. A model that only ever emits a starvation shape (`for (;;) {}`, no await in the loop
 *      body) never reaches `executionModule.main` - the guard refuses it every attempt, the
 *      refusal reason (naming the rule) is fed back as a system message, and the loop runs out
 *      its full attempt budget rather than hanging or silently dropping the code.
 *   2. A model that repeats one crashing program stops after 2 identical failures, not 5 -
 *      `failureSignature` + `shouldRetry` end the loop early, and `LearnedSkills.recordFailure`
 *      (previously zero callers) actually increments the matching stored skill's failure count.
 *
 * Run: bun tests/coder_guard_wiring.test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Coder } from '../src/agent/coder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAME = '__coder_wiring_test__';
const BOTS_DIR = path.join(__dirname, '..', 'bots', NAME);

let failures = 0;
const check = (label, cond) => { if (!cond) { console.error(`FAIL: ${label}`); failures++; } };

fs.rmSync(BOTS_DIR, { recursive: true, force: true });

/** Captures console.log/console.warn output for the duration of one call. */
async function captureLogs(fn) {
    const lines = [];
    const origLog = console.log, origWarn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        console.log = origLog;
        console.warn = origWarn;
    }
}

/** A fake prompter whose promptCoding always returns the same canned code block. */
function makeAgent(codeFixture, extraDocs = []) {
    let promptCalls = 0;
    const agent = {
        name: NAME,
        bot: {
            interrupt_code: false,
            modes: { pause: () => {} },
        },
        actions: {
            getBotOutputSummary: () => '(no output)',
        },
        prompter: {
            skill_libary: {
                getAllSkillDocs: async () => ['skills.wait', ...extraDocs],
            },
            promptCoding: async () => {
                promptCalls++;
                return '```\n' + codeFixture + '\n```';
            },
        },
    };
    const history = {
        getHistory: () => ([{ role: 'user', content: 'test intent for coder wiring' }]),
    };
    return { agent, history, calls: () => promptCalls };
}

function loadTemplates(coder) {
    // Bypass the constructor's async readFile race - load synchronously so the first
    // generateCode() call in the test does not depend on callback timing.
    coder.code_template = fs.readFileSync(path.join(__dirname, '..', 'bots', 'execTemplate.js'), 'utf8');
    coder.code_lint_template = fs.readFileSync(path.join(__dirname, '..', 'bots', 'lintTemplate.js'), 'utf8');
}

/* ==========================================================================================
 * 1. Starvation shape: refused every attempt, never executed, reason fed back.
 * ======================================================================================== */
{
    // An await earlier in the function keeps ESLint's require-await happy so the code reaches
    // the guard; the loop body itself has no await, which is the actual kill shape.
    const src = `await skills.wait(bot, 1);\nfor (;;) { bot.setControlState('forward', true); }`;
    const { agent, history, calls } = makeAgent(src);
    const coder = new Coder(agent);
    loadTemplates(coder);

    const { result, lines } = await captureLogs(() => coder.generateCode(history));

    check('exhausts all attempts rather than hanging or silently dropping the code',
        result === 'Code generation failed after 5 attempts.');
    check('prompter was asked every attempt', calls() === 5);
    check('the guard actually refused it (named in the log)',
        lines.some(l => l.includes('Code guard refused')));
    check('the refusal names the rule', lines.some(l => l.includes('unbounded-loop')));
    check('the refusal explains the starvation mechanism',
        lines.some(l => l.includes('starves the event loop')));
    check('generated code was never executed', !lines.some(l => l.includes('Executing code')));
}

/* ==========================================================================================
 * 2. Identical crash, twice: the retry loop stops early and recordFailure gets its call.
 * ======================================================================================== */
{
    // "skills.nonexistentZZZ" is declared to the (fake) lint doc list so it passes linting, but
    // does not exist on the real skills module the sandbox is given - so it throws at runtime,
    // deterministically, on every attempt. That is the shape this dedupe exists for.
    const src = `await skills.wait(bot, 1);\nawait skills.nonexistentZZZ(bot);`;
    const { agent, history, calls } = makeAgent(src, ['skills.nonexistentZZZ']);
    const coder = new Coder(agent);
    loadTemplates(coder);

    // Pre-seed a matching learned skill so recordFailure's effect is observable, not just its
    // call - this is the "stored skill that then throws has failures incremented" property.
    const intent = 'test intent for coder wiring';
    const key = coder.learned.add(intent, 'dummy code');
    check('learned skill starts with zero failures', coder.learned.skills[key].failures === 0);

    const { result, lines } = await captureLogs(() => coder.generateCode(history));

    check('stops after 2 identical failures, not 5', calls() === 2);
    check('reports the early stop, not attempt exhaustion',
        typeof result === 'string' && result.startsWith('Code generation failed: the same failure has now happened'));
    check('the stop names a signature', /Signature: cg:/.test(result));
    check('recordFailure actually fired (log line present)',
        lines.some(l => l.includes('Generated code threw error')));
    check('recordFailure incremented the matching learned skill',
        coder.learned.skills[key].failures >= 1);
}

fs.rmSync(BOTS_DIR, { recursive: true, force: true });

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: coder.js wiring (validateGeneratedCode + failure dedupe) correct');
