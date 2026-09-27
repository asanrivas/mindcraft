/**
 * Orientation verification: is the block in the world facing the way the blueprint asked?
 *
 *   bun tests/facing_verify.test.mjs
 *
 * Why it matters: every verification in blueprint_builder.js used to compare the block NAME and
 * nothing else - `placeOne`'s return value, `blueprintStatus`'s match count, and the final
 * `VERIFIED BUILD` tally - so a tower of correctly-named, wrongly-facing stairs reported as a clean
 * build and `!buildStatus` agreed. The repo's dominant bug shape: measure something true (the name
 * matches), conclude something false (the blueprint is satisfied).
 *
 * It was not hypothetical. The 2026-09-21 Wizard Tower run finished with its stairs, doors and
 * chests pointing whichever way the bot happened to be looking on the PREVIOUS placement - root
 * cause in `block_io.snapLook`, which rotated the bot locally and let `block_place` overtake the
 * rotation on the wire. Measured with tools/facing_probe.mjs: 4/28 look-steered facings correct
 * before that fix, 33/33 after. Neither number was visible to the builder until this predicate
 * existed.
 *
 * The cases that must NOT fire matter most. A false positive here re-places a correct block -
 * break, re-place, re-verify - on every pass, forever.
 */
import { orientationMismatch } from '../src/agent/library/blueprint_builder.js';

let failures = 0;
function check(name, got, want) {
    const ok = got === want;
    if (!ok) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
/** A stand-in for a prismarine Block: name plus the state the server reports. */
const block = (name, props = {}) => ({ name, getProperties: () => props });

// ---- the measured defect: right block, wrong way round
check('a stair facing the wrong way is a mismatch',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east' } },
        block('spruce_stairs', { facing: 'west' })) !== null, true);
check('and it says which property and both values',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east' } },
        block('spruce_stairs', { facing: 'west' })), 'facing=west, want east');

// ---- the correct case must be silent
check('a stair facing the right way is fine',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east' } },
        block('spruce_stairs', { facing: 'east' })), null);
check('every verified prop agreeing is fine',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'north', half: 'top' } },
        block('spruce_stairs', { facing: 'north', half: 'top', shape: 'inner_left' })), null);

// ---- absence in the BLUEPRINT means "do not care": not every schematic records every state
check('a blueprint that does not name facing does not care',
    orientationMismatch({ name: 'stone', properties: {} }, block('stone', { facing: 'west' })), null);
check('a blueprint with no properties at all does not care',
    orientationMismatch({ name: 'stone' }, block('stone', { facing: 'west' })), null);

// ---- server-computed state is NOT ours to be held to
check('shape is ignored (the server derives it from neighbours)',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east', shape: 'straight' } },
        block('spruce_stairs', { facing: 'east', shape: 'inner_left' })), null);
check('waterlogged is ignored',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east', waterlogged: 'true' } },
        block('spruce_stairs', { facing: 'east', waterlogged: 'false' })), null);
// A double slab is TWO placements the builder flags on its own; comparing `type` would report every
// half-finished one as an orientation defect, which is a false positive that never converges.
check('slab type is ignored (a double slab is two placements)',
    orientationMismatch({ name: 'smooth_stone_slab', properties: { type: 'double' } },
        block('smooth_stone_slab', { type: 'bottom' })), null);

// ---- axis and rotation are checked, since the builder chooses the face that sets them
check('a log on the wrong axis is a mismatch',
    orientationMismatch({ name: 'oak_log', properties: { axis: 'x' } },
        block('oak_log', { axis: 'y' })), 'axis=y, want x');
check('a sign at the wrong rotation is a mismatch',
    orientationMismatch({ name: 'oak_sign', properties: { rotation: '8' } },
        block('oak_sign', { rotation: '12' })), 'rotation=12, want 8');
// The wire carries numbers and prismarine may hand them back as either, so 8 and "8" must agree.
check('rotation compares across string and number',
    orientationMismatch({ name: 'oak_sign', properties: { rotation: 8 } },
        block('oak_sign', { rotation: '8' })), null);

// ---- unreadable is UNVERIFIED, never "correct"
check('a missing block is reported, not passed',
    orientationMismatch({ name: 'stone', properties: { facing: 'east' } }, null), 'unreadable');
check('a property the server does not report is unset, not ignored',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east' } },
        block('spruce_stairs', {})), 'facing unset, want east');
// A block with no getProperties at all (a stub, an older prismarine) must not read as correct
// when the blueprint asked for something specific.
check('a block without getProperties still fails a specified facing',
    orientationMismatch({ name: 'spruce_stairs', properties: { facing: 'east' } },
        { name: 'spruce_stairs' }), 'facing unset, want east');

// ---- several wrong props are all named, so one report explains the whole defect
check('multiple mismatches are all reported',
    orientationMismatch({ name: 'spruce_trapdoor', properties: { facing: 'east', half: 'top' } },
        block('spruce_trapdoor', { facing: 'west', half: 'bottom' })),
    'facing=west, want east half=bottom, want top');

console.log(failures === 0 ? 'facing_verify: all checks passed' : `facing_verify: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
