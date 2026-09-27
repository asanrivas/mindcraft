/**
 * A cell with nothing to click against is EARLY, not stuck: park it, and place it the moment a
 * neighbour exists.
 *
 *   bun tests/build_frontier.test.mjs
 *
 * Why it matters. The cathedral, 2026-09-25: 617 of its 3,055 ground-layer cells stood over a lake
 * 9 to 26 blocks deep, beyond the foundation's reach. `orderForBuild` grows each layer from what
 * exists - but only on paper, treating the ground under the ground layer as support everywhere. At
 * runtime the lake cells were visited before any shore neighbour was down, each failed `no solid
 * neighbor (... below=water ...)`, 802 of them, and the watchdog read 200 in a row as a stuck bot
 * and stopped the build at 5.9%.
 *
 * Cobblestone floats. A deck grown from the shore crosses the lake one block against the next, so
 * every one of those cells was placeable - just not yet.
 */
import fs from 'node:fs';
import { Frontier, isNotYet } from '../src/agent/library/blueprint_builder.js';

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

// ---------------------------------------------------------------- the helper
{
    const f = new Frontier();
    f.park({ x: 5, y: 0, z: 0, name: 'stone' }, 'no solid neighbor (...)');
    f.park({ x: 9, y: 0, z: 9, name: 'stone' }, 'no solid neighbor (...)');
    check('a parked cell is not ready', f.next(), undefined);
    f.placed({ x: 4, y: 0, z: 0 });
    const r = f.next();
    check('placing its neighbour releases it', r && r.x, 5);
    check('...keeping why it was parked', r && r.why, 'no solid neighbor (...)');
    check('...and only it', f.next(), undefined);
    check('an unrelated cell stays parked', f.waiting.size, 1);
    f.placed({ x: 9, y: 1, z: 9 });                                        // the cell ABOVE
    check('a neighbour above counts (hanging and ceiling blocks)', f.next()?.z, 9);
    f.park({ x: 0, y: 0, z: 0 }, 'x');
    f.placed({ x: 1, y: 1, z: 0 });                                        // diagonal: NOT a face
    check('a diagonal is not a neighbour - there is no face to click', f.next(), undefined);
    check('drain hands back what never got a neighbour', f.drain().length, 1);
    check('...and empties it', f.waiting.size, 0);
}

// ---------------------------------------------------------------- what counts as "not yet"
//
// The real strings, from the cathedral's log. Only a missing face is "not yet"; everything else is a
// genuine failure the watchdog must see, or a stuck bot would be parked forever instead of stopped.
check('the lake failure is "not yet"',
    isNotYet('no solid neighbor (self=air below=water/empty above=air/empty n=air/empty s=air/empty w=air/empty e=air/empty)'), true);
check('...and over a drop',
    isNotYet('no solid neighbor (self=air below=air/empty above=air/empty n=air/empty s=air/empty w=air/empty e=air/empty)'), true);
check('out of reach is NOT "not yet" - a stuck bot must reach the watchdog',
    isNotYet('out of reach (no clear hover within range)'), false);
check('a server refusal is not', isNotYet('refused by server (ack 36ms)'), false);
check('a wrong orientation is not', isNotYet('wrong orientation (spruce_stairs: facing=north, want east)'), false);
// supports need a PERMANENT one, which parking cannot supply - it is a different fault
check('"needs a permanent support" is a failure, not a wait',
    isNotYet('refused: no solid neighbor [needs a permanent support]'), false);
check('an empty reason is not', isNotYet(undefined), false);

