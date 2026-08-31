/**
 * Static guards for LLM-generated code. No server, no bot, no filesystem:
 *   bun tests/code_guard.test.mjs
 *
 * Written in the shape of tests/world_guard.test.mjs, for the same reason: the cases that must
 * NOT fire matter more than the ones that must. A guard that refuses legitimate code is worse
 * than the status quo - `!newAction` is the escape hatch, and an escape hatch that refuses
 * ordinary work has been removed, not fixed. So the must-NOT-fire block comes first and is the
 * larger of the two.
 *
 * The must-fire cases are replays of the recorded process deaths:
 *   - !newAction("Walk to the door and enter the igloo") generated code that took the bot
 *     process down (connection lost, watchdog re-login ~25s later).
 *   - bob's memory store accumulated six paraphrases of "non-terminating code killed at 10s".
 *   - `main(this.agent.bot)` hands generated code the FULL bot, so bot.chat('/...') routes
 *     around world_guard and the ALLOW_RESCUE_TP marker.
 */
import {
    validateGeneratedCode, findUnboundedLoops, findForbiddenAccess, findServerChat,
    chatAllowed, failureSignature, shouldRetry, parseCode, parserName,
} from '../src/agent/library/code_guard.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};
/** Convenience: does the whole validator pass this source? */
const ok = (src) => validateGeneratedCode(src).ok;
/** Which rules fired, sorted, as a comma string - so a refusal is asserted to NAME ITSELF. */
const rules = (src) => [...new Set(validateGeneratedCode(src).violations.map(v => v.rule))].sort().join(',');

// A parser must actually be present, or every case below trivially "passes" by failing open.
check('a parser is available', parserName() !== 'none', true);

/* ==========================================================================================
 * MUST NOT FIRE - legitimate generated code
 * ======================================================================================== */

// The bread and butter: a straight sequence of skill calls, top-level await, top-level return.
check('plain skill sequence', ok(`
    await skills.collectBlocks(bot, 'oak_log', 10);
    await skills.craftRecipe(bot, 'oak_planks', 4);
    if (!await skills.goToPosition(bot, 100, 64, 100)) {
        log(bot, "could not get there");
        return;
    }
    log(bot, "done");
`), true);

// A bounded loop.
check('bounded for loop', ok(`
    for (let i = 0; i < 5; i++) {
        await skills.placeBlock(bot, 'dirt', 10 + i, 64, 10);
    }
`), true);

// A conditional while with an await - not an unbounded shape at all.
check('conditional while with await', ok(`
    while (world.getNearestBlock(bot, 'stone', 16)) {
        await skills.wait(bot, 500);
    }
`), true);

// THE ONE THAT MATTERS MOST. `while (true) { ... await ... }` is a legitimate shape in this
// codebase (every poll loop in skills.js is one). It yields, so timers fire, the interrupt flag
// is observed and stop() can end it. Starvation is the rule; loop shape is not.
check('while(true) WITH an await passes', ok(`
    while (true) {
        const b = world.getNearestBlock(bot, 'diamond_ore', 32);
        if (!b) break;
        await skills.breakBlockAt(bot, b.position.x, b.position.y, b.position.z);
        await skills.wait(bot, 200);
    }
`), true);
check('for(;;) WITH an await passes', ok(`for (;;) { await skills.wait(bot, 100); if (bot.health > 15) break; }`), true);
check('do/while(true) WITH an await passes', ok(`do { await skills.wait(bot, 100); } while (true);`), true);
check('while(true) with await in a nested block passes', ok(`
    while (true) {
        if (bot.food < 20) {
            try { await skills.consume(bot, 'bread'); } catch (e) { log(bot, e.message); }
        }
    }
`), true);

// It is an AST, not a regex: the kill shape written in a string or a comment is just text.
check('"while(true)" inside a string literal passes', ok(`log(bot, "never write while(true) {} here");`), true);
check('"for(;;)" inside a comment passes', ok(`// avoid for(;;) {} in generated code\nawait skills.wait(bot, 10);`), true);
check('"/tp" inside an ordinary string passes', ok(`log(bot, "I cannot use /tp, so I will walk");`), true);

// Chat that is chat.
check('bot.chat plain speech passes', ok(`bot.chat("hello!");`), true);
check('bot.chat with an agent command passes', ok(`bot.chat("!stats");`), true);
check('bot.chat with a template of speech passes', ok('bot.chat(`I am at ${bot.entity.position}`);'), true);

