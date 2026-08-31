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
    // Every call's message array, in order - lets a test inspect exactly what the model was
    // shown on a given attempt (e.g. whether a failure-history note was injected).
    const promptMessages = [];
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
            promptCoding: async (messages) => {
                promptCalls++;
                promptMessages.push(messages);
                return '```\n' + codeFixture + '\n```';
            },
        },
    };
    const history = {
        getHistory: () => ([{ role: 'user', content: 'test intent for coder wiring' }]),
    };
    return { agent, history, calls: () => promptCalls, promptMessages };
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

/* ==========================================================================================
 * 3. Cross-invocation read-back (the KNOWN LIMITATION comment in code_guard.test.mjs): a
 *    failure recorded on one generateCode() call must inform - never gate - the NEXT one for
 *    the same intent, and a first-time intent must see nothing at all.
 * ======================================================================================== */
{
    // Isolate from whatever the earlier blocks wrote under this same agent name.
    fs.rmSync(BOTS_DIR, { recursive: true, force: true });

    const src = `await skills.wait(bot, 1);\nawait skills.stillNotReal(bot);`;
    const { agent, history, promptMessages } = makeAgent(src, ['skills.stillNotReal']);
    const coder = new Coder(agent);
    loadTemplates(coder);
    const flatten = (msgs) => msgs.map(m => m.content).join('\n');

    // First call: this exact intent has never failed before, so nothing is injected.
    await captureLogs(() => coder.generateCode(history));
    check('first-time intent: no failure-history note on the very first prompt',
        !flatten(promptMessages[0]).includes('earlier attempts at this same request failed'));

    // A second, SEPARATE generateCode() call for the same intent (same Coder instance, exactly
    // how one bot process reuses its Coder across many !newAction commands - the persisted
    // FailureLog is what makes this durable across a restart too, unlike `priorSignatures`).
    const secondCallStart = promptMessages.length;
    const { result: secondResult } = await captureLogs(() => coder.generateCode(history));
    const secondFirstPrompt = promptMessages[secondCallStart];
    check('the prior failure now surfaces, on the very first prompt of the second call',
        flatten(secondFirstPrompt).includes('earlier attempts at this same request failed'));
    check('it reads as guidance, not a refusal',
        flatten(secondFirstPrompt).includes('try a different approach'));
    // It informs, it does not block: the second call still ran generation exactly like the
    // first (same dedupe-driven early stop after 2 identical attempts), not a hard refusal.
    check('generation still ran normally on the second call (informed, not blocked)',
        typeof secondResult === 'string' && secondResult.startsWith('Code generation failed: the same failure has now happened'));
}

/* ==========================================================================================
 * 4. The injection is bounded, and ranks by repeat count rather than recency.
 * ======================================================================================== */
{
    fs.rmSync(BOTS_DIR, { recursive: true, force: true });

    const src = `await skills.wait(bot, 1);`; // succeeds - only the INJECTED note is under test
    const { agent, history, promptMessages } = makeAgent(src);
    const coder = new Coder(agent);
    loadTemplates(coder);

    const intent = 'test intent for coder wiring';
    const key = coder.learned._makeKey(intent);
    // Five distinct manufactured failures with different repeat counts - more than the cap
    // (3, see MAX_PRIOR_FAILURES_SHOWN in coder.js), so bounding has something real to cut, and
    // the most-repeated one is NOT also the most recently recorded (recorded last, below).
    for (let i = 0; i < 5; i++) {
        const times = 5 - i; // fake0 repeated 5x (most) down to fake4 repeated 1x (least)
        for (let j = 0; j < times; j++) {
            coder.failureLog.record(key, `cg:fake${i}`, `fake failure number ${i}`);
        }
    }

    await captureLogs(() => coder.generateCode(history));
    const note = promptMessages[0].find(m =>
        typeof m.content === 'string' && m.content.includes('earlier attempts at this same request failed'));
    check('a note was injected', !!note);
    const shown = note ? (note.content.match(/fake failure number \d/g) || []) : [];
    check('injection is capped at 3, not all 5 distinct failures', shown.length === 3);
    check('ranked most-repeated first: fake0 (5x) appears before fake1 (4x)',
        !!note && note.content.indexOf('fake failure number 0') < note.content.indexOf('fake failure number 1'));
    check('the least-repeated of the 5 (1x) is the one dropped',
        !!note && !note.content.includes('fake failure number 4'));
}

/* ==========================================================================================
 * 5. A corrupt or missing failure store must never block code generation (fail open).
 * ======================================================================================== */
{
    fs.rmSync(BOTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(BOTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(BOTS_DIR, 'skill_failures.json'), '{not valid json');

    const src = `await skills.wait(bot, 1);`;
    const { agent, history } = makeAgent(src);

    // FailureLog.load() runs synchronously in the constructor, so it has to be inside the
    // capture too, or the warning prints straight to the real console instead of being caught.
    let coder;
    const { result, lines } = await captureLogs(async () => {
        coder = new Coder(agent);
        loadTemplates(coder);
        return coder.generateCode(history);
    });
    check('generation still succeeds despite a corrupt failure store',
        typeof result === 'string' && result.includes('Agent wrote this code'));
    check('the corrupt store was logged rather than thrown',
        lines.some(l => l.includes('[FailureLog] Failed to load store')));
}

fs.rmSync(BOTS_DIR, { recursive: true, force: true });

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: coder.js wiring (validateGeneratedCode + failure dedupe) correct');
