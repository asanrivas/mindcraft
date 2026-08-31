/**
 * Durable memory with database discipline. No disk, no bot:
 *   bun tests/memory_store.test.mjs
 *
 * The headline case is the one that actually happened: a model-written summary replaced a
 * user-assigned task ("build a base, mine, return") with one the model invented for itself
 * ("travel west to red bed at -2572,63,5269"), and the overwrite reloaded on every restart.
 * That must now be structurally impossible, not merely discouraged.
 */
import { MemoryStore, ORIGIN, KIND, recordId, normalizeKey, normalizeValue, isTransientPlaceKey,
         isTransientPlaceValue, hasAbsoluteCoords, probationSlots, proseTokens } from '../src/agent/memory_store.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};

// Injectable clock: monotonic and deterministic, so ordering assertions never flake.
let clock = 1000;
// The log is injected too, for the same reason: a discard must be announced (see `_discard`), and
// collecting it here lets the tests ASSERT on what was said instead of scrolling past it.
let logged = [];
const mk = (opts = {}) => new MemoryStore({ now: () => ++clock, log: m => logged.push(m), ...opts });

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


// --- ITEM 1: THE STORE SATURATED AND FROZE ------------------------------------------------------
// Eviction ranked by `revision` - how often a fact has been independently re-learned - which was
// the right fix for a bot narrating its stuck loop into memory. But revision is a lifetime total
// that never decays, so once every incumbent sits at 29-187 (measured on andy: 40 of 40 rows,
// EVERY kind exactly at cap) a new fact arrives at revision 1, sorts to the front of the victim
// list, and is deleted on the same call that created it. The bot could no longer learn anything it
// had not already learned many times, and nothing anywhere said so.
{
    // A store saturated exactly the way the live one is: every location slot full, every
    // incumbent enormously reinforced.
    const s = mk();
    for (let i = 0; i < 12; i++) {
        s.records.set(recordId(KIND.LOCATION, `old${i}`), {
            id: recordId(KIND.LOCATION, `old${i}`), kind: KIND.LOCATION, key: `old${i}`,
            value: `${3300 + i},62,${4800 + i}`, origin: ORIGIN.AGENT,
            created: 1, updated: 100 + i, revision: 30 + i * 5,
        });
    }
    logged = [];
    const r = s.put({ kind: KIND.LOCATION, key: 'Village well', value: '5120,71,4402', origin: ORIGIN.AGENT });

    check('a new fact into a saturated store is accepted', r.ok, true);
    check('...and it is STILL THERE afterwards', s.get(KIND.LOCATION, 'Village well')?.value, '5120,71,4402');
    check('...the section is still at its cap', s.list(KIND.LOCATION).length, 12);
    // The victim is the stalest incumbent, not the newest arrival.
    check('...the stalest incumbent made way', s.get(KIND.LOCATION, 'old0'), null);
    check('...the freshest incumbent did not', s.get(KIND.LOCATION, 'old11') !== null, true);

    // A silent discard is indistinguishable from never having been offered the fact - which is
    // exactly how this bug stayed invisible for days.
    check('the discard is announced', logged.some(l => /evicted location "old0"/.test(l)), true);
    check('...with the revision it had', logged.some(l => /revision 30/.test(l)), true);
    check('...and the reason', logged.some(l => /least recently reinforced/.test(l)), true);
    check('...and journalled, so it is answerable later', s.pending.some(e => e.op === 'evict' && e.id === 'location:old0'), true);
    check('...and readable in-process', s.evicted.some(e => e.key === 'old0'), true);
}
{
    // The point of admitting it is that it can then be REINFORCED. A brand-new fact that keeps
    // being restated must climb out of probation and become as durable as anything else - if it
    // cannot, the ratchet is merely delayed by one call.
    const s = mk();
    for (let i = 0; i < 12; i++) {
        s.records.set(recordId(KIND.LOCATION, `old${i}`), {
            id: recordId(KIND.LOCATION, `old${i}`), kind: KIND.LOCATION, key: `old${i}`,
            value: `${3300 + i},62,${4800 + i}`, origin: ORIGIN.AGENT,
            created: 1, updated: 100 + i, revision: 40, });
    }
    // Three summarisations, each restating the new place along with everything else. This is the
    // live path: history.js hands the model's markdown to importLegacyBlob.
    for (let round = 0; round < 3; round++) {
        s.importLegacyBlob('## Locations\n'
            + s.list(KIND.LOCATION).map(r => `- ${r.key}: ${r.value}`).join('\n')
            + '\n- Village well: 5120,71,4402');
    }
    check('a restated new fact accumulates reinforcement', s.get(KIND.LOCATION, 'Village well')?.revision >= 3, true);

    // Ordinary operation - another summarisation, another new place - no longer touches it: it is
    // out of probation, so a fresh arrival displaces a stale incumbent instead.
    s.importLegacyBlob('## Locations\n'
        + s.list(KIND.LOCATION).map(r => `- ${r.key}: ${r.value}`).join('\n')
        + '\n- Ridge camp: 5300,90,4100');
    check('...and an ordinary new arrival no longer displaces it', s.get(KIND.LOCATION, 'Village well') !== null, true);

    // It climbs clear of probation on its own.
    for (let round = 0; round < 8; round++) {
        s.importLegacyBlob('## Locations\n'
            + s.list(KIND.LOCATION).map(r => `- ${r.key}: ${r.value}`).join('\n'));
    }
    check('...and climbs out of probation entirely', s.get(KIND.LOCATION, 'Village well')?.revision >= 8, true);

    // AND THIS IS HOW IT BECOMES DURABLE. It will not out-reinforce an incumbent at 50 by
    // counting - both gain +1 per summarisation, so the gap never closes, and pretending
    // otherwise is what the saturation experiment got wrong. What it CAN do is outlast an
    // incumbent the summariser has stopped restating, because staleness leads the ordering. That
    // is not a theoretical route: on bob the four stalest location rows are all dead episode
    // state and the three genuine places are the freshest.
    const stale = s.list(KIND.LOCATION).find(r => r.key === 'old5');
    stale.updated = 1;                       // nobody has restated this for an episode
    s.put({ kind: KIND.LOCATION, key: 'Ridge camp 2', value: '5301,90,4101', origin: ORIGIN.AGENT });
    check('...and the STALE incumbent is what makes way, not the newcomer', s.get(KIND.LOCATION, 'old5'), null);
    check('...the newcomer is untouched', s.get(KIND.LOCATION, 'Village well') !== null, true);
    check('...and so is the most reinforced row', s.get(KIND.LOCATION, 'old11') !== null, true);
}
{
    // THE OTHER DIRECTION, which matters more: the eviction rule was written to stop a stuck bot
    // narrating its loop over the durable facts, and opening the door to new facts must not
    // reopen that. The guarantee is structural rather than statistical: established rows are only
    // ever trimmed to `cap - probationSlots`, whatever the arrival RATE, because everything
    // beyond the probation slice evicts other probationers.
    const s = mk();
    const durable = [];
    for (let i = 0; i < 10; i++) {
        const key = `durable${i}`;
        durable.push(key);
        s.records.set(recordId(KIND.LESSON, key), {
            id: recordId(KIND.LESSON, key), kind: KIND.LESSON, key,
            value: `durable lesson ${i} about ${'abcdefghij'[i]} which is worth keeping forever`,
            origin: ORIGIN.AGENT, created: 1, updated: 100 + i, revision: 40 + i,
        });
    }
    // A stuck bot restating eight genuinely different failures, six times over. Distinct enough
    // not to fold, which is the hostile case - a folding paraphrase only ever costs one slot.
    const noise = ['bedrock refused every excavation approach attempted underground tonight',
        'pillar jumping upward from the void chamber produced no vertical gain at all',
        'the village chest appears permanently full of cobblestone gravel and flint',
        'torch placement consumed the entire remaining coal reserve within minutes',
        'boat travel across the northern ocean stalled against an unexpected ice sheet',
        'furnace smelting queue emptied before any iron ingots had actually appeared',
        'sand collapsed repeatedly into the desert staircase during every descent',
        'villager trading window closed instantly on each emerald offer this evening'];
    for (let round = 0; round < 6; round++) {
        for (const n of noise) s.put({ kind: KIND.LESSON, key: `n${round}-${n.slice(0, 8)}`, value: `${n} (attempt ${round})`, origin: ORIGIN.AGENT });
    }
    const survivors = durable.filter(k => s.get(KIND.LESSON, k));
    const slots = probationSlots(10, 0);
    check('narration cannot take more than the probation slice', survivors.length, 10 - slots);
    check('...and the durable lessons that remain are the reinforced ones',
        survivors.every(k => s.get(KIND.LESSON, k).revision >= 40), true);
    check('...while the section is still exactly at cap', s.list(KIND.LESSON).length, 10);
}
{
    // A summarisation is ONE statement of what the bot knows, so the cap is applied to the
    // finished statement. Evicting per line makes whichever fact the model listed FIRST the
    // stalest the moment the batch ends, and the new fact appended at the bottom of the same
    // summary then evicts it - measured on a replay of andy's real store, `Shaft` (revision 75)
    // and `DANGER` (73) destroyed for being listed first while junk listed last survived.
    const order = (first) => {
        const s = mk();
        for (let i = 0; i < 12; i++) {
            s.records.set(recordId(KIND.LOCATION, `p${i}`), {
                id: recordId(KIND.LOCATION, `p${i}`), kind: KIND.LOCATION, key: `p${i}`,
                value: `${3300 + i},62,${4800 + i}`, origin: ORIGIN.AGENT,
                created: 1, updated: 100, revision: 50,
            });
        }
        const keys = [...Array(12).keys()].map(i => `p${i}`);
        const listed = first ? keys : [...keys].reverse();
        s.importLegacyBlob('## Locations\n'
            + listed.map(k => `- ${k}: ${3300 + Number(k.slice(1))},62,${4800 + Number(k.slice(1))}`).join('\n')
            + '\n- New place: 5120,71,4402');
        return keys.filter(k => s.get(KIND.LOCATION, k));
    };
    check('the survivors do not depend on the order the model listed them in',
        JSON.stringify(order(true)), JSON.stringify(order(false)));
}
{
    // Reinforcement SATURATES rather than decaying with age - see the block comment on
    // ESTABLISHED_AT. Decay would rank the current bad episode above a hard-won fact, because
    // narration is by construction the freshest thing in the store. Saturation instead stops an
    // incumbent's lifetime total from compounding: at the ceiling, 8 and 800 are the same.
    const s = mk();
    const row = (key, revision, updated) => s.records.set(recordId(KIND.LESSON, key), {
        id: recordId(KIND.LESSON, key), kind: KIND.LESSON, key, value: `lesson ${key} kept distinct`,
        origin: ORIGIN.AGENT, created: 1, updated, revision,
    });
    for (let i = 0; i < 8; i++) row(`k${i}`, 500, 300);       // enormous, restated this batch
    row('ceiling', 9, 300);                                   // just past the ceiling, same batch
    row('stale', 900, 10);                                    // enormous, but nobody restates it
    s.put({ kind: KIND.LESSON, key: 'new', value: 'a genuinely new lesson worth remembering here', origin: ORIGIN.AGENT });
    check('reinforcement past the ceiling buys no protection over staleness', s.get(KIND.LESSON, 'stale'), null);
    check('...and a row at the ceiling is as safe as one at 500', s.get(KIND.LESSON, 'ceiling') !== null, true);
}

