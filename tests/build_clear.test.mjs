/**
 * The terrain clear: what has to come OUT of the footprint before anything can go in.
 *
 *   bun tests/build_clear.test.mjs
 *
 * Why it matters. The clear phase used to be skipped whenever the site read as mostly built:
 *
 *     const resuming = sampled >= 20 && presentPct >= 25;
 *     if (meta.size && !resuming) { ...clear... }
 *
 * "The site is 95% built" is true and "therefore no terrain intrudes" does not follow from it -
 * the repo's dominant bug shape, measuring one thing and concluding another. The two facts are
 * independent, and on the wizard tower they disagreed badly: the tower stood finished to its roof
 * while 1304 of its 1999 grass_block cells were still buried in the hillside it was sited on. The
 * preflight had said so on every single run -
 *
 *     origin y=63 is 3 below grade (median surface 66) - about 4725 cells of terrain to clear
 *
 * - and every run then resumed at 95% and skipped the clear.
 *
 * Read back from the live world at (4571,63,4595), a blueprint grass_block cell: y=64 SOLID,
 * y=65 air, y=66 air, and the blueprint places NOTHING at local (1,1,1). So that solid block was
 * leftover ground, and it cost twice: the cell is unreachable, because nothing can hover inside
 * rock, and grass with an opaque block directly above it decays to dirt - which is exactly the
 * 149 `grass_block -> dirt` differences the verifier kept reporting.
 *
 * The cases that must NOT fire matter as much: a clear that digs a cell the blueprint wants, or a
 * cell holding somebody's build, is destroying the thing it is meant to be preparing for.
 */
import fs from 'node:fs';
import { Vec3 } from 'vec3';
import { layerClearTargets } from '../src/agent/library/blueprint_builder.js';

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

const origin = new Vec3(4570, 63, 4594);
const size = { width: 4, length: 4, height: 70 };
/** A world where `solid` names the cells holding something, everything else is air. */
const worldOf = (solid) => ({
    blockAt: (v) => {
        const k = `${v.x},${v.y},${v.z}`;
        return solid[k] ? { name: solid[k], boundingBox: 'block', position: v } : { name: 'air', boundingBox: 'empty', position: v };
    },
});
const has = (ts, x, y, z) => ts.some(t => t.x === x && t.y === y && t.z === z);

// ---------------------------------------------------- the measured cell, at its real coordinates
{
    // local (1,1,1) = world (4571, 64, 4595): leftover ground, and the blueprint claims nothing there
    const world = worldOf({ '4571,64,4595': 'dirt' });
    const occupied = new Set(['1,0,1']);          // the grass_block cell below it, and nothing else
    const targets = layerClearTargets(world, origin, size, occupied, 1);
    report('the block burying (4571,63,4595) is a clear target',
        has(targets, 1, 1, 1), `found ${targets.length} target(s) in layer 1`);
}

// ---------------------------------------------------- what must NOT be dug
{
    const world = worldOf({
        '4571,64,4595': 'dirt',          // leftover ground -> dig
        '4572,64,4595': 'stone',         // the blueprint wants stone here -> KEEP
        '4573,64,4595': 'oak_planks',    // somebody's build, not natural -> KEEP
        '4571,64,4596': 'deepslate',     // leftover ground -> dig
    });
    const occupied = new Set(['2,1,1']);
    const targets = layerClearTargets(world, origin, size, occupied, 1);

    check('a cell the blueprint claims is never dug', has(targets, 2, 1, 1), false);
    check('a non-natural block is never dug',         has(targets, 3, 1, 1), false);
    check('leftover ground is dug',                   has(targets, 1, 1, 1), true);
    check('...on both axes',                          has(targets, 1, 1, 2), true);
    check('and nothing else is',                      targets.length, 2);
}

// ---------------------------------------------------- air is not a target, and neither is a gap
{
    const targets = layerClearTargets(worldOf({}), origin, size, new Set(), 0);
    report('an already-clear layer yields nothing', targets.length === 0,
        `${targets.length} targets - so an unconditional clear on a clean site digs nothing`);
}

// A bot that cannot read a cell must not have it dug on a guess: an unloaded chunk is absence of
// evidence, and the builder's own rule is that absence never defaults to "fine".
{
    const blind = { blockAt: () => null };
    const targets = layerClearTargets(blind, origin, size, new Set(), 0);
    report('an unreadable cell is not assumed to be terrain', targets.length === 0,
        `${targets.length} targets from a world that returns null`);
}

// ---------------------------------------------------- the whole point: being built is not being clear
//
// The regression in one assertion. A site can be finished AND buried; the clear must not consult
// how built it looks.
{
    const world = worldOf({ '4571,64,4595': 'grass_block', '4572,64,4596': 'dirt' });
    const targets = layerClearTargets(world, origin, size, new Set(), 1);
    report('terrain is found regardless of how built the site is',
        targets.length === 2,
        `${targets.length} targets - layerClearTargets takes no "resuming" argument, so it cannot be skipped by one`);
    check('layerClearTargets has no resume parameter', layerClearTargets.length, 5);
}

// ---------------------------------------------------- and the CALL SITE, which is where it broke
//
// Everything above tests the helper. The bug was never in a helper - it was one conditional at the
// call site, and a suite that tests only the function it guards stays green while the guard is
// wrong. Proven: restoring `if (meta.size && !resuming)` left every assertion above passing. So
// assert the call site itself.
{
    const src = fs.readFileSync(new URL('../src/agent/library/blueprint_builder.js', import.meta.url), 'utf8');
    report('the clear phase is not gated on resuming',
        !/if \(meta\.size && !resuming\)/.test(src),
        'no `!resuming` guard in front of the terrain clear');
    report('and it still runs at all',
        /if \(meta\.size\) \{\s*await clearTerrainLayers\(/.test(src),
        'the clear is reached whenever the blueprint has a size');
    // `resuming` may still exist - it is honest reporting - but it must not decide anything. The
    // property is "no branch reads it", so assert that, rather than counting the word (which a log
    // string saying "resuming there" once tripped for no reason).
    // ONE branch may: the resume reorder (roofed stragglers last, tests/build_resume_order.test.mjs)
    // exists only because a resume replays the order over standing walls. It is excluded by its
    // exact shape, so a new `if (resuming)` anywhere else still fails here.
    const gates = (src.replace(/if \(resuming && meta\.size\) \{\s*const roofed = makeRoofProbe/, '')
        .match(/\b(if|while)\s*\([^)]*\bresuming\b/g) || []);
    report('resuming gates no branch', gates.length === 0,
        gates.length ? `still read by: ${gates.join(' | ')}` : 'the flag only describes the site now');
}

console.log(failures === 0 ? 'build_clear: all checks passed' : `build_clear: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
