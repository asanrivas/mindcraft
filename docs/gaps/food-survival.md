# Gap: Food self-sufficiency

**Status: PLAN — nothing implemented**

Andy went survival yesterday. `mineflayer-auto-eat` (v3.3.6, loaded in `src/utils/mcdata.js:143`, configured in `src/agent/agent.js:258-263` with `startAt: 14`, chicken/rotten flesh banned) eats from inventory — but nothing refills the inventory. `tillAndSow` plants and nothing harvests. There is no hunting-for-food loop, no raw→cooked pipeline, and the prompt shows hunger but not supply. When the last bread is gone, the bot starves politely.

**Ground rules inherited from [README.md](README.md):** mineflayer-pathfinder cannot move this bot (protocol 775 vs 774, `onGround` lies — [NAVIGATION_REBUILD.md §1](../NAVIGATION_REBUILD.md)). All movement below goes through `nav.navigateTo` (`src/agent/library/nav.js:695`, returns `{arrived, covered, replans}`) or skills built on it. Mode `execute()` always passes a timeout (units: minutes; the `-1` default pins `currentActionLabel` forever). Measure before tuning.

## 0. Measure first: can we read crop age on this server?

Everything in §4 depends on reading crop block state through a one-version-stale registry. Verify before building:

```
!serverSetblock("wheat", <x>, <y>, <z>, "age=7")     # state is a separate arg (WORLD_TOOLS.md §4)
!serverSetblock("wheat", <x2>, <y>, <z>, "age=0")
```

then log `bot.blockAt(pos).getProperties()` and `.metadata` for both (temporary console.log, or via `!newAction`). Expected: `{age: 7}` vs `{age: 0}`. If `getProperties()` is garbage on 26.1 chunks, fall back to comparing `block.metadata` against a measured per-crop mature value — measured on this server, not copied from a wiki. Record the result in this doc.

## 1. Prompt surface: what the model sees

`!stats` (`src/agent/commands/queries.js:29`) already prints `- Hunger: N / 20` every turn. Add ONE conditional line, following the repo's established only-when-it-matters pattern (`In water:` line, `Brain: BACKUP` line):

```
- Food supply: LOW — edible 4 pts (2 apple), 6 raw cookable (beef x6)
```

Rendered only when `ediblePoints < 20 || bot.food < 14`. A well-fed, well-stocked bot pays zero prompt tokens; a hungry one pays ~15. No new query command — `!inventory` already exists and `$STATS` is in every `conversing` prompt. The three new action commands (§5 below) cost ~60–90 tokens of `$COMMAND_DOCS` depending on `command_docs_mode`; that is the whole prompt bill.

Computation is pure: `summarizeFoodSupply(inventoryCounts)` in the new `src/agent/library/farming.js` (see §6), fed from `world.getInventoryCounts(bot)`. It must exclude auto-eat's `bannedFood` (rotten flesh in the bag is not supply) and count raw meat as *cookable*, not *edible*.

## 2. Hunting: `skills.huntForFood(bot, maxKills=3, range=48)`

Pieces that exist: `mc.isHuntable` (`src/utils/mcdata.js:158` — cow/pig/sheep/chicken/rabbit/llama/mooshroom, excludes babies via `metadata[16]`), `skills.attackEntity` (`skills.js:485` — `bot.pvp.attack` + waits for despawn + `pickupNearbyItems` on kill), and the existing `hunting` mode (`modes.js:333`, idle-only, 8-block radius).

What is broken for the survival case:

- **`bot.pvp.attack`'s chase uses pathfinder**, which cannot move this bot. A fleeing pig escapes forever. The kill=true wait loop in `attackEntity` also treats "left 24-block range" as "dead" — a fled animal reads as a successful kill.
- **`skills.goToPosition` is still pathfinder-backed** (`skills.js:3090` calls `goToGoal` → `bot.pathfinder.goto`). Do not route the approach through it. `moveAway` (`skills.js:3321`) already shows the correct pattern: `nav.navigateTo(bot, target, {arriveDist, maxReplans, goalXZOnly, planRange})`.

New skill, in `src/agent/library/skills.js`:

```javascript
export async function huntForFood(bot, maxKills=3, range=48)
// per target: rankHuntTargets() picks best food mob (farming.js, pure —
//   cow/sheep/pig > chicken/rabbit; llama LAST, it drops no meat; skip babies);
// chase loop with a 45s per-target deadline:
//   while dist > 3: await nav.navigateTo(bot, mob.position, {arriveDist: 2, maxReplans: 2, planRange: 32})
//   when in reach: bot.pvp.attack(mob); re-approach when it flees;
//   confirm kill by entity.isValid === false / health, not by leaving range;
// pickupNearbyItems after each kill (attackEntity already does this — reuse it for the in-reach phase);
// refuse to start while swim.inWater(bot) — never contest the jump key with SwimAssist;
// returns count of kills + list of meat items gained (diff inventory before/after).
```

