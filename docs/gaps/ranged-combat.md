# Gap: Ranged combat + shield

Status: **PARTIALLY IMPLEMENTED** — stages 2-4 shipped and live-verified 2026-08-22:
`archery.js` (pure ballistics + tests), `bow.js` (draw/release, crossbow load/fire, the
item-use-channel lock, friendly-fire corridor), `skills.shootBow`, `!shoot(mob, weapon)`.
Verified: `VERIFIED SHOOT: killed pig, 3 shot(s) in 5.3s, arrows 128->125` (bow) and
`3 shot(s) in 6.9s` (crossbow). Note: hostile-mob testing is blocked — **the server runs
peaceful difficulty**, summoned zombies/creepers vanish instantly; verified with a pig that
appears fine. Still open: `!bowProbe` calibration, ShieldGuard, the self_defense ranged branch
(pointless to wire until hostiles exist).

A human kites skeletons with a bow, blocks with an off-hand shield, and never lets a creeper
close. Andy is melee-only through `mineflayer-pvp`, on top of land physics where the chase
half of that plugin does not work at all. `bow`/`shield`/`crossbow` appear in this repo only in
item-classification lists (`skills.js:235-236`, `skills.js:1463`, `skills.js:2124`).

## 1. What the stack actually offers (verified against installed code)

**mineflayer 4.37.1** (`node_modules/mineflayer/lib/plugins/inventory.js:115-155`):
- `bot.activateItem(offHand = false)` — starts "using" an item. On this version
  (`useItemWithOwnPacket`) it writes a `use_item` packet with `hand: offHand ? 1 : 0` and the
  bot's **current yaw/pitch**. Main hand + bow = start drawing. Off-hand + shield = raise shield.
- `bot.deactivateItem()` — writes `block_dig` with `status: 5` (*released use item*). Bow:
  fires the arrow. Shield: lowers it. **Critical: this is ONE channel, not per-hand.** Status 5
  releases whichever item is in use, and `bot.usingHeldItem` is a single flag. A shield lower
  and a bow release are the same packet — bow and shield code must share one owner lock.
- `bot.equip(item, 'off-hand')` — confirmed valid: `simple_inventory.js:18-20` maps
  `'off-hand'` to slot 45 (gated on `!supportFeature('doesntHaveOffHandSlot')`). Our own
  `skills.equip` already routes any `*shield*` item there (`skills.js:1463-1464`), so
  `!equip("shield")` works **today**; what is missing is acquiring one and raising it.
- Bow charge is entirely client-timed: mineflayer does not model it. Vanilla: full charge at
  20 ticks (~1s), arrow leaves at ~3.0 blocks/tick, gravity 0.05 b/t², drag ×0.99/tick.
  Those constants are what `!bowProbe` exists to confirm on this 26.1-vs-774 server.

**minecrafthawkeye is NOT installed.** Not in `package.json`; the only trace in
`node_modules` is mineflayer's own `examples/perfectShotBow.js`. Decision on whether to port
its maths: §4.

**mineflayer-pvp 1.3.2** (`node_modules/mineflayer-pvp/lib/PVP.js`):
- The *chase* is pathfinder: `attack()` sets `GoalFollow(target, followRange=2)` (PVP.js:69-72).
  On this server pathfinder cannot move the bot (CLAUDE.md, `onGround` lies), so **the bot
  never closes distance**. `defendSelf` (`skills.js:547-557`) wraps its own
  `bot.pathfinder.goto` approach/retreat in try/catch — those blocks silently do nothing live.
- The *swing loop* is fine: it runs on `physicsTick` and attacks whenever the target is within
  `attackRange = 3.5` (PVP.js:141-167). So melee today works exactly when the mob walks into us
  — true for zombies, useless against skeletons (which hold ~8+ blocks) and suicidal against
  creepers.
- **pvp already has shield logic, dormant for lack of a shield**: `hasShield()` checks slot 45
  for `*shield*` (PVP.js:234-241); `attemptAttack()` lowers the shield 100ms before each swing
  and re-raises 150ms after (PVP.js:198-225); `checkExplosion()` raises the shield and faces an
  ignited creeper when `target.metadata[16] === 1` (PVP.js:171-187). Caveats: it only guards
  the entity pvp is *currently attacking*, and metadata index 16 for creeper ignition is
  version-sensitive on our mismatched protocol — verify live before trusting it.
- `pvp.stop()` waits up to **5 seconds** for a `path_stop` event that our unused pathfinder may
  never emit (PVP.js:80-97). Ranged code should use `pvp.forceStop()`.

