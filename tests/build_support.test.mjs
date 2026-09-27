/**
 * Temporary supports: giving a floating cell something to click against.
 *
 *   bun tests/build_support.test.mjs
 *
 * WHY THIS EXISTS, in the numbers that produced it. The wizard tower stopped three times at the
 * same wall, and the last run said why in one line: 1,887 of 1,969 failures (96%) were
 * `no solid neighbor (self=air below=air/empty ...)`, with the build watchdog-stopped at 46%
 * verified (3,815 of 8,285). Ordering had already done its share - `orderForBuild` grows each
 * layer outward from what is supported and gets the cells that start a region with nothing beside
 * or below under 3% (tests/build_order.test.mjs asserts it) - but 31% of the cells in layers 6-14
 * have no blueprint cell below them at all. Spires, arches and an overhanging roof do not become
 * clickable in a better order; they need the block a human would put there, use, and knock away.
 *
 * The planner is pure over two predicates, so the cases that matter are assertions here rather
 * than another four-hour live run. The last check is the one worth reading: it replays the real
 * blueprint and counts how many of the cells ordering CANNOT reach a support would rescue.
 */
import fs from 'fs';
import { planSupportChain, supportIsSafe, orderForBuild, supportDirs } from '../src/agent/library/blueprint_builder.js';

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
const key = (c) => `${c.x},${c.y},${c.z}`;
const STEPS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1;

/** A world where `solid` holds real blocks and `want` holds cells the blueprint has reserved. */
const world = (solid, want = []) => ({
    isSolid: (c) => solid.some(s => key(s) === key(c)),
    isFree: (c) => !solid.some(s => key(s) === key(c)) && !want.some(w => key(w) === key(c)),
});

// ---- the common case: a cell one gap above a floor
{
    const target = { x: 0, y: 2, z: 0 };
    const chain = planSupportChain(target, world([{ x: 0, y: 0, z: 0 }]));
    check('a cell one gap above solid ground is reachable', chain?.length, 1);
    check('and the support goes in the gap', key(chain[0]), '0,1,0');
    check('which is adjacent to the target', adjacent(chain[0], target), true);
}

// ---- a genuinely floating cell: the spire case
{
    const target = { x: 0, y: 4, z: 0 };
    const chain = planSupportChain(target, world([{ x: 0, y: 0, z: 0 }]));
    check('a cell four above ground is still reachable', chain?.length, 3);
    // anchor first, so every link has the previous one to click against
    check('the chain starts at the anchor end', key(chain[0]), '0,1,0');
    check('and ends beside the target', adjacent(chain[chain.length - 1], target), true);
    let linked = true;
    for (let i = 1; i < chain.length; i++) if (!adjacent(chain[i - 1], chain[i])) linked = false;
    check('every link touches the one before it', linked, true);
    check('the target is never part of its own support', chain.some(c => key(c) === key(target)), false);
}

// ---- reaching SIDEWAYS, which is what an overhang needs
{
    const chain = planSupportChain({ x: 3, y: 5, z: 0 }, world([{ x: 0, y: 5, z: 0 }]));
    check('a cell overhanging a wall reaches sideways', chain?.length, 2);
    check('from the wall outward', key(chain[0]), '1,5,0');
}

// ---- the budget is real: nothing solid within reach is an honest null
{
    check('nothing solid within reach returns null',
        planSupportChain({ x: 0, y: 20, z: 0 }, world([{ x: 0, y: 0, z: 0 }])), null);
    check('and the budget is a parameter',
        planSupportChain({ x: 0, y: 8, z: 0 }, { ...world([{ x: 0, y: 0, z: 0 }]), maxLen: 20 })?.length, 7);
}