Also gate the existing idle `hunting` mode on need (`summarizeFoodSupply` low) so the bot stops recreationally slaughtering every sheep it passes — and so it and the new mode never compete for the same mob.

## 3. Cooking: `skills.cookFood(bot)` on top of `smeltItem`

`skills.smeltItem` (`skills.js:291`) already does everything hard: finds/places a furnace within 16, fuels it via `mc.getSmeltingFuel`, waits per-item, drains input/fuel slots, checks `bot.interrupt_code`. `mc.isSmeltable` (`mcdata.js:323`) already accepts `beef, chicken, cod, mutton, porkchop, rabbit, salmon, potato` — exactly the modern raw-meat item names.

New skill is a thin sequencer:

```javascript
export async function cookFood(bot)
// RAW_COOKABLE = ['beef','porkchop','mutton','chicken','rabbit','cod','salmon','potato'];
// for each present in getInventoryCounts: await smeltItem(bot, name, count);
// stop and report concretely on the two known failure modes smeltItem already logs:
//   no furnace and none in inventory; no fuel (coal/charcoal/logs).
// Prioritize chicken first: raw chicken is BANNED by auto-eat, so it is dead weight until cooked.
// returns per-item tallies for the VERIFIED string.
```

Recovery for an interrupted cook: `clearNearestFurnace` (`skills.js:424`) already exists.

## 4. Farming loop: `skills.harvestCrops(bot, range=16, replant=true)`

`tillAndSow` (`skills.js:3484`) plants; nothing reads maturity or breaks mature crops. Note `tillAndSow`'s own approach branch (`skills.js:3530-3533`) still calls `bot.pathfinder.setMovements` + `goToGoal` — **fix that to `nav.navigateTo` as part of this work**, or replanting beyond 4.5 blocks silently never arrives. (`!collectBlocks` is the wrong tool here: `collectBlock` navigates via the pathfinder-backed `goToPosition` at `skills.js:692` and knows nothing about age — it would harvest age-0 wheat into nothing.)

```javascript
export async function harvestCrops(bot, range=16, replant=true)
// find: world.getNearestBlocksWhere(bot, b => isMatureCrop(b.name, b.getProperties()), range)
//   (getNearestBlocksWhere: world.js:279)
// per crop at (x,y,z):
//   nav.navigateTo(bot, blockPos, {arriveDist: 3, maxReplans: 2, planRange: 32})
//   breakBlockAt(bot, x, y, z)             // skills.js:764
//   pickupNearbyItems(bot)                 // skills.js:735
//   if replant: tillAndSow(bot, x, y-1, z, seedItemFor(cropName))
//     — farmland is the block UNDER the crop; tillAndSow already handles the
//       "block is farmland, above is air" case by skipping the hoe and just planting.
// returns: harvested count, items gained, replanted count.
```

Maturity is data, kept pure in `src/agent/library/farming.js`:

```javascript
export const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
export function isMatureCrop(blockName, properties)   // true iff properties?.age === CROP_MAX_AGE[blockName]
export function seedItemFor(blockName)                // wheat→wheat_seeds, carrots→carrot, potatoes→potato, beetroots→beetroot_seeds
```

Sweet berries / nether wart deliberately out of scope for v1 (berries use `activateBlock`, not break; wart needs the Nether).

## 5. Commands (register in `src/agent/commands/actions.js`, add to `actionsList` in `index.js`)

All via `runAsAction(fn, false, timeoutMinutes)`; each returns a concrete VERIFIED string:

| Command | Timeout | Returns |
|---|---|---|
| `!huntFood(num)` | 5 min | `VERIFIED HUNT: killed 2/3 (cow, pig), gained 3 beef, 2 porkchop. 1 fled.` |
| `!cookFood()` | 10 min | `VERIFIED COOK: 6 beef -> 6 cooked_beef, 2 chicken -> 2 cooked_chicken. Fuel: coal x2.` |
| `!harvestCrops(range)` | 5 min | `VERIFIED HARVEST: broke 9 mature wheat, gained 9 wheat + 13 seeds, replanted 9/9.` |

## 6. Mode: new `food_supply` — do NOT extend auto-eat

