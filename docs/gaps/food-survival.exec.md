# Food self-sufficiency — execution plan (supersedes food-survival.md for implementation)

**Status: EXECUTION PLAN — verified against the tree on `feature/llm-failover`, 2026-08-31.**
The 2026-08-22 plan ([food-survival.md](food-survival.md)) predates the onGround correction, the
navToGoal seam conversion, the owned block/container engines, `difficulty.js` and
`build_guard.js`. Every claim below was re-checked against current code; file:line cites are
from this tree. Static analysis only — no live measurement was run for this revision (the bot is
live and shared); everything that needs the server is in the LIVE list, §4.

---

## 1. What is stale in the old plan (with evidence)

| # | Old claim | Current truth |
|---|---|---|
| S1 | Ground rule: "mineflayer-pathfinder cannot move this bot (protocol 775 vs 774, `onGround` lies)" | Both halves overturned. Server is natively 1.21.11, no version skew; `onGround` is not generally broken (clean bot jumps vanilla 1.252) — CLAUDE.md "Movement". The *executor* remains dead, but `goToGoal` (skills.js:2379) now routes through the `navToGoal` seam first and **has no pathfinder execution branch left at all** (comment block skills.js:2399–2412: "NOTHING FALLS THROUGH HERE ANY MORE"). |
| S2 | "`skills.goToPosition` is still pathfinder-backed (`skills.js:3090`)... do not route the approach through it" | Stale. `goToPosition` (now skills.js:2683) → `goToGoal` → `navToGoal`, i.e. our navigator. The existing movers are safe to reuse; no per-skill nav plumbing needed. |
| S3 | "`tillAndSow`'s approach branch still calls `bot.pathfinder.setMovements` + `goToGoal` — fix that as part of this work" | Already fine. `tillAndSow` (skills.js:3836) approaches via `goToGoal(bot, new pf.goals.GoalNear(...))` at skills.js:3883–3885, which the seam translates. **Task removed.** |
| S4 | §0 "can we read crop age through a one-version-stale registry?" as a *blocking gate* | The rationale (protocol skew, stale registry) is dead: `minecraft_version` resolves to the server's native 1.21.11, and world decode was verified byte-identical across 24,389 blocks *including stateful blocks* (CLAUDE.md "Movement" §checks 2). `block.getProperties()` on wheat is expected to work. Downgraded to a 5-minute live sanity check (L2, §4), non-blocking. |
| S5 | auto-eat "loaded in `src/utils/mcdata.js:143`, configured in `agent.js:258-263`, chicken/rotten flesh banned" | Loaded at `src/mc/backends/mineflayer.js:116`; configured at `agent.js:361–366`; `bannedFood` is now `["rotten_flesh","spider_eye","poisonous_potato","pufferfish","chicken"]`. `summarizeFoodSupply` must mirror the full list. |
| S6 | Line numbers throughout | All shifted: `isHuntable` mcdata.js:117 (not 158), `smeltItem` skills.js:300, `attackEntity` :562, `pickupNearbyItems` :814, `breakBlockAt` :841, `eatIfHungry` :2168, `tillAndSow` :3836. `world.getNearestBlocksWhere` is still world.js:279. |
| S7 | "register in `commands/index.js`: `actionsList = [...]`" | No index.js edit exists or is needed: `actionsList` lives in and is exported from actions.js:81, and index.js:8 does `commandList = queryList.concat(actionsList)`. **Zero footprint in index.js.** |
| S8 | Mode position "after `self_defense` (index 5), before `hunting`" | The list has grown: `night_safety` (modes.js:411) now sits between `self_defense` (:369) and `hunting` (:547). New position: **after `night_safety`, before `hunting`** — night (skeletons at dusk) still outranks dinner, and the "everything above keeps updating while this is active" comment at modes.js:407–410 documents exactly the semantics we want. |
| S9 | Reviewer note: "There is no rcon on this machine" | Stale. CLAUDE.md Quick Reference documents the `mc` alias → `tools/rcon.mjs`, password in `~/.config/mc-rcon.env`. The §8-style live script is valid again (but see the shared-bot caveat in §4). |
| S10 | *(missing)* Peaceful means more than "no hostiles" | On Peaceful **hunger does not drain**, so auto-eat never fires and a `food_supply` urgent tier can never trigger naturally. The old plan had no difficulty gate because `src/agent/difficulty.js` didn't exist yet. The mode must stand down on Peaceful exactly as `night_safety` does, or it is dead weight that live-fires untested the day difficulty changes. Evidence on current state: logs/service.log's most recent difficulty lines (2026-08-28 12:25) read `difficulty="peaceful"` — despite CLAUDE.md's quick-ref comment "difficulty normal (set 2026-08-22)". Trust the bot-side reading; re-verify live (L5). |
| S11 | *(understated)* "pvp chase is pathfinder-backed and dead here" — old plan's fix was "re-approach with nav when it flees" while `bot.pvp.attack` runs | Worse than dead: `mineflayer-pvp` sets a pathfinder `GoalFollow` (`node_modules/mineflayer-pvp/lib/PVP.js:69–72`), and per CLAUDE.md pathfinder "rewrites control states every tick and silently cancels ours". Leaving `pvp.attack` live *while* `nav.navigateTo` drives is jump-key-contention all over again. The hunt loop must `bot.pvp.stop()` before every nav leg — or skip pvp entirely and swing with `bot.attack` on our own cadence. `defendSelf` (skills.js:598–650) is the in-repo precedent for the alternation. |
| S12 | "`smeltItem` already does everything hard" — cookFood as a thin sequencer, no risk noted | Two new facts. (a) Furnace I/O rides `bot.transfer` (`node_modules/mineflayer/lib/plugins/furnace.js:104`) — the **same cursor-based transfer `container_io.js` was written to replace** for chests (CLAUDE.md "Chests": desync throws, items stranded on the cursor, dropped on close). Chest-measured defects are not automatically furnace defects, but nobody has measured the furnace path since the container findings. (b) The `!smeltItem` command **restarts the whole agent on success** (`agent.cleanKill('Safely restarting to update inventory.')`, actions.js:886–889) — symptomatic of the bot.inventory-frozen-while-window-open defect. `cookFood` must not inherit a restart-per-item; whether it needs one at all is a live question (L1). |
| S13 | *(missing)* nothing about builds | `build_guard.js` (uncommitted) now exists: `isProtected(x,y,z)` (build_guard.js:73). A farm inside a blueprint's footprint must not be harvested out from under the builder; `harvestCrops` gets a one-line skip. |

