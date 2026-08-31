# Ranged combat + shield — execution plan (2026-08-31)

Supersedes the open half of [ranged-combat.md](ranged-combat.md) (drafted 2026-08-22).
Everything below is from reading the CURRENT tree, not the docs. Bow/crossbow shooting is
shipped; this plan covers the remainder: the shield reflex (ShieldGuard), its `self_defense`
wiring, the creeper never-melee guard, and the deferred `!bowProbe`.

**Governing constraint:** the shared server is believed to be on Peaceful, so no combat path
can be live-tested against hostiles. Note a contradiction to resolve first: CLAUDE.md's quick
reference says `difficulty normal` was **set 2026-08-22** ("was Peaceful"), while this gap's
docs say Peaceful. One RCON read settles it (`mc "difficulty"`) — to be run by a human/operator,
not by a planning agent. Until then, design for Peaceful: maximize the pure decision surface.

---

## 1. Accounting: SHIPPED / PARTIAL / NOT DONE

| Item | Status | Evidence |
|---|---|---|
| Pure ballistics (`simulateShot`, `solvePitch`, `leadPoint`, `friendlyInCorridor`) | **SHIPPED** | `src/agent/library/archery.js` (152 lines); constants at `archery.js:12-17` are uncalibrated vanilla defaults, flagged as such |
| Pure tests for ballistics | **SHIPPED** | `tests/archery.test.mjs` (85 lines, no network) |
| `bow.js`: `bowInfo`, `crossbowLoaded`, `shootAt` (bow AND crossbow), `shootAtPosition` | **SHIPPED** | `src/agent/library/bow.js:28-192`; aim-before-draw abort safety at `bow.js:141-148`; friendly-corridor gate at `bow.js:82-98` |
| Item-use-channel lock (`bot.itemUseOwner`) | **PARTIAL** | Lock at `bow.js:54-60`, but honoured ONLY in bow.js — `bow.js:13-17` admits it: skills eating/buckets and two plugins bypass it (see §3) |
| `skills.shootBow` with entityDead-confirmed kill | **SHIPPED** | `src/agent/library/skills.js:504-561` |
| `!shoot(mob_type, weapon)` command | **SHIPPED** | `src/agent/commands/actions.js:1054-1064`; refuses players (`bow.js:110`, `skills.js:508`) |
| Shield → off-hand equip | **PARTIAL** | `skills.equip` routes `*shield*` to off-hand (`skills.js:1515-1517`); mineflayer-armor-manager auto-equips shields to slot 45 (`node_modules/mineflayer-armor-manager/dist/data/armor.js:25` `offhandMaterials=["shield","totem_of_undying"]`, `dist/lib/invUtil.js:16-17`), on `equipAll()` (called `skills.js:270`) and on item pickup (`dist/index.js:24`). **Nothing anywhere RAISES it.** |
| ShieldGuard reflex | **NOT DONE** | no `shield_guard.js`; zero references to shieldGuard in `src/` |
| `self_defense` ranged branch | **NOT DONE** | `src/agent/modes.js:376-403` is melee-only `defendSelf`, gated on `world.isClearPath` (`modes.js:382`) — a pathfinder-planner question, wrong gate for an arrow |
| Creeper never-melee policy | **NOT DONE** | `defendSelf` skips only the *approach* for creepers (`skills.js:622`) then `bot.pvp.attack(enemy)` unconditionally (`skills.js:637`) |
| `skills.rangedDefense` | **NOT DONE** | no such symbol in skills.js |
| `!bowProbe` calibration | **NOT DONE** | no `bow_probe.js`; `ARROW`/`CROSSBOW_ARROW` remain defaults |
| `!stats` combat line | **NOT DONE** | `queries.js` has water/jump/brain conditional lines only (`queries.js:33-50`) |
| Old plan §8 cleanup "delete dead pathfinder approach in defendSelf" | **ALREADY DONE DIFFERENTLY** | `defendSelf` now approaches via `nav.navigateTo` and backs off via `fleeFrom` (`skills.js:624-635`) — do not re-do |

Verdict on docs/gaps/README.md line 25: **accurate.** Shooting is real; shield reflex and
self_defense wiring are genuinely open.

---

## 2. mineflayer API findings — shields (mineflayer 4.37.1, read from node_modules)

