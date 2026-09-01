/**
 * Which mobs the bot will fight:
 *   bun tests/hostile.test.mjs
 *
 * `isHostile` decides whether `self_defense` attacks, whether `cowardice` flees, and what
 * `!shoot` may target. It used to end in three substring tests, and `"villager".includes("illager")`
 * is true - the same defect as `"sandstone".includes("sand")`, which CLAUDE.md already warned
 * about for blocks. It cost 469,887 `[SELF_DEFENSE]` log lines and a pathfinder query per tick
 * for as long as a villager stood nearby.
 *
 * The false NEGATIVES matter as much as the positives here: a substring list that happens to
 * catch every hostile today silently stops catching one the day a mob is renamed.
 */
import { isHostile } from '../src/utils/mcdata.js';

let failures = 0;
const check = (name, want) => {
    const got = isHostile({ name });
    if (got !== want) { console.error(`FAIL ${name}: got ${got}, expected ${want}`); failures++; }
};

// THE BUG. A villager is not an illager, however the substring reads.
check('villager', false);
// ...and the neighbours the same hack broke: both are passive mounts.
check('skeleton_horse', false);
check('zombie_horse', false);
// The false NEGATIVE the same hack produced - a real illager containing no "illager".
check('illusioner', true);

// Genuinely hostile, including the zombie/skeleton family that must stay covered now that
// the substring shortcut is gone. If someone re-adds `includes('zombie')`, these still pass -
// which is why the four cases above are the ones that actually guard the change.
for (const n of ['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'wither_skeleton',
                 'stray', 'bogged', 'creeper', 'spider', 'enderman', 'witch', 'pillager',
                 'vindicator', 'evoker', 'ravager', 'warden', 'blaze', 'ghast', 'wither'])
    check(n, true);

// NEUTRAL IS NOT HOSTILE. These attack only when provoked, and attacking first is how the bot
// starts a fight it did not need - the comment in mcdata.js says so and the test enforces it.
for (const n of ['zombified_piglin', 'piglin', 'wolf', 'bee', 'iron_golem', 'polar_bear',
                 'llama', 'panda', 'dolphin'])
    check(n, false);

// Plainly friendly.
for (const n of ['villager', 'wandering_trader', 'allay', 'cat', 'snow_golem', 'cow', 'sheep'])
    check(n, false);

// Degrade safely - this runs inside a per-tick entity scan.
if (isHostile(null) !== false) { console.error('FAIL null'); failures++; }
if (isHostile({}) !== false) { console.error('FAIL nameless'); failures++; }

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('hostile: all checks passed');
