/**
 * When the navigator may lay a block across a gap:
 *   bun tests/bridge.test.mjs
 *
 * mineflayer-pathfinder could bridge because scaffolding lived in its MOVEMENT GENERATOR, so
 * every `goto` had it. We replaced that executor - its own cannot move this bot at all - and the
 * ability went with it: `travelToward` kept a bridge step in its recovery ladder, but
 * `navigateTo` (which is `!navTo`, `followPlayer`, `moveAway`, the chest approach and every
 * mode-driven move) had none, so a one-block gap simply stopped the bot.
 *
 * The refusals are the tested surface. Bridging spends materials and permanently alters terrain
 * the bot is only crossing, so a false positive is not a slow route - it is a hole in someone's
 * build filled with dirt, or an inventory emptied into a ravine.
 */
import { bridgeVerdict } from '../src/agent/library/nav.js';

let failures = 0;
const check = (label, got, want) => {
    if (got !== want) {
        console.error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
        failures++;
    }
};

// A one-block gap with the far side visible: the case this exists for.
const ok = { hasBlocks: true, wet: false, lava: false, gapAhead: true,
             footingBlocked: false, landingDist: 2 };
check('one-block gap with a visible landing', bridgeVerdict(ok).bridge, true);
check('...and says how wide it is', bridgeVerdict(ok).reason.includes('gap of 1'), true);
check('a seven-block gap is still bridged',
    bridgeVerdict({ ...ok, landingDist: 8 }).bridge, true);
// The look-ahead and the build budget have to agree, or the bot commits to a span it will
// abandon half-built - which is worse than refusing, because the abandoned half is a ledge to
// walk off. BRIDGE_REACH must equal nav's maxBridge.
check('a landing beyond the build budget is refused',
    bridgeVerdict({ ...ok, landingDist: 9 }).bridge, false);

// --- refusals ----------------------------------------------------------------------------------
check('nothing to build with', bridgeVerdict({ ...ok, hasBlocks: false }).bridge, false);
// Placing does not work while floating - nothing under the bot to build against. Same invariant
// that stops pillaring in water.
check('afloat', bridgeVerdict({ ...ok, wet: true }).bridge, false);
check('lava', bridgeVerdict({ ...ok, lava: true }).bridge, false);
// A wall is digAhead's job and a step is climbAhead's; bridging into either wastes the leg and
// the blocks.
check('a wall is not a gap', bridgeVerdict({ ...ok, gapAhead: false }).bridge, false);
check('there is already a floor there',
    bridgeVerdict({ ...ok, footingBlocked: true }).bridge, false);
// NEVER BRIDGE INTO THE UNKNOWN. Without this the bot spans hopefully out over a ravine, spends
// the inventory, and strands itself in mid-air over the same gap it started at.
check('no landing in sight', bridgeVerdict({ ...ok, landingDist: null }).bridge, false);
check('...and says so', bridgeVerdict({ ...ok, landingDist: null }).reason.includes('no landing'), true);

// --- precedence: the cheapest refusal should win, so the log names the real problem -----------
check('no blocks is reported before anything else',
    bridgeVerdict({ hasBlocks: false, wet: true, lava: true, gapAhead: false,
                    footingBlocked: true, landingDist: null }).reason, 'nothing to build with');
check('afloat outranks the terrain checks',
    bridgeVerdict({ ...ok, wet: true, gapAhead: false }).reason.includes('afloat'), true);

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('bridge: all checks passed');

// --- the recovery ladder must FIT INSIDE the leg the caller asked for --------------------------
// `followPlayer` passes `waypointMs: 1500` because the target moves and it wants to re-evaluate
// often. Digging, climbing and bridging are gated on `pinnedMs` (2500) plus two hops 700ms apart,
// so the leg ALWAYS broke first and the follow silently had no recovery at all. Measured: boxed
// in behind a one-block wall, `!followPlayer` moved 0.0 blocks in 45 seconds; with the trigger
// scaled to the caller's budget it was out in 9.0s.
{
    const src = (await import('fs')).readFileSync(
        new URL('../src/agent/library/nav.js', import.meta.url), 'utf8');
    check('the pinned trigger scales to the leg budget',
        /const shortLeg = o\.waypointMs < o\.pinnedMs \* 2/.test(src), true);
    check('...and the branch uses the scaled value, not the raw constant',
        /Date\.now\(\) - stallSince > pinnedAt && hops >= hopsBeforeDig/.test(src), true);
    // Hopping is free and digging is destructive, so hops normally go first - but on a short leg
    // there is only time for one, and requiring two is the same as requiring none.
    check('a short leg needs only one hop before digging',
        /hopsBeforeDig = shortLeg \? 1 : 2/.test(src), true);
}

// --- reaching a player must report what HAPPENED ------------------------------------------------
// `goToPlayer` logged "You have reached <player>" unconditionally, discarding goToGoal's result,
// so a bot sealed in a box twelve blocks away announced that it had arrived.
{
    const src = (await import('fs')).readFileSync(
        new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function goToPlayer'),
                         src.indexOf('function entityInWater'));
    check('goToPlayer measures the distance before claiming arrival',
        /const gap = bot\.entity\.position\.distanceTo\(livePlayer\.position\)/.test(fn), true);
    // And it must measure against a FRESHLY READ entity. mineflayer destroys and rebuilds a
    // player's entity across render distance, so the object captured at the top of a long walk
    // can be an orphan frozen at its last position - which is how "You have reached <player>"
    // gets said to an empty field.
    check('...against a re-read entity, not the one captured at the top',
        /const livePlayer = bot\.players\[username\]\?\.entity \?\? player/.test(fn), true);
    check('...and names being walled in', /nav\.enclosed\(bot\)/.test(fn), true);
    check('...and says when there is no pickaxe', /_pickaxe/.test(fn), true);
}
