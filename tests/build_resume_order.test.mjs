/**
 * On a RESUMED build, missing cells with built work above them are placed last.
 *
 *   bun tests/build_resume_order.test.mjs
 *
 * Why it matters. A resume replays the bottom-up order over a site whose walls already stand, so
 * every lower-layer straggler is inside the building. Measured 2026-09-25: the cathedral resumed at
 * 63% and spent 2h38m in layers 0-12 placing 260 blocks, then wedged in a gallery 13 blocks from
 * open ground - with 13,000 open-sky cells above it untouched. See roofedLast in blueprint_builder.js.
 */
import fs from 'node:fs';
import { roofedLast, makeRoofProbe, ROOF_CLEARANCE } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
function report(name, ok, detail) {
    if (!ok) { failures++; console.log(`FAIL ${name}: ${detail}`); }
    else console.log(`ok   ${name} (${detail})`);
}

// ---- the partition: stable, roofed to the end, nothing lost
{
    const list = [{ id: 1, r: 1 }, { id: 2 }, { id: 3, r: 1 }, { id: 4 }, { id: 5 }];
    const n = roofedLast(list, p => !!p.r);
    check('roofed cells move to the end, both halves in their original order', list.map(p => p.id), [2, 4, 5, 1, 3]);
    check('...reports how many moved', n, 2);
    check('...in place, on the array the pass loop iterates', list.length, 5);
}

// ---- the probe: a column with a floor far above is roofed; open sky or a block right on top is not
{
    const origin = { x: 100, y: 60, z: 200 };
    // column (0,0): solid at local y=10. column (1,0): nothing. column (2,0): solid at local y=3.
    const solid = new Set(['100,70,200', '102,63,200']);
    const bot = { blockAt: (v) => ({ name: solid.has(`${v.x},${v.y},${v.z}`) ? 'stone' : 'air', boundingBox: solid.has(`${v.x},${v.y},${v.z}`) ? 'block' : 'empty' }) };
    const roofed = makeRoofProbe(bot, origin, 20);
    check('a floor built well above the cell roofs it', roofed({ x: 0, y: 2, z: 0 }), true);
    check('open sky above: not roofed', roofed({ x: 1, y: 2, z: 0 }), false);
    check(`a block within ${ROOF_CLEARANCE} above: still reachable from the side, not roofed`, roofed({ x: 2, y: 1, z: 0 }), false);
    check('a cell above the column top: not roofed', roofed({ x: 0, y: 12, z: 0 }), false);
}

// ---- the call site: gated on a resume, only MISSING cells, before the passes, both passes
{
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    const at = src.indexOf('if (resuming && meta.size) {\n            const roofed = makeRoofProbe');
    const loop = src.indexOf("for (const [passName, list] of [['pass1', pass1], ['pass2', pass2]])");
    report('the reorder runs on a resume, before the pass loop', at !== -1 && loop !== -1 && at < loop, `at ${at}, loop ${loop}`);
    const block = src.slice(at, loop);
    report('...on both passes', /roofedLast\(pass1,/.test(block) && /roofedLast\(pass2,/.test(block), 'pass1 and pass2');
    report('...deferring only cells that are not already done', /!cellIsDone\(q,/.test(block), '!cellIsDone');
}

// ---- the terrain clear: on a resume, terrain under built work is not flown to either
{
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    report('the clear is handed the roof probe on a resume',
        /await clearTerrainLayers\([^;]*\{ skip: resuming \? makeRoofProbe\(/.test(src), 'skip: resuming ? makeRoofProbe(...)');
    report('...and filters its targets with it', /const kept = targets\.filter\(t => !skip\(t\)\)/.test(src), 'targets.filter(!skip)');
}

console.log(failures === 0 ? 'build_resume_order: all checks passed' : `build_resume_order: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