// ---- a support must NEVER stand in a cell the blueprint wants
//
// It would be dug out again at teardown, leaving a hole in the finished build that the verified
// percentage counts as a miss - and the retry pass would then try to fill it against the support
// that is no longer there.
{
    const target = { x: 0, y: 3, z: 0 };
    const chain = planSupportChain(target,
        world([{ x: 0, y: 0, z: 0 }], [{ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }]));
    const usesReserved = chain?.some(c => key(c) === '0,1,0' || key(c) === '0,2,0');
    check('the straight route through reserved cells is refused', usesReserved || false, false);
    check('and a way round is found instead', chain !== null, true);
}
{
    // walled in by reserved cells on every side: null, not a support in somebody else's cell
    const target = { x: 0, y: 1, z: 0 };
    const want = STEPS.map(([dx, dy, dz]) => ({ x: dx, y: 1 + dy, z: dz }));
    check('a cell whose every neighbour is reserved gets no support',
        planSupportChain(target, { ...world([{ x: 0, y: -4, z: 0 }], want), maxLen: 2 }), null);
}

// ---- shortest first: breadth-first, so the chain is the cheapest one available
{
    // ground far below, and a wall two cells to the east: the wall is the cheaper anchor
    const chain = planSupportChain({ x: 0, y: 3, z: 0 },
        world([{ x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 0 }]));
    check('the nearer anchor wins', chain?.length, 1);
    check('and it is the one beside the wall', key(chain[0]), '1,3,0');
}

// ---- determinism: a support that moves between runs cannot be compared between runs
{
    const w = world([{ x: 0, y: 0, z: 0 }, { x: 5, y: 4, z: 0 }]);
    const a = planSupportChain({ x: 0, y: 4, z: 0 }, w).map(key).join('|');
    const b = planSupportChain({ x: 0, y: 4, z: 0 }, w).map(key).join('|');
    check('the chain is deterministic', a === b, true);
}

// ---- which blocks may be supported at all
//
// A block that only stands up BECAUSE of its support falls when the support goes, so it would be
// placed, verified and destroyed on every pass forever. The live path also re-reads the block
// after teardown and learns, but the obvious cases must never cost a round trip.
for (const name of ['stone', 'spruce_stairs', 'smooth_stone_slab', 'oak_planks', 'glass', 'iron_bars'])
    check(`${name} stands on its own`, supportIsSafe(name), true);
for (const name of ['wall_torch', 'torch', 'oak_sign', 'lantern', 'ladder', 'rail', 'white_carpet',
                    'oak_door', 'iron_chain', 'stone_pressure_plate', 'white_candle', 'oak_sapling'])
    check(`${name} needs a permanent support`, supportIsSafe(name), false);
// The falling blocks come from the canonical test, never from a substring match on the name -
// "sandstone".includes("sand") is exactly the mistake that froze the agent in a desert.
check('sand falls and is refused', supportIsSafe('sand'), false);
check('gravel falls and is refused', supportIsSafe('gravel'), false);
check('sandstone does NOT fall and is allowed', supportIsSafe('sandstone'), true);
// ...and a name list must not overreach either: these contain a banned word and are ordinary blocks.
check('a chain command block is not a chain', supportIsSafe('chain_command_block'), true);
check('a torchflower is not a torch', supportIsSafe('torchflower'), true);