// Planning is fine here and must stay allowed - CLAUDE.md: "pathfinder PLANS fine. It is the
// EXECUTOR that is broken." A guard that refused getPathTo would be refusing the working half.
check('bot.pathfinder.getPathTo passes', ok(`const p = bot.pathfinder.getPathTo(movements, goal); log(bot, p.status);`), true);
check('ordinary bot reads pass', ok(`
    const pos = bot.entity.position;
    const items = bot.inventory.items();
    log(bot, pos + " " + items.length);
`), true);
check('bot.setControlState passes', ok(`bot.setControlState('forward', true); await skills.wait(bot, 500); bot.clearControlStates();`), true);
check('bot.removeListener passes', ok(`bot.removeListener('physicsTick', fn);`), true);
// `goto`/`setGoal` are only refused ON the pathfinder. A same-named method elsewhere is not it.
check('an unrelated .goto passes', ok(`await router.goto(4, 5);`), true);

// Unknown / unparseable input FAILS OPEN. ESLint runs first and owns syntax errors; this guard
// must not become the thing that refuses everything the day its parser goes missing.
check('unparseable source fails open', ok(`this is not ) javascript {{{`), true);
check('unparseable source is marked unchecked', validateGeneratedCode(`) ( {`).parsed, false);
check('empty source fails open', ok(''), true);
check('null source fails open', ok(null), true);
check('parseCode reports why it could not parse', typeof parseCode(') ( {').error === 'string', true);
// An exotic-but-valid shape is traversed, not refused.
check('classes, generators and labels pass', ok(`
    class Helper { *gen() { yield 1; } }
    outer: for (const x of [1, 2, 3]) { if (x === 2) continue outer; await skills.wait(bot, 1); }
`), true);

/* ==========================================================================================
 * MUST FIRE - each a replay of a recorded kill path
 * ======================================================================================== */

// 1. Synchronous starvation. No timer fires, so neither the 10-minute action timeout nor
//    ActionManager.stop()'s 10s fuse can run; the socket goes unread and the SERVER drops us.
{
    const src = `while (true) { bot.setControlState('forward', true); }`;
    check('sync while(true) refused', ok(src), false);
    check('sync while(true) names the rule', rules(src), 'unbounded-loop');
    const r = validateGeneratedCode(src);
    check('refusal explains the mechanism', /starves the event loop/.test(r.reason), true);
    check('refusal says what to do instead', /skills\.wait/.test(r.reason), true);
    check('refusal carries a line number', r.violations[0].line, 1);
}
check('for(;;) {} refused', ok(`for (;;) {}`), false);
check('do/while(true) with no await refused', ok(`let i = 0; do { i++; } while (true);`), false);
// An await inside a CALLBACK is the callback's turn, not the loop's - this starves just as hard.
check('while(true) whose only await is in a nested function refused', ok(`
    while (true) {
        [1, 2, 3].forEach(async (x) => { await skills.wait(bot, x); });
    }
`), false);
// Reported at the right line even when nested deep.
{
    const v = findUnboundedLoops(parseCode(`\n\nfunction f() {\n  while (true) { x++; }\n}`).ast, { lineOffset: 1 });
    check('nested loop found', v.length, 1);
    check('nested loop line', v[0].line, 4);
}

// 2. The full-bot hole: chat commands route around world_guard AND the ALLOW_RESCUE_TP marker.
for (const src of [
    `bot.chat("/tp andy 0 64 0");`,
    `bot.chat("/setblock 1 2 3 stone");`,
    `bot.chat(" /fill 0 0 0 9 9 9 stone");`,        // a leading space is not a loophole
    `bot.chat("/give andy diamond 64");`,
    'bot.chat(`/tp andy ${x} ${y} ${z}`);',          // template with a literal prefix
    `bot.chat("/kill " + target);`,                  // concatenation with a literal left end
    `bot.whisper("bob", "/op bob");`,
]) {
    check(`server chat refused: ${src.trim().slice(0, 34)}`, ok(src), false);
    check(`server chat names the rule: ${src.trim().slice(0, 34)}`, rules(src), 'server-chat');
}
check('server chat refusal names world_guard', /world_guard/.test(validateGeneratedCode(`bot.chat("/tp a 0 0 0");`).reason), true);

// 3. Capabilities that reach past the guards or outlive the run.
for (const [label, src] of [
    ['raw packet write', `bot._client.write('position', {x: 0, y: 0, z: 0});`],
    ['listener bot.on', `bot.on('physicsTick', () => { throw new Error('boom'); });`],
    ['listener bot.once', `bot.once('spawn', () => {});`],
    ['listener bot.prependListener', `bot.prependListener('move', () => {});`],
    ['setInterval', `setInterval(() => bot.chat('hi'), 1000);`],
    ['setTimeout', `setTimeout(() => bot.chat('hi'), 1000);`],
    ['pathfinder.goto', `await bot.pathfinder.goto(new GoalBlock(1, 2, 3));`],
    ['pathfinder.setGoal', `bot.pathfinder.setGoal(goal);`],
    ['process.exit', `process.exit(1);`],
    ['eval', `eval("1+1");`],
    ['new Function', `const f = new Function("return 1");`],
    ['require', `const fs = require('fs');`],
    ['dynamic import', `const m = await import('fs');`],
]) {
    check(`forbidden: ${label}`, ok(src), false);
    check(`forbidden names the rule: ${label}`, rules(src), 'forbidden-access');
}
// The door incident's altitude: the refusal has to point at the routine that works.
check('pathfinder refusal points at the navigator',
    /navigateTo|goToPosition/.test(validateGeneratedCode(`bot.pathfinder.goto(g);`).reason), true);