Carried forward unchanged (re-verified, still true):
- `attackEntity(kill=true)` still treats "left 24-block range" as a confirmed kill (skills.js:585–592: `while (world.getNearbyEntities(bot, 24).includes(entity))` … then `Successfully killed`). A fled pig logs as dead.
- `hunting` mode (modes.js:547–566) is idle-ish (interrupts only `action:followPlayer`), radius 8, **not need-gated** — it hunts recreationally.
- `mc.isHuntable` (mcdata.js:117–121): chicken/cow/llama/mooshroom/pig/rabbit/sheep, `!mob.metadata[16]` baby filter. Llama drops no meat — rank last.
- `mc.isSmeltable` (mcdata.js:282) accepts the modern raw-meat names; `getSmeltingFuel` (:287) and `getFuelSmeltOutput` (:297) exist.
- `eatIfHungry` (skills.js:2168) stays the manual fallback; auto-eat keeps the consumption job.
- New mode, not an auto-eat extension — that recommendation stands, for the same reasons.

## 2. New files and signatures

### `src/agent/library/farming.js` — NEW, pure. No bot import, no Vec3, no timers.

```javascript
// Data (vanilla constants; tests assert membership and the two famous asymmetries)
export const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
export const SEED_FOR = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' };
export const RAW_COOKABLE = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
export const DEFAULT_BANNED = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']; // mirror agent.js:364
export const FOOD_POINTS = { cooked_beef: 8, cooked_porkchop: 8, bread: 5, /* ... full table ... */ };
export const HUNT_VALUE = { cow: 3, sheep: 3, pig: 3, mooshroom: 3, rabbit: 2, chicken: 2, llama: 0 };

export function isMatureCrop(blockName, properties)      // true iff properties?.age === CROP_MAX_AGE[blockName]
export function seedItemFor(blockName)                    // SEED_FOR[blockName] ?? null
export function summarizeFoodSupply(invCounts, banned = DEFAULT_BANNED)
  // -> { ediblePoints, edible: [{name,count}], rawCookable: [{name,count}], low }
  // banned items are NOT supply; raw meat is rawCookable, never edible; low = ediblePoints < 20
export function foodSupplyLine(supply, food)              // -> string | null  (null when stocked AND food >= 14)
export function rankHuntTargets(entities)                 // babies (metadata[16]) OUT, sort by HUNT_VALUE desc then distance; llama value 0 -> last
export function killConfirmed(entity)                     // entity && (entity.isValid === false || entity.health <= 0); "far away" is NOT confirmation
export function huntVerdict(s)                            // { targetValid, dist, elapsedMs, deadlineMs, botInWater, targetInWater }
                                                          // -> 'approach' | 'attack' | 'give_up' | 'refuse'
export function cookPlan(invCounts)                       // ordered [{item,count}] from RAW_COOKABLE only; chicken FIRST (banned raw -> dead weight)
export function decideFoodAction(s)                       // { food, ediblePoints, rawCookableCount, matureCropCount, huntableCount,
                                                          //   inWater, peaceful, cooldownActive }
                                                          // -> 'none' | 'cook' | 'harvest' | 'hunt'
```

