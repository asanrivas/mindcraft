/**
 * Static guards for LLM-generated code, before it is evaluated.
 *
 * This is the `world_guard.js` of `!newAction`. Same posture, same reasons:
 *
 *   - Every refusal NAMES ITSELF (rule + line + what to do instead), so an override or a
 *     retry is never silent and the model is told precisely what to change.
 *   - UNKNOWN CONSTRUCTS PASS. A guard that refuses legitimate code is worse than the status
 *     quo - the same rule `openObstruction()` follows: a check that guessed "blocked" from
 *     missing data would disable the command in exactly the situations we cannot diagnose.
 *     Unparseable source, a missing parser, an exotic shape: all fail OPEN.
 *
 * What it exists to stop, all of it recorded, none of it hypothetical:
 *
 *   1. `while (true) { bot.setControlState('forward', true); }` - a synchronous loop starves
 *      the event loop. No timer fires, so neither the 10-minute action timeout nor
 *      `ActionManager.stop()`'s 10s fuse can even run; the socket goes unread and the SERVER
 *      drops the client (`lost connection: Timed out`, watchdog re-login ~25s later).
 *      Synchronous starvation cannot be contained at runtime in-process. The defence has to
 *      be static, which is why this file is the load-bearing half of the containment.
 *   2. `bot.chat('/tp andy 0 64 0')` - the SES compartment guards globals, but the run is
 *      `main(this.agent.bot)`: the FULL bot object. Every `/`-prefixed chat routes around
 *      world_guard AND the ALLOW_RESCUE_TP marker. CLAUDE.md: "Doc text does not deter a
 *      capable model. Real guards protect; descriptions only inform."
 *   3. `bot.on(...)` / `setInterval(...)` - a listener outlives the run, and an async throw
 *      from one escapes both `generateCode`'s try/catch and `_executeAction`'s. There is no
 *      `unhandledRejection` handler anywhere in src/, so that path is an instant process death.
 *
 * NOTE on the loop rule, because it is the one most likely to be "simplified" wrongly:
 * `while (true) { ... await ... }` is a LEGITIMATE shape and deliberately PASSES. The thing
 * that kills the process is the absence of a yield, not the absence of a bound. An awaiting
 * loop reaches the event loop's timer/IO phases every iteration, so the socket is read, the
 * interrupt flag is observed, and `stop()` can end it. The rule is starvation, not loop shape.
 *
 * Everything here is PURE: source text in, verdict out. No bot, no network, no filesystem.
 * That is what makes `tests/code_guard.test.mjs` able to replay the real incidents.
 */

/**
 * The parser is loaded defensively. `espree` ships with eslint (a direct dependency) and
 * `acorn` sits under it; neither is declared in package.json on its own, so a future
 * `bun install` could in principle move them. Losing the parser must degrade this guard to
 * "passes everything" rather than throwing at import time and taking `!newAction` - or the
 * whole coder module - down with it.
 */
let PARSER = null;
let PARSER_NAME = 'none';
try {
    PARSER = await import('espree');
    PARSER_NAME = 'espree';
} catch {
    try {
        PARSER = await import('acorn');
        PARSER_NAME = 'acorn';
    } catch {
        PARSER = null;
    }
}

export function parserName() { return PARSER_NAME; }

/**
 * Generated code is written as the BODY of `async (bot) => { ... }` (bots/execTemplate.js),
 * so top-level `await` AND top-level `return` are both legal in it and neither parses as a
 * module or as a script. Wrapping restores the real context; the wrapper occupies line 1, so
 * every reported line is shifted back by `lineOffset`.
 *
 * @param {string} src
 * @returns {{ast: object|null, lineOffset: number, error: string|null}}
 */