// --- ITEM 2b: transient VALUES, not just transient keys -----------------------------------------
// `isTransientPlaceKey` catches junk by NAME. It cannot catch a plausible name carrying an
// unresolvable body, and andy's live store holds three of those. A place recorded as an offset
// from a position the bot no longer occupies is unresolvable forever - and worse than useless,
// because "5 blocks East" reads as actionable.
//
// OVER-FILTERING IS THE REAL DANGER HERE, so the must-KEEP list matters more than the must-drop
// one. Every case below is real, from bots/{andy,bob}/memory_store.json(.journal.jsonl), 2026-08-31.
{
    // MUST be filtered - the three the plan names, plus the families the corpus turned up.
    const mustFilter = [
        ['5 chests', '`5 blocks East` of current position.'],
        ['Veins from shaft', 'Cu 2W/2SW+2up; Fe 6W&7SW/3up; Coal 7-8W/SW+7dn.'],
        ['Copper ore', '~14 blocks W, 12 down'],
        ['Coal ore', '7-8 blk W/SW of base, 7 down'],
        ['5 chests', '23 NW'],
        ['Nearby red_bed', '3W'],
        ['Furnace', '4 blocks SW'],
        ['Water hazards', '1 block away, 2 blocks SE, 5 blocks South.'],
        ['**Ore Found**', 'Coal vein at `12 blocks NW, 11 down` from current position.'],
        ['asanrivas', 'nearby (exact coords still unknown)'],
        ['- 8 blocks SE', '- 8 blocks SE'],
    ];
    for (const [key, value] of mustFilter) {
        check(`isTransientPlaceValue filters ${JSON.stringify(value.slice(0, 40))}`,
            isTransientPlaceValue(key, value), true);
    }

    // MUST be kept. A false KEEP costs one slot that the probation slice churns anyway; a false
    // DROP costs the bot a place it can never recover.
    const mustKeep = [
        // Relative phrasing AND a real coordinate: the coordinate wins. A hazard call-out is a
        // fact about a place, and this is the row the truncated evidence made look like junk.
        ['DANGER', 'Water pockets at `~1 block away` and `2 blocks SE`; Cavity at `3394, 58, 4889`.'],
        ['Base', '`~(3391, 62, 4890)` — Copper/Iron/Coal accessible.'],
        ['Desert bed (respawn)', '`(4525, 69, 4881)`.'],
        ['Shaft', '3392,62,4887 → vert. y45-56 → mine 3393-3399,y42-45,z~4888'],
        ['Nearby sandy area', '4460–4470, 62, 4680–4690'],       // ranges, not points, but locatable
        ['Red bed', '-2572,63,5269'],                             // negative coordinates
        ['Doorway', '3392,62-63,4889 S wall'],                    // " S wall" trips the compass pattern
        ['Water Pool', '~6 blocks NE (approx 4697–4703 range), depth varies (1–3 down)'],
        ['desert village@X', '4744,Y:75,Z:4733 — Nearby village.'],
        ['drop_zone@X', '4536-39, Y: -63 to -61, Z: 4747 — Bedrock breach.'],  // junk by KEY, not by value
        ['chest@4882,64,4455', 'chest (full, but used for depositing items)'],  // coords in the KEY
        ['asanrivas@4886.30,62.00,4456.53', 'asanrivas'],                       // decimals, in the key
        ['Biome', 'Desert'],                                      // no coords, but no offset either
        ['Block Below', 'Cobblestone.'],
        ['Storage', '"ores" and "building" chests auto-sorted; Furnace clear.'],
    ];
    for (const [key, value] of mustKeep) {
        check(`isTransientPlaceValue KEEPS ${JSON.stringify(String(key).slice(0, 34))}`,
            isTransientPlaceValue(key, value), false);
    }

    check('empty value does not throw and is kept', isTransientPlaceValue('', ''), false);
    check('non-string input does not throw', isTransientPlaceValue(undefined, undefined), false);

    // The coordinate veto is the whole safety argument, so it is tested on its own.
    check('a plain triple is coordinates', hasAbsoluteCoords('3391,62,4890'), true);
    check('an axis-labelled value is coordinates', hasAbsoluteCoords('4744,Y:75,Z:4733'), true);
    check('a bare y is coordinates', hasAbsoluteCoords('cobble lid @ y62'), true);
    check('a distance is NOT coordinates', hasAbsoluteCoords('~14 blocks W, 12 down'), false);
    check('a compass sketch is NOT coordinates', hasAbsoluteCoords('Cu 2W/2SW+2up; Fe 6W&7SW/3up'), false);
}
{
    // End to end through importLegacyBlob, which is what summarisation calls.
    const s = mk();
    logged = [];
    const n = s.importLegacyBlob(`## Locations
- Base: \`(3391, 62, 4890)\`
- 5 chests: \`5 blocks East\` of current position.
- Veins from shaft: Cu 2W/2SW+2up; Fe 6W&7SW/3up; Coal 7-8W/SW+7dn.
- DANGER: Water pockets at \`~1 block away\` and \`2 blocks SE\`; Cavity at \`3394, 58, 4889\`.`);
    check('two unresolvable places refused, two real ones kept', n, 2);
    check('Base kept', s.get(KIND.LOCATION, 'Base') !== null, true);
    check('DANGER kept - it names a real coordinate', s.get(KIND.LOCATION, 'DANGER') !== null, true);
    check('the relative "5 chests" is refused', s.get(KIND.LOCATION, '5 chests'), null);
    check('the relative vein sketch is refused', s.get(KIND.LOCATION, 'Veins from shaft'), null);
    check('the skips are counted', s.skippedPlaces, 2);
    check('...and logged', logged.some(l => /dropped 2 transient location row/.test(l)), true);
}
{
    // Refusing the WRITE does not remove the same junk already in the store, and until the
    // probation slice existed that junk was immortal: `isTransientPlaceKey` shipped days ago, yet
    // bob still holds `hold_spot@X` at revision 66 because a filtered write can no longer refresh
    // it and nothing could out-score it.
    const s = mk();
    s.records.set(recordId(KIND.LOCATION, 'hold_spot@X'), {
        id: recordId(KIND.LOCATION, 'hold_spot@X'), kind: KIND.LOCATION, key: 'hold_spot@X',
        value: '3371, Y: 62, Z: 4845 — Safe zone.', origin: ORIGIN.AGENT,
        created: 1, updated: 2, revision: 66,
    });
    s.importLegacyBlob('## Locations\n- hold_spot@X:3371,Y:62,Z:4845');
    check('a refused write also prunes the row it would have refreshed', s.get(KIND.LOCATION, 'hold_spot@X'), null);
    check('...and the prune is counted', s.prunedPlaces, 1);
}
{
    // ...but ONLY when the incumbent fails the same test on its own merits. A summarisation that
    // writes a relative body must never be able to delete a REAL place that shares its key.
    const s = mk();
    s.put({ kind: KIND.LOCATION, key: '5 chests', value: '4574,68,4814', origin: ORIGIN.AGENT });
    s.importLegacyBlob('## Locations\n- 5 chests: `5 blocks East` of current position.');
    check('a good row sharing the key is NOT pruned', s.get(KIND.LOCATION, '5 chests')?.value, '4574,68,4814');
    check('...nothing was pruned', s.prunedPlaces, 0);
    check('...and the junk write was still refused', s.skippedPlaces, 1);
}
{
    // The filter is Locations only. A lesson describing a relative offset is prose about how the
    // world works, not a claim to be a place.
    const s = mk();
    const n = s.importLegacyBlob('## Lessons\n- Ores sit about 7 blocks W/SW of a shaft, 7 down.');
    check('a LESSON about relative offsets is untouched', n, 1);
}