- **Raise** = `bot.activateItem(true)` — `node_modules/mineflayer/lib/plugins/inventory.js:115-138`.
  On this version (`useItemWithOwnPacket`) it writes `use_item` with `hand: offHand ? 1 : 0`
  and the bot's **current yaw/pitch** (inventory.js:129-137). There is no slot argument: it
  uses whatever already sits in the off-hand, so the shield must be in **slot 45 first** —
  `bot.equip(item, 'off-hand')`, mapped at
  `node_modules/mineflayer/lib/plugins/simple_inventory.js:19` (`armorSlots['off-hand'] = 45`).
- **Lower** = `bot.deactivateItem()` — inventory.js:140-155: a single `block_dig status:5`
  ("released use item") packet. **ONE channel, not per-hand**: it releases whichever item is in
  use, and `bot.usingHeldItem` is a single boolean (set true at inventory.js:116, false at 154).
  A shield lower and a bow release are the same packet. This is the load-bearing fact of §3.
- **Warm-up**: vanilla shields block only after **5 ticks (~250ms)** raised. mineflayer does not
  model this; any raise must precede the hit by ≥250ms to matter. Not verifiable statically —
  listed under live verification.
- **Axe disable / cooldown**: the server sends `set_cooldown`; mineflayer consumes it ONLY to
  finish an eating task (inventory.js:91-97) — there is **no public item-cooldown API**. We can
  hook `bot._client.on('set_cooldown', ...)` ourselves and record `shieldCooldownUntil`.
  Whether Purpur actually sends it for shield-disable must be verified live.

### What the bot can know about incoming attacks, honestly

| Signal | Timing | Source |
|---|---|---|
| `entityHurt(entity, source)` incl. the **damaging entity** | AFTER damage | `damage_event` (1.20+, live on 1.21.11): `node_modules/mineflayer/lib/plugins/entities.js:377-381`; also animation 1 and entity_status 2 (entities.js:14-16, 23-24) without source |
| own `health` drop → `bot.lastDamageTime`/`lastDamageTaken` | AFTER damage | `health.js:17-22`; derived in `src/agent/agent.js:840-848` |
| arrow entity appears | BEFORE impact | `spawn_entity` → `entitySpawn` (entities.js:228-234). **Spawn carries no velocity** — `addNewNonPlayer` (206-213) → `updateEntityPos` (180-188) sets position/yaw only; velocity lands via the companion `entity_velocity` packet (entities.js:281-285) a tick later. Track arrows from `entitySpawn`, read velocity next tick. |
| creeper/skeleton proximity | BEFORE | `bot.entities` scan per physicsTick — reliable, cheap |
| creeper ignition metadata | BEFORE (maybe) | `metadata[16]` per mineflayer-pvp (`node_modules/mineflayer-pvp/lib/PVP.js:176-178`) — index is version-sensitive; treat as unverified bonus trigger, never the only one |

**Honest capability statement:** proactive blocking is achievable for *proximity* threats
(creeper/melee — raise on approach, well before any hit) and for *far arrows* (flight from 15-24
blocks is ~6-12 ticks ≈ 300-600ms at ~3 b/t: enough for raise + 5-tick warm-up only at the far
end, and only if the reflex runs per-tick). For close arrows and surprise melee the reflex is
**reactive**: it blocks the follow-up hits, not the first. The plan claims exactly that and no
more; skeletons re-fire every ~2s, so blocking follow-ups is still most of the value.

---

## 3. Control-state / use-channel ownership map

`clearControlStates` (movement keys) never touches the use channel — the shield cannot be
dropped the way SwimAssist's jump was. But the use channel has its **own** five contenders, and
one of them fires at the worst possible moment:

| Caller | Site | Lock-aware? | When it fires |
|---|---|---|---|
| `bow.js shootAt` | `bow.js:124-173`, lock at 54-60 | **YES** (originator) | during `!shoot` |
| **mineflayer-auto-eat 3.3.6** | `node_modules/mineflayer-auto-eat/dist/index.js:76-77` — `bot.deactivateItem(); bot.activateItem(offhand)` unconditionally | **NO** | on **every `health` event** (index.js:103-108) and on item pickup (index.js:91) whenever `food <= startAt(14)`. I.e. **the moment the bot takes damage while hungry, it lowers the shield.** Loaded at `src/mc/backends/mineflayer.js:116`; options `src/agent/agent.js:362-366` |
| mineflayer-pvp 1.3.2 | `PVP.js:202` (deactivate pre-swing), `PVP.js:223` + `PVP.js:182` (activateItem(true)); `hasShield` at 234 | **NO** | only while `bot.pvp.target` is set — callers: `skills.js:584` (attackEntity), `skills.js:637` (defendSelf) |
| `skills.useToolOn`/bucket | `skills.js:4340`, `skills.js:4425` | **NO** | explicit tool-use commands |
| `skills.consume` → `bot.consume()` | `skills.js:2214,2238` → `inventory.js:99-113` | **NO** | `!consume` |

