/**
 * Getting a sealed bot out, and knowing when it is sealed.
 *
 *   bun tests/build_escape.test.mjs
 *
 * THE INCIDENT, 2026-09-22. Bob spent fifty minutes at (4586.8, 53.2, 4616.7) - ten blocks BELOW
 * the wizard tower's base plane, in a pocket with air at y=52-54 and solid rock from y=55 to y=63.
 * Flight removes gravity, not collision, so he could not fly out; every cell reported
 * `out of reach (no clear hover within range)`, 100 of 100 attempts, and the wedge rescue logged
 *
 *     [builder] wedged - returned to station above the build (84.3 short)
 *
 * over and over. That sentence is the whole bug: the VERB claims success, the NUMBER reports
 * failure, and nothing escalated. The builder walked 1,400 cells with `0 placed` while the log read
 * like progress, and the progress watchdog could not fire because pre-existing cells - a resume is
 * mostly pre-existing cells - keep resetting its counter.
 *
 * Three things had to change, and only the first is pure enough to assert here:
 *   1. know WHICH WAY out is cheapest, and what it costs               <- this suite
 *   2. report whether the bot MOVED, not whether a rescue was attempted
 *   3. stop the build, naming the position, once rescues stop working
 */
import { planBreakOut } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
const K = (c) => `${c.x},${c.y},${c.z}`;
/**
 * A world built from explicit sets. `solid` are blocks; `open` are the cells that count as OUT
 * (the body fits and nothing is overhead). Everything else is air that is not an exit - the
 * inside of the next room along, which is the case the climbing version kept mistaking for
 * freedom.
 */
const world = (solid, open, build = []) => ({
    isSolid: (c) => solid.some((k) => k === K(c)),
    isOpen: (c) => open.some((k) => k === K(c)),
    isBlueprint: (c) => build.some((k) => k === K(c)),
});
const ORIGIN = { x: 0, y: 0, z: 0 };

// ---- the measured case: one wall east, four floors up
//
// Bob at (4579, 67, 4612) took three lifts to climb from y=67 to y=106, converging on a station at
// y=139 above the whole building, while every cell of pass 1 sat at y=63. He ended further from
// his work than he started. One wall block east would have done it.
{
    const plan = planBreakOut({ from: ORIGIN,
        ...world(['1,0,0', '0,1,0', '0,2,0', '0,3,0'], ['2,0,0', '0,4,0']) });
    check('the cheapest direction wins', plan?.dir, 'east');
    // one block of WALL. Only the cells that are actually SOLID get dug - in this fixture the
    // head-height cell beside the wall is already air, so a single dig leaves a two-tall opening.
    check('and it is one block thick', new Set(plan.dig.map((c) => `${c.x},${c.z}`)).size, 1);
    check('and only the solid cell is broken', plan.dig.length, 1);
}

// ---- air that is not open is not an exit
//
// The next room along is air, and stopping there solves nothing. This is the single assertion
// that separates this planner from the one it replaced.
{
    const plan = planBreakOut({ from: ORIGIN,
        // east: wall at 1, room air at 2 (NOT open), wall at 3, open at 4
        ...world(['1,0,0', '3,0,0'], ['4,0,0']) });
    check('it digs past the next room to real open air',
        new Set(plan.dig.map((c) => `${c.x},${c.z}`)).size, 2);
    check('in the right direction', plan.dir, 'east');
}

// ---- every direction is considered, including up
{
    check('up is used when it is the only way',
        planBreakOut({ from: ORIGIN, ...world(['0,1,0'], ['0,2,0']) })?.dir, 'up');
    check('north is used when it is cheapest',
        planBreakOut({ from: ORIGIN, ...world(['0,0,-1', '1,0,0', '2,0,0'], ['0,0,-2', '3,0,0']) })?.dir, 'north');
}

// ---- the build is spent sparingly, and the debt is counted
{
    const plan = planBreakOut({ from: ORIGIN,
        ...world(['1,0,0', '0,0,1'], ['2,0,0', '0,0,2'], ['1,0,0']) });
    check('a tie is broken toward the cheaper wall', plan?.dir, 'south');
    check('and costs the build nothing', plan.brokeBlueprint, 0);
}
{
    const solid = ['1,0,0', '2,0,0', '3,0,0', '4,0,0', '5,0,0'];
    check('a wall thicker than the build allowance is refused',
        planBreakOut({ from: ORIGIN, maxBlueprint: 2, ...world(solid, ['6,0,0'], solid) }), null);
    check('...and allowed when the allowance covers it',
        planBreakOut({ from: ORIGIN, maxBlueprint: 5, maxDig: 12, ...world(solid, ['6,0,0'], solid) })?.dig.length, 5);
}