export function parseCode(src) {
    if (!PARSER || typeof PARSER.parse !== 'function') {
        return { ast: null, lineOffset: 0, error: 'no JavaScript parser available' };
    }
    if (typeof src !== 'string' || !src.trim()) {
        return { ast: null, lineOffset: 0, error: 'empty source' };
    }
    const opts = { ecmaVersion: 'latest', sourceType: 'script', loc: true, locations: true };
    // Wrapped first: that is how the code actually runs.
    try {
        return { ast: PARSER.parse(`(async (bot) => {\n${src}\n})`, opts), lineOffset: 1, error: null };
    } catch (wrapErr) {
        // A module (top-level import/export) will not survive the wrap. Try it straight before
        // giving up, so an unusual-but-valid program is still inspected rather than waved through.
        try {
            return { ast: PARSER.parse(src, { ...opts, sourceType: 'module' }), lineOffset: 0, error: null };
        } catch {
            return { ast: null, lineOffset: 0, error: String(wrapErr && wrapErr.message || wrapErr) };
        }
    }
}

/* ------------------------------------------------------------------------------------------
 * AST walking. Deliberately generic (any node with a `.type`), so a construct this file has
 * never heard of is traversed rather than silently skipped.
 * ---------------------------------------------------------------------------------------- */

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function walk(node, visit, stopAt = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, visit, stopAt); return; }
    if (typeof node.type !== 'string') return;
    if (stopAt && stopAt(node)) return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range' || key === 'parent' || key === 'start' || key === 'end') continue;
        const child = node[key];
        if (child && typeof child === 'object') walk(child, visit, stopAt);
    }
}

function lineOf(node, lineOffset) {
    const l = node && node.loc && node.loc.start && node.loc.start.line;
    return typeof l === 'number' ? Math.max(1, l - lineOffset) : 0;
}

/** The base identifier of a member chain: `bot.pathfinder.goto` -> 'bot'. */
function rootIdentifier(node) {
    let cur = node;
    while (cur && cur.type === 'MemberExpression') cur = cur.object;
    if (cur && cur.type === 'Identifier') return cur.name;
    if (cur && cur.type === 'ThisExpression') return 'this';
    return null;
}

/** The static (non-computed) property name of a member expression, or null. */
function propName(node) {
    if (!node || node.type !== 'MemberExpression') return null;
    if (node.computed) return node.property && node.property.type === 'Literal' ? String(node.property.value) : null;
    return node.property && node.property.type === 'Identifier' ? node.property.name : null;
}

/* ------------------------------------------------------------------------------------------
 * Rule 1: unbounded loops that never yield
 * ---------------------------------------------------------------------------------------- */

/** `while (true)`, `do {} while (true)`, `for (;;)` - the shapes with no exit condition. */
function isUnboundedLoop(node) {
    if (node.type === 'ForStatement') return node.test == null;
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
        const t = node.test;
        return !!t && t.type === 'Literal' && t.value === true;
    }
    return false;
}

/**
 * Does this loop body yield to the event loop on its own turn?
 *
 * The search deliberately does NOT descend into nested function bodies: an `await` inside a
 * callback belongs to the callback's turn, not the loop's, so
 * `while (true) { arr.forEach(async x => { await f(x); }); }` starves exactly as hard as an
 * empty loop. Counting that await would be the difference between catching the kill shape and
 * waving it through.
 */
function yieldsInBody(body) {
    let found = false;
    walk(body, (n) => {
        if (n.type === 'AwaitExpression' || n.type === 'YieldExpression') found = true;
        if (n.type === 'ForOfStatement' && n.await) found = true;
    }, (n) => FUNCTION_NODES.has(n.type));
    return found;
}

/**
 * @param {object} ast
 * @param {{lineOffset?: number}} [opts]
 * @returns {Array<{line:number, rule:string, detail:string}>}
 */
export function findUnboundedLoops(ast, { lineOffset = 0 } = {}) {
    const out = [];
    if (!ast) return out;
    walk(ast, (n) => {
        if (!isUnboundedLoop(n)) return;
        if (yieldsInBody(n.body)) return;   // the legitimate shape - see the header note
        const shape = n.type === 'ForStatement' ? 'for (;;)'
            : n.type === 'DoWhileStatement' ? 'do { } while (true)' : 'while (true)';
        out.push({
            line: lineOf(n, lineOffset),
            rule: 'unbounded-loop',
            detail: `${shape} with no await in its body. A loop that never yields starves the `
                + `event loop: no timer fires, the interrupt flag is never observed, and the server `
                + `drops the connection. Put an await inside the loop (e.g. await skills.wait(bot, 50)) `
                + `or give the loop a real exit condition.`,
        });
    });
    return out;
}

