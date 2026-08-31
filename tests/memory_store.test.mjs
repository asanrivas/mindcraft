/**
 * Durable memory with database discipline. No disk, no bot:
 *   bun tests/memory_store.test.mjs
 *
 * The headline case is the one that actually happened: a model-written summary replaced a
 * user-assigned task ("build a base, mine, return") with one the model invented for itself
 * ("travel west to red bed at -2572,63,5269"), and the overwrite reloaded on every restart.
 * That must now be structurally impossible, not merely discouraged.
 */
import { MemoryStore, ORIGIN, KIND, recordId, normalizeKey, normalizeValue, isTransientPlaceKey } from '../src/agent/memory_store.js';

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

// --- DEDUP: the second live defect ----------------------------------------------------------------
// Live memory reached 66 records, mostly near-duplicates: every summarisation re-worded the same
// fact and each variant became its own row. Nothing was lost, but recall bloats and the prompt
// carries the same fact three times.
check('ore suffix folds', normalizeKey('Coal ore'), normalizeKey('Coal'));
check('leading count folds', normalizeKey('5 chests'), normalizeKey('Chests'));
check('qualifier folds', normalizeKey('Torches inside'), normalizeKey('Torches'));
check('distinct keys stay distinct', normalizeKey('Coal') === normalizeKey('Copper'), false);
check('blk/blocks fold in values', normalizeValue('7-8 blk W of base'), normalizeValue('7-8 blocks W of base'));
check('connector words fold', normalizeValue('a and b'), normalizeValue('a b'));

{
    const s = mk();
    s.put({ kind: KIND.LOCATION, key: 'Coal', value: '7-8 blk W/SW of base, 7 down', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.LOCATION, key: 'Coal ore', value: '7-8 blocks W/SW of base, 7 down', origin: ORIGIN.AGENT });
    check('re-worded key updates in place', s.list(KIND.LOCATION).length, 1);
    check('newest wording wins', s.list(KIND.LOCATION)[0].value, '7-8 blocks W/SW of base, 7 down');
    check('it is an update, not an insert', s.list(KIND.LOCATION)[0].revision, 2);

    s.put({ kind: KIND.LOCATION, key: 'Copper', value: '14 blocks W, 12 down', origin: ORIGIN.AGENT });
    check('genuinely different facts still added', s.list(KIND.LOCATION).length, 2);
}
{
    // Two different keys can carry one fact; value folding catches those.
    const s = mk();
    s.put({ kind: KIND.LOCATION, key: 'Chests', value: 'x3391-3395, y62, z4886', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.LOCATION, key: '5 chests', value: 'x3391-3395, y62, z4886', origin: ORIGIN.AGENT });
    check('duplicate fact folds to one row', s.list(KIND.LOCATION).length, 1);
}
{
    // A goal must never be folded into some other row by key similarity.
    const s = mk();
    s.setGoal('do the thing', ORIGIN.USER);
    s.put({ kind: KIND.GOAL, key: 'goals', value: 'sneaky', origin: ORIGIN.AGENT });
    check('goal is not fold-merged away', s.goal(), 'do the thing');
}

