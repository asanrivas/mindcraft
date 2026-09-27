/**
 * Plain-English commands that a typed model is SURE about skip the LLM turn.
 *
 * "follow me" -> !followPlayer("<sender>", 3), executed exactly as if the player had typed it.
 * Everything else - unsure, conversational, or a command whose arguments code cannot fill -
 * falls through to the LLM untouched. The router can only ever REMOVE an LLM turn; it never
 * changes what the LLM would have been asked.
 *
 * WHY A SYSTEM ONE MODEL AND WHY THIS SHAPE
 * -----------------------------------------
 * Measured with scratchpad/obedience_jev.mjs (hosted jev, whole command menu as a Choice):
 * 8/8 on the eight confusable cases, 6 runs of 6 on 2026-09-25, against the local chat model's
 * 5-8/8. The same harness against local Laya scored 2/8 with `!harvestCrops` for "go mine some
 * diamonds" at confidence 1.00 - confidently wrong, so no threshold could have gated it. This
 * module therefore defaults to the hosted API; a different endpoint is a setting, not a code path.
 *
 * The model picks WHICH command. It never writes arguments. A command is routable only if code
 * can fill every argument without guessing - the sender's own name, or a fixed distance - which
 * is what ROUTABLE below encodes. The whole menu is still OFFERED, because the measured accuracy
 * came from the model seeing every alternative, and "which of 93" discriminates far better than
 * "which of 20". A pick outside ROUTABLE is simply not acted on.
 *
 * FAILS OPEN, ALWAYS. No key, a timeout, an HTTP error, a malformed answer: every one returns
 * "not routed" and the message goes to the LLM exactly as before. The router must never be the
 * reason a message went unanswered.
 */
import settings from './settings.js';
import { executeCommand, compactDescription } from './commands/index.js';

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * Commands the router may execute, and how to fill their arguments from the message's context.
 * Deliberately short. Left out on purpose even though they take no arguments:
 *   !clearMemory !clearChat !restart !marathonReset   destructive or disruptive to undo
 *   !marathonRun !clearFurnace !stfu                  long-running or easy to trigger in banter
 * and every command that needs coordinates, a block, an item or free text - the LLM fills those.
 * @type {Record<string, (ctx: {source: string}) => Array<string|number>>}
 */
export const ROUTABLE = {
    // Read-only queries: harmless if ever wrong.
    '!stats': () => [], '!inventory': () => [], '!nearbyBlocks': () => [], '!surroundings': () => [],
    '!craftable': () => [], '!entities': () => [], '!modes': () => [], '!savedPlaces': () => [],
    '!blueprints': () => [], '!marathonStatus': () => [], '!steering': () => [],
    // Actions whose meaning is complete without arguments.
    '!stop': () => [], '!endGoal': () => [], '!climbOut': () => [], '!surface': () => [],
    '!goToBed': () => [], '!shelter': () => [], '!cookFood': () => [],
    // "me" is the only player a chat message can name without an argument, and it is always
    // the sender. 3 is what the chat model itself chose for "follow me" in the live log.
    '!followPlayer': ({ source }) => [source, 3],
    '!goToPlayer': ({ source }) => [source, 3],
};

const NONE = 'NONE';
const NONE_DESC = 'No command fits this message, or the right response is plain conversation '
    + 'rather than an action.';

// Same question the harness measured, with the bot's real name. "those redirections are
// binding" is load-bearing: many descriptions end "Do NOT use for X - use !other".
function instructions(botName) {
    return `A player has sent a chat message to ${botName}, a Minecraft bot. ${botName} answers `
        + 'by calling exactly one command. Each option below is one of the bot\'s commands and '
        + 'what it does; some options explicitly say when to use a different command instead, '
        + 'and those redirections are binding. Which single command should the bot call for '
        + '`message.text`? Choose NONE if no command fits.';
}

/** The router's settings, with defaults. Off unless `system_one_router.enabled` is true. */
export function routerConfig() {
    const c = settings.system_one_router ?? {};
    return {
        enabled: c.enabled === true,
        threshold: c.threshold ?? 0.9,
        timeoutMs: c.timeout_ms ?? 2500,
        url: c.url ?? DEFAULT_URL,
        model: c.model ?? 'jev-latest',
        keyEnv: c.key_env ?? 'TYPESAFE_API_KEY',
    };
}

/**
 * The menu as the agent's own model sees it: blocked and hidden commands never offered, and
 * the COMPACT descriptions - the text measured at 8/8.
 */
export function buildCriteria(commands, { blocked = [], hidden = [] } = {}) {
    const skip = new Set([...blocked, ...hidden]);
    const criteria = {};
    for (const c of commands) if (!skip.has(c.name)) criteria[c.name] = compactDescription(c.description);
    criteria[NONE] = NONE_DESC;
    return criteria;
}

