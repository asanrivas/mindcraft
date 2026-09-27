/**
 * WHERE a build goes, decided before a block moves: act on the preflight instead of logging it and
 * building somewhere else.
 *
 *   bun tests/build_site.test.mjs
 *
 * Why it matters. The preflight has long known the right answer and then built at the wrong one.
 * 2026-09-24, the cathedral, started at y=63 because that is where bob happened to be standing:
 *
 *   preflight: origin y=63 is 3 above grade (median surface 60) - the base will float or need
 *              fill. Suggested origin y: 60
 *
 * logged, and proceeded. The fill that followed ran down through a pond at y=61, bob followed it
 * under, and the drowning interrupt killed the process - after the build had ALSO been begun once
 * already at (892,64,4653), twenty blocks away, footprints overlapping. The user's verdict on the
 * wizard tower, which spent three days repairing what it should never have got wrong: a bot should
 * not make mistakes from the start and spend its time fixing them.
 *
 * The cases that must NOT fire matter as much: a build already under way must never be moved or
 * refused - that strands the work - and an unreadable site is not evidence of a fresh one.
 */
import fs from 'node:fs';
import { decideSite, wetLimit, recordedSiteFor, preflightBuild }
    from '../src/agent/library/blueprint_builder.js';

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

// A 20x20 footprint of plain stone - the names always check out, so only grade and water vary.
const cells = [];
for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) cells.push({ x, y: 0, z, name: 'stone' });

/** A world with ground at `ground` everywhere, and optionally a pond. */
function world({ ground, pond = null }) {
    // pond: {x0, x1, z0, z1, floor, top} - water from floor+1 to top, solid at floor
    const inPond = (x, z) => pond && x >= pond.x0 && x <= pond.x1 && z >= pond.z0 && z <= pond.z1;
    return {
        hasItem: () => true,
        naturalAt: () => true,
        surfaceAt: (x, z) => inPond(x, z) ? pond.floor : ground,
        waterAt: (x, y, z) => inPond(x, z) && y > pond.floor && y <= pond.top,
        solidAt: (x, y, z) => y <= (inPond(x, z) ? pond.floor : ground),
    };
}
const at = (probe) => (o) => preflightBuild(cells, o, probe);

// ================================================== off grade: build AT the grade, and say so
{
    // the cathedral's own numbers: asked for 63, ground at 60
    const d = decideSite({ requested: { x: 880, y: 63, z: 4637 }, fresh: true, preflightAt: at(world({ ground: 60 })) });
    check('a fresh site above grade is built at the grade', d.origin.y, 60);
    check('...only y moves: x stays where it was asked for', d.origin.x, 880);
    check('...and z', d.origin.z, 4637);
    report('...and it says so', d.notes.length === 1 && /above grade/.test(d.notes[0]), d.notes[0]);
    check('...and builds', d.action, 'build');
}
{
    const d = decideSite({ requested: { x: 0, y: 60, z: 0 }, fresh: true, preflightAt: at(world({ ground: 63 })) });
    check('a fresh site below grade is raised to the grade', d.origin.y, 63);
    report('...naming the direction', /below grade/.test(d.notes[0]), d.notes[0]);
}
{
    const d = decideSite({ requested: { x: 0, y: 60, z: 0 }, fresh: true, preflightAt: at(world({ ground: 60 })) });
    check('a site already at grade is left alone', d.origin.y, 60);
    check('...with nothing to say', d.notes.length, 0);
}