`decideFoodAction` order: any of `peaceful` / `inWater` / `cooldownActive` / well-stocked → `'none'`;
then `cook` (cheapest, no travel) > `harvest` > `hunt` (only when starving: `food <= 6 && ediblePoints === 0 && huntableCount > 0`).

### `src/agent/library/skills.js` — three appended exports (see §5 for exact placement)

```javascript
export async function huntForFood(bot, maxKills = 3, range = 48)
// targets: rankHuntTargets(world.getNearbyEntities(bot, range).filter(e => mc.isHuntable(e)))
// per target, 45s deadline, driven by huntVerdict each iteration:
//   'approach' -> bot.pvp.stop(); await nav.navigateTo(bot, {x,y,z of a FRESH entity.position read},
//                   { arriveDist: 2.5, maxReplans: 2, waypointMs: 1500 });   // re-read per leg: GoalFollow-staleness lesson
//   'attack'   -> equipHighestAttack(bot); bot.attack(entity); await 600ms   // our own swing cadence; pvp NEVER runs across a nav leg (S11)
//   'give_up'  -> log "1 fled", next target
// kill test is killConfirmed(entity), never "left range" (S6/attackEntity bug);
// pickupNearbyItems(bot) after each confirmed kill;
// REFUSE up front while swim.inWater(bot) (SwimAssist owns the jump key) — and huntVerdict
// refuses a target that is itself in water: never chase a swimming cow into a lake;
// returns { kills, fled, gained } via inventory diff (world.getInventoryCounts before/after).

export async function cookFood(bot)
// plan = cookPlan(world.getInventoryCounts(bot)); for each: await smeltItem(bot, item, count)  (skills.js:300)
// stop on smeltItem's two hard failures (no furnace, no fuel) and report which;
// NO per-item agent restart (S12); result counted by inventory diff AFTER the last window closes
// (bot.inventory thaws on closeWindow — CLAUDE.md "Chests"); whether any restart is needed at all is L1;
// returns per-item tallies for the VERIFIED string.

export async function harvestCrops(bot, range = 16, replant = true)
// finds: world.getNearestBlocksWhere(bot, b => farming.isMatureCrop(b.name, b.getProperties?.()), range, 64)  (world.js:279)
// skip any cell where build_guard.isProtecting() && build_guard.isProtected(x, y, z)  (S13)
// per crop: nav.navigateTo(bot, pos, { arriveDist: 3, maxReplans: 2 });
//   breakBlockAt(bot, x, y, z) (skills.js:841 — approaches by itself if needed, S2 makes that safe);
//   if replant: tillAndSow(bot, x, y - 1, z, farming.seedItemFor(name))  (skills.js:3836; its farmland-with-air-above
//     path already skips the hoe and just plants);
// pickupNearbyItems every 4 crops and once at the end;
// returns { harvested, replanted, gained } via inventory diff.
```

## 3. PURE / LIVE split

**PURE (in farming.js, all unit-tested, no server):** `isMatureCrop`, `seedItemFor`,
`summarizeFoodSupply`, `foodSupplyLine`, `rankHuntTargets`, `killConfirmed`, `huntVerdict`,
`cookPlan`, `decideFoodAction`. Every *decision* in the three skills routes through one of
these; the skills themselves are thin drivers (the `waterExitVerdict`/`followVerdict` pattern —
tests/water_exit.test.mjs, tests/follow.test.mjs). The `!stats` line text is pure
(`foodSupplyLine`), so the must-NOT-render case is testable offline.

