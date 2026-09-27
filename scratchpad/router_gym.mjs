/**
 * Calibrate the System One router's threshold: which messages may skip the LLM.
 *
 *   bun scratchpad/router_gym.mjs [runs]          # needs TYPESAFE_API_KEY, no server, no bot
 *
 * Runs the router's OWN question (buildCriteria + ask + routeVerdict from
 * src/agent/system_one_router.js) over two lists:
 *
 *   SHOULD ROUTE   plain-English orders for a routable command, and which command.
 *   MUST NOT       conversation, and traps - "I'm going to bed now" is not !goToBed, "my
 *                  inventory is full" is not !inventory - plus orders for commands only the LLM
 *                  can fill ("go mine diamonds"), which must reach the LLM however sure the model is.
 *
 * THE TWO ERRORS DO NOT COST THE SAME. A missed route costs one ordinary LLM turn - exactly what
 * happens today. A FALSE route runs a command nobody asked for. So the threshold is chosen as
 * the lowest one with ZERO false routes across every run, and the number reported is how many
 * real orders still route at it. Accuracy on its own would hide the only error that matters.
 */
import { writeFileSync } from 'fs';
import settingsFile from '../settings.js';
import { setSettings } from '../src/agent/settings.js';

setSettings(settingsFile);
await import('../src/agent/commands/index.js');   // must load before actions.js (init order)
const { actionsList } = await import('../src/agent/commands/actions.js');
const { queryList } = await import('../src/agent/commands/queries.js');
const { buildCriteria, ask, routeVerdict, ROUTABLE } = await import('../src/agent/system_one_router.js');

const key = process.env.TYPESAFE_API_KEY;
if (!key) { console.error('TYPESAFE_API_KEY is not set - nothing measured.'); process.exit(2); }
const RUNS = Number(process.argv[2] || 2);

const SHOULD_ROUTE = [
    ['follow me', '!followPlayer'],
    ['bob follow me please', '!followPlayer'],
    ['keep following me', '!followPlayer'],
    ['come here', '!goToPlayer'],
    ['come to me bob', '!goToPlayer'],
    ['stop', '!stop'],
    ["stop what you're doing", '!stop'],
    ['stop following me', '!stop'],
    ['what do you have in your inventory?', '!inventory'],
    ['how much health do you have', '!stats'],
    ['you are done, drop the goal', '!endGoal'],
    ['go to sleep in a bed', '!goToBed'],
    ["you're stuck in a cave, get back to daylight", '!climbOut'],
    ['what can you craft right now?', '!craftable'],
    ['cook your food', '!cookFood'],
];
const MUST_NOT = [
    'hi bob', 'hello', 'nice work', 'thanks!', 'lol', 'good job on the tower',
    'what are you doing?', 'how are you?', 'do you like building?', "that's a cool house",
    "I'm going to bed now, see you tomorrow", 'I followed the river north', 'my inventory is full',
    'the stats on this sword are great', "come on, that's not fair", "don't stop",
    "I'll stop by the village later", 'where did you come from?', 'can you believe it is night already',
    // Real orders, but for commands whose arguments only the LLM can fill.
    'I want diamonds, go mine some', 'build a house at 100 64 100', 'go to 4412 64 4934',
    'give me 10 cobblestone',
];

const criteria = buildCriteria([...queryList, ...actionsList],
    { blocked: settingsFile.blocked_actions, hidden: settingsFile.hidden_actions });
const opts = { url: 'https://api.typesafe.ai/v1/systemone', key, model: 'jev-latest', timeoutMs: 15000, botName: 'bob' };

const rows = [];
for (let run = 0; run < RUNS; run++) {
    for (const [text, want] of SHOULD_ROUTE) rows.push({ text, want, ...(await ask(text, criteria, opts)) });
    for (const text of MUST_NOT) rows.push({ text, want: null, ...(await ask(text, criteria, opts)) });
}

const pOf = (r) => r.probabilities[r.choice] ?? 0;
for (const r of rows) {
    const routable = Object.hasOwn(ROUTABLE, r.choice);
    console.log(`${r.want ? 'ROUTE ' : 'MUSTNT'} ${r.text.slice(0, 44).padEnd(45)} -> ${r.choice.padEnd(15)} p=${pOf(r).toFixed(2)}`
        + `${routable ? '' : ' (not routable)'} ${String(r.ms).padStart(5)}ms`);
}

// Sweep: at each threshold, count real orders routed correctly, orders routed WRONGLY, and
// conversation routed at all. The last two are both false routes.
const sweep = [];
for (const th of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98]) {
    let hit = 0, wrongCmd = 0, falseRoute = 0;
    for (const r of rows) {
        const v = routeVerdict(r, th);
        if (!v.route) continue;
        if (r.want === null) falseRoute++;
        else if (r.choice === r.want) hit++;
        else wrongCmd++;
    }
    sweep.push({ th, hit, wrongCmd, falseRoute });
}
const orders = rows.filter((r) => r.want).length;
console.log(`\nthreshold  routed-correctly(of ${orders})  wrong-command  chat-routed`);
for (const s of sweep) console.log(`  ${s.th.toFixed(2)}      ${String(s.hit).padStart(3)}                  ${s.wrongCmd}              ${s.falseRoute}`);
const safe = sweep.find((s) => s.wrongCmd === 0 && s.falseRoute === 0);
console.log(safe ? `\nlowest safe threshold: ${safe.th} - routes ${safe.hit}/${orders} real orders, 0 false routes`
    : '\nNO threshold is free of false routes - do not enable the router');
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`latency p50 ${ms[Math.floor(ms.length / 2)]}ms  p95 ${ms[Math.floor(ms.length * 0.95)]}ms`);

writeFileSync('scratchpad/router_gym.last.json', JSON.stringify({
    date: new Date().toISOString(), runs: RUNS, sweep, safe: safe ?? null,
    rows: rows.map((r) => ({ text: r.text, want: r.want, choice: r.choice, p: pOf(r), ms: r.ms })),
}, null, 2));
console.log('wrote scratchpad/router_gym.last.json');
