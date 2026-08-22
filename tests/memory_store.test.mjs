/**
 * Durable memory with database discipline. No disk, no bot:
 *   bun tests/memory_store.test.mjs
 *
 * The headline case is the one that actually happened: a model-written summary replaced a
 * user-assigned task ("build a base, mine, return") with one the model invented for itself
 * ("travel west to red bed at -2572,63,5269"), and the overwrite reloaded on every restart.
 * That must now be structurally impossible, not merely discouraged.
 */
import { MemoryStore, ORIGIN, KIND, recordId } from '../src/agent/memory_store.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

// Injectable clock: monotonic and deterministic, so ordering assertions never flake.
let clock = 1000;
const mk = (opts = {}) => new MemoryStore({ now: () => ++clock, ...opts });

// --- THE REGRESSION -----------------------------------------------------------------------------
{
    const s = mk();
    s.setGoal('Build a base with 5 chests, mine the minerals below, return to base', ORIGIN.USER);

    // Exactly what the summariser did: an agent write against the goal row.
    const r = s.put({
        kind: KIND.GOAL, key: 'current', origin: ORIGIN.AGENT,
        value: 'Travel west to red bed at -2572,63,5269',
    });

    check('agent overwrite of a user goal is REJECTED', r.ok, false);
    check('rejection explains itself', /user-authored/.test(r.reason), true);
    check('the user goal survives intact',
          s.goal(), 'Build a base with 5 chests, mine the minerals below, return to base');

    // "delete then write" must not be a loophole around the same constraint.
    check('agent cannot delete a user goal either', s.delete(KIND.GOAL, 'current', ORIGIN.AGENT).ok, false);
    check('still there after the delete attempt', s.goal() !== null, true);

    // A human can always change their own mind.
    check('a user CAN replace a user goal', s.setGoal('New task', ORIGIN.USER).ok, true);
    check('user goal updated', s.goal(), 'New task');
    check('user can delete their own goal', s.delete(KIND.GOAL, 'current', ORIGIN.USER).ok, true);
}
{
    // An agent goal is fine when no user goal stands, and a user may overwrite it.
    const s = mk();
    check('agent may set a goal when none exists', s.setGoal('explore west', ORIGIN.AGENT).ok, true);
    check('user overrides an agent goal', s.setGoal('come home', ORIGIN.USER).ok, true);
    check('user value wins', s.goal(), 'come home');
    check('agent cannot take it back', s.setGoal('explore west again', ORIGIN.AGENT).ok, false);
}

// --- validation ---------------------------------------------------------------------------------
{
    const s = mk();
    check('empty value rejected', s.put({ kind: KIND.NOTE, key: 'a', value: '  ' }).ok, false);
    check('missing kind rejected', s.put({ key: 'a', value: 'x' }).ok, false);
    check('bad origin rejected', s.put({ kind: KIND.NOTE, key: 'a', value: 'x', origin: 'hacker' }).ok, false);
    check('rejections are counted', s.rejections, 3);
    check('value is trimmed', s.put({ kind: KIND.NOTE, key: 'a', value: '  hi  ' }).record.value, 'hi');
    check('missing key defaults to current', s.put({ kind: KIND.NOTE, value: 'x' }).record.key, 'current');
}

// --- revisions and provenance ---------------------------------------------------------------------
{
    const s = mk();
    s.put({ kind: KIND.NOTE, key: 'n', value: 'one', origin: ORIGIN.AGENT });
    const second = s.put({ kind: KIND.NOTE, key: 'n', value: 'two', origin: ORIGIN.AGENT });
    check('revision increments', second.record.revision, 2);
    check('created is preserved across updates', second.record.created < second.record.updated, true);
    check('id is kind:key', second.record.id, recordId(KIND.NOTE, 'n'));
}

// --- the journal (write-ahead log) ------------------------------------------------------------------
{
    const s = mk();
    s.setGoal('do the thing', ORIGIN.USER);
    s.put({ kind: KIND.NOTE, key: 'n', value: 'x', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.GOAL, key: 'current', value: 'hijack', origin: ORIGIN.AGENT });  // rejected
    s.delete(KIND.NOTE, 'n', ORIGIN.AGENT);

    check('journal records accepted writes only', s.pending.length, 3);
    check('rejected write is NOT journalled', s.pending.some(e => e.value === 'hijack'), false);
    check('journal captures the op', s.pending[0].op, 'put');
    check('journal captures provenance', s.pending[0].origin, ORIGIN.USER);
    check('journal captures deletes', s.pending[2].op, 'delete');
}

// --- summarisation path -------------------------------------------------------------------------
{
    // What the periodic LLM summariser calls: it may replace its own rows and nothing else.
    const s = mk();
    s.setGoal('user task', ORIGIN.USER);
    s.put({ kind: KIND.LESSON, key: 'old', value: 'stale lesson', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.LESSON, key: 'pinned', value: 'human lesson', origin: ORIGIN.USER });

    const n = s.replaceAgentRecords(KIND.LESSON, [['fresh', 'new lesson'], ['also', 'another']]);
    check('replaced agent rows', n, 2);
    check('stale agent row is gone', s.get(KIND.LESSON, 'old'), null);
    check('user row survives summarisation', s.get(KIND.LESSON, 'pinned')?.value, 'human lesson');
    check('goal untouched by summarisation', s.goal(), 'user task');
}

