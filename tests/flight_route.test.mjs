/**
 * Flight routing: can the bot find its way INTO a closed volume?
 *
 *   bun tests/flight_route.test.mjs
 *
 * Why it matters: "fly at it, and climb over if blocked" is not a route, and the end of a build is
 * exactly when the remaining cells stop being in open air. Measured 2026-09-22 on the Wizard
 * Tower: bob parked at its station at (4672, 89.5, 4618) with the remaining work at y 73-79 inside
 * the finished shell, emitting 5,238 consecutive `flyNear ... failed: flew short by 11-15 | budget
 * spent` lines while the builder reported `0 placed, 183 failed` with `140-216x out of reach (no
 * clear hover within range)` per pass. The server was not refusing anything - zero forcedMove on
 * our side, zero `moved too quickly` on its - the bot simply had no way in.
 *
 * `planFlight` only reads `bot.blockAt` and `bot.entity.position`, so the interesting geometry can
 * be asserted against a fake grid with no server at all. The cases that matter most are the two
 * that must NOT return a route: a sealed volume, and one whose only opening is unloaded chunk.
 * A router that "finds" a way through either of those flies a bot into a wall.
 */
import { Vec3 } from 'vec3';
import { planFlight, flyRoute } from '../src/agent/library/flight.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
    else console.log(`ok   ${name}`);
}
/** Like check, but for a measured property whose NUMBER is worth printing on a pass too. */
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

/**
 * A fake world. `solid` is a set of "x,y,z" keys; everything else is air, and anything outside
 * `loaded` reads as null the way an unloaded chunk does.
 */
function fakeBot(at, solid, opts = {}) {
    const inside = opts.loaded ?? (() => true);
    return {
        entity: { position: new Vec3(at.x + 0.5, at.y, at.z + 0.5) },
        blockAt(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            if (!inside(x, y, z)) return null;
            return solid.has(`${x},${y},${z}`)
                ? { name: 'stone', boundingBox: 'block' }
                : { name: 'air', boundingBox: 'empty' };
        },
    };
}

/** A hollow box from lo to hi inclusive, with an optional list of cells punched out of the shell. */
function shell(lo, hi, holes = []) {
    const s = new Set();
    for (let x = lo.x; x <= hi.x; x++)
        for (let y = lo.y; y <= hi.y; y++)
            for (let z = lo.z; z <= hi.z; z++) {
                const onShell = x === lo.x || x === hi.x || y === lo.y || y === hi.y || z === lo.z || z === hi.z;
                if (onShell) s.add(`${x},${y},${z}`);
            }
    for (const h of holes) s.delete(`${h.x},${h.y},${h.z}`);
    return s;
}

// ---- open air: a route exists and is not padded with pointless waypoints
{
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, new Set());
    const route = planFlight(bot, new Vec3(10, 70, 0));
    check('open air routes', Array.isArray(route), true);
    check('open air is smoothed to one leg', route?.length, 2);
}

// ---- a wall between start and goal: over, under or around, but a route
{
    const solid = new Set();
    for (let y = 60; y <= 80; y++) for (let z = -8; z <= 8; z++) solid.add(`5,${y},${z}`);
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, solid);
    const route = planFlight(bot, new Vec3(10, 70, 0));
    check('a wall is routed around', Array.isArray(route), true);
    // Every waypoint must be somewhere the body actually fits, or the "route" is a wish.
    const allClear = (route ?? []).every(w => !solid.has(`${Math.floor(w.x)},${Math.floor(w.y)},${Math.floor(w.z)}`));
    check('no waypoint is inside the wall', allClear, true);
}

// ---- THE MEASURED CASE: the work is inside a shell with one opening
{
    const door = { x: 4, y: 71, z: 0 };          // a 1-block gap, two tall (71 and 72 are free)
    const solid = shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 }, [door, { x: 4, y: 72, z: 0 }]);
    const bot = fakeBot({ x: 8, y: 75, z: 0 }, solid);   // outside and above, like the station
    const route = planFlight(bot, new Vec3(0, 71, 0));
    check('a shell with a door is enterable', Array.isArray(route), true);
    // The PATH must cross the wall at the door - sampled along each leg, not only at waypoints: a
    // smoothed route may fly straight through the doorway without a waypoint inside it.
    const crossings = [];
    for (let i = 1; i < (route ?? []).length; i++) {
        const a = route[i - 1], b = route[i], d = b.minus(a), n = Math.ceil(d.norm() / 0.1);
        for (let k = 0; k <= n; k++) { const q = a.plus(d.scaled(k / n)); if (Math.floor(q.x) === door.x) crossings.push(q); }
    }
    const viaDoor = crossings.length > 0
        && crossings.every(q => Math.floor(q.z) === door.z && Math.floor(q.y) === door.y);
    check('the route goes through the opening', viaDoor, true);
}