// The listener refusal has to explain WHY, not just say no.
check('listener refusal explains the throw path',
    /outlives this run/.test(validateGeneratedCode(`bot.on('x', () => {});`).reason), true);

// The rules are individually testable, like isProtectedName/isTrappingBlock.
{
    const { ast, lineOffset } = parseCode(`bot._client.write('x');\nbot.chat("/tp a");\nwhile(true){}`);
    check('findForbiddenAccess in isolation', findForbiddenAccess(ast, { lineOffset }).length >= 1, true);
    check('findServerChat in isolation', findServerChat(ast, { lineOffset }).length, 1);
    check('findUnboundedLoops in isolation', findUnboundedLoops(ast, { lineOffset }).length, 1);
    check('a null ast yields no violations', findUnboundedLoops(null).length, 0);
}

// Many problems must not produce a multi-kilobyte refusal handed back to an LLM.
{
    const src = Array.from({ length: 30 }, (_, i) => `bot.chat("/tp andy ${i} 64 0");`).join('\n');
    const r = validateGeneratedCode(src);
    check('violation list capped', r.violations.length <= 8, true);
    check('truncation flagged', r.truncated, true);
}

/* ==========================================================================================
 * chatAllowed - the runtime half of the same hole (dynamic strings the AST cannot see)
 * ======================================================================================== */
for (const [msg, want] of [
    ['hello!', true],
    ['!stats', true],
    ['!inventory', true],
    ['I am going to /home now', true],      // a slash mid-message is not a command
    ['', true],
    ['   ', true],
    ['/tp andy 0 64 0', false],
    ['  /fill 0 0 0 1 1 1 stone', false],   // leading whitespace
    ['/give andy diamond', false],
    ['/', false],
]) check(`chatAllowed(${JSON.stringify(msg)})`, chatAllowed(msg).ok, want);

check('chatAllowed names the command it refused', /"\/tp"/.test(chatAllowed('/tp andy 0 64 0').reason), true);
check('chatAllowed names the bypass', /ALLOW_RESCUE_TP/.test(chatAllowed('/tp a').reason), true);
check('chatAllowed on a passing message gives no reason', chatAllowed('hello').reason, null);
// Fail open on things that are not messages at all.
check('chatAllowed(null) passes', chatAllowed(null).ok, true);
check('chatAllowed(undefined) passes', chatAllowed(undefined).ok, true);
check('chatAllowed(42) passes', chatAllowed(42).ok, true);

/* ==========================================================================================
 * Failure memory - the dedupe that stops attempt 4 from repeating attempt 2
 * ======================================================================================== */

// Same failure, different coordinates. This is the inversion of memory_store's proseTokens
// rule: there digits were the identity, here they are the noise.
{
    const a = failureSignature(`await skills.goToPosition(bot, 4321, 62, 4935);`,
        `Error: no path to (4321, 62, 4935)`);
    const b = failureSignature(`await skills.goToPosition(bot, 4288, 71, 5010);`,
        `Error: no path to (4288, 71, 5010)`);
    check('same failure at different coordinates folds', a, b);
}
{
    // Stack noise (paths, line:col, hex ids) must not split one failure into many.
    const a = failureSignature(`await skills.foo(bot);`,
        `TypeError: skills.foo is not a function\n  at file:///home/x/bots/andy/action-code/12.js:4:11`);
    const b = failureSignature(`await skills.foo(bot);`,
        `TypeError: skills.foo is not a function\n  at file:///home/x/bots/andy/action-code/37.js:9:3`);
    check('same failure with different stack noise folds', a, b);
}
{
    // MUST NOT fold: genuinely different failures. Over-folding would end the retry loop on a
    // failure the model had not actually seen before - the false-refusal shape again.
    const base = `await skills.foo(bot);`;
    const s1 = failureSignature(base, `TypeError: skills.foo is not a function`);
    const s2 = failureSignature(base, `Error: Digging aborted`);
    const s3 = failureSignature(base, `Error: no path to the target`);
    check('different errors do not fold (1 vs 2)', s1 === s2, false);
    check('different errors do not fold (2 vs 3)', s2 === s3, false);
    check('different errors do not fold (1 vs 3)', s1 === s3, false);
    // Different CODE with the same error is a new attempt worth making.
    check('different code with the same error does not fold',
        failureSignature(`await skills.bar(bot);`, `Error: Digging aborted`)
        === failureSignature(`await skills.baz(bot);`, `Error: Digging aborted`), false);
}
{
    // Comments and whitespace are not identity - the model rewording its own comment is the
    // same program failing the same way.
    const a = failureSignature(`// try the door\nawait skills.foo(bot);`, `Error: boom`);
    const b = failureSignature(`// now try the door instead\n\n    await skills.foo(bot);`, `Error: boom`);
    check('comment/whitespace churn folds', a, b);
}
check('signature is stable across calls',
    failureSignature('await x();', 'Error: y') === failureSignature('await x();', 'Error: y'), true);