**LIVE only (genuinely needs the server; every navigateTo leg is implicitly here):**
- **L1 — furnace window I/O (the gate for cookFood).** Does `furnace.putFuel/putInput/takeOutput`
  (→ `bot.transfer`, furnace.js:104) work, hang, or strand items on this server post-1.17-click-prediction?
  And is `!smeltItem`'s post-success `cleanKill` restart actually still necessary? Probe rig:
  a `scratchpad/furnace_rig.mjs` in the style of `chest_rig.mjs`. If broken → extend the owned
  container protocol (`furnace_io` on top of `container_io.js` click primitives, counts from
  `window.slots`) *before* shipping `!cookFood`.
- **L2 — crop `getProperties()` sanity** (de-risked by S4, 5 min): setblock wheat age=0/age=7,
  read both. Non-blocking; only the metadata-fallback work would revive if it failed.
- **L3 — melee swing cadence**: does a 600ms `bot.attack` loop register hits and kill a cow in
  sane time? (pvp's cooldown solver is what we give up by not using it across nav legs.)
- **L4 — auto-eat end-to-end**: after `!cookFood`, hunger recovers unaided under a hunger effect.
- **L5 — difficulty**: confirm `!stats` Gamemode/difficulty; Peaceful ⇒ hunger never drains ⇒
  all hunger-driven live tests need `mc "effect give andy minecraft:hunger 30 200"`. Passive
  mobs spawn fine on Peaceful, so hunting *mechanics* are testable either way.
- **L6 — mode drill + control**: urgent tier fires when starved with an empty bag; and the
  control — stays silent through a travel leg with bread in the bag (a fix that fires always has
  removed the feature).

## 4. Tests — `tests/food.test.mjs`

Plain bun script, `check(label, got, want)` + `process.exit(failures)`, same shape as
tests/water_exit.test.mjs. Refusals carry the weight:

- `isMatureCrop`: wheat 7→true, 6→false; **beetroots 3→true, 7→false** (the off-by-crop bug);
  `tall_grass`/7→false; wheat/undefined→false; wheat/{}→false.
- `seedItemFor`: the four mappings; `'melon_stem'`→null; `undefined`→null.
- `summarizeFoodSupply`: bread counts; **every DEFAULT_BANNED item contributes 0 edible**
  (rotten_flesh, pufferfish, spider_eye, poisonous_potato, raw chicken); raw beef → rawCookable
  and NOT edible; raw chicken appears in rawCookable even though banned-to-eat; empty inv →
  `{ediblePoints:0, low:true}`.
- `foodSupplyLine` (the must-NOT-fire case first): stocked + food 20 → **null** (the ordinary
  prompt pays nothing); low supply → string mentions counts; hungry but stocked → string.
- `rankHuntTargets`: cow before chicken; **llama last even when nearest**; baby cow
  (metadata[16] truthy) excluded; [] → [].
- `killConfirmed`: `isValid:false`→true; `health:0`→true; **healthy entity 30 blocks away →
  false** (the attackEntity "fled == killed" bug, inverted into a test).
- `huntVerdict`: in reach → `attack`; out of reach, time left → `approach` (a *fled* target with
  time left re-approaches, never `give_up`); past deadline → `give_up`; `botInWater` →
  **`refuse`**; `targetInWater` → **`refuse`** (never chase a swimming cow); `targetValid:false`
  → `give_up`.
- `cookPlan`: chicken ordered first; beef included; **`{cobblestone:64, sand:12, oak_log:9}` →
  `[]`** (smeltable ≠ food — the whitelist, not `isSmeltable`); {} → [].
- `decideFoodAction` (must-NOT-fire cases first): `peaceful:true` → `none` whatever else says;
  `inWater:true` → `none`; stocked → `none`; `cooldownActive` → `none`; starving with raw meat
  in bag → `cook` (never `hunt` past food in hand); mature crops, no raw → `harvest`; starving,
  nothing else, huntables → `hunt`; starving, huntableCount 0 → `none` (no thrash at an empty
  desert).
- compact-docs guard: run `compactDescription` (exported, commands/index.js:586) over the three
  new descriptions in §6 and assert each "Do NOT / Refused / Takes" sentence survives and prose
  is dropped — the same contract tests/command_docs.test.mjs enforces for existing commands.

`tests/modes.test.mjs` needs no edits: its execute-call-site scan (lines 27–42) automatically
covers the new mode's `execute(..., timeout)` calls.

## 5. Integration points (minimal, additive)

| File | Change | Exact placement |
|---|---|---|
| `src/agent/library/farming.js` | NEW | — |
| `src/agent/library/skills.js` | 1 import + 3 appended exports | `import * as farming from './farming.js';` and `import * as build_guard from './build_guard.js';` added to the import block at top (additive lines); `huntForFood`, `cookFood`, `harvestCrops` appended at EOF, after `climbShaftUp` (current EOF ≈ line 5659). Nothing existing touched. |
| `src/agent/commands/actions.js` | 3 command objects appended | inside `actionsList`, immediately before the closing `];` (currently line 1593), after `!creativeStatus`. |
| `src/agent/commands/index.js` | **none** | `commandList = queryList.concat(actionsList)` (index.js:8) picks the new entries up. |
| `src/agent/modes.js` | 1 import + 1 mode object inserted | import `farming` at top; mode object inserted between `night_safety`'s closing `},` (line 545) and `hunting`'s opening `{` (line 546). Insertion of new lines only — no existing mode moved or edited. Reuse the `isPeaceful` import `night_safety` already has (difficulty.js:61). |
| `src/agent/commands/queries.js` | ~8 lines inserted in `!stats` | after the Brain-BACKUP block (ends line 88), before `let players = ...` (line 91). queries.js is not on the shared-file constraint list. |
| `tests/food.test.mjs` | NEW | — |

Mode shape (unchanged in spirit from the old plan, with the S8/S10 corrections):

```javascript
{
    name: "food_supply",
    description: "Acquire food when supply is low: cook raw meat, harvest crops, hunt only when starving.",
    interrupts: ["all"],
    excludeFromInterrupt: ["action:surface", "action:dive", "action:swimTo", "mode:drowning",
                           "mode:self_preservation", "mode:self_defense", "action:cookFood",
                           "action:huntFood", "action:harvestCrops"],
    on: true, active: false,
    cooldownUntil: 0, failures: 0,          // drowning-mode anti-thrash pattern
    update: async function (agent) {
        if (isPeaceful(agent.bot.game)) return;               // S10: hunger cannot drain
        const act = farming.decideFoodAction({ ...gathered state... });
        if (act === 'none') return;
        // URGENT (food<=6, nothing edible): runs via interrupts, 3-min cap
        // MAINTENANCE (supply low): agent.isIdle() only, 5-min cap
        execute(this, agent, fn, act === 'hunt' ? 3 : 5);     // ALWAYS a timeout (modes.test scan)
        // on a failed acquisition: cooldownUntil = Date.now() + 60_000 * 2 ** this.failures++
    },
}
```

**Flagged in-place edits (the only non-append touches; tiny, coordinate with parallel
workstreams, shippable last and independently):**
- F1 `!collectBlocks` description (actions.js:857), append one sentence: `Do NOT use on
  wheat/carrots/potatoes - use !harvestCrops, which checks maturity and replants.` (Prohibition
  on the TEMPTING command — measured rule, CLAUDE.md "Writing a description the model will obey".)
- F2 `!attack` description (actions.js:1222), append: `Do NOT use to gather food - use
  !huntFood, which chases fleeing animals and confirms kills.`
- F3 need-gate the recreational `hunting` mode: one guard line at the top of its `update`
  (modes.js:552): `if (!farming.summarizeFoodSupply(world.getInventoryCounts(agent.bot)).low) return;`

## 6. Command docs (compact mode keeps sentence 1 + imperative follow-ups; param NAMES are the docs)

```javascript
{
    name: '!huntFood',
    description: 'Hunt nearby passive animals for raw meat and pick up the drops. '
        + 'Do NOT use !attack for food - it loses fleeing animals. '
        + 'Refused while in water. Use !cookFood afterward - raw chicken cannot be eaten.',
    params: { 'maxKills': { type: 'int', description: 'Animals to kill before stopping.', domain: [1, 5] } },
    perform: runAsAction(async (agent, maxKills) => { ... }, false, 5)
},
{
    name: '!cookFood',
    description: 'Cook all raw meat and potatoes in your inventory at a furnace. '
        + 'Use this instead of !smeltItem for food - it cooks everything raw in one pass, chicken first. '
        + 'Takes no arguments. Needs a furnace nearby or in inventory, and coal/charcoal/logs.',
    params: {},
    perform: runAsAction(async (agent) => { ... }, false, 10)
},
{
    name: '!harvestCrops',
    description: 'Harvest mature crops within range and replant their seeds. '
        + 'Do NOT use !collectBlocks on crops - it ignores maturity and destroys immature plants. '
        + 'Takes range in blocks. Skips immature crops and protected build cells.',
    params: { 'range': { type: 'int', description: 'Search radius in blocks.', domain: [2, 32] } },
    perform: runAsAction(async (agent, range) => { ... }, false, 5)
},
```

Param names are self-explanatory bare (`maxKills:int`, `range:int` — the `!branchMine` y-vs-depth
lesson). No aliases (none needed; and no new name sits one letter from a destructive command —
`!huntFood`/`!cookFood`/`!harvestCrops` collide with nothing in actions.js:83–1593).

## 7. Ordered tasks (each ≈ one engineer-day or less)

| # | Task | Acceptance |
|---|---|---|
| T1 | `farming.js` pure module + `tests/food.test.mjs` (§2, §4). No bot, no server. | `bun tests/food.test.mjs` green, including every must-NOT case; existing suites untouched. |
| T2 | **L1 furnace probe** (`scratchpad/furnace_rig.mjs`, chest_rig style) + L2 crop-age sanity + L5 difficulty read. *Live — schedule against the shared bot; do not run from this planning session.* | Numbers recorded in this doc: furnace put/take verified or defect named; wheat age 0/7 reads correctly; difficulty stated. |
| T3 | `cookFood` + `!cookFood` (path chosen by T2: `smeltItem` as-is, or `furnace_io` first). No per-item restart; counts by inventory diff. | Pure: `cookPlan` cases. Live: `VERIFIED COOK: 6 beef -> 6 cooked_beef...`; a bag of cobblestone produces `nothing raw to cook`, zero furnace opens. |
| T4 | `harvestCrops` + `!harvestCrops` (+ build_guard skip). | Live: `VERIFIED HARVEST: ... replanted N/N`, plot ends as age-0 wheat. Refusal: an age-0 field → 0 broken, field intact. Protected-cell crop skipped. |
| T5 | `huntForFood` + `!huntFood` (nav/pvp alternation per S11, `killConfirmed`, L3 cadence check). | Live: summoned cows → `VERIFIED HUNT: killed 2/3 ... gained N beef`; a target teleported away mid-chase reports `1 fled`, never `killed`; refused from water. |
| T6 | `!stats` supply line (queries.js insert, rendered from pure `foodSupplyLine`). | Pure: null-when-stocked case. Live: absent at food 20 + full bag (control); present under a hunger effect. |
| T7 | `food_supply` mode (insert at modes.js:545/546) with Peaceful stand-down + exponential cooldown. | `bun tests/modes.test.mjs` green (timeout scan picks up new call sites); pure `decideFoodAction` matrix; live L6 drill AND its control (silent during a stocked travel leg). |
| T8 | Flagged edits F1–F3 (own PR; coordinate with other workstreams on actions.js/modes.js). | `bun tests/command_docs.test.mjs` green; compact render of edited descriptions keeps the new prohibitions; optionally A/B via `scratchpad/obedience_ab.mjs`. |

Dependencies: T1 blocks nothing else starting but everything merging (all skills consume it).
T2 gates only T3. T4/T5/T6 are parallel after T1. T7 last (consumes T3–T5). T8 independent.

## 8. Risks (delta from the old plan — its §9 list still applies except the two struck items)

- ~~"goToPosition is pathfinder-backed, don't reuse the movers"~~ — struck (S1/S2).
- ~~"crop state on a stale registry is unproven"~~ — downgraded to L2 (S4).
- **Furnace I/O is the new sharpest edge** (S12): if the chest-class defects apply, `!cookFood`
  built naively either hangs (unbounded `updateSlot` await) or strands food on the cursor and
  drops it on close. That is why T2 gates T3.
- **pvp/nav control-state contention** (S11): the one new way this work could reintroduce the
  "two owners for one key" class of bug. The invariant: *pvp is never active while nav drives*.
- **Peaceful masks everything** (S10): with hunger frozen, every live pass needs the hunger
  effect, and a green run without it proves nothing.
- Starvation-on-travel, thrash-in-a-desert, llama-ranking, SwimAssist ownership: unchanged from
  old §9, all now encoded as pure refusal tests rather than prose.