// ---- and the case that must fail: sealed
{
    const solid = shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 });
    const bot = fakeBot({ x: 8, y: 75, z: 0 }, solid);
    check('a sealed shell returns no route', planFlight(bot, new Vec3(0, 71, 0)), null);
}

// ---- an unloaded cell is NOT free space: a route may not be invented through what we cannot see
{
    const door = { x: 4, y: 71, z: 0 };
    const solid = shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 }, [door, { x: 4, y: 72, z: 0 }]);
    const bot = fakeBot({ x: 8, y: 75, z: 0 }, solid, { loaded: (x) => x !== 4 });  // the door column is unloaded
    check('an unloaded opening is not a route', planFlight(bot, new Vec3(0, 71, 0)), null);
}

// ---- a destination the body cannot occupy is "no route", not a crash
{
    const solid = new Set(['10,70,0']);
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, solid);
    check('a solid destination returns null', planFlight(bot, new Vec3(10, 70, 0)), null);
}

// ---- the head cell counts too: a 1-block-high slot is not flyable
{
    const solid = new Set();
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) solid.add(`${x},72,${z}`); // ceiling
    for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) solid.add(`${x},70,${z}`); // floor
    // The only free layer is y=71, one block tall: feet fit, head does not.
    const bot = fakeBot({ x: 0, y: 71, z: 0 }, solid);
    check('a one-block-tall gap is refused', planFlight(bot, new Vec3(8, 71, 0)), null);
}

// ---- the smoother must answer for the BODY, not for a point
{
    // A block at (2,70,1) that the centre line from (0.5,0.5) to (4.5,4.5) never enters - on that
    // line x === z, so floor(x)=2 with floor(z)=1 is impossible - but the 0.6-wide body clips its
    // corner at x≈2.1. A point-only check smooths this into one diagonal leg and the flight then
    // stops dead on a block the plan called clear (measured live as `route of 5 legs left 10.2`).
    const solid = new Set(['2,70,1', '2,71,1']);
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, solid);
    const route = planFlight(bot, new Vec3(4, 70, 4));
    check('a corner the body would clip is not smoothed through', (route?.length ?? 0) > 2, true);
    // and with nothing in the way the same pair of endpoints IS one leg, so the check above is
    // measuring the obstruction rather than a smoother that simply never smooths.
    const open = planFlight(fakeBot({ x: 0, y: 70, z: 0 }, new Set()), new Vec3(4, 70, 4));
    check('the same diagonal is one leg when clear', open?.length, 2);
}

// ---- flight is a LOCAL manoeuvre: a cross-country goal is refused rather than half-flown
{
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, new Set());
    check('a 400-block goal is refused by range', planFlight(bot, new Vec3(400, 70, 0)), null);
    const near = planFlight(bot, new Vec3(30, 70, 0));
    check('a 30-block goal is in range', Array.isArray(near), true);
    // The cap is a parameter, not a belief: a caller that knows better can raise it.
    check('the range cap is a parameter', Array.isArray(planFlight(bot, new Vec3(80, 70, 0), { maxRange: 128, pad: 4 })), true);
}

// ---- an interrupt must STOP the route, not spin it
// This is the one that took a bot down. `flyDirect` returns instantly while `bot.interrupt_code` is
// set, so without this check every leg "fails", the caller replans, and the loop runs as fast as the
// CPU allows: measured after a `!stop` as 1,524 no-progress legs and 781 wedges in 70 seconds,
// followed by the server dropping the client and the agent process exiting with code 1.
{
    let reads = 0;
    const bot = {
        interrupt_code: true,
        username: 'test',
        entity: { position: new Vec3(0.5, 70, 0.5), velocity: new Vec3(0, 0, 0) },
        blockAt() { reads++; return { name: 'air', boundingBox: 'empty' }; },
    };
    const t0 = Date.now();
    const left = await flyRoute(bot, [new Vec3(0.5, 70, 0.5), new Vec3(10.5, 70, 0.5)]);
    const ms = Date.now() - t0;
    check('an interrupted route returns at once', ms < 100, true);
    check('and reports the distance it did not fly', Math.round(left), 10);
}