**Recommendation: a new mode, not an auto-eat extension.** Auto-eat is an opaque third-party plugin whose one job — consuming from inventory — already works; teaching it to *acquire* food would mean patch-packaging movement, combat and furnace logic into node_modules, all of which must go through our navigator anyway. Acquisition is exactly what this codebase's mode system is for, and the "keep the bot alive" family (drowning, self_preservation) already lives there. Auto-eat keeps its job untouched; `eatIfHungry` (`skills.js:2466`) stays as the manual fallback.

Shape (in `src/agent/modes.js`):

```javascript
{
  name: "food_supply",
  description: "Acquire food when supply is low: cook raw meat, harvest crops, hunt when starving.",
  interrupts: ["all"],
  excludeFromInterrupt: ["action:surface", "action:dive", "action:swimTo", "mode:drowning"],
  on: true, active: false,
  cooldownUntil: 0, failures: 0,        // same anti-thrash pattern as drowning mode
  update: async function (agent) {
    // decision core is PURE: decideFoodAction({food, ediblePoints, rawCookableCount,
    //   matureCropCount, huntableCount, inWater}) -> 'none'|'cook'|'harvest'|'hunt'
    // URGENT tier (interrupts anything): bot.food <= 6 AND ediblePoints === 0
    //   -> execute(this, agent, fn, 3)   // hunt nearest / harvest nearest, 3-min cap
    // MAINTENANCE tier (agent.isIdle() only): ediblePoints < 20
    //   -> execute(this, agent, fn, 5)   // cook first (cheapest), then harvest
    // never act while swim.inWater(bot); on failure set cooldownUntil = now + 60s * 2^failures
  }
}
```

**Position in `modes_list`: after `self_defense` (index 5), before `hunting`.** Justification against the priority semantics of `ModeController.update()` (`modes.js:665-686` — earlier modes run first, and an *active* mode blocks everything after it): drowning kills in seconds, lava/damage in seconds, being stuck blocks all acquisition, and a zombie on you outranks dinner — so all four stay above it. But eating outranks every opportunistic idle behavior below (`hunting`, `item_collecting`, `torch_placing`), and sitting above `hunting` means the need-gated food hunt wins the mob before the recreational one sees it. New mode defaults survive `loadJson` (absent keys keep defaults), so existing `bots/andy` state needs no migration.

## 7. Pure-testable — `tests/food.test.mjs`

Plain bun script, `[input, expected]` arrays, `process.exit(1)` on failure, same shape as `tests/tools.test.mjs`. No server, no bot:

- `isMatureCrop`: `['wheat',{age:7}]→true`, `['wheat',{age:6}]→false`, `['beetroots',{age:3}]→true`, `['beetroots',{age:7}]→false` (beetroot max is 3 — the classic off-by-crop bug), `['tall_grass',{age:7}]→false`, `['wheat', undefined]→false`.
- `seedItemFor`: wheat→wheat_seeds, carrots→carrot, potatoes→potato, unknown→null.
- `summarizeFoodSupply`: bread counts, rotten_flesh does NOT, raw beef lands in `rawCookable` not `edible`, empty inventory → 0/0.
- `rankHuntTargets` (plain entity objects): cow before chicken, llama last, baby (metadata[16]) excluded.
- `decideFoodAction`: starving+no food+animals → `hunt`; raw meat in bag → `cook` before `hunt`; in water → `none`; everything stocked → `none`.

Not pure-testable, live only: crop state reads on protocol 775 (§0), furnace window behavior, pvp melee reach, every `navigateTo` approach.

## 8. Live verification (RCON `mc` alias + bot chat; one step at a time, per CLAUDE.md's journey-driving rule)

```
# setup: survival, controlled hunger
mc "gamemode survival andy"
mc "effect give andy minecraft:hunger 30 200"        # drain hunger fast
mc "msg andy !stats"                                  # EXPECT: Hunger < 14 and the "Food supply: LOW" line

# hunting
mc "summon minecraft:cow <x> <y> <z>"                 # x3, within ~20 blocks
mc "msg andy !huntFood(2)"                            # EXPECT: VERIFIED HUNT ... gained N beef
mc "msg andy !inventory"                              # confirm beef

# cooking
mc "give andy furnace 1" ; mc "give andy coal 8"
mc "msg andy !cookFood()"                             # EXPECT: VERIFIED COOK ... cooked_beef; then auto-eat fires on its own (watch Hunger recover in !stats)

# farming (uses §0's setblock trick to skip growth time)
mc "msg andy !tillAndSow(<x>, <y>, <z>, \"wheat_seeds\")"
!serverSetblock("wheat", <x>, <y+1>, <z>, "age=7")
mc "msg andy !harvestCrops(8)"                        # EXPECT: VERIFIED HARVEST ... replanted; verify plot block is wheat age=0

# mode, urgent tier
# empty all food from inventory, effect hunger to food<=6, summon a pig 15 blocks away, leave idle
# EXPECT: !stats Current Action shows mode:food_supply, then a kill, cook, eat — no human input

# regression: no thrash above the urgent threshold
mc "msg andy !travel(\"west\", 100)"                  # with food at ~8-10 and bread in bag
# EXPECT: one uninterrupted VERIFIED TRAVEL line; auto-eat handles hunger mid-leg; food_supply stays quiet
```

