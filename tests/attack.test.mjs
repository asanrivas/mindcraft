/**
 * "It left the area" is not "it died":
 *   bun tests/attack.test.mjs
 *
 * `attackEntity(kill=true)` used to wait with
 *
 *     while (world.getNearbyEntities(bot, 24).includes(entity)) { ... }
 *     log(bot, `Successfully killed ${entity.name}.`);
 *     return true;
 *
 * so an animal that simply RAN AWAY was reported as a kill. `!attack`, `defendSelf` and
 * `mode:hunting` all inherited that, and `npc/item_goal.js` counted the flight as dinner and
 * moved on with an empty bag. A bot that believes it ate cannot fix being hungry.
 *
 * These states are the reason this is a pure function: a live run only ever exercises whichever
 * one the world happens to hand it, and the ones that must NOT report a kill are the point.
 */
import { attackOutcome, attackReport } from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

const alive = { id: 7, name: 'cow', health: 10 };
const dead  = { id: 7, name: 'cow', health: 0 };

// --- THE BUG ------------------------------------------------------------------------------
// Out of the radius, in perfect health, with no death event: that is a flight, and it was the
// case the old code called a kill.
check('a healthy animal that left the radius FLED',
    attackOutcome({ entity: alive, deathSeen: false, present: false, timedOut: false }), 'fled');
// The same shape with the entity already dropped from bot.entities. Still not a kill: mineflayer
// clears the entity for a view-distance exit exactly as it does for a death.
check('a vanished entity with no death event FLED',
    attackOutcome({ entity: null, deathSeen: false, present: false, timedOut: false }), 'fled');
// `isValid === false` is explicitly NOT evidence - see farming.killConfirmed.
check('isValid=false alone is not a kill',
    attackOutcome({ entity: { id: 7, name: 'cow', isValid: false }, deathSeen: false, present: false }), 'fled');

// --- POSITIVE EVIDENCE --------------------------------------------------------------------
check('health 0 is a kill',
    attackOutcome({ entity: dead, deathSeen: false, present: true, timedOut: false }), 'killed');
check('an observed entityDead is a kill even with the entity gone',
    attackOutcome({ entity: null, deathSeen: true, present: false, timedOut: false }), 'killed');

// --- PRECEDENCE ---------------------------------------------------------------------------
// A confirmed kill outranks an interrupt and a deadline: the mob is dead either way, and
// reporting "interrupted" would send the bot back for a corpse.
check('a kill on the same tick as an interrupt is still a kill',
    attackOutcome({ entity: dead, deathSeen: false, interrupted: true, present: true }), 'killed');
check('a kill on the deadline tick is still a kill',
    attackOutcome({ entity: null, deathSeen: true, timedOut: true, present: false }), 'killed');
// An interrupt outranks absence: we stopped, we did not lose it.
check('interrupted beats fled',
    attackOutcome({ entity: alive, deathSeen: false, interrupted: true, present: false }), 'interrupted');
check('the deadline is only reached while the target is still there',
    attackOutcome({ entity: alive, deathSeen: false, present: true, timedOut: true }), 'timeout');

// --- KEEP FIGHTING ------------------------------------------------------------------------
check('present, healthy, in time: keep swinging',
    attackOutcome({ entity: alive, deathSeen: false, present: true, timedOut: false }), 'fighting');
// Missing inputs must not read as evidence of anything. `present` defaults to undefined, which
// is deliberately not `false` - an unknown radius reading must not be reported as a flight.
check('an empty state is not a kill and not a flight',
    attackOutcome({}), 'fighting');
check('a null entity with nothing else known is not a kill',
    attackOutcome({ entity: null }), 'fighting');
// health is a number test, not a truthiness test: `undefined <= 0` is false but so is any
// accidental coercion, and a mob with no health field must never read as dead.
check('an entity with no health field is not dead',
    attackOutcome({ entity: { id: 7, name: 'cow' }, present: true }), 'fighting');

// --- THE SENTENCE THE MODEL READS ---------------------------------------------------------
// A refusal that does not name itself is indistinguishable from the branch never running, and
// "fled" in particular has to be unmistakable: it is the outcome that used to read as success.
check('the kill line is unchanged', attackReport('killed', 'cow', '3.0'), 'Successfully killed cow.');
const fledLine = attackReport('fled', 'cow', '9.0');
check('the flight line says NOT killed', /NOT killed/.test(fledLine), true);
check('the flight line does not say killed on its own',
    /^Successfully/.test(fledLine), false);
check('the timeout line names the wait', /9.0s/.test(attackReport('timeout', 'cow', '9.0')), true);
check('the interrupt line refuses to claim a kill',
    /not confirmed dead/.test(attackReport('interrupted', 'cow', '1.0')), true);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('attack: outcomes correct - a flight is never a kill');