// ---- THE POINT OF THE EXERCISE, replayed on the blueprint that exposed it
//
// Replay the real build order over the real blueprint, placing a cell only when something solid is
// already beside or below it and - this is what makes the replay fair - NOT adding a cell that
// could not be placed. The live failure is a cascade: one unfillable cell removes the face every
// cell above it was going to click.
//
// THE CORRECTION THIS SUITE EXISTS TO RECORD. The first version of it measured ONE pass, found
// 5,766 of 8,335 cells unbuildable, and called them impossible. They are not: a blueprint is built
// from the ground up, so a cell whose support has not been placed YET fails for a reason the next
// pass removes. Iterating to the fixed point is the honest measurement, and it says something very
// different - 29 cells are genuinely impossible, not 5,766. Supports are worth 0.3%, not 69%.
//
// What was actually broken was the retry gate: it retried once, and only when fewer than a quarter
// of the cells had failed, so at 42% failures the retry list was empty on all three live runs and
// the tower stopped one pass in, at 28% and then 46%. Pass 1 of this replay lands at 30.8%, which
// is what makes the rest of the curve credible.
//
// y < 0 is the terrain under the origin; the live site is cleared and flat, which is what the
// preflight checks before a block moves.
{
    const cells = (JSON.parse(fs.readFileSync('blueprints/wizard_tower.json', 'utf8')).placements || [])
        .filter(p => typeof p.x === 'number');
    const want = new Set(cells.map(key));
    const order = orderForBuild(cells, want);

    /**
     * Sweep the order repeatedly until a pass gains nothing, exactly as `buildBlueprint` now does.
     * `supportsFrom` says when temporary supports become available: 'never', 'eager' (from pass 1,
     * which is what the first version of this mechanism did) or 'last-resort' (only once ordinary
     * retrying has stopped paying, which is what it does now).
     */
    const run = (supportsFrom) => {
        const placed = new Set();
        const solidAt = (c) => placed.has(key(c)) || c.y < 0;
        const freeAt = (c) => c.y >= 0 && !want.has(key(c)) && !placed.has(key(c));
        const curve = [];
        let rescued = 0, supportCells = 0, allow = supportsFrom === 'eager';
        for (let pass = 1; pass <= 40; pass++) {
            let gained = 0;
            for (const p of order) {
                if (placed.has(key(p))) continue;
                if (STEPS.some(([dx, dy, dz]) => solidAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))) {
                    placed.add(key(p)); gained++; continue;
                }
                if (!allow) continue;
                const chain = planSupportChain(p, { isSolid: solidAt, isFree: freeAt });
                if (!chain) continue;
                placed.add(key(p)); gained++; rescued++; supportCells += chain.length;
            }
            curve.push(gained);
            if (gained > 0) continue;
            if (supportsFrom === 'last-resort' && !allow) { allow = true; continue; }
            break;
        }
        return { curve, placed: placed.size, stuck: cells.length - placed.size, rescued, supportCells };
    };

    const plain = run('never');
    const supported = run('last-resort');
    const eager = run('eager');
    const pct = (n) => ((n / cells.length) * 100).toFixed(1);

    // The gate that was wrong: one pass is nowhere near enough, and the SECOND pass is the big one.
    report('one pass builds only a third of the tower', plain.curve[0] / cells.length < 0.4,
        `pass 1 places ${plain.curve[0]} of ${cells.length} (${pct(plain.curve[0])}%) - the live runs stopped here, at 28% and 46%`);
    report('the second pass is where the tower gets built', plain.curve[1] > plain.curve[0],
        `pass 2 adds ${plain.curve[1]} more (${pct(plain.curve[0] + plain.curve[1])}% cumulative) - it was never run, because the retry gate required fewer than a quarter of the cells to have failed`);
    report('retrying converges', plain.curve[plain.curve.length - 1] === 0,
        `${plain.curve.length - 1} productive passes: ${plain.curve.slice(0, 6).map((g, i) => `p${i + 1}+${g}`).join(' ')}${plain.curve.length > 7 ? ' ...' : ''}`);
    report('and it converges well short of a full build', plain.stuck > 0 && plain.stuck < cells.length * 0.01,
        `${plain.stuck} of ${cells.length} cells (${pct(plain.stuck)}%) can never be placed without a support`);

    // Supports are the last 0.3%, and they are cheap. Said plainly so nobody re-derives the
    // overclaim this comment was written to retract.
    report('supports finish what retrying cannot', supported.stuck === 0,
        `${supported.placed}/${cells.length} (100%) with supports, against ${plain.placed} without`);
    report('supports are a small, cheap addition - not the main event', supported.rescued <= plain.stuck * 1.5,
        `${supported.rescued} rescues costing ${supported.supportCells} temporary blocks, each placed and dug once`);
    // A support spent on a cell that the NEXT pass would have freed is pure waste: a flight leg, a
    // placement and a dig, for a face that was about to appear anyway. Both orders finish the
    // tower, so nothing but the cost distinguishes them - which is exactly why it has to be
    // asserted rather than reasoned about.
    report('supporting eagerly costs more for the same tower', eager.rescued > supported.rescued,
        `eager ${eager.rescued} rescues / ${eager.supportCells} blocks against last-resort ${supported.rescued} / ${supported.supportCells}, both finishing ${eager.placed}/${cells.length}`);
    check('and both finish the tower', eager.stuck === supported.stuck, true);

    // MAX_RETRY_ROUNDS must exceed the measured fixed point, or the builder stops with work it
    // knows how to do. Same shape as JUMP_FALL_SAFE > maxDrop: a bound that contradicts the
    // behaviour it bounds is worse than no bound.
    report('the retry bound leaves headroom over the fixed point', plain.curve.length - 1 < 14,
        `fixed point at ${plain.curve.length - 1} productive passes, MAX_RETRY_ROUNDS is 14`);
}

