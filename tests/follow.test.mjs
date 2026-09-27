/**
 * When a follow should chase, seek, or give up:
 *   bun tests/follow.test.mjs
 *
 * `followPlayer` used to capture the target's entity ONCE, before its loop:
 *
 *     let player = playerObj.entity;          // and then `player.position` forever
 *
 * mineflayer destroys a player's entity when they leave render distance and builds a NEW
 * object when they return, so that reference becomes an orphan whose position is frozen
 * wherever it was last seen. The bot chases a ghost - confidently, indefinitely, with nothing
 * in chat to say so, because from the inside every reading is perfectly consistent.
 *
 * The states below need a second player and a teleport to produce live, which is why they are
 * tested here: a live run only ever exercises whichever one the world happens to be in.
 */
import { followVerdict } from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- the ordinary case ---------------------------------------------------------------------
check('in sight is simply followed',
    followVerdict({ hasEntity: true, online: true }).action, 'follow');
// Being far away is not the same as being invisible: a tracked entity 200 blocks off is still
// a chase, and the loop's own distance test decides whether to walk.
check('in sight but far is still a follow',
    followVerdict({ hasEntity: true, online: true, distToLastSeen: 400 }).action, 'follow');

// --- out of render distance is RECOVERABLE BY WALKING ----------------------------------------
// This is the case the whole fix exists for. Giving up when the entity blinks out is what makes
// a long teleport END the follow rather than start a chase.
check('just vanished - go to where they were',
    followVerdict({ hasEntity: false, online: true, lostMs: 0, distToLastSeen: 90 }).action, 'seek');
check('still walking after the timer, because we are not there yet',
    followVerdict({ hasEntity: false, online: true, lostMs: 60000, distToLastSeen: 90 }).action, 'seek');
check('close to the old spot but still inside the grace period',
    followVerdict({ hasEntity: false, online: true, lostMs: 1000, distToLastSeen: 2 }).action, 'seek');

// --- giving up, and why it needs BOTH conditions ----------------------------------------------
// Time alone would abandon a chase mid-walk; distance alone would abandon it the instant the
// target teleported from right beside us. Only "arrived AND still nothing" is real evidence.
check('arrived where they were and they are not there',
    followVerdict({ hasEntity: false, online: true, lostMs: 60000, distToLastSeen: 2 }).action, 'lost');
check('...and says which of the two problems it is',
    followVerdict({ hasEntity: false, online: true, lostMs: 60000, distToLastSeen: 2 }).reason
        .includes('still not in sight'), true);

// --- offline outranks everything --------------------------------------------------------------
// Checked FIRST on purpose. A player who quit is not out of render distance, and walking to
// their last position would be a pointless journey ending in a timeout instead of a reason.
check('logged out is not a chase',
    followVerdict({ hasEntity: false, online: false, lostMs: 0, distToLastSeen: 90 }).action, 'gone');
check('logged out even while we still hold a stale entity',
    followVerdict({ hasEntity: true, online: false }).action, 'gone');
check('...and names it', followVerdict({ hasEntity: false, online: false }).reason, 'left the game');

// --- the thresholds are a boundary, not a range -------------------------------------------------
check('exactly at the time limit is not yet lost',
    followVerdict({ hasEntity: false, online: true, lostMs: 8000, distToLastSeen: 1 }).action, 'seek');
check('exactly at the reacquire distance is not yet lost',
    followVerdict({ hasEntity: false, online: true, lostMs: 60000, distToLastSeen: 6 }).action, 'seek');

// A caller may tighten the budget the way followPlayer's short legs tighten nav's.
check('limits are overridable',
    followVerdict({ hasEntity: false, online: true, lostMs: 900, distToLastSeen: 1,
                    lostMsLimit: 500, reacquireDist: 3 }).action, 'lost');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('follow: all checks passed');