check('signature carries a readable tail', /error-boom/.test(failureSignature('x();', 'Error: boom')), true);

// shouldRetry: a NEW failure always retries.
{
    const s = failureSignature('x();', 'Error: boom');
    const other = failureSignature('y();', 'Error: different');
    check('first failure retries', shouldRetry(s, []).retry, true);
    check('a different failure after one failure retries', shouldRetry(other, [s]).retry, true);
    check('a different failure after three failures retries', shouldRetry(other, [s, s, s]).retry, true);
    check('the same failure twice stops', shouldRetry(s, [s]).retry, false);
    check('stopping names the signature', shouldRetry(s, [s]).reason.includes(s), true);
    check('stopping counts the occurrences', shouldRetry(s, [s]).seen, 1);
    check('maxRepeats loosens it', shouldRetry(s, [s], 2).retry, true);
    check('maxRepeats still stops eventually', shouldRetry(s, [s, s], 2).retry, false);
    // Fail open on nonsense rather than ending the loop.
    check('missing signature retries', shouldRetry(null, [s]).retry, true);
    check('missing history retries', shouldRetry(s, null).retry, true);
    check('maxRepeats 0 is treated as 1, not as "never retry"', shouldRetry(s, []).retry, true);
    check('a passing signature gives no reason', shouldRetry(s, []).reason, null);
}

// ---------------------------------------------------------------------------
// The REAL failure corpus, and what the dedupe deliberately does NOT collapse.
//
// Captured live from andy, 2026-08-31 00:35-00:38 UTC: seventeen generated-code
// failures in a three-minute window, in two classes - invented mineflayer APIs, and
// output that never parses. They differ only by an identifier, so it is a fair question
// whether they should fold into one signature. MEASURED: they do not, and that is the
// intended behaviour, locked here so nobody "fixes" it without reading this.
//
// Folding them would mean the second attempt of a DIFFERENT invented API stops the
// loop. But `bot.setBlock` -> `bot.placeBlock` is exactly the correction we want the
// model to make, and it arrives as a different-error retry. This repo's rule is that a
// guard which blocks legitimate work is worse than the status quo, so the dedupe stays
// exact: it only stops a failure that has literally already happened and therefore
// cannot change.
//
// KNOWN LIMITATION, deliberately not fixed here: the history is per-generateCode call,
// so a model that reaches for the same nonexistent API on the NEXT !newAction starts
// with a clean slate. Cross-invocation memory is what `LearnedSkills.recordFailure`
// exists for - it now has a caller, but nothing feeds it back into generation yet.
{
    const code = "await skills.placeBlock(bot, 'stone', 1, 2, 3);";
    const invented = [
        'TypeError: bot.setBlock is not a function',
        'TypeError: bot.setBlockForced is not a function',
        'TypeError: bot.setEntityPosition is not a function',
    ];
    const unparseable = [
        "SyntaxError: Unexpected identifier 'skills'",
        "SyntaxError: Unexpected identifier 'bot'",
        "SyntaxError: Unexpected identifier 'setTimeout'",
    ];
    const sigs = [...invented, ...unparseable].map((e) => failureSignature(code, e));
    check('six real distinct failures give six distinct signatures',
        new Set(sigs).size, 6);

    // Walking the real sequence: every step is a NEW failure, so every step retries.
    const hist = [];
    let stopped = false;
    for (const sig of sigs) {
        if (!shouldRetry(sig, hist).retry) stopped = true;
        hist.push(sig);
    }
    check('a flailing sequence of DIFFERENT failures is never cut short', stopped, false);

    // The control that makes the above safe: a genuine repeat still stops at once.
    const repeat = failureSignature(code, invented[0]);
    check('but repeating ONE of them still stops', shouldRetry(repeat, [repeat]).retry, false);

    // Same error text, different code, must stay distinct - the model rewrote the body.
    check('same error from different code stays distinct',
        failureSignature('await skills.wait(bot, 10);', invented[0]) === repeat, false);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: generated-code guards correct');
