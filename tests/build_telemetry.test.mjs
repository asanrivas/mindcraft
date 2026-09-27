/**
 * Build telemetry: the numbers the web panel and tools/build_status.mjs show while a build runs.
 *
 *   bun tests/build_telemetry.test.mjs
 *
 * Why it matters. Every question that decides what to do about a running build - how fast, how long
 * left, placing or only failing, which failure dominates NOW, is it stuck - used to be answerable
 * only from a shared log, after the fact. A crash, a hang and a watchdog stop all looked the same
 * from outside: a status file that stopped changing. These are the numbers that tell them apart, so
 * a wrong one sends whoever reads it after the wrong fault.
 *
 * The rate is the one that matters most and the easiest to get subtly wrong: it must be a SLIDING
 * window, or a build that ran fast for an hour and then stopped placing reads as healthy.
 */
import fs from 'node:fs';
import { BuildTelemetry, RATE_WINDOW_MS, SAMPLE_EVERY_MS, HISTORY_SAMPLES, formatDuration }
    from '../src/agent/library/build_telemetry.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}
const T0 = 1_000_000_000_000;
const MIN = 60_000;
const fresh = () => new BuildTelemetry({ file: 'blueprints/cathedral.json', origin: { x: 880, y: 63, z: 4637 }, total: 35142, now: T0 });

// ---------------------------------------------------------------- the rate is a sliding window
{
    const t = fresh();
    // an hour at 30 placements a minute...
    for (let i = 0; i < 60 * 30; i++) t.recordAttempt(T0 + i * 2000, { placed: true });
    const busy = T0 + 60 * MIN;
    report('a busy build reads ~30/min', Math.abs(t.perMinute(busy) - 30) < 1, `${t.perMinute(busy).toFixed(1)}/min`);
    // ...then ten minutes of nothing
    const idle = busy + 10 * MIN;
    report('ten quiet minutes later it reads ZERO, not a lifetime average', t.perMinute(idle) === 0,
        `${t.perMinute(idle)}/min - a since-start average would still say ${(1800 / 70).toFixed(1)}`);
    report('and the window does not grow without bound', t.placedAt.length <= RATE_WINDOW_MS / 2000 + 1,
        `${t.placedAt.length} stamps kept`);
}
{
    // two minutes in, the rate is over two minutes - not diluted across a five-minute window
    const t = fresh();
    for (let i = 0; i < 20; i++) t.recordAttempt(T0 + i * 6000, { placed: true });
    report('an early rate uses the time actually elapsed', Math.abs(t.perMinute(T0 + 2 * MIN) - 10) < 0.01,
        `${t.perMinute(T0 + 2 * MIN)}/min for 20 in 2 minutes`);
}
{
    // attempts and placements are different rates: a build failing everything attempts fast and places nothing
    const t = fresh();
    for (let i = 0; i < 100; i++) t.recordAttempt(T0 + i * 1000, { placed: false });
    const now = T0 + 100_000;
    check('failing fast: nothing placed', t.perMinute(now), 0);
    report('...while attempts are plainly happening', t.perMinute(now, t.attemptAt) > 50, `${t.perMinute(now, t.attemptAt).toFixed(0)} attempts/min`);
}

// ---------------------------------------------------------------- ETA: this pass only, from the attempt rate
{
    const t = fresh();
    for (let i = 0; i < 60; i++) t.recordAttempt(T0 + i * 1000, { placed: i % 2 === 0 });
    t.pass = { name: 'pass1', planned: 1000, length: 1600 };
    t.counts.waiting = 0;
    const s = t.snapshot(T0 + MIN);
    // 60 attempts/min, 600 left -> 10 minutes
    report('ETA is cells left in this pass over the attempt rate', Math.abs(s.passEtaMs - 10 * MIN) < 1000,
        `${formatDuration(s.passEtaMs)} for 600 cells at ${s.attemptsPerMin}/min`);
    t.counts.waiting = 60;
    report('parked cells are still left to do', t.snapshot(T0 + MIN).passEtaMs > s.passEtaMs,
        `${formatDuration(t.snapshot(T0 + MIN).passEtaMs)} with 60 waiting`);
}
{
    const t = fresh();
    t.pass = { name: 'pass1', planned: 0, length: 100 };
    check('no attempts yet: no ETA rather than infinity', t.snapshot(T0 + 1000).passEtaMs, null);
    t.pass = null;
    check('between passes: no ETA', t.snapshot(T0 + 1000).passEtaMs, null);
}

// ---------------------------------------------------------------- trend samples
{
    const t = fresh();
    check('the first sample is taken immediately', t.maybeSample(T0 + 1) !== null, true);
    check('...the next not before SAMPLE_EVERY_MS', t.maybeSample(T0 + 1 + SAMPLE_EVERY_MS - 1), null);
    check('...and then it is', t.maybeSample(T0 + 1 + SAMPLE_EVERY_MS) !== null, true);
    for (let i = 0; i < HISTORY_SAMPLES * 2; i++) t.maybeSample(T0 + (i + 3) * SAMPLE_EVERY_MS);
    check('history is capped, so a day-long build does not grow the UI payload', t.history.length, HISTORY_SAMPLES);
    const s = t.history.at(-1);
    report('a sample carries what the chart and the trend need',
        ['ts', 'phase', 'placed', 'skipped', 'failed', 'waiting', 'perMin', 'attemptsPerMin'].every(k => k in s),
        Object.keys(s).join(','));
}

