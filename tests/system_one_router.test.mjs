/**
 * The System One router: plain-English orders a typed model is sure about skip the LLM turn.
 *
 *   bun tests/system_one_router.test.mjs
 *
 * No network: the API is a fake. What the live model does is measured by
 * scratchpad/router_gym.mjs (0 false routes, 26/30 orders at threshold 0.7); this suite holds
 * the code around it to the properties that make that measurement safe to act on:
 *
 *   - it can only REMOVE an LLM turn: every failure, doubt or non-routable pick returns false
 *     and the message reaches the LLM exactly as before;
 *   - it never writes arguments: only ROUTABLE commands, filled by code from the sender;
 *   - a routed order runs as the USER's command, like a typed `!command`.
 */
import fs from 'fs';
import settings, { setSettings } from '../src/agent/settings.js';
import {
    routeVerdict, commandText, buildCriteria, routeByIntent, ROUTABLE, routerConfig,
} from '../src/agent/system_one_router.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
const origLog = console.log;
const quietly = async (fn) => { console.log = () => {}; try { return await fn(); } finally { console.log = origLog; } };

// --- the policy ---------------------------------------------------------------------------------
const ans = (choice, p) => ({ choice, probabilities: { [choice]: p }, ms: 1 });
check('a sure routable pick routes', routeVerdict(ans('!followPlayer', 0.9), 0.7).route, true);
check('exactly at the threshold routes', routeVerdict(ans('!stop', 0.7), 0.7).route, true);
check('below the threshold does not', routeVerdict(ans('!stop', 0.69), 0.7).route, false);
check('NONE never routes, however sure', routeVerdict(ans('NONE', 1), 0.7).route, false);
// The model was 0.91 sure of !branchMine for "go mine diamonds" - right, and still not ours to fill.
check('a sure pick that needs arguments goes to the LLM', routeVerdict(ans('!branchMine', 0.99), 0.7).route, false);
check('...and says why', routeVerdict(ans('!branchMine', 0.99), 0.7).why.includes('arguments'), true);
check('no answer does not route', routeVerdict(null, 0.7).route, false);
check('a choice with no probability does not route', routeVerdict({ choice: '!stop', probabilities: {} }, 0.7).route, false);
check('an inherited property name is not a routable command', routeVerdict(ans('constructor', 1), 0.7).route, false);
for (const bad of ['!clearMemory', '!restart', '!clearChat', '!attackPlayer', '!givePlayer', '!newAction']) {
    check(`${bad} is never routable`, Object.hasOwn(ROUTABLE, bad), false);
}

// --- arguments come from code, never the model -----------------------------------------------------
check('follow fills the sender', commandText('!followPlayer', ROUTABLE['!followPlayer']({ source: 'asanrivas' })),
    '!followPlayer("asanrivas", 3)');
check('a name with a quote cannot break out of the string',
    commandText('!goToPlayer', ['a"b', 3]), '!goToPlayer("a\\"b", 3)');
check('no-argument commands render bare', commandText('!stop', []), '!stop');

// --- the menu ----------------------------------------------------------------------------------------
const cmds = [
    { name: '!stop', description: 'Stop all actions. Second sentence.' },
    { name: '!secret', description: 'hidden one' },
    { name: '!gone', description: 'blocked one' },
];
const crit = buildCriteria(cmds, { blocked: ['!gone'], hidden: ['!secret'] });
check('blocked commands are never offered', '!gone' in crit, false);
check('hidden commands are never offered', '!secret' in crit, false);
check('NONE is always offered', 'NONE' in crit, true);

// --- routeByIntent against a fake agent and a fake API -------------------------------------------
function fakeAgent() {
    const a = {
        name: 'bob', blocked_actions: [], hidden_actions: [], command_author: null,
        said: [], hist: [],
        history: { add: async (who, msg) => { a.hist.push([who, msg]); } },
        routeResponse: (to, msg) => { a.said.push(msg); },
    };
    return a;
}
const reply = (choice, p) => async () => ({ ok: true, json: async () => ({ answers: { command: { choice, probabilities: { [choice]: p } } } }) });
let calls = 0;
const counting = (f) => async (...a) => { calls++; return f(...a); };
const deps = (fetch, executed = []) => ({
    commands: cmds, fetch: counting(fetch),
    execute: async (_agent, cmd) => { executed.push(cmd); return `ran ${cmd}`; },
});
const KEY = 'TEST_SYSTEM_ONE_KEY';
const base = { ...settings };
const configure = (c) => setSettings({ ...base, system_one_router: { key_env: KEY, ...c } });
process.env[KEY] = 'k';