// --- prose kinds: keys are identity, not display ------------------------------------------------------
{
    // The live bug: splitting a sentence on its first colon made the key a TRUNCATED PREFIX of its
    // own value, then rendered both -> "goToSurface unreliable; climbOut: goToSurface unreliable; c"
    const s = mk();
    s.importLegacyBlob('## Lessons\n- goToSurface unreliable; climbOut is better.');
    const out = s.render(500);
    check('lesson renders once', (out.match(/goToSurface/g) || []).length, 1);
    check('lesson keeps its full text', /climbOut is better/.test(out), true);
    check('no key prefix is printed', /climbOut: goToSurface/.test(out), false);
}
{
    // "Parched:: Parched:" - a value that merely restates its key.
    const s = mk();
    s.importLegacyBlob('## Players\n- Parched: Parched');
    const out = s.render(500);
    check('self-restating value is not doubled', /Parched:: /.test(out), false);
}
{
    // Re-importing the same summary twice must not double the store.
    const s = mk();
    const blob = '## Locations\n- Base: 3391,62,4890\n## Lessons\n- travel beats navTo here.';
    s.importLegacyBlob(blob);
    const after1 = s.records.size;
    s.importLegacyBlob(blob);
    check('re-import is idempotent', s.records.size, after1);
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
    // Distinct values: identical ones would (correctly) fold into a single row, which is the
    // dedup test above, not this one.
    for (let i = 0; i < 6; i++) s.put({ kind: KIND.NOTE, key: `u${i}`, value: `fact number ${i}`, origin: ORIGIN.USER });
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
    for (let i = 0; i < 40; i++) s.put({ kind: KIND.NOTE, key: `n${i}`, value: `distinct note ${i} ` + 'y'.repeat(50), origin: ORIGIN.AGENT });
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

    // allowGoal: this is the one-time MIGRATION path, where the blob is the previous state.
    // "Current: 3249,62,4896" is the exact pollution pattern item 2 exists to kill, so it is
    // now filtered rather than imported - dropping the count from 5 to 4.
    const n = s.importLegacyBlob(legacy, { allowGoal: true });
    check('imports every DURABLE fact (Current is transient, filtered)', n, 4);
    check('goal imported', /red bed/.test(s.goal()), true);
    check('locations parsed into keys', s.get(KIND.LOCATION, 'Red bed')?.value, '-2572,63,5269');
    check('"Current" is NOT stored as a location', s.get(KIND.LOCATION, 'Current'), null);
    check('the skip is counted', s.skippedPlaces, 1);
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

// --- ITEM 2: transient episode state minted as a Location --------------------------------------
// andy.json's saving_memory prompt writes Locations as `[name@X:n,Y:n,Z:n]`. importLegacyBlob's
// non-prose parser splits on the FIRST colon, which lands right after the literal "X" label -
// so every location under that template keys as `<name>@X`, genuine places included
// ("desert village@X", "iron_ore@X") right alongside the bot's own live navigation bookkeeping
// ("current@X", "hold_spot@X", "nav_failures@X"). isTransientPlaceKey is the predicate that
// tells the two apart. Cases below are pulled from the REAL journals
// (bots/{andy,bob}/memory_store.json.journal.jsonl, read-only, 2026-08-31) - both the ones the
// plan names explicitly and extra ones this corpus turned up, in both directions.
{
    // MUST be filtered - the plan's own required list.
    const mustFilter = ['current@X', 'Current', 'nav_failures@X', 'hold_spot@X', 'drop_zone@X',
        'previous_drop_zone@X', 'Target dry spot', 'Follow target'];
    for (const key of mustFilter) {
        check(`isTransientPlaceKey filters ${JSON.stringify(key)} (plan-required)`, isTransientPlaceKey(key), true);
    }

    // MUST NOT be filtered - the plan's own required list. This is the tested surface that
    // answers the denylist worry: a false positive here is a worse bug than the one being fixed.
    const mustKeep = ['Base', 'Shaft', '5 chests', 'Desert bed (respawn)', 'DANGER',
        'AVOID water cavity', 'Veins from shaft', 'Nearby red_bed', 'ice_spikes', 'desert village@X'];
    for (const key of mustKeep) {
        check(`isTransientPlaceKey keeps ${JSON.stringify(key)} (plan-required)`, isTransientPlaceKey(key), false);
    }

    // Extra corpus evidence, filter side - real repeated keys the required list didn't name.
    // bob's nav-bookkeeping family (all wear the same "@X" template artifact as the kept ones):
    const corpusFilter = [
        'target@X', 'nav_target@X', 'dig_zone@X', 'target_cluster@X',
        'target_cluster_diamond@X', 'nav_target_chest3@X', 'drop_zone_recent@X', 'current_loop@X',
        'current_pos@X',
        // andy's own restatements of the same episode state, in the wild:
        'Follow target (user-set)', 'Previous teleport start', 'Previous teleport origin',
        'Recent teleport origin', 'Current pos', 'Last pos', 'Last known pos',
        'Current (after disconnect)', 'Status', '**Previous**', 'Target',
    ];
    for (const key of corpusFilter) {
        check(`isTransientPlaceKey filters corpus key ${JSON.stringify(key)}`, isTransientPlaceKey(key), true);
    }

    // Extra corpus evidence, keep side - genuine places the bots actually saved, including ones
    // that could plausibly be over-matched by a broader rule than the one implemented:
    //   - ore CLUSTERS (not a "target" pointed at one) are places, not nav state;
    //   - "village_dig"/"safe_hold"/"last_safe"/"recovery_point" contain words this predicate
    //     matches ONLY as a prefix ("hold spot", not "safe hold"), so they must survive;
    //   - hazard call-outs are warnings ABOUT a place, not the bot's own position.
    const corpusKeep = [
        'Base site', 'Forest target', 'Red bed', 'Coal ore', 'Copper ore', 'Veins', 'Doorway',
        'Torches inside', 'Stone ledge', 'Base/Shaft', 'chest@4882,64,4455', 'EMERGENCY',
        'iron_ore@X', 'chest@X', 'diamond_cluster@X', 'coal_cluster@X', 'diamond_ore@X',
        'red_bed@X', 'village_dig@X', 'safe_hold@X', 'last_safe@X', 'recovery_point@X',
        'bedrock_breach@X', 'bedrock_breach_area@X', 'build_corner@X', 'hut_floor@X',
        'immediate_surroundings@X', 'chest3_full@X', 'beds', 'water@X',
    ];
    for (const key of corpusKeep) {
        check(`isTransientPlaceKey keeps corpus key ${JSON.stringify(key)}`, isTransientPlaceKey(key), false);
    }

    check('empty/undefined key does not throw and is kept', isTransientPlaceKey(''), false);
    check('non-string key does not throw', isTransientPlaceKey(undefined), false);
}
{
    // The filter is applied ONLY to Locations inside importLegacyBlob - a Lesson or Note that
    // happens to contain the word "current" is prose, keyed by content hash, and untouched.
    const s = mk();
    const summary = `## Locations
- Base: 3391,62,4890
- current@X:4721,Y:67,Z:4627
- hold_spot@X:3371,Y:62,Z:4845
- desert village@X:4744,Y:75,Z:4733

## Lessons
- My current strategy is to mine at the base.`;

    const n = s.importLegacyBlob(summary);
    check('only the two genuine places import', n, 3); // Base, desert village@X, + the lesson
    check('Base kept', s.get(KIND.LOCATION, 'Base')?.value, '3391,62,4890');
    check('desert village@X kept', s.get(KIND.LOCATION, 'desert village@X') !== null, true);
    check('current@X filtered out', s.get(KIND.LOCATION, 'current@X'), null);
    check('hold_spot@X filtered out', s.get(KIND.LOCATION, 'hold_spot@X'), null);
    check('two locations filtered, counted', s.skippedPlaces, 2);
    check('a lesson containing "current" is untouched', s.list(KIND.LESSON).length, 1);
    check('locations store holds exactly the two genuine places', s.list(KIND.LOCATION).length, 2);
}


// --- ENDING a goal, which is the other half of setting one -------------------------------------
// The bug: `!endGoal` only ever stopped the self-prompt LOOP. The goal ALSO lives here, and this
// record renders into `$MEMORY`, which is injected into every conversing prompt - so a goal the
// user had cancelled was handed back to the model on every turn and it kept resuming the work.
// On disk: `self_prompt: null, self_prompting_state: 0` while `goal:current` still read
// "Mine minerals below the base at 3391,62,4890...", reloaded by `load_memory` after a restart.
//
// Authority is deliberately asymmetric, exactly as for `put`: "delete then re-add" must not be a
// way around "cannot overwrite".
{
    const s = mk();
    s.setGoal('Mine minerals below the base and deposit them in the 5 chests', ORIGIN.USER);

    check('the agent cannot delete a user goal',
        s.delete(KIND.GOAL, 'current', ORIGIN.AGENT).ok, false);
    check('...and it is still there afterwards',
        s.goal(), 'Mine minerals below the base and deposit them in the 5 chests');

    check('the user can delete their own goal',
        s.delete(KIND.GOAL, 'current', ORIGIN.USER).ok, true);
    check('...and it is gone from the store', s.goal(), null);
    check('...and gone from the rendered $MEMORY', /Goal/.test(s.render(2000)), false);
}

// An agent-origin goal is the model's own and it may drop it.
{
    const s = mk();
    s.setGoal('wander around looking for copper', ORIGIN.AGENT);
    check('the agent can delete a goal it set itself',
        s.delete(KIND.GOAL, 'current', ORIGIN.AGENT).ok, true);
    check('...and it is gone', s.goal(), null);
}

// Clearing a goal that is not there is not an error worth surfacing.
{
    const s = mk();
    check('deleting a missing goal reports not-ok', s.delete(KIND.GOAL, 'current', ORIGIN.USER).ok, false);
    check('...and goal() stays null', s.goal(), null);
}

// A cleared goal must not come back when the model next summarises. replaceAgentRecords is what
// summarisation calls, and it must not resurrect a goal from lesson/location rows.
{
    const s = mk();
    s.setGoal('old cancelled goal', ORIGIN.USER);
    s.delete(KIND.GOAL, 'current', ORIGIN.USER);
    s.replaceAgentRecords(KIND.LESSON, [['a', 'water is fast'], ['b', 'trees are cheap to walk around']]);
    check('summarising does not resurrect the goal', s.goal(), null);
}


// --- SUMMARISATION MUST NOT MINT GOALS ---------------------------------------------------------
// The store already refuses to let the model OVERWRITE a user's goal. Nothing stopped it
// INVENTING one where none stood - and importLegacyBlob is what every periodic summarisation
// calls, with an LLM writing markdown under a template that literally contains a `## Goal`
// header. Observed: a user cleared the goal with !endGoal, and the very next summarisation
// re-created "Mine minerals below the base at 3391,62,4890..." as an agent record, out of the
// recent turns alone. A goal is a directive; it arrives through !goal or not at all.
{
    const s = mk();
    const summary = `## Goal
Mine minerals below the base at 3391,62,4890 and deposit them in the 5 chests

## Locations
- Base: 3391,62,4890

## Lessons
- Water is faster than walking.`;

    const n = s.importLegacyBlob(summary);
    check('a cleared goal is NOT re-minted by summarisation', s.goal(), null);
    check('...and the skip is counted so it can be logged', s.skippedGoals, 1);
    check('...while the other facts still import', n, 2);
    check('...locations survive', s.get(KIND.LOCATION, 'Base')?.value, '3391,62,4890');
    check('...lessons survive', s.list(KIND.LESSON).length, 1);
}

// A goal already standing is untouched by summarisation, whoever set it.
{
    const s = mk();
    s.setGoal('follow asanrivas', ORIGIN.USER);
    s.importLegacyBlob('## Goal\nGo mine at the base instead');
    check('summarisation cannot replace a user goal', s.goal(), 'follow asanrivas');

    const t = mk();
    t.setGoal('explore west', ORIGIN.AGENT);
    t.importLegacyBlob('## Goal\nGo mine at the base instead');
    check('nor an agent goal it set through !goal', t.goal(), 'explore west');
}

// The migration path still wants the goal - there the blob IS the previous state.
{
    const s = mk();
    check('migration imports the goal', s.importLegacyBlob('## Goal\nBuild a base', { allowGoal: true }), 1);
    check('...and it lands as agent origin', s.get(KIND.GOAL).origin, ORIGIN.AGENT);
}


// --- the call sites, because the flag only matters if it is passed correctly ------------------
// The unit tests above prove importLegacyBlob honours allowGoal. What they cannot prove is that
// summarisation omits it and the migration passes it - and getting that backwards restores the
// exact bug (a cleared goal re-minted on the next summary) with every test still green.
{
    const src = await (await import('fs')).promises.readFile(
        new URL('../src/agent/history.js', import.meta.url), 'utf8');

    // Match the actual call, not the word where it appears in a nearby comment.
    const callWith = (arg) => {
        const m = new RegExp(`importLegacyBlob\\(${arg}[^)]*\\)`).exec(src);
        return m ? m[0] : null;
    };
    const summariseCall = callWith('summary');
    check('summarisation calls importLegacyBlob at all', summariseCall !== null, true);
    check('summarisation does NOT allow goals', /allowGoal/.test(summariseCall ?? ''), false);

    const migrateCall = callWith('legacyBlob');
    check('the migration calls importLegacyBlob at all', migrateCall !== null, true);
    check('the migration DOES allow goals', /allowGoal:\s*true/.test(migrateCall ?? ''), true);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: memory store integrity correct');
