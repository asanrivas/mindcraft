/**
 * Where a server CORRECTION stops and a TELEPORT starts.
 *
 * `forcedMove` fires on every server position packet - login, respawn, operator `/tp`, and the
 * routine anti-cheat nudges this server sends constantly - and mineflayer gives us no way to
 * tell them apart. Only DISTANCE does. Four separate subsystems have now had to draw that line
 * (teleport detection, SwimAssist's boost valve, JumpAssist's rubber-band valve, GroundTruth),
 * and every one of them drew it privately.
 *
 * That is a drift hazard with a genuinely nasty symptom. Anyone retuning the teleport threshold
 * moves one literal, the others silently disagree, and teleports start counting as anti-cheat
 * corrections again - which is a bug that already happened once (2026-08-30 17:46:27: a harness
 * teleporting the bot into place tripped SwimAssist's valve two seconds after enable, before the
 * bot had touched water) and would reappear with no code change at the site of the failure.
 *
 * So the shared numbers live here. This module deliberately imports NOTHING: `agent.js` sits at
 * the top of the tree and the assists are libraries under it, so a constant either side would
 * own is a cycle waiting to happen.
 *
 * NOT everything belongs here. `jump_assist`'s `disagreeBlocks` (1.0) and `ground_truth`'s
 * `disagreeY` (0.5) answer different questions - one tick of flight against a per-tick baseline,
 * and vertical-only disagreement - so they stay local. Only the two numbers that must AGREE to
 * be correct are shared.
 */

/**
 * How far the server must move the bot in ONE position packet for it to be a teleport.
 *
 * The load-bearing constant of teleport detection, not a tuning knob. 8 blocks is far above any
 * correction observed here and far below any deliberate teleport (the smallest real one in the
 * logs is a `/tp andy asanrivas` across a valley).
 *
 * It is ALSO the upper edge of what an anti-cheat valve may count: at or beyond this the server
 * relocated us deliberately, which is no evidence that whatever we were doing was objectionable.
 */
export const TELEPORT_MIN_BLOCKS = 8;

/**
 * How far the bot must be moved before a running action is CANCELLED, as opposed to merely
 * reported.
 *
 * Separate from TELEPORT_MIN_BLOCKS on purpose, and deliberately NOT a retune of it: that constant
 * answers "did the server relocate us deliberately", which is what SwimAssist's anti-cheat valve
 * needs, and moving it would silently change the valve (the warning above this file's threshold
 * exists for exactly that). This one answers a different question - "is the destination we were
 * walking to still meaningful?" - and a 15-block nudge does not make a target 50 blocks away
 * wrong.
 *
 * MEASURED over every teleport in this repo's logs (17 events, `grep -E "TELEPORTED [0-9]+ blocks
 * .* during action:"`). The distribution is cleanly bimodal with nothing in between:
 *
 *   8-21 blocks, 13 events   server corrections, during navTo (5), travel (4), groundProbe (2),
 *                            buildBlueprint (2); dy mostly 0-3
 *   173-1181 blocks, 4 events  somebody moved the bot, during collectBlocks, chestDepositAll,
 *                            navTo, travel
 *
 * So TELEPORT_MIN_BLOCKS's own comment - "8 blocks is far above any correction observed here" -
 * was true when written and is not true now. Cancelling on the small ones is a false alarm that
 * throws away a running action and tells the model not to resume: measured 2026-09-22 killing a
 * `!navTo` mid-walk after a 15-block correction, which then read as the bot refusing to go where
 * it was sent. 32 sits above every measured correction and below every measured real teleport.
 */
export const TELEPORT_CANCEL_BLOCKS = 32;

/**
 * Below this, the server did not disagree with us - it re-synced a position we already held.
 *
 * Counting those is how a valve trips on a bot standing still: this server sends position
 * packets constantly, and a packet counter cannot tell a routine sync from a shove.
 */
export const CORRECTION_MIN_BLOCKS = 0.5;