// --- eviction -------------------------------------------------------------------------------------
{
    const s = mk({ maxRecords: 5 });
    s.setGoal('keep me', ORIGIN.USER);
    for (let i = 0; i < 20; i++) s.put({ kind: KIND.NOTE, key: `n${i}`, value: `v${i}`, origin: ORIGIN.AGENT });
    check('respects the cap', s.records.size <= 5, true);
    check('never evicts the user goal', s.goal(), 'keep me');
    check('keeps the NEWEST agent rows', s.get(KIND.NOTE, 'n19')?.value, 'v19');
    check('drops the oldest agent rows', s.get(KIND.NOTE, 'n0'), null);
}
{
    // A store full of user rows must not spin trying to evict what it may not evict.
    const s = mk({ maxRecords: 2 });
    for (let i = 0; i < 6; i++) s.put({ kind: KIND.NOTE, key: `u${i}`, value: 'x', origin: ORIGIN.USER });
    check('user rows are never evicted', s.records.size, 6);
}

// --- rendering ------------------------------------------------------------------------------------
{
    const s = mk();
    s.setGoal('THE GOAL', ORIGIN.USER);
    s.put({ kind: KIND.LOCATION, key: 'base', value: '3391,62,4890', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.LESSON, key: 'nav', value: 'prefer !travel', origin: ORIGIN.AGENT });
    const out = s.render(1200);
    check('goal is rendered first', out.indexOf('## Goal') === 0, true);
    check('goal text present', /THE GOAL/.test(out), true);
    check('locations rendered', /3391,62,4890/.test(out), true);
    check('locations precede lessons', out.indexOf('## Locations') < out.indexOf('## Lessons'), true);
}
{
    // The budget must never be the thing that loses the goal.
    const s = mk();
    s.setGoal('CRITICAL GOAL', ORIGIN.USER);
    for (let i = 0; i < 40; i++) s.put({ kind: KIND.NOTE, key: `n${i}`, value: 'x'.repeat(60), origin: ORIGIN.AGENT });
    const out = s.render(200);
    check('render respects the budget', out.length <= 200, true);
    check('goal survives truncation', /CRITICAL GOAL/.test(out), true);
    check('truncation is disclosed', /truncated/.test(out), true);
}
{
    check('empty store renders empty', mk().render(500), '');
}

// --- snapshot round-trip ---------------------------------------------------------------------------
{
    const s = mk();
    s.setGoal('persist me', ORIGIN.USER);
    s.put({ kind: KIND.LOCATION, key: 'base', value: '1,2,3', origin: ORIGIN.AGENT });

    const s2 = mk();
    s2.loadSnapshot(s.snapshot());
    check('goal round-trips', s2.goal(), 'persist me');
    check('origin round-trips', s2.get(KIND.GOAL)?.origin, ORIGIN.USER);
    check('constraint survives a reload', s2.put({ kind: KIND.GOAL, key: 'current', value: 'x', origin: ORIGIN.AGENT }).ok, false);
    check('other rows round-trip', s2.get(KIND.LOCATION, 'base')?.value, '1,2,3');
}
{
    const s = mk();
    check('garbage snapshot is survivable', s.loadSnapshot({ records: [{ nonsense: true }, null] }), 0);
    check('null snapshot is survivable', s.loadSnapshot(null), 0);
    // An unknown origin must degrade to AGENT, never silently become USER - that would grant
    // immunity to whatever wrote the file.
    s.loadSnapshot({ records: [{ kind: KIND.NOTE, key: 'a', value: 'v', origin: 'root' }] });
    check('unknown origin degrades to agent', s.get(KIND.NOTE, 'a').origin, ORIGIN.AGENT);
}

// --- legacy import ------------------------------------------------------------------------------------
{
    const s = mk();
    const legacy = `## Goal
Travel west to red bed at -2572,63,5269.

## Locations
- Red bed: -2572,63,5269
- Current: 3249,62,4896

## Lessons
- goToSurface failed previously; avoid relying on it.

## Players
- Parched: hostile skeleton, killed me once.`;

    const n = s.importLegacyBlob(legacy);
    check('imports every fact', n, 5);
    check('goal imported', /red bed/.test(s.goal()), true);
    check('locations parsed into keys', s.get(KIND.LOCATION, 'Red bed')?.value, '-2572,63,5269');
    check('players parsed', /skeleton/.test(s.get(KIND.PLAYER, 'Parched').value), true);
    check('lessons kept', s.list(KIND.LESSON).length, 1);

    // Everything imported is AGENT origin: prose written by a model cannot prove a human asked
    // for it, and marking it USER would grant the immunity this class exists to withhold.
    check('imported goal is agent origin', s.get(KIND.GOAL).origin, ORIGIN.AGENT);
    check('a user goal then overrides it', s.setGoal('real task', ORIGIN.USER).ok, true);
    check('and the agent cannot take it back', s.setGoal('back to the bed', ORIGIN.AGENT).ok, false);
}
{
    check('empty legacy blob imports nothing', mk().importLegacyBlob(''), 0);
    check('null legacy blob is survivable', mk().importLegacyBlob(null), 0);
    check('unknown headings become notes', mk().importLegacyBlob('## Weird\n- a: b') > 0, true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: memory store integrity correct');
