/**
 * Deep Infra provider tests. No server, no network, no API key required:
 *   bun tests/deepinfra.test.mjs
 *
 * The network call is stubbed by replacing `instance.openai` after construction, so what is
 * pinned here is the provider's OWN behaviour - the parts that decide whether an outage
 * reaches FallbackModel as an outage.
 *
 * Why this file exists rather than trusting a live smoke test: the two defects it guards are
 * both INVISIBLE to a working-key check.
 *
 *   1. A placeholder return on error. CLAUDE.md: "A provider must never return a placeholder
 *      string on error. A placeholder reads as SUCCESS and stops the failover chain."
 *      llamacpp.js and fireworks.js both shipped this bug; deepseek.js still has it
 *      ('My brain disconnected, try again.'). A smoke test with a good key passes either way.
 *   2. An empty body from a reasoning model. Measured on Deep Infra 2026-09-22:
 *      Qwen/Qwen3-32B at max_tokens=60 returns finish_reason=length with content '' - the
 *      whole budget went to hidden reasoning. That is a SUCCESSFUL HTTP 200 carrying nothing,
 *      so nothing downstream can tell it from a real answer unless the provider throws.
 */
import { DeepInfra } from '../src/models/deepinfra.js';
import { selectAPI } from '../src/models/_model_map.js';

// getKey() reads keys.json first, then the environment. Set it here so the suite does not
// depend on a gitignored file - keys.json is absent in a fresh clone and in CI.
process.env.DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY || 'test-key-not-used';

let failures = 0;
const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); failures++; }
};

/** A provider instance whose HTTP layer is replaced by `reply`. */
function stubbed(model_name, reply, params) {
    const m = new DeepInfra(model_name, undefined, params);
    m.sent = [];
    m.openai = {
        chat: { completions: { create: async (pack) => {
            m.sent.push(pack);
            const r = typeof reply === 'function' ? reply(pack, m.sent.length) : reply;
            if (r instanceof Error) throw r;
            return r;
        } } },
        embeddings: { create: async (pack) => {
            m.sent.push(pack);
            return { data: [{ embedding: new Array(1024).fill(0.1) }] };
        } },
    };
    return m;
}

const ok = (content, finish_reason = 'stop', extra = {}) =>
    ({ choices: [{ finish_reason, message: { content, ...extra } }] });