**Ownership rules (the single-owner doctrine, applied):**

1. **ShieldGuard owns the off-hand use channel** under `bot.itemUseOwner = 'shield'`. It never
   raises while owner is `'bow'` (raising is harmless but the LOWER would fire the half-drawn
   bow — same packet). `bow.js:54-56` already refuses to draw while any other owner holds it,
   so bow-vs-shield exclusion works today with zero bow.js changes.
2. **While `bot.pvp.target` is set, pvp owns the shield** (it dips it around swings and raises
   for ignited creepers). ShieldGuard stands down — the exact mirror of AutoJump early-returning
   in water.
3. **Auto-eat wins the channel** — it cannot be locked out without forking the plugin, and
   eating at low health is also survival. ShieldGuard listens to `autoeat_started` /
   `autoeat_finished` (emitted at index.js:69/88) to stand down during the ~1.6s eat, then
   re-raises.
4. **Assert against reality, never a cached flag** — the SwimAssist §5.1 lesson, verbatim:
   every tick, if the verdict says "raised" but `bot.usingHeldItem === false` (anything above
   stole the channel), re-issue `activateItem(true)`. This single rule makes rules 2-3 into
   optimizations rather than correctness requirements.
5. ShieldGuard touches **no movement control states**. It sets look (`lookAt(threat)`) once per
   raise — pitch/yaw are free here (not movement inputs, SWIMMING.md invariant); digging uses
   `block_dig status 0/2`, a different packet family, so there is no dig/shield channel
   conflict.
6. The `src/mc` seam already passes `activateItem`/`deactivateItem` (`src/mc/contract.js:29`)
   and whitelists `itemUseOwner` (`contract.js:55`); add `shieldGuard` beside `swimAssist` in
   that field list — one word.

---

## 4. Files, signatures, PURE/LIVE split

### NEW `src/agent/library/shield_guard.js` (the only substantial new file)

```js
// PURE — no bot import, unit-tested with fabricated inputs (the water_exit/follow pattern)
export function shieldVerdict(state)
//   state = {
//     hasShieldOffhand,       // slot-45 read, done by the live caller
//     wet, submerged,         // swim.inWater / swim.isSubmerged
//     useOwner,               // bot.itemUseOwner: 'bow' | 'shield' | null
//     eating,                 // autoeat_started..finished window
//     pvpTargetSet,           // !!bot.pvp.target
//     cooldownUntil, now,     // axe-disable window (0 when unverified)
//     raisedForMs,            // hysteresis input
//     threats: [ { kind: 'creeper'|'skeleton'|'arrow'|'hurt_by',
//                  dist, ignited, incoming, ticksToImpact } ],
//   }
// -> { raise: boolean, faceIndex: number|null, reason: string }

export function arrowThreat(arrowPos, arrowVel, botPos)
// -> { incoming: boolean, ticksToImpact: number|null, missDistance: number|null }
//    incoming requires vel·(bot-arrow) > 0 AND missDistance < 1.2 (body + margin)

// LIVE — modeled line-for-line on AutoJump (auto_jump.js): physicsTick listener,
// enable()/disable()/setMode()/status(); plus entitySpawn tracking of arrow entities
// (velocity read on the NEXT tick, §2) and bot._client 'set_cooldown' for cooldownUntil.
export class ShieldGuard { constructor(bot, opts = {}) }
```

Raise = `lookAt(threat)` then `activateItem(true)`; lower after 1.5s with no qualifying threat
(hysteresis, the `verticalIntent` pattern). Re-assert per rule 4 of §3. `status()` feeds `!stats`.

### NEW `tests/shield.test.mjs` — pure, `bun tests/shield.test.mjs`, no network. Cases in §5.

### NEW (deferred, last task) `src/agent/library/bow_probe.js` — unchanged from old plan §3:
`measureBow(bot, opts) -> { rows, speed, gravity, chargeCurve, forced }`, pure
`fitConstants(rows)` / `formatBowProbe(m)`. Registered as `!bowProbe` in `hidden_actions`.