**Movement reality check** (why the doctrine below is stand-your-ground): strafing/kiting
needs ground acceleration, and `onGround` reads false for seconds at a time here, so a held
`back`/`left` control state stalls exactly like held `forward` does (CLAUDE.md, Movement).
`followPath` only moves by pulsing jump for airborne acceleration. Combat repositioning is
therefore limited to `nav.navigateTo` legs (~430ms planning + slow execution) — usable to open
distance *before* a fight, useless for dodging *during* one. Design accordingly: **shield and
bow from a standstill beat any movement plan on this physics.**

## 2. Doctrine

1. **Stand ground.** Face the threat, shield up, and shoot or swing. No strafing, no kiting.
2. **Shield first.** It is a passive win: once in slot 45, mineflayer-pvp's existing melee
   loop already manages it. Cheapest capability in this whole plan.
3. **Bow for the two mobs melee cannot answer**: skeletons (never come to us) and creepers
   (must never be meleed).
4. **Movement only for creepers**, and only as a discrete `nav`-based retreat leg, never a dodge.

## 3. Stage 0 — measure first: `!bowProbe`

Modeled on `!swimProbe` (`src/agent/library/swim_probe.js`, registered at
`src/agent/commands/actions.js:214`). New file `src/agent/library/bow_probe.js`:

- `export async function measureBow(bot, opts = {}) -> { rows, speed, gravity, chargeCurve, forced }`
- `export function fitConstants(rows)` (pure), `export function formatBowProbe(m)` (pure)

