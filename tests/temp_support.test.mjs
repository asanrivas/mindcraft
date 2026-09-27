/**
 * !placeWithSupport - one block, temporary support if it needs one.
 *
 *   bun tests/temp_support.test.mjs
 *
 * Why it matters. The builder's support chain (planSupportChain + supportDirs, tested in
 * build_support.test.mjs) was only reachable from inside a blueprint's retry rounds. The cathedral
 * finished at 99.6% with ~70 window grilles hanging in air, and there was no way to place one of
 * them on its own. This exposes the SAME path for one cell, so the command cannot drift from what
 * the builder does. Pure parts here; the live path is the builder's.
 */
import fs from 'node:fs';
import { Vec3 } from 'vec3';
import { parseBlockSpec, supportCtx, placeWithSupport } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}

// ---- the block spec: the command form of a blueprint cell
check('a bare name', parseBlockSpec('iron_bars'), { name: 'iron_bars', properties: {} });
check('states in brackets', parseBlockSpec('oak_log[axis=z]'), { name: 'oak_log', properties: { axis: 'z' } });
check('several states, spaces, namespace', parseBlockSpec(' minecraft:lever[face=wall, facing=east] '),
    { name: 'lever', properties: { face: 'wall', facing: 'east' } });
check('malformed states are refused, not guessed', parseBlockSpec('oak_log[axis]'), null);
check('junk is refused', parseBlockSpec('oak log'), null);

// ---- the one-cell context
{
    const P = new Vec3(100, 70, 200);
    const ctx = supportCtx({}, P, [{ x: 100, y: 69, z: 200 }]);
    check('supports are allowed from the start (no later pass to wait for)', ctx.allowSupports, true);
    check('the target cell is reserved - a support never goes into it', ctx.occupied.has('0,0,0'), true);
    check('protected cells are reserved too', ctx.occupied.has('0,-1,0'), true);
    check('a single placement may build a longer chain than the builder (spire bars: 14-16 links)', ctx.supportMaxLen >= 16, true);
    check('the leash box is centred on the cell', [ctx.box.centreX, ctx.box.centreZ, ctx.box.minX < P.x, ctx.box.maxZ > P.z], [100, 200, true, true]);
}

// ---- refusals that must happen before anything moves
{
    const bot = { game: { gameMode: 'survival' }, blockAt: () => ({ name: 'air' }) };
    const r = await placeWithSupport({ bot }, new Vec3(0, 70, 0), { name: 'iron_bars', properties: {} });
    check('outside creative it refuses', [r.ok, /creative/.test(r.message)], [false, true]);
    const cbot = { game: { gameMode: 'creative' }, blockAt: () => ({ name: 'air' }) };
    const a = await placeWithSupport({ bot: cbot }, new Vec3(0, 70, 0), { name: 'anvil', properties: {} });
    check('a block that falls without its support is refused, not attempted', [a.ok, /permanent/.test(a.message)], [false, true]);
    const done = { game: { gameMode: 'creative' }, blockAt: () => ({ name: 'iron_bars', getProperties: () => ({}) }) };
    const d = await placeWithSupport({ bot: done }, new Vec3(0, 70, 0), { name: 'iron_bars', properties: {} });
    check('an already-correct cell is left alone', [d.ok, /already/.test(d.message)], [true, true]);
}

// ---- the command
{
    const src = fs.readFileSync('src/agent/commands/actions.js', 'utf8');
    const i = src.indexOf("name: '!placeWithSupport'");
    const block = src.slice(i, src.indexOf("name: '!fill'", i));
    check('the command is registered', i > 0, true);
    const desc = /description: '([^']*)'/.exec(block)?.[1] ?? '';
    check('its description fits the 210-char compact render', desc.length <= 210, true);
    check('it goes through the library skill, not its own copy', /placeWithSupport\(agent, new Vec3/.test(block), true);
}

{
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    check('buildSupport honours the per-context chain length', /maxLen: ctx\.supportMaxLen \?\? SUPPORT_MAX_LEN,/.test(src), true);
}

