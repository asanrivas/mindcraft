/**
 * The pure parts of owned block placement:
 *   bun tests/block_io.test.mjs
 *
 * Both of these decide whether a placement packet is worth sending at all, and both were found
 * the expensive way - by a bot that jumped perfectly, asked the server for something impossible,
 * and reported the refusal as "block never appeared".
 */
import { bodyClearsCell, placeGapRemaining, BODY_HEIGHT, MIN_PLACE_GAP_MS }
    from '../src/agent/library/block_io.js';

let failures = 0;
const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- bodyClearsCell -----------------------------------------------------------------------
// Pillaring fills the cell the feet are standing in. The bot is 1.8 tall, so "started rising"
// is not the same as "out of the way".
check('standing in the cell is not clear', bodyClearsCell({ feetY: 67, destY: 67 }), false);
check('half a block up is STILL not clear', bodyClearsCell({ feetY: 67.5, destY: 67 }), false);
check('three quarters up is still not clear', bodyClearsCell({ feetY: 67.75, destY: 67 }), false);
check('a full block up is clear', bodyClearsCell({ feetY: 68, destY: 67 }), true);

// The sampler is not the physics clock: at an apex of exactly 1.00 a 10ms poll routinely reads
// 0.98. Refusing there would mean never placing at all on a 1.00 apex.
check('0.98 counts as clear (sampling slack)', bodyClearsCell({ feetY: 67.98, destY: 67 }), true);
check('...but 0.9 does not', bodyClearsCell({ feetY: 67.9, destY: 67 }), false);

// Placing a block BELOW the body is the ordinary case and must not be blocked by the same test.
check('a cell well below the feet is clear', bodyClearsCell({ feetY: 70, destY: 64 }), true);
check('a cell well above the head is clear', bodyClearsCell({ feetY: 64, destY: 70 }), true);
// The head occupies the cell above the feet, so that one is NOT free.
check('the cell at head height is not clear', bodyClearsCell({ feetY: 67, destY: 68 }), false);

// A shorter body clears a cell above it that the full 1.8 hitbox would still be inside.
check('a short body clears a cell the full hitbox would not',
      bodyClearsCell({ feetY: 66.2, destY: 67, height: 0.7 }), true);
check('...and the default height does not', bodyClearsCell({ feetY: 66.2, destY: 67 }), false);
check('BODY_HEIGHT is the vanilla hitbox', BODY_HEIGHT, 1.8);
check('no state is not clear', bodyClearsCell(undefined), false);

// --- placeGapRemaining --------------------------------------------------------------------
// The server rate-limits interactions and silently DROPS the excess, so a burst fails wholesale
// while the same placements spread out all succeed.
check('first placement waits for nothing', placeGapRemaining(0, 10_000), 0);
check('immediately after one, wait the full gap',
      placeGapRemaining(10_000, 10_000), MIN_PLACE_GAP_MS);
check('halfway through, wait the remainder',
      placeGapRemaining(10_000, 10_000 + 100), MIN_PLACE_GAP_MS - 100);
check('after the gap, no wait', placeGapRemaining(10_000, 10_000 + MIN_PLACE_GAP_MS), 0);
check('long after, no wait (never negative)', placeGapRemaining(10_000, 99_000), 0);
check('custom gap is honoured', placeGapRemaining(10_000, 10_050, 400), 350);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('block_io: all checks passed');