// --- discovery: the class registers itself through its static prefix ------------------------
// _model_map.js imports every file in src/models and keys the map by `static prefix`. Nothing
// else registers a provider, so the prefix IS the registration.
check('static prefix is deepinfra', DeepInfra.prefix === 'deepinfra');
{
    const p = selectAPI({ model: 'deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' });
    check('prefix routes to the deepinfra api', p.api === 'deepinfra');
    // The org/name id must survive prefix-stripping intact - selectAPI removes only the
    // leading "deepinfra/", and a mangled id fails later as an opaque 404.
    check('model id keeps its org/name form', p.model === 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo');
}

// --- the default model must be a NON-REASONING one -----------------------------------------
// Not a style preference: a reasoning model returns an empty body under a small max_tokens
// (see the header), and the default is what a bare {"api":"deepinfra"} profile gets.
{
    const m = stubbed(null, ok('/tp 1 2 3'));
    await m.sendRequest([{ role: 'user', content: 'go' }], 'sys');
    check('a null model falls back to a default', typeof m.sent[0].model === 'string' && m.sent[0].model.length > 0);
    check('the default is not a Qwen3 reasoning model', !/Qwen3/i.test(m.sent[0].model));
}

// --- never a placeholder: errors must THROW -------------------------------------------------
{
    const m = stubbed('x/y', Object.assign(new Error('Connection error.'), { code: 'ECONNREFUSED' }));
    let threw = false, returned;
    try { returned = await m.sendRequest([{ role: 'user', content: 'go' }], 'sys'); }
    catch { threw = true; }
    check('a socket error throws rather than returning', threw);
    check('and no string was returned in its place', returned === undefined);
}
{
    const m = stubbed('no/such-model', Object.assign(new Error('404'), { status: 404 }));
    let threw = false;
    try { await m.sendRequest([{ role: 'user', content: 'go' }], 'sys'); } catch { threw = true; }
    check('a 404 throws too (fails over WITHOUT opening the breaker)', threw);
}

// --- an empty body is a failure, not an answer ---------------------------------------------
{
    // The measured Qwen3-32B shape: HTTP 200, finish_reason=length, content '', reasoning only.
    // turns.length === 1 so the shorter-context retry cannot apply and the error must surface.
    const m = stubbed('Qwen/Qwen3-32B', ok('', 'length', { reasoning_content: 'thinking...' }));
    let err = null;
    try { await m.sendRequest([{ role: 'user', content: 'go' }], 'sys'); } catch (e) { err = e; }
    check('finish_reason=length with no content throws', err !== null);
}
{
    // Whitespace is not content either - it would reach the agent as an empty model turn.
    const m = stubbed('x/y', ok('   '));
    let err = null;
    try { await m.sendRequest([{ role: 'user', content: 'go' }], 'sys'); } catch (e) { err = e; }
    check('whitespace-only content throws', err !== null);
    check('and the thrown message names the cause', err && /reasoning|content/i.test(err.message));
}
{
    // The same empty body with reasoning present must SAY so: this is the one error message
    // that tells an operator to raise max_tokens rather than hunt for a network fault.
    const m = stubbed('Qwen/Qwen3-32B', ok(null, 'stop', { reasoning_content: 'thinking...' }));
    let err = null;
    try { await m.sendRequest([{ role: 'user', content: 'go' }], 'sys'); } catch (e) { err = e; }
    check('an empty reasoning reply blames the token budget', err && /max_tokens/i.test(err.message));
}

// --- a long context retries SHORTER before giving up ---------------------------------------
{
    let calls = 0;
    const m = stubbed('x/y', () => {
        calls++;
        return calls === 1 ? ok('', 'length') : ok('/tp 1 2 3');
    });
    const turns = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }];
    const res = await m.sendRequest(turns, 'sys');
    check('a length-truncated reply retries with fewer turns', calls === 2);
    // Asserted on CONTENT, not on messages.length: strictFormat merges consecutive same-role
    // turns, so three user turns collapse into one message and the count never changes. The
    // oldest turn's text disappearing is the observable fact.
    check('the first attempt carried the oldest turn', /\na\b/.test(m.sent[0].messages[0].content));
    check('and the retry dropped it', !/\na\b/.test(m.sent[1].messages[0].content));
    check('the retry result is returned', res === '/tp 1 2 3');
}

// --- request shape --------------------------------------------------------------------------
{
    const m = stubbed('x/y', ok('hi'), { max_tokens: 4096, temperature: 0.7 });
    await m.sendRequest([{ role: 'user', content: 'go' }], 'SYSTEM PROMPT');
    const pack = m.sent[0];
    // strictFormat - shared by every provider in src/models - rewrites the system role into a
    // 'SYSTEM: '-prefixed USER message and requires the conversation to start with one
    // (anthropic's constraint). So the contract is "the prompt leads, as a user turn", not
    // "role === system". Pinned because it is surprising, and because a provider that skipped
    // strictFormat would silently talk to the model differently from its siblings.
    check('the conversation opens with a user turn', pack.messages[0].role === 'user');
    check('and the system prompt leads it', pack.messages[0].content.startsWith('SYSTEM: SYSTEM PROMPT'));
    check('profile params reach the request', pack.max_tokens === 4096 && pack.temperature === 0.7);
    check('the stop sequence is passed', pack.stop === '***');
}

// --- embeddings are real here, not a throw --------------------------------------------------
// Deep Infra serves embeddings, so this provider can back SkillLibrary. An embedding instance
// is built from the profile's `embedding` entry, so model_name is the EMBEDDING model.
{
    const m = stubbed('BAAI/bge-large-en-v1.5', ok('unused'));
    const v = await m.embed('collect 10 oak logs');
    check('embed returns a vector', Array.isArray(v) && v.length === 1024);
    check('embed uses the instance model', m.sent[0].model === 'BAAI/bge-large-en-v1.5');
}
{
    const m = stubbed(null, ok('unused'));
    await m.embed('x');
    check('embed has its own default model', typeof m.sent[0].model === 'string' && m.sent[0].model.length > 0);
}
{
    // The API rejects over-long input; truncation keeps a long skill doc from failing the batch.
    const m = stubbed(null, ok('unused'));
    await m.embed('x'.repeat(9000));
    check('over-long embed input is truncated', m.sent[0].input.length <= 8191);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: deepinfra provider correct');