// ---- hover candidates: prefer cells the body can get OUT of
//
// Measured 2026-09-23 on the wizard tower. Bob was repeatedly sealed inside his own build - the
// planner reporting `NO ROUTE for a 0.6x1.8 body, 45.7 away - sealed in, or no body-sized opening`
// and the escape reporting `the obstruction is sideways` - yet of the 922 cells he had left, only
// 45 actually required being inside. He was ending up there because `nearbyClearHovers` returns
// "anywhere nearby that is free", and a cell under a roof is often nearer than one in open air.
//
// The ranking is a PREFERENCE, never a filter: interior work is real work, and refusing roofed
// hovers would make the inside of every finished building unbuildable.
{
    const { nearbyClearHovers, isBoxedIn } = await import('../src/agent/library/flight.js');
    // A world with a roof slab over the near side of the target, open air on the far side.
    const roofY = 12;
    const fake = (roofed) => ({
        blockAt: (v) => {
            if (v.y < 5) return { boundingBox: 'block', name: 'stone' };
            // the roof covers x <= 0 only
            if (v.y === roofY && v.x <= 0 && roofed) return { boundingBox: 'block', name: 'stone' };
            return { boundingBox: 'empty', name: 'air' };
        },
    });
    const bot = fake(true);
    check('a cell under the roof is boxed in', isBoxedIn(bot, { x: -1.5, y: 8, z: 0.5 }), 1);
    check('a cell in open air is not', isBoxedIn(bot, { x: 3.5, y: 8, z: 0.5 }), 0);
    // An unreadable column is boxed in, never "open" - absence of evidence is not free space.
    check('an unloaded column counts as boxed in',
        isBoxedIn({ blockAt: () => null }, { x: 0.5, y: 8, z: 0.5 }), 1);

    const P = { x: 0, y: 8, z: 0 };
    const hovers = nearbyClearHovers(bot, P);
    report('candidates are returned', hovers.length > 0, `${hovers.length} clear hovers`);
    const boxed = hovers.map((h) => isBoxedIn(bot, h));
    const firstOpen = boxed.indexOf(0);
    const lastOpen = boxed.lastIndexOf(0);
    const firstBoxed = boxed.indexOf(1);
    report('every open candidate precedes every roofed one',
        firstBoxed === -1 || lastOpen < firstBoxed,
        `open at 0..${lastOpen}, first roofed at ${firstBoxed} of ${hovers.length}`);
    report('roofed candidates are kept, not dropped', firstBoxed !== -1 || boxed.length > 0,
        `${boxed.filter((b) => b === 1).length} roofed candidates still offered`);
    // ...and within a group the nearest still wins, or the travel win is lost.
    const open = hovers.filter((h) => !isBoxedIn(bot, h));
    const eye = (h) => Math.hypot(h.x - (P.x + 0.5), (h.y + 1.62) - (P.y + 0.5), h.z - (P.z + 0.5));
    let ascending = true;
    for (let i = 1; i < open.length; i++) if (eye(open[i]) < eye(open[i - 1]) - 1e-9) ascending = false;
    check('nearest-first still holds within the open group', ascending, true);
}

// ---- a SET of goals: any reachable one will do, and one sealed goal must not sink the rest.
// flyNear used to plan to its FIRST clear candidate only; when that one sat in a pocket, the cell
// failed with a dozen reachable candidates untried (measured on the cathedral 2026-09-26: 81% of
// leftover cells routed that way, 90% with every candidate as a goal).
{
    const solid = shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 });
    const bot = fakeBot({ x: 8, y: 75, z: 0 }, solid);
    const sealedGoal = new Vec3(0, 71, 0), openGoal = new Vec3(8, 71, 6);
    const route = planFlight(bot, [sealedGoal, openGoal]);
    check('a sealed first goal does not stop the search reaching another', Array.isArray(route), true);
    const end = route?.[route.length - 1];
    check('...and the route ends at the reachable one', end ? `${Math.floor(end.x)},${end.y},${Math.floor(end.z)}` : null, '8,71,6');
    check('a set of only sealed goals is still no route', planFlight(bot, [sealedGoal, new Vec3(1, 71, 1)]), null);
    check('a single goal still works as before', Array.isArray(planFlight(bot, openGoal)), true);
}
{
    const src = (await import('node:fs')).readFileSync('src/agent/library/flight.js', 'utf8');
    report('flyNear plans to EVERY clear candidate, not the first',
        /const routable = tries\.filter\(p => hoverIsClear\(bot, p\)\)/.test(src)
        && /planFlight\(bot, routable, \{ maxNodes: FLYNEAR_ROUTE_MAX_NODES \}\)/.test(src), 'routable = tries.filter(...), one search');
}

