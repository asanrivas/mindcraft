/**
 * "Climb to the surface" is meaningless under a bedrock roof:
 *   bun tests/nether.test.mjs
 *
 * `climbToSurface` and `travelToward` both ask `nav.surfaceY(..., 140, ...)` where the sky is.
 * In the nether that scan returns the BEDROCK ROOF - a perfectly ordinary standable-looking
 * answer sixty blocks up - so the bot stairs and towers toward a block that cannot be broken
 * until its entire step budget is gone. One operator teleport reaches this today.
 *
 * The gate is deliberately TWO tests in a fixed order, and the order is the whole fail-safe.
 * `bot.game.difficulty` on this very server is `undefined` while the world is Peaceful, and was
 * additionally overwritten with `undefined` by a mineflayer listener registered after ours
 * (CLAUDE.md, "Modes System") - so no field on `bot.game` gets to be the only thing standing
 * between the bot and mining at bedrock for a quarter of an hour. The world is asked too.
 */
import { skyScanVerdict, dimensionOf } from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// --- the ordinary case must keep working ----------------------------------------------------
// Getting this wrong disables overland travel everywhere, which is far worse than the bug.
check('the overworld scans the sky', skyScanVerdict({ dimension: 'overworld' }).ok, true);
check('the end scans the sky', skyScanVerdict({ dimension: 'the_end' }).ok, true);

// --- the bug --------------------------------------------------------------------------------
check('the nether refuses by name', skyScanVerdict({ dimension: 'the_nether' }).ok, false);
check('the short spelling refuses too', skyScanVerdict({ dimension: 'nether' }).ok, false);
check('the nether refusal says nether',
    /nether/.test(skyScanVerdict({ dimension: 'the_nether' }).reason), true);
// A refusal that does not name itself is indistinguishable from the branch never running.
check('the nether refusal is a sentence',
    skyScanVerdict({ dimension: 'the_nether' }).reason.length > 20, true);

// Exact membership, never a substring: this repo has been bitten three times
// ("sandstone".includes("sand"), water_cauldron, bedrock/bed).
check('a custom dimension whose name contains nether is not the nether',
    skyScanVerdict({ dimension: 'skyblock_nether_hub' }).ok, true);

// --- FAILING SAFE ----------------------------------------------------------------------------
// The field is unset or unparseable. Allowed - refusing here would break the common case - but
// only because the physical test below covers the case that actually hurts.
check('an unknown dimension with clear sky is allowed', skyScanVerdict({}).ok, true);
check('a null dimension with clear sky is allowed',
    skyScanVerdict({ dimension: null, bedrockAbove: null }).ok, true);

// Bedrock overhead refuses REGARDLESS of what the field claims. This is the branch that
// survives `bot.game.dimension` being wrong the way `bot.game.difficulty` provably was.
check('bedrock overhead refuses even with no dimension',
    skyScanVerdict({ dimension: null, bedrockAbove: 127 }).ok, false);
check('bedrock overhead refuses even when the field says overworld',
    skyScanVerdict({ dimension: 'overworld', bedrockAbove: 127 }).ok, false);
check('the bedrock refusal names the height',
    /y=127/.test(skyScanVerdict({ dimension: 'overworld', bedrockAbove: 127 }).reason), true);
// y=0 is a real height and must not read as "no bedrock" - the classic falsy-zero bug, which
// this repo hit before with `difficulty: 0` meaning Peaceful.
check('bedrock at y=0 still refuses', skyScanVerdict({ dimension: null, bedrockAbove: 0 }).ok, false);
// The dimension name is checked FIRST so the message is the useful one.
check('the nether names itself even with bedrock detected',
    /nether/.test(skyScanVerdict({ dimension: 'the_nether', bedrockAbove: 127 }).reason), true);

// --- reading the field defensively ------------------------------------------------------------
check('a missing bot.game is null', dimensionOf({}), null);
check('a missing dimension is null', dimensionOf({ game: {} }), null);
check('an empty string is null', dimensionOf({ game: { dimension: '' } }), null);
check('a non-string is null', dimensionOf({ game: { dimension: 0 } }), null);
check('the namespace is stripped',
    dimensionOf({ game: { dimension: 'minecraft:the_nether' } }), 'the_nether');
// And the stripped form is the one the gate matches on.
check('a namespaced nether still refuses',
    skyScanVerdict({ dimension: dimensionOf({ game: { dimension: 'minecraft:the_nether' } }) }).ok, false);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('nether: the sky scan is gated, and fails safe on an unreadable dimension');