// ---- the body must be OUT of the cell before placing into it (spire bars: 13/13 refused at link 2-3)
{
    const { bodyOverlapsCell } = await import('../src/agent/library/blueprint_builder.js');
    const P = new Vec3(10, 70, 10);
    check('hovering in the column, feet one below: overlaps', bodyOverlapsCell(new Vec3(10.5, 69.2, 10.5), P), true);
    check('feet in the cell: overlaps', bodyOverlapsCell(new Vec3(10.5, 70, 10.5), P), true);
    check('shoulder 0.2 into the cell from the side: overlaps', bodyOverlapsCell(new Vec3(9.9, 70, 10.5), P), true);
    check('beside it, clear by more than half a body: does not', bodyOverlapsCell(new Vec3(9.6, 70, 10.5), P), false);
    check('head just below the cell: does not', bodyOverlapsCell(new Vec3(10.5, 68.2, 10.5), P), false);
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    const i = src.indexOf('async function stepOff(');
    check('stepOff flies clear when there is nothing to stand on', /flight\.canFly\(bot\)/.test(src.slice(i, i + 2500)) && /bodyOverlapsCell\(bot\.entity\.position, P\)/.test(src.slice(i, i + 2500)), true);
}

// ---- the live path: approach first, and pause the modes the builder pauses
{
    const src = fs.readFileSync('src/agent/library/blueprint_builder.js', 'utf8');
    const i = src.indexOf('export async function placeWithSupport');
    const fn = src.slice(i, src.indexOf('async function placeOne(', i));
    // bob started 96 blocks from the first grille; every local flight said "out of range"
    check('it flies into range before the local placement', fn.indexOf('flight.flyTo(bot,') > 0 && fn.indexOf('flight.flyTo(bot,') < fn.indexOf('placeOne(bot, P, spec, ctx)'), true);
    check('...with a range beyond the 64-block local cap', /maxRange: 256/.test(fn), true);
    // routed 2/15 of the cathedral's last grilles at the local box, 15/15 at pad 32 / 100k nodes
    const { APPROACH_PLAN } = await import('../src/agent/library/blueprint_builder.js');
    check('the approach plans WIDE (pad >= 32, >= 100k nodes)', APPROACH_PLAN.pad >= 32 && APPROACH_PLAN.maxNodes >= 100000, true);
    check('...to any clear hover near the cell, before the fallback flight',
        fn.indexOf('flight.planFlight(bot, goals, APPROACH_PLAN)') > 0 && fn.indexOf('flight.planFlight(bot, goals, APPROACH_PLAN)') < fn.indexOf('flight.flyTo(bot,'), true);
    // a creeper fight interrupted placements mid-chain
    check('modes are paused for the placement and restored after', /bot\.modes\.pause\(m\)/.test(fn) && /bot\.modes\.unPauseAll\(\)/.test(fn), true);
}

// ---- clicking an interactive block (anvil, chest, door...) must SNEAK, or the server uses the
// block and refuses the placement - the cathedral's floating grilles are anchored only to anvils.
{
    const { INTERACTIVE_REF, placeVerified } = await import('../src/agent/library/block_io.js');
    for (const n of ['anvil', 'chest', 'crafting_table', 'oak_door', 'spruce_trapdoor', 'red_bed', 'stone_button', 'lever', 'barrel'])
        check(`${n} is clicked sneaking`, INTERACTIVE_REF.test(n), true);
    for (const n of ['stone_bricks', 'oak_log', 'dirt', 'glass', 'oak_planks', 'bedrock', 'oak_fence'])
        check(`${n} is clicked plainly`, INTERACTIVE_REF.test(n), false);
    // the wrapper: sneak on before the click, off after - even when the click fails
    const log = [];
    const bot = { setControlState: (k, v) => log.push(`${k}=${v}`), blockAt: () => null };
    await placeVerified(bot, { name: 'anvil', position: new Vec3(0, 0, 0) }, new Vec3(0, 1, 0), { verifyMs: 1, pace: false });
    check('sneak is pressed for an anvil and released afterwards', log, ['sneak=true', 'sneak=false']);
    log.length = 0;
    await placeVerified(bot, { name: 'stone', position: new Vec3(0, 0, 0) }, new Vec3(0, 1, 0), { verifyMs: 1, pace: false });
    check('...and not touched for stone', log, []);
}

console.log(failures === 0 ? 'temp_support: all checks passed' : `temp_support: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