// A support must end where the block can be CLICKED FROM. The cathedral's roof beams (axis=z oak
// logs) got supports underneath, which chooseFaces then rejects: 412 built, 3 placements rescued.
{
    check('an axis=z log is supported only at a z end', JSON.stringify(supportDirs({ name: 'oak_log', properties: { axis: 'z' } })), '[[0,0,1],[0,0,-1]]');
    check('an axis=y log prefers below', JSON.stringify(supportDirs({ name: 'oak_log', properties: { axis: 'y' } })?.[0]), '[0,-1,0]');
    check('a wall lever facing east is clicked from the west', JSON.stringify(supportDirs({ name: 'lever', properties: { face: 'wall', facing: 'east' } })), '[[-1,0,0]]');
    check('a plain block may be supported from any side', supportDirs({ name: 'stone_bricks' }), null);
    // ground 2 below a beam cell: unconstrained the chain comes up from below; constrained it
    // must arrive at a z neighbour instead
    const target = { x: 0, y: 2, z: 0 };
    const free = world([{ x: 0, y: 0, z: 0 }]);
    const any = planSupportChain(target, free);
    check('unconstrained: the last link is below the target', any && `${any[any.length - 1].x},${any[any.length - 1].y},${any[any.length - 1].z}`, '0,1,0');
    const beam = planSupportChain(target, { ...free, ends: supportDirs({ name: 'oak_log', properties: { axis: 'z' } }) });
    const last = beam?.[beam.length - 1];
    check('axis=z: the last link sits at a z end of the target', last && last.x === 0 && last.y === 2 && Math.abs(last.z) === 1, true);
    check('...and the chain still starts against something solid', !!beam && beam.length >= 2, true);
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    report('buildSupport passes the block\'s clickable faces to the planner',
        /ends: p \? supportDirs\(p\) : null,/.test(src) && /await buildSupport\(bot, P, ctx, p\)/.test(src), 'ends: supportDirs(p), called with p');
}

// The retry bound is PER PHASE: enabling supports resets it. A shared count ended the cathedral at
// 99.0% (2026-09-26) with supports still placing 34 a round, because ordinary placement had spent
// ten of the fourteen rounds reaching its own fixed point.
{
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    report('the loop is bounded by rounds in THIS phase, not in total',
        /&& phaseRounds < MAX_RETRY_ROUNDS &&/.test(src) && !/&& round < MAX_RETRY_ROUNDS &&/.test(src), 'phaseRounds < MAX_RETRY_ROUNDS');
    report('...and enabling supports starts a fresh budget',
        /ctx\.allowSupports = true;\s*phaseRounds = 0;/.test(src), 'allowSupports = true; phaseRounds = 0');
}

console.log(failures === 0 ? 'build_support: all checks passed' : `build_support: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