// ---------------------------------------------------------------- the dominant failure, now
{
    const t = fresh();
    t.failuresRef = [
        ...Array(5).fill({ why: 'out of reach (no clear hover within range)' }),
        ...Array(9).fill({ why: 'no solid neighbor (self=air below=water/empty above=air/empty n=air/empty)' }),
        { why: 'refused by server (ack 36ms)' },
    ];
    const top = t.topFailures();
    check('failures are ranked, most first', top[0].why, 'no solid neighbor');
    check('...counted', top[0].n, 9);
    report('...with the per-cell detail folded away so like groups with like',
        !top.some(f => /below=/.test(f.why)), top.map(f => `${f.n}x ${f.why}`).join(' | '));
    // WHICH blocks each reason hit - a reason alone ("1,002 refused by server") is not actionable
    t.failuresRef = [
        ...Array(3).fill({ name: 'quartz_slab', why: 'refused by server (ack 40ms)' }),
        { name: 'oak_log', why: 'refused by server (ack 41ms)' },
    ];
    const r = t.topFailures()[0];
    check('each reason names the blocks it hit, most first', r.blocks[0]?.name, 'quartz_slab');
    check('...counted per block', r.blocks[0]?.n, 3);
    check('...and every block in the group is kept', r.blocks.length, 2);
    // it reads the builder's LIVE array, so a retry round that fixes cells is reflected immediately
    t.failuresRef.length = 0;
    check('a live reference: cleared failures vanish from the ranking', t.topFailures().length, 0);
}

// ---------------------------------------------------------------- the status file stays backward compatible
{
    const t = fresh();
    t.setPhase('pass1', T0 + 5000);
    Object.assign(t.counts, { placed: 665, skipped: 1792, failed: 25 });
    const s = t.snapshot(T0 + 10_000);
    report('the keys BUILD_STATUS.json always had are still there',
        s.phase === 'pass1' && s.placed === 665 && s.failed === 25 && s.total === 35142 && s.done === 665 + 1792 + 25,
        `phase ${s.phase}, placed ${s.placed}, failed ${s.failed}, done ${s.done}, total ${s.total}`);
    check('standing % counts what is in the world, placed or already there', s.standingPct, Number((((665 + 1792) / 35142) * 100).toFixed(1)));
    check('phase time is measured from the phase change', s.phaseElapsedMs, 5000);
    check('health reads the builder ctx without it', s.health.rescues, 0);
    t.ctxRef = { rescues: 4, recentres: 2, facingRepairsTried: 7 };
    check('...and follows it once attached', t.snapshot(T0 + 10_000).health.refacing, 7);
    const json = JSON.stringify(t.snapshot(T0 + 10_000));
    report('the whole snapshot is plain JSON, so it survives the socket', JSON.parse(json).file === 'blueprints/cathedral.json', `${json.length} bytes`);
}
check('setting the same phase does not reset its clock', (() => { const t = fresh(); t.setPhase('pass1', T0 + 1); t.setPhase('pass1', T0 + 9); return t.phaseStartedAt; })(), T0 + 1);

check('durations read as a person would', formatDuration(3 * 3600_000 + 7 * MIN), '3h 07m');
check('...minutes', formatDuration(4 * MIN + 5000), '4m 05s');
check('...unknown is a dash, not NaN', formatDuration(null), '-');

// ---------------------------------------------------------------- it actually reaches the UI and the file
{
    const builder = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    const full = fs.readFileSync(new URL('../src/agent/library/full_state.js', import.meta.url), 'utf8');
    const html = fs.readFileSync(new URL('../src/mindcraft/public/index.html', import.meta.url), 'utf8');
    report('every build gets telemetry before its first status write',
        builder.indexOf('agent.buildTelemetry = new BuildTelemetry(') < builder.indexOf("writeStatus(agent, { phase: 'preflight' }"),
        'created before the preflight status write');
    report('status writes carry the snapshot, not just the call-site fields', /payload = tel\.snapshot\(now\);/.test(builder),
        'writeStatus serialises tel.snapshot()');
    report('a crash or interrupt is recorded as why it ended',
        /\} catch \(e\) \{\s*threw = e;\s*throw e;\s*\} finally \{\s*if \(threw\) \{[\s\S]{0,300}tel\.ended =/.test(builder),
        'catch-rethrow then tel.ended in finally');
    report('both loops record every attempt', (builder.match(/tel\.recordAttempt\(Date\.now\(\)/g) || []).length === 2,
        'pass loop and retry loop');
    // Found live within ten minutes of shipping: the foundation reported `50 placed` while the rate
    // read 0/min and the trend was flat, because only the passes recorded attempts - and it wrote its
    // status every 25th placement, so a slow stretch could look like a hang to the stall watcher.
    const found = builder.slice(builder.indexOf('export async function placeFoundation('), builder.indexOf('export async function buildBlueprint('));
    report('the foundation records every attempt', /agent\.buildTelemetry\?\.recordAttempt\(Date\.now\(\), \{ placed: res\.ok && !res\.skipped \}\)/.test(found),
        'placeFoundation feeds the rate');
    report('...and refreshes the status on every attempt, not every 25th placement',
        !/foundationPlaced % 25 === 0/.test(found), 'no 25-placement cadence left');
    const clear = builder.slice(builder.indexOf('export async function clearTerrainLayers('), builder.indexOf('export async function placeFoundation('));
    report('the clear records its digs as attempts', /agent\.buildTelemetry\?\.recordAttempt\(Date\.now\(\), \{ placed: false \}\)/.test(clear),
        'a dig is work, not silence');
    report('getFullState sends it to the UI, and cannot fail the whole update',
        /build: \(\(\) => \{\s*try \{ return agent\.buildTelemetry \? agent\.buildTelemetry\.snapshot\(Date\.now\(\)\) : null; \}/.test(full),
        'build: guarded snapshot');
    report('the page loads the panel', /<script src="js\/build-panel\.js"><\/script>/.test(html), 'index.html');
}

console.log(failures === 0 ? 'build_telemetry: all checks passed' : `build_telemetry: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