// ================================================== wet: refuse, counting what it found
{
    // The cathedral case exactly: base plane DRY (y=63, pond tops out at 61), pond in the fill.
    // Measured before this change as silence - the old check looked only at the base plane.
    const probe = world({ ground: 63, pond: { x0: 0, x1: 11, z0: 0, z1: 11, floor: 57, top: 61 } });
    const pf = preflightBuild(cells, { x: 0, y: 63, z: 0 }, probe);
    report('water BELOW a dry base plane is seen', pf.wetColumns > 0,
        `${pf.wetColumns} of ${pf.sampled} sampled columns wet - the base plane alone would have said 0`);

    const d = decideSite({ requested: { x: 0, y: 63, z: 0 }, fresh: true, preflightAt: at(probe) });
    check('a fresh site over a pond is refused', d.action, 'refuse');
    report('...and the refusal says what to do', /Pick dry ground/.test(d.why), d.why);
}
{
    // A puddle is filled, not refused: one wet column out of 25 sampled.
    const probe = world({ ground: 63, pond: { x0: 0, x1: 0, z0: 0, z1: 0, floor: 60, top: 62 } });
    const d = decideSite({ requested: { x: 0, y: 63, z: 0 }, fresh: true, preflightAt: at(probe) });
    report('a single wet column does not refuse the site', d.action === 'build',
        `${d.pf.wetColumns} wet of ${d.pf.sampled}, limit ${wetLimit(d.pf.sampled)}`);
}
{
    // Water below the first SOLID block is not in the fill - an aquifer under the ground is not a pond.
    const probe = {
        hasItem: () => true, naturalAt: () => true, surfaceAt: () => 63,
        solidAt: (x, y) => y <= 63,
        waterAt: (x, y) => y === 58,           // deep under solid ground
    };
    const pf = preflightBuild(cells, { x: 0, y: 64, z: 0 }, probe);
    check('water under solid ground is not a wet foundation', pf.wetColumns, 0);
}
// ================================================== ground out of the foundation's reach, wet OR dry
{
    // The cathedral as measured 2026-09-25: a lake up to 26 deep under a fifth of the footprint.
    const probe = world({ ground: 60, pond: { x0: 0, x1: 11, z0: 0, z1: 11, floor: 35, top: 61 } });
    const pf = preflightBuild(cells, { x: 0, y: 63, z: 0 }, probe);
    report('ground deeper than the foundation reaches is counted', pf.unsupportedColumns > 0,
        `${pf.unsupportedColumns} of ${pf.sampled} sampled columns out of reach`);
    const d = decideSite({ requested: { x: 0, y: 63, z: 0 }, fresh: true, preflightAt: at(probe) });
    check('a fresh site over a deep lake is refused', d.action, 'refuse');
    report('...for being out of reach, which is the fault that cannot be fixed by filling',
        /no ground within 8 blocks/.test(d.why), d.why);
}
{
    // A DRY drop is the same fault. The water check alone passed this, and it would have failed
    // exactly like the lake: base cells over nothing, never placeable.
    const cliff = {
        hasItem: () => true, naturalAt: () => true,
        surfaceAt: (x) => (x < 12 ? 40 : 63),
        waterAt: () => false,
        solidAt: (x, y) => y <= (x < 12 ? 40 : 63),
    };
    const pf = preflightBuild(cells, { x: 0, y: 64, z: 0 }, cliff);
    check('a dry cliff has no water', pf.wetColumns, 0);
    report('...but IS out of reach', pf.unsupportedColumns > 0, `${pf.unsupportedColumns} columns over a 23-block drop`);
    // fresh:false so the grade does not move it first - this isolates the reach refusal
    const d = decideSite({ requested: { x: 0, y: 64, z: 0 }, fresh: true,
        preflightAt: (o) => ({ ...preflightBuild(cells, o, cliff), gradeDelta: 0 }) });
    check('a fresh site on a cliff edge is refused', d.action, 'refuse');
}
{
    // Unreadable is not "no ground": an unloaded chunk must never refuse a site on a guess.
    const blind = { hasItem: () => true, naturalAt: () => true, surfaceAt: () => 63, waterAt: () => false, solidAt: () => null };
    const pf = preflightBuild(cells, { x: 0, y: 64, z: 0 }, blind);
    check('an unreadable column is not counted as out of reach', pf.unsupportedColumns, 0);
}
{
    // Within reach, even through water, is supportable: the 511 shallow-wet cathedral columns.
    const probe = world({ ground: 60, pond: { x0: 0, x1: 0, z0: 0, z1: 0, floor: 57, top: 61 } });
    const pf = preflightBuild(cells, { x: 0, y: 63, z: 0 }, probe);
    check('a shallow pond is in reach', pf.unsupportedColumns, 0);
}

check('the wet limit is at least two columns', wetLimit(10), 2);
check('...and 2% of a big sample', wetLimit(504), 11);