// --- ITEM 3: a real duplicate survived the fold -------------------------------------------------
// `"Stop immediately when a player says stop."` (revision 37) and `"Stop immediately when player
// says stop."` (29) both reduce to {immediately, player, say, stop} - FOUR content words - so
// PROSE_MIN_TOKENS refused to fold them and the same sentence held two of ten lesson slots
// forever. MIN_TOKENS is NOT lowered: at four tokens a Jaccard of 0.6 means "three of five words
// agree", which merges unrelated lessons. But a score of exactly 1.0 is not an approximation.
{
    const a = 'Stop immediately when a player says stop.';
    const b = 'Stop immediately when player says stop.';
    check('the pair really is under the fuzzy guard', proseTokens(a).length < 5, true);
    check('...and their content words really are identical', proseTokens(a).join(' '), proseTokens(b).join(' '));

    const s = mk();
    s.put({ kind: KIND.LESSON, key: 'x', value: a, origin: ORIGIN.AGENT });
    s.put({ kind: KIND.LESSON, key: 'y', value: b, origin: ORIGIN.AGENT });
    check('the same short sentence twice is ONE row', s.list(KIND.LESSON).length, 1);
    check('...and it counts as reinforcement, not as a new fact', s.list(KIND.LESSON)[0].revision, 2);
}
{
    // The pair is already in andy's store, where neither write can collapse it: a fold picks one
    // row, and the problem is a PAIR of incumbents. A restatement now merges them and the
    // survivor inherits the other's reinforcement, the way scratchpad/compact.mjs folds.
    const s = mk();
    for (const [key, value, revision] of [
        ['a', 'Stop immediately when a player says stop.', 37],
        ['b', 'Stop immediately when player says stop.', 29]]) {
        s.records.set(recordId(KIND.LESSON, key), {
            id: recordId(KIND.LESSON, key), kind: KIND.LESSON, key, value,
            origin: ORIGIN.AGENT, created: 1, updated: 2, revision,
        });
    }
    logged = [];
    s.put({ kind: KIND.LESSON, key: 'c', value: 'Stop immediately when player says stop', origin: ORIGIN.AGENT });
    check('an incumbent duplicate PAIR is collapsed on the next restatement', s.list(KIND.LESSON).length, 1);
    check('...and reinforcement is summed, not thrown away', s.list(KIND.LESSON)[0].revision, 37 + 29 + 1);
    check('...and the collapse is announced', logged.some(l => /same sentence as an existing row/.test(l)), true);
}
{
    // THE CONTROL, and it is the half that matters: short sentences that merely share vocabulary
    // must still NOT merge. These are the false merges PROSE_MIN_TOKENS was written to stop, and
    // exact-set equality does not let any of them through.
    const distinct = [
        // The sharpest case, and the reason the short fold compares SEQUENCES and not sets:
        // identical content words {water, faster, walking}, opposite meanings.
        ['Water is faster than walking.', 'Walking is faster than water.'],
        ['Check the chest before mining.', 'Check the furnace before mining.'],
        ['Bedrock cannot be broken.', 'Obsidian cannot be broken.'],
        ['Sand falls when dug.', 'Gravel falls when dug.'],
        ['Torches stop spawns.', 'Beds stop spawns.'],
    ];
    for (const [a, b] of distinct) {
        const s = mk();
        s.put({ kind: KIND.LESSON, key: 'a', value: a, origin: ORIGIN.AGENT });
        s.put({ kind: KIND.LESSON, key: 'b', value: b, origin: ORIGIN.AGENT });
        check(`distinct short lessons are NOT merged: ${JSON.stringify(a)}`, s.list(KIND.LESSON).length, 2);
    }
    // A single shared content word is a topic, not a sentence - one token never folds. ("here"
    // and "there" are stopwords, so both of these reduce to the single token {sand}, while their
    // normalised VALUES differ - so nothing but the short fold could merge them, and it must not.)
    const s = mk();
    s.put({ kind: KIND.NOTE, key: 'a', value: 'Sand here.', origin: ORIGIN.AGENT });
    s.put({ kind: KIND.NOTE, key: 'b', value: 'Sand there.', origin: ORIGIN.AGENT });
    check('one-token rows are left alone', s.list(KIND.NOTE).length, 2);
}


if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: memory store integrity correct');