/* ------------------------------------------------------------------------------------------
 * Rule 2: capabilities that reach past the guards or outlive the run
 * ---------------------------------------------------------------------------------------- */

const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const TIMER_FUNCTIONS = new Set(['setInterval', 'setTimeout', 'setImmediate']);
const PATHFINDER_EXECUTORS = new Set(['goto', 'setGoal']);

/**
 * @param {object} ast
 * @param {{lineOffset?: number}} [opts]
 * @returns {Array<{line:number, rule:string, detail:string}>}
 */
export function findForbiddenAccess(ast, { lineOffset = 0 } = {}) {
    const out = [];
    if (!ast) return out;
    const push = (n, detail) => out.push({ line: lineOf(n, lineOffset), rule: 'forbidden-access', detail });

    walk(ast, (n) => {
        if (n.type === 'MemberExpression') {
            const p = propName(n);
            // Raw packet forgery. Any `_client` reach, whatever it is hung off.
            if (p === '_client') {
                push(n, `bot._client is the raw protocol socket - writing packets by hand bypasses `
                    + `every guard in the agent. Use the skills library.`);
                return;
            }
            // The pathfinder EXECUTOR. Planning is fine and stays allowed (getPathTo): it is
            // execution that cannot move this bot, and that rewrites control states every tick,
            // silently cancelling ours.
            if (PATHFINDER_EXECUTORS.has(p)) {
                const obj = n.object;
                const objIsPathfinder = (obj && obj.type === 'MemberExpression' && propName(obj) === 'pathfinder')
                    || (obj && obj.type === 'Identifier' && obj.name === 'pathfinder');
                if (objIsPathfinder) {
                    push(n, `bot.pathfinder.${p} - mineflayer-pathfinder's executor cannot move this bot `
                        + `and fights our navigator. Use skills.goToPosition / nav.navigateTo. `
                        + `(bot.pathfinder.getPathTo is fine: planning works.)`);
                    return;
                }
            }
            // process.exit and friends.
            if (rootIdentifier(n) === 'process') {
                push(n, `process is not available to generated code, and process.exit would take the `
                    + `whole agent down.`);
                return;
            }
        }

        if (n.type === 'CallExpression' || n.type === 'NewExpression') {
            const callee = n.callee;
            if (callee && callee.type === 'Identifier') {
                if (TIMER_FUNCTIONS.has(callee.name)) {
                    push(n, `${callee.name}() schedules work that OUTLIVES this run: an async throw from `
                        + `the callback escapes every catch in the agent and there is no unhandledRejection `
                        + `handler, so it kills the process. Use await skills.wait(bot, ms).`);
                    return;
                }
                if (callee.name === 'eval' || callee.name === 'Function') {
                    push(n, `${callee.name} builds code at runtime, outside this check entirely.`);
                    return;
                }
                if (callee.name === 'require') {
                    push(n, `require is not available inside the sandbox; only skills, world, Vec3 and log are.`);
                    return;
                }
            }
            if (callee && callee.type === 'MemberExpression') {
                const p = propName(callee);
                if (LISTENER_METHODS.has(p) && rootIdentifier(callee) === 'bot') {
                    push(n, `bot.${p}(...) registers a listener that outlives this run. An async throw from `
                        + `it escapes generateCode's catch AND the action manager's, and kills the process. `
                        + `Do the work inline, in the code's own async flow.`);
                    return;
                }
            }
        }

        if (n.type === 'ImportExpression') {
            push(n, `dynamic import() reaches outside the sandbox.`);
        }
    });
    return out;
}

/* ------------------------------------------------------------------------------------------
 * Rule 3: server commands smuggled through chat
 * ---------------------------------------------------------------------------------------- */