// ---- flyNear skips the direct flight when the straight line is blocked, and plans instead.
{
    const { lineIsClear } = await import('../src/agent/library/flight.js');
    const wall = new Set();
    for (let y = 65; y <= 80; y++) for (let z = -5; z <= 5; z++) wall.add(`4,${y},${z}`);
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, wall);
    check('a wall across the line: blocked', lineIsClear(bot, { x: 0.5, y: 70, z: 0.5 }, { x: 8.5, y: 70, z: 0.5 }), false);
    check('open air: clear', lineIsClear(bot, { x: 0.5, y: 70, z: 0.5 }, { x: 3.5, y: 70, z: 3.5 }), true);
    const src = (await import('node:fs')).readFileSync('src/agent/library/flight.js', 'utf8');
    report('flyNear skips a direct flight whose line is blocked, before flying',
        src.indexOf("rejected.push(`line blocked@") !== -1
        && src.indexOf("rejected.push(`line blocked@") < src.indexOf("const short = await flyTo(bot, p, { ...opts, route: false"),
        'line check precedes the direct flyTo');
}

// ---- planEscape: the NEAREST way out of the footprint, not a route to one fixed point.
// The cathedral stopped at 95.5% with bob 33 blocks inside the nave and five rescues aimed at a
// point behind the wall; every interior spot there did connect to open air.
{
    const { planEscape } = await import('../src/agent/library/flight.js');
    const box = { minX: -4, maxX: 4, minZ: -4, maxZ: 4, topY: 78 };
    const door = { x: -4, y: 71, z: 2 };
    const solid = shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 }, [door, { x: -4, y: 72, z: 2 }]);
    const bot = fakeBot({ x: 2, y: 71, z: -2 }, solid);
    const way = planEscape(bot, box);
    check('from inside a shell with a door, a way out exists', Array.isArray(way), true);
    const end = way?.[way.length - 1];
    check('...and it ends outside the footprint', !!end && (end.x < box.minX || end.x > box.maxX + 1 || end.z < box.minZ || end.z > box.maxZ + 1), true);
    check('...through the door', (way ?? []).some(w => Math.floor(w.x) === door.x && Math.floor(w.z) === door.z) || (end && Math.floor(end.x) < door.x), true);
    const sealed = fakeBot({ x: 2, y: 71, z: -2 }, shell({ x: -4, y: 68, z: -4 }, { x: 4, y: 78, z: 4 }));
    check('a sealed shell has no way out', planEscape(sealed, box), null);
    const src = (await import('node:fs')).readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    report('the wedge rescue falls back to the nearest way out when the park spot falls short',
        /if \(rescued >= 5 && !bot\.interrupt_code\) \{\s*const way = flight\.planEscape\(bot, ctx\.box\);/.test(src), 'rescued >= 5 -> planEscape');
}

// ---- a CLIMBING leg must clear the whole body, not the feet cell and the one above.
// At fractional y a 1.8-tall body reaches a third cell; 13 of 183 live cathedral legs clipped one.
{
    const { lineIsClear } = await import('../src/agent/library/flight.js');
    // a ceiling block at y=72 over x=3: at integer y=70 the body spans 70-71.8 and fits under it,
    // but a leg climbing from y=70 to y=71 passes x=3 at y~70.4, where the head reaches 72.2.
    const solid = new Set(['3,72,0']);
    const bot = fakeBot({ x: 0, y: 70, z: 0 }, solid);
    check('level under a low ceiling: clear', lineIsClear(bot, { x: 0.5, y: 70, z: 0.5 }, { x: 6.5, y: 70, z: 0.5 }), true);
    check('climbing into that ceiling: blocked', lineIsClear(bot, { x: 0.5, y: 70, z: 0.5 }, { x: 6.5, y: 71, z: 0.5 }), false);
}

console.log(failures === 0 ? 'flight_route: all checks passed' : `flight_route: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