configure({ enabled: false });
calls = 0;
check('disabled: not routed', await routeByIntent(fakeAgent(), 'asanrivas', 'follow me', deps(reply('!followPlayer', 1))), false);
check('disabled: the API is never called', calls, 0);
check('the default is OFF when the key is absent from settings', (setSettings({ ...base, system_one_router: undefined }), routerConfig().enabled), false);

configure({ enabled: true, threshold: 0.7 });
delete process.env[KEY];
calls = 0;
check('no key: not routed', await quietly(() => routeByIntent(fakeAgent(), 'asanrivas', 'follow me', deps(reply('!followPlayer', 1)))), false);
check('no key: the API is never called', calls, 0);
process.env[KEY] = 'k';

let agent = fakeAgent(); let executed = [];
check('a sure order is handled', await quietly(() => routeByIntent(agent, 'asanrivas', 'follow me', deps(reply('!followPlayer', 0.88), executed))), true);
check('...by running the filled command', executed[0], '!followPlayer("asanrivas", 3)');
check('...as the USER\'s command', agent.command_author, 'user');
check('...with the plain-English order in history', agent.hist[0]?.join('|'), 'asanrivas|follow me');
check('...and what was done, for the LLM\'s next turn', agent.hist[1]?.[1]?.includes('!followPlayer'), true);
check('...and the player is told', agent.said.some((m) => m.includes('followPlayer')), true);

for (const [label, fetch] of [
    ['NONE', reply('NONE', 1)],
    ['a command that needs arguments', reply('!navTo', 0.99)],
    ['an unsure pick', reply('!stop', 0.5)],
    ['HTTP 500', async () => ({ ok: false, status: 500 })],
    ['a malformed answer', async () => ({ ok: true, json: async () => ({ answers: {} }) })],
    ['a network error', async () => { throw new Error('ECONNREFUSED'); }],
]) {
    agent = fakeAgent(); executed = [];
    check(`${label}: goes to the LLM`, await quietly(() => routeByIntent(agent, 'asanrivas', 'hi', deps(fetch, executed))), false);
    check(`${label}: nothing executed, nothing added to history`, executed.length + agent.hist.length, 0);
}

// A hung API must not hold the chat hostage: the abort fires at timeout_ms.
configure({ enabled: true, threshold: 0.7, timeout_ms: 50 });
const hang = async (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
}));
const t0 = Date.now();
check('a hung API times out and goes to the LLM', await quietly(() => routeByIntent(fakeAgent(), 'asanrivas', 'follow me', deps(hang))), false);
check('...promptly', Date.now() - t0 < 1000, true);

configure({ enabled: true, threshold: 0.7 });
calls = 0;
check('a long message is a conversation: not routed', await routeByIntent(fakeAgent(), 'asanrivas', 'x'.repeat(301), deps(reply('!stop', 1))), false);
check('...without an API call', calls, 0);

// --- the hook in agent.js ------------------------------------------------------------------------
const src = fs.readFileSync(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
const hm = src.slice(src.indexOf('async handleMessage('), src.indexOf('async routeResponse('));
const hook = hm.indexOf('routeByIntent(');
check('the hook exists in handleMessage', hook > 0, true);
check('...after the typed-command path, so a typed !command is never re-asked',
    hook > hm.indexOf('let execute_res = await executeCommand(this, message);'), true);
check('...before the LLM is prompted', hook < hm.indexOf('this.prompter.promptConvo('), true);
check('...for humans only', /!self_prompt && !from_other_bot && await routeByIntent/.test(hm), true);

setSettings(base);
delete process.env[KEY];
console.log(failures === 0 ? 'system_one_router: all checks passed' : `system_one_router: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