const CHAT_METHODS = new Set(['chat', 'whisper']);

/**
 * The statically-known PREFIX of a string expression, or null when it cannot be known.
 * Enough to catch a literal, a template, and a concatenation whose left end is literal -
 * which is every form a model actually writes. Anything genuinely dynamic is the runtime
 * guard's job (`chatAllowed`, called from the harness proxy).
 */
function staticPrefix(node) {
    if (!node) return null;
    if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
    if (node.type === 'TemplateLiteral') {
        const first = node.quasis && node.quasis[0];
        const cooked = first && first.value && (first.value.cooked ?? first.value.raw);
        return typeof cooked === 'string' ? cooked : null;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') return staticPrefix(node.left);
    return null;
}

/**
 * @param {object} ast
 * @param {{lineOffset?: number}} [opts]
 * @returns {Array<{line:number, rule:string, detail:string}>}
 */
export function findServerChat(ast, { lineOffset = 0 } = {}) {
    const out = [];
    if (!ast) return out;
    walk(ast, (n) => {
        if (n.type !== 'CallExpression') return;
        const callee = n.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        const p = propName(callee);
        if (!CHAT_METHODS.has(p)) return;
        for (const arg of n.arguments || []) {
            const prefix = staticPrefix(arg);
            if (typeof prefix !== 'string') continue;
            const verdict = chatAllowed(prefix);
            if (verdict.ok) continue;
            out.push({
                line: lineOf(n, lineOffset),
                rule: 'server-chat',
                detail: `bot.${p}(${JSON.stringify(prefix.slice(0, 40))}...) sends a SERVER COMMAND. `
                    + `That bypasses world_guard (beds, chests, self-entombment, the respawn point) and `
                    + `the ALLOW_RESCUE_TP marker. Use the !server* commands, which are guarded.`,
            });
            return;
        }
    });
    return out;
}

/**
 * Runtime chat check, used by the harness proxy - pure so it is testable on its own.
 *
 * Plain speech passes. `!commands` pass: they go through the agent's own command layer, which
 * carries the guards. A '/'-prefixed message (after trimming - a leading space is not a
 * loophole) is a server command and refuses, naming the command it refused.
 *
 * @param {string} message
 * @returns {{ok: boolean, reason: string|null}}
 */
export function chatAllowed(message) {
    if (typeof message !== 'string') {
        // Not our business to police the type; mineflayer coerces. Fail open.
        if (message === null || message === undefined) return { ok: true, reason: null };
        message = String(message);
    }
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return { ok: true, reason: null };
    const cmd = (trimmed.slice(1).split(/\s/)[0] || '').slice(0, 32);
    return {
        ok: false,
        reason: `refusing to send the server command "/${cmd}": chat commands bypass world_guard `
            + `and the ALLOW_RESCUE_TP marker. Use the guarded !server* commands instead.`,
    };
}

/* ------------------------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------------------------- */

const MAX_REPORTED = 8;   // world_guard's lesson: a multi-kilobyte refusal handed to an LLM is a hazard.

/**
 * Static validation of generated code before it is evaluated. Pure: source text in, verdict
 * out. Unknown constructs PASS - only the named kill-shapes refuse.
 *
 * @param {string} src  the generated code as the model wrote it (pre-template)
 * @returns {{ok: boolean, reason: string|null, parsed: boolean,
 *            violations: Array<{line:number, rule:string, detail:string}>, truncated: boolean}}
 */
export function validateGeneratedCode(src) {
    const result = { ok: true, reason: null, parsed: false, violations: [], truncated: false };

    const { ast, lineOffset, error } = parseCode(src);
    if (!ast) {
        // FAIL OPEN, loudly in the field but permissively in the verdict. Unparseable source is
        // ESLint's problem (it runs first and rejects syntax errors); a guard that refused
        // everything it could not read would be a guard that refuses most of what it sees the
        // day its parser goes missing.
        result.note = `not statically checked: ${error}`;
        return result;
    }
    result.parsed = true;

    const opts = { lineOffset };
    const all = [
        ...findUnboundedLoops(ast, opts),
        ...findForbiddenAccess(ast, opts),
        ...findServerChat(ast, opts),
    ];

    // Dedupe: a member chain reports once, not once per level.
    const seen = new Set();
    for (const v of all) {
        const key = `${v.rule}|${v.line}|${v.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.violations.push(v);
        if (result.violations.length >= MAX_REPORTED) { result.truncated = true; break; }
    }

    if (!result.violations.length) return result;

    result.ok = false;
    result.reason = `refusing to run this code - ${result.violations.length}${result.truncated ? '+' : ''} `
        + `problem(s):\n`
        + result.violations.map(v => `  [${v.rule}] line ${v.line}: ${v.detail}`).join('\n')
        + (result.truncated ? '\n  ...and more.' : '');
    return result;
}

/* ------------------------------------------------------------------------------------------
 * Failure memory: "have I already failed this exact way?"
 *
 * Within one generateCode call nothing stopped attempt 4 from being byte-identical to attempt
 * 2's failure, and `LearnedSkills.recordFailure` had zero callers - so the same crash could be
 * paid for five times, and then again on the next ask.
 * ---------------------------------------------------------------------------------------- */

/** FNV-1a, so the signature is stable across processes without pulling in a crypto import. */
function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Fold the noise out of a piece of text.
 *
 * This is `memory_store`'s proseTokens lesson INVERTED, and the inversion is the point. There,
 * digits were kept because "10s" and "Y=-58" ARE the identity of a lesson. Here they are the
 * noise: the same crash at (4321, 62, 4935) and at (4288, 71, 5010) is ONE failure, and
 * treating them as two is what lets the attempt loop repeat itself. Identifiers, operators and
 * message words are all kept, because those are what actually distinguishes two failures.
 */
function foldNoise(text) {
    return String(text ?? '')
        .replace(/\/\/[^\n]*/g, ' ')              // line comments
        .replace(/\/\*[\s\S]*?\*\//g, ' ')        // block comments
        .replace(/\b0x[0-9a-f]+\b/gi, '#')        // hex ids
        .replace(/\b[0-9a-f]{8,}\b/gi, '#')       // long hex noise (uuids, hashes)
        .replace(/(file|https?):\/\/\S+/gi, '#')  // stack frame paths
        .replace(/-?\d+(\.\d+)?/g, '#')           // coordinates, counts, line numbers
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * "Have I already failed this exact way." Coordinates, ids and hex noise are stripped so the
 * same crash at different positions folds; everything else is preserved so two genuinely
 * different failures never do.
 *
 * @param {string} code
 * @param {string} errorString
 * @returns {string} stable signature (readable tail, so the refusal can name itself)
 */
export function failureSignature(code, errorString) {
    const codeNorm = foldNoise(code);
    const errNorm = foldNoise(errorString);
    const slug = errNorm.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'no-error-text';
    return `cg:${hash32(codeNorm)}:${hash32(errNorm)}:${slug}`;
}

/**
 * @param {string} signature
 * @param {string[]} priorSignatures
 * @param {number} [maxRepeats=1]  how many times this exact failure may already have happened
 *                                 and still be worth another attempt
 * @returns {{retry: boolean, reason: string|null, seen: number}}  a NEW failure ALWAYS retries
 */
export function shouldRetry(signature, priorSignatures, maxRepeats = 1) {
    // Fail open: a missing signature or a malformed history must never end the attempt loop.
    if (typeof signature !== 'string' || !signature) return { retry: true, reason: null, seen: 0 };
    if (!Array.isArray(priorSignatures)) return { retry: true, reason: null, seen: 0 };
    const seen = priorSignatures.filter(s => s === signature).length;
    if (seen < Math.max(1, maxRepeats)) return { retry: true, reason: null, seen };
    return {
        retry: false,
        seen,
        reason: `the same failure has now happened ${seen + 1} time(s) - regenerating will not `
            + `change it. Signature: ${signature}`,
    };
}