Procedure: refuse unless a bow and ≥12 arrows are in inventory and no player is within 48
blocks of the firing cone. Pick the longest open lane (reuse the lane-scan idea from
`swim_probe.js`'s `aimedPhase`). For each pitch in {0°, 5°, 10°, 20°, 35°}: full-charge shot
(hold 1200ms), track the spawned `arrow` entity via `entitySpawn`/`entityMoved` until it stops
or `entityGone`, record `(pitch, horizontalRange, drop, flightTicks)`. Then charge-time curve:
three shots at 0° with 300/700/1200ms holds. Output a table plus fitted `speed`/`gravity` for
§4, and flag any server position corrections (the anti-cheat valve lesson from SwimAssist).
Report arrow landing points so they can be recovered.

Traps to inherit from swim_probe: the self-prompt loop will interrupt a probe (`!endGoal`
first); the position-packet throttle (`src/utils/mcdata.js:98-121`, `POSITION_THROTTLE_MS = 50`)
coalesces `look` packets, so **settle the final `lookAt` ≥100ms before `deactivateItem()`** or
the server fires the arrow along its *last acknowledged* look, not ours.

## 4. Aim maths: small pure module, not a hawkeye port

Decision: **do not port minecrafthawkeye.** It is not installed, it assumes version-correct
physics/entity data (we are protocol-mismatched), and it drags in its own movement logic. The
ballistics we need is ~100 pure lines, calibrated by measurement — this codebase's rule.

New file `src/agent/library/archery.js` (pure, no bot import — like `swimCostFor` in nav.js):

```js
export const ARROW = { speed: 3.0, gravity: 0.05, drag: 0.99 };  // overwritten by probe fit
export function simulateShot(pitchRad, speed, { gravity, drag, targetDy }) // -> { range, drop, ticks }
export function solvePitch({ dist, dy, speed })                  // low-arc solution or null (out of range)
export function leadPoint(targetPos, targetVel, flightTicks)     // one-iteration lead
export function corrections(dropTable)                           // per-distance offsets from !bowProbe rows
```

`solvePitch` = closed-form no-drag solution + interpolated correction from the measured drop
table; clamp engagement to 8-24 blocks where drag error is small. Tests in
`tests/archery.test.mjs` (pure, no network — like `tests/swim.test.mjs`): round-trip
`solvePitch` against `simulateShot`, lead maths, table interpolation, out-of-range returns null.

## 5. Bow skill

New file `src/agent/library/bow.js`:

- `export function bowInfo(bot) -> { bow, arrows }` — count `arrow|spectral_arrow|tipped_arrow`.
- `export async function shootAt(bot, entity, opts = {}) -> { fired, reason }` — sequence:
  1. Acquire the item-use lock: `bot.itemUseOwner = 'bow'` (refuse if held by `'shield'` or
     `bot.usingHeldItem` — auto-eat uses the same channel via `consume()`).
  2. Friendly-fire gate: refuse if any player/`mc.isFriendly` entity sits within ~10° of the
     firing line and nearer than the target (`FRIENDLY_ENTITIES`, `src/utils/mcdata.js:55-71`).
  3. `bot.equip(bow, 'hand')`, `lookAt` target, `bot.activateItem()` (main hand).
  4. Hold ~1150ms, re-aiming every 250ms at `leadPoint(...)` with `solvePitch` pitch; final
     look settled ≥100ms before release (throttle, §3).
  5. `bot.deactivateItem()`, release the lock, decrement expected arrows.
- `export async function shootAtPosition(bot, pos)` — for the probe.

`skills.js` additions:
- `export async function shootBow(bot, targetType)` — find target via
  `world.getNearbyEntities(bot, 32)`, refuse players and friendlies, loop `shootAt` until dead,
  out of arrows, or `bot.interrupt_code`; then `pickupNearbyItems(bot)` (arrow recovery).
- `export async function rangedDefense(bot, range = 16)` — the strategy layer, §7.

## 6. Shield

**Acquire**: shield = 6 planks + 1 iron ingot (`!craftRecipe("shield")` — recipe exists in
mc-data); bow = 3 sticks + 3 string; arrows = flint + stick + feather. Bootstrap note: string
and arrows drop from the very mobs this plan targets; one melee'd skeleton often supplies both
bow and arrows. Automating the supply chain belongs to resource-progression, not here — this
plan treats "bow + arrows + shield in inventory" as the precondition and reports when it is
unmet.

**Equip**: existing `skills.equip` path (`bot.equip(item, 'off-hand')`, verified §1). Add a
startup habit: if a shield is in inventory and slot 45 is empty, equip it (one line in the
spawn handler near `armorManager`, or in `self_defense` before engaging).

**Raise — WHO decides**: a new always-on reflex class, `src/agent/library/shield_guard.js`,
modeled exactly on `AutoJump` (`auto_jump.js:30-51`: `physicsTick` listener,
`enable()/disable()/setMode()/status()`), instantiated in `agent.js` beside
`SwimAssist` (`agent.js:144-146`) and exposed as `bot.shieldGuard`.

```js
export class ShieldGuard {
    constructor(bot, opts = {})   // physicsTick tick; owns OFF-HAND use only
    enable(); disable(); setMode(mode); status();
}
export function shouldRaise({ threats, ownerLock, wet })   // pure, unit-testable predicate
```

Raise triggers (any): creeper within 3 blocks (unconditional — do not trust metadata);
creeper within 6 with ignition metadata set (index 16 per PVP.js:176 — **verify live**, it is
version-sensitive); an `arrow` entity within 24 with velocity pointing at the bot; a skeleton
with line of sight within 20 while we are not mid-draw. Raising = `lookAt(threat)` then
`bot.activateItem(true)`; shields only block frontal hits, and pitch/yaw is free here (pitch is
not a movement input — SWIMMING.md invariant). Lower after 1.5s with no trigger (hysteresis,
like `verticalIntent`).

**Ownership invariants** (the single-owner rule; jump-key contention has caused three separate
incidents — see docs/SWIMMING.md §5.1, where a cached "holding" flag let other code release the
key behind the owner's back and buoyancy died silently):
- ShieldGuard touches **no control states** — only the off-hand use channel and look.
- One owner for the item-use channel: `bot.itemUseOwner ∈ {'bow','shield','eat',null}`.
  ShieldGuard never calls `deactivateItem()` while owner is `'bow'` (it would release the
  half-drawn bow — same packet, §1). `shootAt` never draws while owner is `'shield'` during a
  creeper ignition window.
- While `bot.pvp.target` is set, **pvp owns the shield** (it already lowers/raises around
  swings); ShieldGuard stands down, mirroring how AutoJump early-returns in water.
- Assert state against reality, not a cached flag: re-issue `activateItem(true)` if a raise is
  wanted but `bot.usingHeldItem` is false — the exact lesson of SWIMMING.md §5.1.

## 7. Creeper policy — never melee

In `rangedDefense` and as a new guard in `defendSelf`:
- Creeper < 5 blocks: retreat leg via `skills.moveAway(bot, 8)` (nav-based, works —
  `skills.js:3291-3337`), shield up during the leg (ShieldGuard's <3-block trigger covers a
  blast mid-retreat). Never `bot.pvp.attack` a creeper — today `defendSelf` line 558 does
  exactly that; the existing creeper special-case (line 545) only skips the *approach*.
- Creeper 8-24 blocks with bow+arrows: shoot from standstill.
- No bow: keep ≥8 blocks with repeated `moveAway` legs until it despawns/loses interest, or
  disengage entirely (`cowardice`-style).

## 8. Mode integration (`src/agent/modes.js`)

`self_defense` (`modes.js:295-331`) stays the decision-maker; it gains a weapon choice inside
its `update`, before `execute(...)`:

```js
const { bow, arrows } = bowInfo(agent.bot);
const ranged = bow && arrows > 0 &&
    (enemy.name === 'skeleton' || enemy.name === 'creeper' || dist > 6);
execute(this, agent, async () => {
    if (ranged) await skills.rangedDefense(agent.bot, 16);
    else await skills.defendSelf(agent.bot, 8);
}, /* timeout */ 60);
```

Always pass a timeout — a mode `execute()` with the default `-1` pins `currentActionLabel`
forever (CLAUDE.md, Tools and modes). Also: the current gate `world.isClearPath`
(`world.js:536-551`) asks the *pathfinder planner*, which cannot plan over a 1-block step here
— it suppresses triggers on any uneven ground. For the ranged branch replace it with a new
`world.hasLineOfSight(bot, entity)` (eye-to-eye `bot.world.raycast`); pathability is irrelevant
to an arrow. `cowardice` is unchanged (note in passing: its `avoidEnemies` is pathfinder-based
and mostly does not move the bot today — a separate fix, out of scope).

Cleanup in the same PR: delete the dead pathfinder approach/retreat in `defendSelf`
(`skills.js:545-557`) and replace `bot.pvp.stop()` calls in new code with `forceStop()` (§1).

## 9. Commands (`src/agent/commands/actions.js`)

- `!shoot(type)` → `skills.shootBow` — refuses players (unlike `!attackPlayer`, actions.js:955).
- `!bowProbe` → `runAsAction(async (agent) => formatBowProbe(await measureBow(agent.bot)), false, 3)` — mirror `!swimProbe` (actions.js:211-220).
- `!stats` grows a combat line **only while relevant** (pattern: swim stats): `Combat: shield up, arrows: 12, owner: bow`.

## 10. Implementation order

1. **Shield free win**: craft/equip guidance + startup off-hand equip. Verify live that
   mineflayer-pvp lowers/raises it during a zombie melee. Smallest diff, immediate survival value.
2. `archery.js` + `tests/archery.test.mjs` (pure, no bot).
3. `!bowProbe` (`bow_probe.js`); run it live; write measured constants back into `ARROW` and
   the correction table.
4. `bow.js` + `skills.shootBow` + `!shoot`; validate on a fenced skeleton.
5. `ShieldGuard` + `agent.js` wiring + `shouldRaise` tests; verify creeper metadata index live.
6. `self_defense` ranged branch, creeper policy, `defendSelf` dead-code cleanup,
   `world.hasLineOfSight`.

## 11. Risks

- **Friendly fire.** Arrows hit players; `isFriendly` protects target *selection* but not the
  flight path. The firing-corridor check (§5) is mandatory, and `!shoot` hard-refuses player
  targets.
- **Arrow supply.** Finite in survival; every ranged path falls back to melee/retreat at zero
  arrows, and every kill ends with `pickupNearbyItems`. Skeleton drops are the loop's fuel.
- **Control-state / channel contention.** pvp (pathfinder goals), the navigator, ShieldGuard,
  auto-eat and bow draw all touch shared machinery. Rules: never run `bot.pvp.attack` while a
  `nav.followPath` leg is active; `itemUseOwner` serializes the use channel; ShieldGuard defers
  to pvp. History says this is where it will break: docs/SWIMMING.md §5.1.
- **Version mismatch.** Creeper ignition metadata index, arrow entity tracking, and the
  ballistic constants may all differ on 26.1-behind-774 — which is why the probe is stage 0
  and pvp's `checkExplosion` is treated as unverified.
- **Look-packet throttle** (`mcdata.js:98`) silently retimes aim; the 100ms settle before
  release is load-bearing, not polish.
- **`pvp.stop()` 5s hang** on the never-emitted `path_stop` — use `forceStop()`.

### Critical Files for Implementation

- /home/asanrivas/mindcraft/src/agent/library/skills.js — `attackEntity`/`defendSelf`/`equip`/`moveAway`; gains `shootBow`, `rangedDefense`
- /home/asanrivas/mindcraft/src/agent/modes.js — `self_defense` weapon choice, `execute()` timeout pattern
- /home/asanrivas/mindcraft/src/agent/library/auto_jump.js — the reflex-class template `ShieldGuard` must copy (with swim_assist.js as the ownership example)
- /home/asanrivas/mindcraft/src/agent/commands/actions.js — `!shoot`, `!bowProbe` registration (`!swimProbe` at line 214 is the model)
- /home/asanrivas/mindcraft/src/agent/agent.js — spawn-time wiring of ShieldGuard beside AutoJump/SwimAssist (lines 138-146)