// ---- already outside: nothing to dig, and NOT a refusal
//
// A bot in open air that cannot reach its work is stuck for some other reason, and digging will
// not fix it. Reporting that as a failed escape would send the caller down the wrong path.
{
    const plan = planBreakOut({ from: ORIGIN, ...world([], ['1,0,0']) });
    check('open air adjacent means nothing to dig', plan?.dig, []);
    check('and it is not a refusal', plan === null, false);
}

// ---- no way out at all within the budget
{
    check('a bot in the middle of solid rock is refused',
        planBreakOut({ from: ORIGIN, maxDig: 3, ...world(
            ['1,0,0', '2,0,0', '3,0,0', '4,0,0', '-1,0,0', '-2,0,0', '-3,0,0', '-4,0,0',
             '0,0,1', '0,0,2', '0,0,3', '0,0,4', '0,0,-1', '0,0,-2', '0,0,-3', '0,0,-4',
             '0,1,0', '0,2,0', '0,3,0', '0,4,0'], []) }), null);
}

// ---- determinism: an escape that changes between runs cannot be compared between runs
{
    const w = world(['1,0,0', '0,0,1'], ['2,0,0', '0,0,2']);
    const a = planBreakOut({ from: ORIGIN, ...w });
    const b = planBreakOut({ from: ORIGIN, ...w });
    check('the plan is deterministic', JSON.stringify(a), JSON.stringify(b));
}

// ---- "out" means OUTSIDE THE BUILDING, not "air with sky above it"
//
// Two proxies were tried live on 2026-09-23 and both called a place inside the tower "out", so the
// break-out declined and the bot stayed sealed:
//   - not under a roof within 6 blocks -> any room taller than six reads as sky.  (4592, 66, 4599)
//   - ...within 32 blocks              -> an ATRIUM is open its whole height and is still indoors.
//                                                                                 (4595, 66, 4598)
// The footprint is the building. These cases pin the distinction so neither proxy comes back.
{
    // A bot in an atrium: air above it for ever, a wall to the east, real outside beyond.
    const insideAtrium = { x: 0, y: 0, z: 0 };
    const atriumIsOut = planBreakOut({ from: insideAtrium,
        isSolid: (c) => c.x === 1,
        isOpen: (c) => c.x >= 2,              // only beyond the wall counts
        isBlueprint: () => false });
    // TWO cells, not one: the body is 1.8 tall, so a horizontal exit needs the cell and the one
    // above it. Measured 2026-09-23 at (4595, 66, 4598) - a one-high hole let bob put his feet
    // through and nothing else, and he came back to the same cell every few minutes while the
    // planner correctly said `not enclosed`, because a way out existed that the body could not use.
    check('a bot in an atrium still breaks through the wall', atriumIsOut?.dig.length, 2);
    check('and goes toward the outside', atriumIsOut.dir, 'east');
    check('the opening is two cells tall', atriumIsOut.dig.map((c) => c.y).sort().join(','), '0,1');

    // The proxy that was wrong: if open-air-overhead counted, the planner would stop where it
    // stands and report nothing to do.
    const skyCounts = planBreakOut({ from: insideAtrium,
        isSolid: (c) => c.x === 1,
        isOpen: (c) => true,                  // the discredited proxy: any air is "out"
        isBlueprint: () => false });
    check('...whereas treating any air as out finds nothing to do', skyCounts?.dig.length, 0);
}

// ---- how far to LOOK and how much to BREAK are different budgets
//
// Measured 2026-09-23 at (4603, 92, 4611): the nearest edge was twelve blocks east, the search
// stopped at eleven because it was capped by the DIG budget, and the break-out reported `no
// direction within 6 build block(s) reaches open air` about a wall it had never looked at. Most of
// the distance across a building is room, and crossing a room costs nothing.
{
    // twenty blocks of air, then one wall, then outside
    const far = { isSolid: (c) => c.x === 21, isOpen: (c) => c.x >= 22, isBlueprint: () => false };
    check('a short reach cannot see the far wall',
        planBreakOut({ from: ORIGIN, maxReach: 10, ...far }), null);
    const plan = planBreakOut({ from: ORIGIN, maxReach: 26, ...far });
    check('a long reach finds it', plan?.dir, 'east');
    check('and still breaks only the wall', plan.dig.length, 2);   // feet + head
    // the COST budget is untouched by the longer reach: a thick wall is still refused
    const thick = { isSolid: (c) => c.x >= 21 && c.x <= 26, isOpen: (c) => c.x >= 27,
                    isBlueprint: (c) => c.x >= 21 && c.x <= 26 };
    check('a long reach does not buy a bigger drill',
        planBreakOut({ from: ORIGIN, maxReach: 40, maxBlueprint: 4, ...thick }), null);
}

console.log(failures === 0 ? 'build_escape: all checks passed' : `build_escape: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