### Additive touches to SHARED files (partition constraint — exact, minimal)

| Shared file | Change | Size |
|---|---|---|
| `src/agent/agent.js` | construct + enable ShieldGuard beside `jump_assist` (the 197-227 block); expose `bot.shieldGuard` | ~4 lines |
| `settings.js` | `shield_guard: true` in the `assists` block (line ~194) | 1 line |
| `src/mc/contract.js` | add `'shieldGuard'` to the field list at line 55 | 1 word |
| `src/agent/library/skills.js` | **append** `export async function rangedDefense(bot, range = 16)` (target selection reusing `shootBow`'s loop shape; creeper: `moveAway(bot, 8)` then shoot from 8-24; falls back to `defendSelf` at 0 arrows); **one guard line** before `skills.js:637`: never `bot.pvp.attack` a creeper — `moveAway` instead | ~40 lines appended + 3 lines in place |
| `src/agent/library/world.js` | **append** `export function hasLineOfSight(bot, entity)` — eye-to-eye `bot.world.raycast`; pathability is irrelevant to an arrow | ~10 lines |
| `src/agent/modes.js` | inside `self_defense.update` ONLY (376-403): compute `bowInfo`, choose `rangedDefense` vs `defendSelf`, use `hasLineOfSight` for the ranged branch's gate, keep `isClearPath` for melee; `execute(..., 60)` timeout explicit | ~10 lines, one function |
| `src/agent/commands/queries.js` | `!stats` combat line **only while relevant** (shield raised, or arrows>0 during a fight): `Combat: shield UP (reason), arrows: 12, channel: shield` | ~5 lines |
| `src/agent/commands/actions.js` / `index.js` | **nothing now** (the reflex is an assist, not a command; `!shoot` exists). `!bowProbe` registration comes with the deferred task, mirroring `!swimProbe` at actions.js:211-220 | 0 now |

No restructuring of any shared file. `defendSelf`'s nav-based approach (`skills.js:624-635`)
stays exactly as it is — the old plan's cleanup item is already superseded.

---

## 5. Test cases (`tests/shield.test.mjs`, all pure)

**Must raise:**
- creeper at dist 2.9 (unconditional — no metadata trust);
- creeper at 5 with `ignited: true`;
- arrow `incoming` with `missDistance 0.8`, `ticksToImpact 9`;
- `hurt_by` threat within 3s of damage with a known source in front (the reactive follow-up case);
- re-raise: verdict stays `raise` while a threat persists even when `raisedForMs` resets
  (models the channel being stolen and re-asserted).

**Must NOT raise (each checked against reality above):**
- `useOwner === 'bow'` — REAL: the lower is the bow-release packet (inventory.js:140-155);
- `pvpTargetSet` — REAL: pvp manages its own dip/raise (PVP.js:198-225); double-driving it
  produces raise/lower fights;
- `eating` — REAL: auto-eat owns the channel for ~1.6s (index.js:76-77);
- `now < cooldownUntil` — REAL in vanilla (axe disable, 5s); delivery of `set_cooldown` on
  Purpur unverified, so the input defaults to 0 and the case tests the gate, not the server;
- `!hasShieldOffhand` — raising an empty off-hand is a wasted state transition;
- `wet`/`submerged` — POLICY, stated as such: vanilla's swim pose cannot block, SwimAssist owns
  wet behavior, and a shield verdict mid-swim would add a second look-writer during climb-bank's
  carefully sequenced approach;
- arrow flying AWAY (`vel·(bot-arrow) < 0`) or `missDistance > 1.2` — a passing shot is not a
  threat;
- hysteresis: threat gone < 1.5s → still raised; > 1.5s → lowered (both directions tested).
- **Explicitly not gated**: mining (different packet family, §3 rule 5) — a test documents that
  `shieldVerdict` ignores a `digging` flag so nobody "fixes" it in later.

`arrowThreat` geometry: head-on, oblique-hit, oblique-miss, zero-velocity (spawn tick, before
entity_velocity arrives — must return `incoming: false`, not NaN).

**Regression:** `tests/modes.test.mjs` (self_defense edit stays inside its update),
`tests/command_docs.test.mjs` (when `!bowProbe` lands), `tests/contract.test.mjs` (field-list
addition).

---

## 6. Verification on a Peaceful server (proposals only — nothing here was run)

1. **Cheapest of all: read the actual difficulty.** `mc "difficulty"` — CLAUDE.md says it was
   set to normal 2026-08-22; this gap's docs say Peaceful. One of them is stale.
2. **Summoned arrows survive Peaceful** (only *hostile mobs* are despawned). A human/operator
   can fire a real arrow at the bot with
   `mc "execute positioned <x> <y+10> <z> run summon arrow ~ ~ ~ {Motion:[0.0,-1.2,0.0]}"`
   (or a horizontal Motion from 15 blocks out). This exercises the ENTIRE proactive chain —
   `entitySpawn`, next-tick `entity_velocity`, `arrowThreat`, raise, and on hit `damage_event`
   — with zero hostiles and zero difficulty change.
3. **`/damage` exists on 1.21.11**: `mc "damage andy 2 minecraft:arrow"` exercises the reactive
   `hurt_by` path and the auto-eat channel-theft re-assert with no entities at all.
4. **Full integration** (skeleton actually shooting, creeper ignition metadata index, shield
   warm-up, axe `set_cooldown` delivery) requires a temporary
   `mc "difficulty easy"` → test → restore. Shared server: needs the user's explicit go-ahead,
   a fenced test area away from both bots' bases, and doing it while no marathon/build is
   running. The pig-verified `!shoot` precedent (ranged-combat.md:6-8) shows targets can also
   be stood in with passives where damage is not the question.

---

## 7. Command doc text (compact-mode rules, CLAUDE.md "Writing a description the model will obey")

No new model-visible command ships with the shield (it is a reflex/assist — the model steers it
only via `!stats` visibility, like SwimAssist). Deferred `!bowProbe`:

- name: `!bowProbe`, **in `settings.hidden_actions`** (measurement harness, exactly like
  `!swimProbe`), so its description is for humans; still keep it compact-safe:
  `"Measure bow ballistics by firing calibration shots down an open lane. Do NOT use near players - arrows are live."`
- `!shoot`'s existing description (actions.js:1055) already follows the rules (first sentence
  states use, "Refuses players. Needs arrows." are kept imperatives). If `rangedDefense` ever
  becomes a command, the prohibition goes on the TEMPTING side: add to `!attackPlayer`/`!attack`
  nothing — they are melee and correctly selected; no cross-reference is needed yet.