// ================================================== a build under way is NEVER moved or refused
{
    const probe = world({ ground: 60, pond: { x0: 0, x1: 19, z0: 0, z1: 19, floor: 55, top: 62 } });
    const d = decideSite({ requested: { x: 880, y: 63, z: 4637 }, fresh: false, preflightAt: at(probe) });
    check('not fresh: built exactly where asked', d.origin.y, 63);
    check('not fresh: never refused, even over water', d.action, 'build');
    check('not fresh: nothing to say', d.notes.length, 0);
}

// ================================================== the ledger: one blueprint, one site
{
    const sites = { 'blueprints/cathedral.json': { x: 880, y: 63, z: 4637, ts: 1 } };
    const size = { width: 69, length: 110 };
    // the real second request, twenty blocks from the first
    const snap = recordedSiteFor(sites, 'blueprints/cathedral.json', { x: 892, y: 64, z: 4653 }, size);
    report('an overlapping request resumes at the recorded site',
        snap && snap.x === 880 && snap.y === 63 && snap.z === 4637, JSON.stringify(snap));
    // a request far enough away that the footprints cannot touch is a genuinely new site
    check('a non-overlapping request is a new site',
        recordedSiteFor(sites, 'blueprints/cathedral.json', { x: 880 + 69, y: 63, z: 4637 }, size), null);
    check('...on the other axis too',
        recordedSiteFor(sites, 'blueprints/cathedral.json', { x: 880, y: 63, z: 4637 + 110 }, size), null);
    // just inside the overlap on both axes still snaps
    report('one block of overlap is still an overlap',
        recordedSiteFor(sites, 'blueprints/cathedral.json', { x: 880 + 68, y: 63, z: 4637 + 109 }, size) !== null,
        'footprints intersect in one column');
    // a different blueprint never snaps to another's site
    check('another blueprint is unaffected',
        recordedSiteFor(sites, 'blueprints/wizard_tower.json', { x: 880, y: 63, z: 4637 }, size), null);
    check('an empty ledger records nothing', recordedSiteFor({}, 'blueprints/cathedral.json', { x: 0, y: 0, z: 0 }, size), null);
}

// ================================================== the CALL SITE, in order
//
// Twice in this builder a helper tested green while the defect sat in the line that called it: the
// facing skip, and the resume gate on the terrain clear. So pin the wiring, as an order of
// operations in buildBlueprint - each step is only correct if it happens before the next one.
{
    const src = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function buildBlueprint('));
    const pos = (needle) => body.indexOf(needle);
    const snap = pos('recordedSiteFor(readSites(agent)');
    const ctxAt = pos('const ctx = {');
    const decideAt = pos('const decision = decideSite(');
    const refuseAt = pos("if (decision.action === 'refuse')");
    const recordAt = pos('recordSite(agent, filePath, origin)');
    const flyAt = pos('ctx.flying = flight.beginFlight(bot)');

    report('the ledger is read BEFORE ctx derives anything from origin', snap > 0 && snap < ctxAt,
        `ledger @${snap}, ctx @${ctxAt}`);
    report('the site is decided before flight begins', decideAt > 0 && decideAt < flyAt,
        `decide @${decideAt}, flight @${flyAt}`);
    report('a refusal returns before flight begins, so there is nothing to stand down',
        refuseAt > decideAt && refuseAt < flyAt, `refuse @${refuseAt}`);
    report('the site is recorded only after it is decided, and before building',
        recordAt > refuseAt && recordAt < flyAt, `record @${recordAt}`);
    // `fresh` must be MEASURED - a literal here would switch the whole feature off, or on for resumes
    report('fresh is measured, and never true for a recorded site',
        /const fresh = !recorded && here\.sampled >= 20 && here\.alreadyThere \/ here\.sampled < 0\.05;/.test(body),
        'fresh = !recorded && >=20 readable cells && under 5% already standing');
    report('the refusal undoes the mode pauses it made', /REFUSING to start[\s\S]{0,300}unPauseAll\(\)[\s\S]{0,120}return `NOT STARTED/.test(body),
        'modes are unpaused on the early return');
}

console.log(failures === 0 ? 'build_site: all checks passed' : `build_site: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
