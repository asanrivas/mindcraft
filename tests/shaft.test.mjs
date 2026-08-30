/**
 * The tower-up decision:
 *   bun tests/shaft.test.mjs
 *
 * `climbShaftUp` mines the block directly above the bot's head and then stands on a block placed
 * under its feet. Two of the ways that goes wrong cannot be undone - breaking into lava costs
 * the bot AND its inventory, and breaking into water floods a sealed pocket the bot is standing
 * at the bottom of - so the REFUSALS are the surface worth testing, not the approvals.
 */
import { shaftUpVerdict } from '../src/agent/library/skills.js';

let failures = 0;
const check = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${label}: got ${g}, expected ${w}`); failures++; }
};
const ok = { hasBlocks: true, afloat: false };

// --- the refusals ------------------------------------------------------------------------------
check('lava overhead is refused', shaftUpVerdict({ ...ok, above: 'lava' }).ok, false);
check('flowing lava too', shaftUpVerdict({ ...ok, above: 'flowing_lava' }).ok, false);
check('water overhead is refused', shaftUpVerdict({ ...ok, above: 'water' }).ok, false);
check('bedrock overhead is refused', shaftUpVerdict({ ...ok, above: 'bedrock' }).ok, false);

// Digging up with nothing to place makes a shaft the bot is still at the bottom of - strictly
// worse than not starting, because the ceiling is spent and the bot has not moved.
check('no blocks to pillar with is refused',
      shaftUpVerdict({ above: 'stone', hasBlocks: false, afloat: false }).ok, false);
// Same invariant the swim code carries: placing needs something under the feet to place against.
check('afloat is refused', shaftUpVerdict({ above: 'stone', hasBlocks: true, afloat: true }).ok, false);
// Being unable to pillar outranks a hazard we would never reach - but either way it is a no.
check('afloat outranks the ceiling', shaftUpVerdict({ above: 'air', hasBlocks: true, afloat: true }).ok, false);

// A refusal has to say WHY. The first live run refused silently, which is indistinguishable
// from the branch never running - the same mistake jump_assist had to fix.
for (const above of ['lava', 'water', 'bedrock'])
    check(`refusing ${above} names a reason`, shaftUpVerdict({ ...ok, above }).reason.length > 0, true);

// --- the approvals -----------------------------------------------------------------------------
check('plain stone is dug', shaftUpVerdict({ ...ok, above: 'stone' }),
      { ok: true, dig: true, falling: false, reason: 'break stone' });
// An open ceiling still approves, but with nothing to dig: this is the ordinary pillarUp case.
check('open air needs no dig', shaftUpVerdict({ ...ok, above: 'air' }),
      { ok: true, dig: false, falling: false, reason: 'already open' });
check('cave_air is open too', shaftUpVerdict({ ...ok, above: 'cave_air' }).dig, false);
check('a missing block reads as open', shaftUpVerdict({ ...ok, above: undefined }).dig, false);

// --- falling blocks ----------------------------------------------------------------------------
// Sand and gravel do not stay mined; the column above drops into the cleared cell. The caller
// needs to know so it re-reads the SAME cell rather than pillaring into one that refills.
check('sand is flagged as falling', shaftUpVerdict({ ...ok, above: 'sand' }).falling, true);
check('gravel is flagged as falling', shaftUpVerdict({ ...ok, above: 'gravel' }).falling, true);
check('concrete powder is falling', shaftUpVerdict({ ...ok, above: 'red_concrete_powder' }).falling, true);
// NEVER substring-match a block name: "sandstone".includes("sand") is true and sandstone does
// not fall. That exact bug made self_preservation fire every tick in a desert.
check('SANDSTONE DOES NOT FALL', shaftUpVerdict({ ...ok, above: 'sandstone' }).falling, false);
check('...and is still perfectly diggable', shaftUpVerdict({ ...ok, above: 'sandstone' }).dig, true);
check('red sandstone does not fall', shaftUpVerdict({ ...ok, above: 'red_sandstone' }).falling, false);

// --- degrading safely --------------------------------------------------------------------------
check('no context at all is a refusal, not a throw', shaftUpVerdict(undefined).ok, false);
check('null context is a refusal', shaftUpVerdict(null).ok, false);


// --- towerUpVerdict: when a STUCK bot should tower, in !navTo / !followPlayer ----------------
// This is the nav-level trigger, not the per-step safety check above. It fires only after
// jumping and bridging have declined, so a false positive costs a pillar the bot did not need
// and permanently alters ground it was only passing over.
const { towerUpVerdict } = await import('../src/agent/library/nav.js');
const stuck = { botY: 60, goalY: 60, wet: false, hasBlocks: true, sealed: false, maxRise: 8 };

check('a goal well above us is worth rising toward',
      towerUpVerdict({ ...stuck, goalY: 66 }), { ok: true, rise: 6, reason: 'goal is 6 above me' });
check('...capped by the remaining budget',
      towerUpVerdict({ ...stuck, goalY: 90, maxRise: 3 }).rise, 3);
// Sealed in, the goal may be flat and still unreachable: every horizontal route is behind a
// wall, so up is not progress toward the goal, it is the only way to be anywhere else at all.
check('sealed in rises even with a level goal', towerUpVerdict({ ...stuck, sealed: true }).ok, true);

// The refusals. A level goal on open ground is the ordinary stall - climbAhead, digAhead and
// bridgeAhead own that, and towering there strands the bot on a pillar.
check('a level goal on open ground is refused', towerUpVerdict(stuck).ok, false);
check('one block up is not enough to tower for', towerUpVerdict({ ...stuck, goalY: 61 }).ok, false);
check('a goal BELOW us is refused', towerUpVerdict({ ...stuck, goalY: 50 }).ok, false);
// Leaving water belongs to climbBank, which is tuned for it - and placing does not work afloat.
check('wet is refused even when sealed and the goal is above',
      towerUpVerdict({ ...stuck, goalY: 70, sealed: true, wet: true }).ok, false);
check('no blocks is refused', towerUpVerdict({ ...stuck, goalY: 70, hasBlocks: false }).ok, false);
check('a spent budget is refused', towerUpVerdict({ ...stuck, goalY: 70, maxRise: 0 }).ok, false);
check('no state is a refusal, not a throw', towerUpVerdict(undefined).ok, false);
for (const s of [stuck, { ...stuck, wet: true }, { ...stuck, hasBlocks: false }])
    check('every refusal names a reason', towerUpVerdict(s).reason.length > 0, true);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('shaft + tower: all checks passed');