// ---------------------------------------------------------------- the lake, simulated
//
// A 20x20 layer. Columns x < 5 stand on ground; x >= 5 are over deep water. The plan visits the
// FAR side of the lake first - the worst case, and roughly what an arbitrary growth seed produced.
// A cell is placeable iff it is over ground or a face-neighbour has been placed.
function lake(useFrontier) {
    const cells = [];
    for (let x = 19; x >= 0; x--) for (let z = 0; z < 20; z++) cells.push({ x, y: 0, z });
    const placed = new Set();
    const k = (c) => `${c.x},${c.y},${c.z}`;
    const placeable = (c) => c.x < 5 || [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .some(([dx, dz]) => placed.has(`${c.x + dx},${c.y},${c.z + dz}`));

    const frontier = new Frontier();
    let planned = 0, failed = 0, run = 0, longestRun = 0;
    for (;;) {
        const p = (useFrontier ? frontier.next() : undefined) ?? cells[planned++];
        if (!p) break;
        if (placeable(p)) {
            placed.add(k(p)); run = 0;
            if (useFrontier) frontier.placed(p);
        } else if (useFrontier) {
            frontier.park(p, 'no solid neighbor');
        } else {
            failed++; run++; longestRun = Math.max(longestRun, run);
        }
    }
    const neverReached = useFrontier ? frontier.drain().length : failed;
    return { placed: placed.size, neverReached, longestRun, released: frontier.released };
}
{
    const before = lake(false);
    const after = lake(true);
    report('before: the lake cells fail when visited before the shore', before.neverReached === 300,
        `${before.placed}/400 placed, ${before.neverReached} failed, ${before.longestRun} failures in a row - the watchdog stops at 200`);
    report('after: EVERY cell is placed, the lake as a deck grown from the shore', after.placed === 400,
        `${after.placed}/400 placed, ${after.neverReached} never reached, ${after.released} released`);
    check('after: nothing is left for the retry rounds', after.neverReached, 0);
}
{
    // a genuinely unreachable island - no shore anywhere touches it - must still come out the end as
    // failures, so the retry rounds and temporary supports get their turn. Parking must not HIDE it.
    const f = new Frontier();
    for (let x = 10; x < 13; x++) f.park({ x, y: 0, z: 10 }, 'no solid neighbor');
    const left = f.drain();
    check('an island nothing ever touches is handed on, not lost', left.length, 3);
}

// ---------------------------------------------------------------- the pass loop is actually wired to it
{
    const src = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    report('the pass classifies with the tested predicate', /\} else if \(isNotYet\(res\.why\)\) \{/.test(src),
        'isNotYet(res.why) decides parking');
    report('the pass takes released cells before its plan',
        /const p = frontier\.next\(\) \?\? list\[planned\+\+\];/.test(src), 'frontier.next() ?? list[planned++]');
    // parked BEFORE the watchdog's counter moves - the whole point
    const park = src.indexOf('frontier.park(p, res.why);');
    const count = src.indexOf('sinceLastPlaced++;', src.indexOf('} else if (NOT_YET.test(res.why'));
    report('a parked cell never reaches the watchdog counter', park > 0 && count > park,
        'park + continue sits in the branch before sinceLastPlaced++');
    report('what is left at the end of a pass becomes a failure',
        /const neverReached = frontier\.drain\(\);[\s\S]{0,400}failures\.push\(\.\.\.neverReached\)/.test(src),
        'drained into failures for the retry rounds');
    report('a successful placement releases its neighbours',
        /if \(!res\.skipped\) frontier\.placed\(p\);/.test(src), 'frontier.placed(p) on every new placement');
}

// ---------------------------------------------------------------- ...and so are the RETRY ROUNDS
// A retry round is mostly `no solid neighbor` cells, and without parking they counted toward the
// watchdog: the cathedral stopped at 94.8% on 200 of them in a row, in a round that had placed 227.
{
    const src = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    const start = src.indexOf('const todo = failures.splice(0, failures.length);');
    const end = src.indexOf('console.log(`[builder] retry round ${round}:', start);
    const retry = src.slice(start, end);
    report('the retry loop is found', start > 0 && end > start, `${retry.length} chars`);
    report('it takes released cells before its list', /const p = frontier\.next\(\) \?\? todo\[nextTodo\+\+\];/.test(retry), 'frontier.next() ?? todo[nextTodo++]');
    const park = retry.indexOf('} else if (isNotYet(res.why)) {');
    const parkCall = retry.indexOf('frontier.park(p, res.why);', park);
    const tick = retry.indexOf('sinceLastPlaced++;', park);
    report('a not-yet cell is parked before, and instead of, the watchdog tick',
        park > 0 && parkCall > park && tick > parkCall, `park@${park} call@${parkCall} tick@${tick}`);
    report('a retry placement releases its neighbours', /if \(!res\.skipped\) frontier\.placed\(p\);/.test(retry), 'frontier.placed(p)');
    report('what is still parked at round end is a failure again',
        /if \(!stoppedEarly\) failures\.push\(\.\.\.frontier\.drain\(\)\);/.test(src.slice(end - 200, end + 10)), 'drain() before the round summary');
    report('a stop mid-round loses nothing', /failures\.push\(p, \.\.\.frontier\.ready\.splice\(0\), \.\.\.todo\.slice\(nextTodo\), \.\.\.frontier\.drain\(\)\);/.test(retry),
        'current + ready + untried + parked');
}

console.log(failures === 0 ? 'build_frontier: all checks passed' : `build_frontier: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