## 9. Risks

- **Starvation on long travel legs** is the sharpest edge. `unstuck` already excludes `action:travel`; `food_supply`'s urgent tier deliberately does NOT — a bot 400 blocks from anywhere with zero food must stop and hunt. The threshold (`food <= 6` AND nothing edible) is set so auto-eat + a stocked bag always wins first; the LOW supply line in `!stats` exists precisely so the driver tops up *before* a leg. Interrupting travel restarts the leg (known cost, CLAUDE.md "Driving long journeys") — acceptable versus death.
- **Drowning/SwimAssist interaction**: `food_supply` sits below `drowning`, excludes `action:surface`/`mode:drowning` from its interrupts, and refuses to act while `swim.inWater` — SwimAssist owns the jump key, and a hunt that wades in after a fleeing cow must not contest it. `attackNearest` (`skills.js:472-476`) already documents why nothing pauses drowning during a hunt: the bot should still come up for air mid-fight.
- **pvp chase is pathfinder-backed and dead here**; without the re-approach loop, every fleeing animal "succeeds" (left range == treated as killed by `attackEntity`). Confirm kills by entity validity, cap each chase at 45s.
- **Mode thrash when no food source exists** (night, desert): exponential cooldown, same pattern as `drowning`'s `cooldownUntil/failures`.
- **`goToPosition`/`goToGoal` are still pathfinder-backed** (`skills.js:2622`, `3090`) — every new skill here must use `nav.navigateTo` directly, and the `tillAndSow` approach branch gets fixed as part of §4. Do not "reuse" the existing movers.
- **Crop state on a stale registry** is unproven until §0 runs. If `getProperties()` fails, metadata fallbacks must be measured on this server, not assumed.
- **Llama is "huntable" but drops no meat**; rank it last or the bot fights a spitting animal for leather while starving.

## 10. Sequencing

1. §0 measurement (blocks §4; everything else can proceed in parallel).
2. `farming.js` pure module + `tests/food.test.mjs` (no bot needed).
3. `cookFood` skill + `!cookFood` (lowest risk — `smeltItem` does the work).
4. `harvestCrops` + `tillAndSow` nav fix + `!harvestCrops`.
5. `huntForFood` chase loop + `!huntFood`.
6. `!stats` supply line.
7. `food_supply` mode + need-gate the old `hunting` mode.
8. §8 live verification, updating this doc's Status line per verified piece.

### Critical Files for Implementation

- /home/asanrivas/mindcraft/src/agent/library/skills.js — `huntForFood`, `cookFood`, `harvestCrops`; fix `tillAndSow`'s pathfinder approach (line 3530); reuse `smeltItem` (291), `attackEntity` (485), `pickupNearbyItems` (735), `breakBlockAt` (764)
- /home/asanrivas/mindcraft/src/agent/modes.js — new `food_supply` mode after `self_defense`; gate existing `hunting` mode; `execute()` timeout pattern (554)
- /home/asanrivas/mindcraft/src/agent/library/farming.js — NEW pure module: `isMatureCrop`, `seedItemFor`, `summarizeFoodSupply`, `decideFoodAction`, `rankHuntTargets`
- /home/asanrivas/mindcraft/src/agent/commands/actions.js — `!huntFood`, `!cookFood`, `!harvestCrops` via `runAsAction` (43); plus registration in commands/index.js
- /home/asanrivas/mindcraft/src/agent/commands/queries.js — conditional `Food supply:` line in `!stats` (after line 29)

---

*Reviewer note (added on save): the live procedure references an rcon `mc` alias. There is no
rcon on this machine — drive Andy over the MindServer socket (docs/../TESTING.md §2); `/give`,
`/summon`, `/effect` are available via the narrow operator commands or an opped client.*