---

## 8. Ordered tasks with acceptance tests

1. **`shield_guard.js` pure surface** (`shieldVerdict`, `arrowThreat`) + `tests/shield.test.mjs`.
   Accept: `bun tests/shield.test.mjs` green with every must-NOT case present; no bot import in
   the pure exports.
2. **ShieldGuard live class + wiring** (`agent.js`, `settings.js` assists,
   `contract.js` field). Accept: `bun tests/modes.test.mjs tests/contract.test.mjs` green;
   `!stats` shows the combat line only while raised; toggling `assists.shield_guard: false`
   constructs but never enables (the teardown-switch convention, settings.js:185-205).
3. **Channel re-assert + auto-eat truce** (`autoeat_started/finished` listeners, per-tick
   `usingHeldItem` reality check, `set_cooldown` hook). Accept: unit test faking the flag-steal
   (verdict raise + `usingHeldItem:false` → exactly one re-activate per tick, none while
   `eating`); live signal via §6.3 `/damage` when an operator runs it.
4. **`skills.rangedDefense` + creeper guard + `world.hasLineOfSight` + `self_defense` branch.**
   Accept: `bun tests/modes.test.mjs tests/command_docs.test.mjs` green; a pure test that the
   weapon-choice picks ranged for {skeleton any-dist, creeper >5, anything >6 with bow+arrows}
   and melee otherwise; grep-level assertion (modes.test style) that `defendSelf`'s creeper
   branch no longer reaches `bot.pvp.attack`.
5. **`!stats` combat line** (queries.js). Accept: absent from output when idle/dry of threats.
6. **Live verification pass** per §6, operator-driven, results written back here and into
   docs/gaps/README.md.
7. **Deferred: `!bowProbe`** (`bow_probe.js`, hidden action, constants written back into
   `archery.js` with the measured values). Accept: pure `fitConstants` tests; live lane run
   after §6.1 resolves the difficulty question.

Risks carried over intact from the old plan: friendly-fire corridor stays mandatory (shipped),
`pvp.stop()` 5s hang → prefer `forceStop()` in any new pvp interaction, look-packet 50ms
throttle (`src/utils/mcdata.js` position throttle) still governs the 100ms settle before any
release.