/** `!followPlayer`, ['asanrivas', 3] -> `!followPlayer("asanrivas", 3)` */
export function commandText(name, args) {
    if (!args.length) return name;
    return `${name}(${args.map((a) => (typeof a === 'number' ? String(a) : JSON.stringify(String(a)))).join(', ')})`;
}

/**
 * Pure policy: act on this answer or not. Every refusal names itself, so a log line can say
 * why a message that looked like a command went to the LLM.
 * @returns {{route: boolean, why: string}}
 */
export function routeVerdict(answer, threshold) {
    if (!answer || typeof answer.choice !== 'string') return { route: false, why: 'no answer' };
    const p = answer.probabilities?.[answer.choice];
    if (typeof p !== 'number' || Number.isNaN(p)) return { route: false, why: 'no probability' };
    if (answer.choice === NONE) return { route: false, why: 'not a command' };
    if (!Object.hasOwn(ROUTABLE, answer.choice)) return { route: false, why: `${answer.choice} needs arguments only the LLM can fill` };
    if (p < threshold) return { route: false, why: `unsure (${p.toFixed(2)} < ${threshold})` };
    return { route: true, why: `p=${p.toFixed(2)}` };
}

/**
 * One Choice call. Throws on anything but a well-formed answer; the caller fails open.
 * `fetchImpl` is injected by the tests.
 */
export async function ask(text, criteria, { url, key, model, timeoutMs, botName = 'the bot' }, fetchImpl = fetch) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetchImpl(url, {
            method: 'POST',
            signal: ctl.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                state: { message: { from: 'a player', text } },
                model,
                questions: { command: { type: 'choice', instructions: instructions(botName), criteria } },
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const a = (await res.json())?.answers?.command;
        if (!a || typeof a.choice !== 'string') throw new Error('malformed answer');
        return { choice: a.choice, probabilities: a.probabilities ?? {}, ms: Date.now() - t0 };
    } finally {
        clearTimeout(timer);
    }
}

let warnedNoKey = false;

/**
 * Try to handle a player's message without the LLM. Returns true when it did - the caller must
 * then skip its own LLM turn. Returns false for everything else, including every failure.
 */
export async function routeByIntent(agent, source, message, deps = {}) {
    const cfg = routerConfig();
    if (!cfg.enabled) return false;
    const key = process.env[cfg.keyEnv];
    if (!key) {
        if (!warnedNoKey) { console.log(`[${agent.name}] router: off - ${cfg.keyEnv} is not set`); warnedNoKey = true; }
        return false;
    }
    const text = String(message ?? '').trim();
    if (!text || text.length > 300) return false;   // long messages are conversations, not orders

    let answer;
    try {
        const commands = deps.commands ?? await loadCommands();
        const criteria = buildCriteria(commands, { blocked: agent.blocked_actions, hidden: agent.hidden_actions });
        answer = await ask(text, criteria, { ...cfg, key, botName: agent.name }, deps.fetch);
    } catch (err) {
        console.log(`[${agent.name}] router: "${text.slice(0, 60)}" -> LLM (router unavailable: ${err.name === 'AbortError' ? `timed out after ${cfg.timeoutMs}ms` : err.message})`);
        return false;
    }

    const v = routeVerdict(answer, cfg.threshold);
    if (!v.route) {
        console.log(`[${agent.name}] router: "${text.slice(0, 60)}" -> LLM (${v.why}; ${answer.ms}ms)`);
        return false;
    }
    const cmd = commandText(answer.choice, ROUTABLE[answer.choice]({ source }));
    console.log(`[${agent.name}] router: "${text.slice(0, 60)}" -> ${cmd} (${v.why}; ${answer.ms}ms)`);

    // Exactly the path a typed `!command` takes in agent.handleMessage: it IS what the player
    // asked for, so it is authored by the user and every command guard applies unchanged.
    // Unlike a typed command, the plain-English message goes into history, so the LLM's next
    // turn knows what was asked and what was done.
    await agent.history.add(source, text);
    agent.routeResponse(source, `*${source} asked; used ${answer.choice.substring(1)}*`);
    agent.command_author = 'user';
    const result = await (deps.execute ?? executeCommand)(agent, cmd);
    await agent.history.add('system', `Handled directly without an LLM turn: ${cmd}${result ? ` -> ${result}` : ''}`);
    if (result) agent.routeResponse(source, result);
    return true;
}

async function loadCommands() {
    const { actionsList } = await import('./commands/actions.js');
    const { queryList } = await import('./commands/queries.js');
    return [...queryList, ...actionsList];
}
