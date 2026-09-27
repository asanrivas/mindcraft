# Gap: Resource progression

Status: **PLAN — nothing implemented**

A human internalises the tech tree: punch wood, craft table + wooden pick, mine stone, stone
pick, find iron, smelt it, iron pick, dive for diamonds at the right Y. Andy has every piece —
`collectBlock`, `craftRecipe`, `smeltItem`, `digDown`, `climbToSurface`, tool tiers in
`tools.js` — but nothing sequences them. The 9B local model improvises the sequence per
conversation and gets it wrong in a different way each time. `!getCraftingPlan` resolves the
dependency tree already, but it renders **text for the model to read**, not steps for an
executor to run.

The fix is the same shape as every win in this repo: move the reasoning out of the prompt and
into deterministic code, and gate "done" on the world, not on the model's say-so (see the
`!endGoal` verification gate in `actions.js` — the model asserts completion regardless; only
the verified read stops it).

## Design

One new command, `!progressTo("iron_pickaxe")`, backed by a deterministic
plan-execute-verify loop. The model's only job is to call it once.

```
!progressTo(item, n)
   └─ skills.progressTo(bot, item, n)          <- runAsAction("progressTo", resume=true, 60min)
        loop until satisfied or deadline:
          1. plan  = resolveProgression(item, n, getInventoryCounts(bot))   <- PURE
          2. step  = plan[0]  (first unsatisfied step)
          3. execute step with the existing skill for its kind
          4. verify: re-read inventory; the step is done only if the COUNT moved
          5. re-plan from scratch (handles breakage, partial yields, surprises)
```

Re-planning every iteration is the robustness mechanism: if a pickaxe breaks mid-plan, the next
resolve simply re-inserts it. No plan state to corrupt.

### 1. The resolver — refactor, don't rewrite

`getDetailedCraftingPlan` in `src/utils/mcdata.js:503` already does the hard part: `craftItem()`
(line 542) recursively resolves recipes against an inventory copy, tracks leftovers, and
accumulates `{required, steps, leftovers}` — then `formatPlan` flattens it to prose. Split it:

```js
// src/utils/mcdata.js — NEW exports, zero behaviour change to !getCraftingPlan
export function getCraftingPlanSteps(targetItem, count, inventory)
//  -> { required: {itemName: n},                    // base items still missing
//       craftSteps: [{produces, count, ingredients: {itemName: n}}],
//       satisfied: boolean }
export function isBaseItem(itemName)                 // currently private (line 538)
```

`getDetailedCraftingPlan` becomes a thin text wrapper over `getCraftingPlanSteps`, so
`!getCraftingPlan` output is unchanged.

On top of that, a **new pure module** `src/agent/library/progression.js` maps base items to
acquisition actions and inserts tool gates:

```js
// All pure functions. No bot, no imports from skills.js.
export const ORES = {
  coal:     { blocks: ['coal_ore','deepslate_coal_ore'],       y: 96,  tool: 'wooden_pickaxe' },
  raw_iron: { blocks: ['iron_ore','deepslate_iron_ore'],       y: 16,  tool: 'stone_pickaxe'  },
  raw_gold: { blocks: ['gold_ore','deepslate_gold_ore'],       y: -16, tool: 'iron_pickaxe'   },
  diamond:  { blocks: ['diamond_ore','deepslate_diamond_ore'], y: -59, tool: 'iron_pickaxe'   },
};

export function resolveProgression(targetItem, count, inventory, deps = mcdataDeps)
// -> ordered [{ kind: 'collect'|'craft'|'smelt'|'mine', item, count, ...extras }]
//    e.g. mine steps carry { blocks, targetY, requiredTool }; smelt carries { input, fuelNeeded }
export function firstUnsatisfied(steps, inventory)   // -> step | null (null = plan satisfied)
```

Rules the resolver encodes (this IS the tech tree, in code instead of in the prompt):

- **Smelt mapping**: `iron_ingot` is not craftable — insert `smelt raw_iron` (reverse of
  `getItemSmeltingIngredient`, `mcdata.js:352`), which recursively requires `raw_iron` (a mine
  step) + a `furnace` (craftable, 8 cobblestone) + fuel (prefer what `getSmeltingFuel`
  accepts: coal if cheap to add, else logs/planks already in the plan).
- **Tool gates**: a `mine` step for `raw_iron` inserts `stone_pickaxe` ahead of it if absent;
  `diamond` inserts `iron_pickaxe`. The gate ladder is hardcoded from `TIERS` in
  `tools.js:16` — do **not** trust `block.harvestTools` from one-version-stale minecraft-data
  as the authority; use it only as a cross-check.
- **Collect mapping**: `oak_log`->`collect` (any log — `collectBlock` already normalises log
  variants, `skills.js:620`), `cobblestone`->`collect` (alias to `stone`, line 616),
  `crafting_table` is a craft step, not a find step.
- **`deps` injection**: the resolver takes its recipe lookups (`getItemCraftingRecipes`,
  `isBaseItem`, `getItemSmeltingIngredient`) as an argument so tests can hand it a fixture and
  never touch a live `minecraft-data` instance (which only initialises after `initBot`).

### 2. The executor

```js
// src/agent/library/skills.js
export async function progressTo(bot, itemName, num = 1)
```

Step dispatch, all existing skills:

| step kind | executes | verifies by |
|---|---|---|
| `collect` | `collectBlock(bot, item, needed)` | inventory count of `item` increased to plan |
| `craft` | `craftRecipe(bot, item, needed)` | inventory count (craftRecipe already re-reads with retry, `skills.js:219-230` — reuse, don't duplicate) |
| `smelt` | `smeltItem(bot, input, needed)` | inventory count of the output |
| `mine` | **new** `branchMine(bot, blocks, needed, {targetY, requiredTool})` | inventory count of the drop |

Invariants:

- **A step is done when the ITEM EXISTS IN INVENTORY in the planned count** —
  `world.getInventoryCounts(bot)` (`world.js:408`) before and after, never the skill's boolean,
  never the model's claim. This extends the repo's verification pattern
  (`VERIFIED TRAVEL: moved n/m`, the `!endGoal` gate) to items.
- **Bounded**: hard deadline (default 60 min via `runAsAction` timeout), max 3 consecutive
  failures of the *same* step before aborting with a diagnosis, `bot.interrupt_code` checked
  every iteration.
- **Outcome string with counts**, both ways:
  - `VERIFIED PROGRESSION: iron_pickaxe x1 in inventory. 14 steps in 27m (7 collect, 5 craft, 1 smelt, 1 mine).`
  - `PROGRESSION INCOMPLETE: stuck at mine raw_iron (have 1/3) after 3 attempts at y=16. Have: stone_pickaxe, 12 cobblestone, ...`
- On completion/failure, also set `bot.last_verification` so the existing `!endGoal` refusal
  covers progression goals for free.

### 3. Ore acquisition: `branchMine`

```js
// src/agent/library/skills.js (or a new mining.js if it outgrows ~150 lines)
export async function branchMine(bot, blockNames, count, { targetY, maxMinutes = 20 })
```

**Y-level targets — assumption stated explicitly.** The server is Minecraft 26.1 (protocol
775), but mineflayer + minecraft-data 3.113.2 run 1.21.11 data, and ore generation curves are
*world-gen*, not in minecraft-data at all — the table cannot be verified from data we ship.
**Assume the 1.18-1.21 distribution is unchanged in 26.1**: diamond -64..16 peaking at **-59**,
iron peaking at **16** (plus a mountain band irrelevant underground), coal peaking at **96**.
Mitigation is calibration, not faith: `branchMine` logs ore-hits-per-100-tunnel-blocks; if iron
yields zero after 200 blocks at y=16, sweep +/-8 and record the result in this doc.

Procedure (built only on primitives proven on this server):

1. **Descend** with `digDown` (`skills.js:3896`) in <=16-block segments to `targetY`. digDown
   already stops on lava/water below and on >2-block drops — **keep that invariant untouched**;
   lava is the death sentence. On a lava stop: seal with cobblestone (`placeNearby`), sidestep
   one column (`breakBlockAt` + step), resume. Torch each segment (`autoLight`, `skills.js:81`,
   already exists and is already called by `collectBlock`).
2. **Branch** at `targetY`: 2x1 tunnels dug with `digWithTool` (`tools.js:51` — already refuses
   bedrock and lava), 3-block spacing, torch every 8. **Before every dig, probe the 5 blocks
   adjacent to the one being broken**; if any is lava, seal and turn — `digWithTool` protects
   against digging *into* lava, not against opening a wall *onto* it. Check
   `isFallingBlockName` above before breaking (use the canonical test, never substring-match).
3. **Harvest**: every few metres, scan with `world.getNearestBlocksWhere` for `blockNames`;
   collect exposed ore via `collectBlock` (its 64-block search sees what the tunnel exposed,
   and it already appends `deepslate_` variants).
4. **Exit**: when `count` is in inventory or the time box expires, `climbToSurface(bot)`
   (`skills.js:4136` — proven, with the pillar-up fallback). branchMine **always returns on
   the surface**.

**Coexistence with the surface-bias machinery — explicit.** `travelDirection` refuses to
tunnel >20 blocks below the surface and auto-invokes `climbToSurface`; that logic fixed a real
31-blocks-down death spiral and must not be fought:

- Mining is a **deliberate action**, `action:progressTo`, and actions are serialised by the
  ActionManager — `travelDirection` never runs while branchMine is underground. Surface travel
  legs inside `progressTo` (e.g. walking to a forest) happen only while on the surface.
- The `unstuck` mode gains `"action:progressTo"` in its `excludeFromInterrupt` list
  (`modes.js:199`), exactly like `action:travel` already has, because tunnelling looks like
  being stuck to the 20s position test. branchMine carries its own deadline instead.
- **Nothing else is excluded**: `self_preservation`, `self_defense`, `cowardice`, `drowning`
  may all still interrupt. `resume=true` on the command means an interrupted progression picks
  up where the re-plan says it should.
- Because branchMine always exits via `climbToSurface`, the bot is never left in the
  "underground with no route" state that the preferY/refuse-to-tunnel machinery exists to
  prevent.

### 4. The command

```js
// src/agent/commands/actions.js
{
  name: '!progressTo',
  description: 'Autonomously acquire an item: resolves the full tech tree (gather, craft, '
             + 'smelt, mine at the right depth) and executes it. Reports VERIFIED counts.',
  params: {
    'item_name': { type: 'ItemName', description: 'The item to acquire, e.g. iron_pickaxe.' },
    'quantity':  { type: 'int', domain: [1, 64], optional: true, default: 1 }
  },
  perform: runAsAction(async (agent, item_name, quantity = 1) => {
    return await skills.progressTo(agent.bot, item_name, quantity);
  }, true, 60)   // resume=true; 60 min ceiling
}
```

Register in `commands/index.js`; alias `'pt': 'progressTo'`.

### 5. LLM interaction: one command, deterministic inside

The model calls `!progressTo("iron_pickaxe")` **once**; the executor drives every step. No
task-loop of per-step prompts. The precedent is already written down in CLAUDE.md: the
`!endGoal` gate exists because "the model will assert completion regardless" — prompt-side
sequencing is exactly what this gap says a 9B model does unreliably, and every reliability win
in this repo (VERIFIED TRAVEL, fill verification, the steering bounds) came from moving logic
out of the prompt. The self-prompt loop interrupting its own in-flight work (the 97-minute
`!travel` incident) is the other half of the argument: a step-per-prompt loop would interrupt
its own mining. `!getCraftingPlan` stays as the informational sibling for when the model just
wants to *talk* about a plan.

### 6. Pure-testable pieces

`tests/progression.test.mjs` (bun, fakes, no network, no bot):

- Resolver with a handcrafted recipe fixture (log->planks->sticks->tools chain): empty inventory ->
  full ordered plan; assert order (planks before sticks before pickaxe, table before any
  table-craft, stone_pickaxe before the raw_iron mine step, furnace+fuel before smelt).
- Inventory diffing: partial inventories (has 3 planks, has a wooden pick already) shrink the
  plan correctly; satisfied inventory -> empty plan.
- Tool gates: `progressTo(diamond)` plan contains `iron_pickaxe` before the mine step even
  when not asked for; breakage simulation — remove the pickaxe from the fake inventory, re-run
  the resolver, assert it is re-inserted.
- `firstUnsatisfied` semantics and the plan-satisfied terminal state.
- `ORES` table sanity: every entry's `tool` is in `TIERS`-derived names, blocks all end in a
  real ore suffix.

### 7. Live verification

From **empty inventory** on the live server (empty via `!discard`, not creative):
`!progressTo("iron_pickaxe")` must end with the VERIFIED line and `!inventory` showing the
pickaxe. **Wall-clock target: <=45 minutes** (budget: wood 3m, craft chain 2m, stone 3m, descend
+ branch-mine 3 iron 15-25m at this bot's speeds, smelt+craft 3m, climb out 3m). Record the
actual number here after the first clean run, per the measure-before-tuning rule. Then the
stretch run: `!progressTo("diamond_pickaxe")` — no time target until iron numbers exist.
Drive it like the travel legs: one command, wait for the VERIFIED line, no self-prompt loop
(`!endGoal` + a `!steer` directive for a clean measurement run).

### 8. Risks

- **Recipe data wrong for 26.1**: crafting recipes for wood/stone/iron tools are ancient and
  stable — low risk; the executor's inventory-diff verification catches a wrong recipe as a
  failed craft step with counts, not silent nonsense. **Ore-gen Y is the real unknown** (see
  §3 calibration).
- **Tool breakage mid-plan**: covered by re-plan-per-iteration; additionally check durability
  before descending (a pickaxe at 5 uses should be replaced on the surface, where wood is).
- **Night/mobs**: night-safety is **gap #2 and a stated dependency** ([night-safety.md](night-safety.md))
  — this plan does not solve it. Mitigation here: combat/flee modes are *not* excluded from
  interrupting, and `resume=true` continues after; being underground with torches is
  incidentally mob-safer than the surface.
- **Inventory full**: `collectBlock` already refuses at 0 free slots (`skills.js:598`).
  Pre-flight: require >=6 free slots to start; mid-plan, discard surplus cobblestone beyond
  plan needs +8 before descending (cheapest item, always re-minable).
- **Lava**: keep digDown's stop-on-lava invariant untouched; branchMine adds adjacent-block
  probing and seal-and-turn. The failure mode of every branch must be "wall of cobblestone",
  never "open channel".

### Critical Files for Implementation

- `src/utils/mcdata.js` — split `getDetailedCraftingPlan` (line 503) into structured `getCraftingPlanSteps` + text wrapper; export `isBaseItem`
- `src/agent/library/progression.js` — NEW: pure resolver (`resolveProgression`, `firstUnsatisfied`, `ORES`)
- `src/agent/library/skills.js` — NEW `progressTo`, `branchMine`; reuses `collectBlock` (580), `craftRecipe` (116), `smeltItem` (291), `digDown` (3896), `climbToSurface` (4136)
- `src/agent/commands/actions.js` — `!progressTo` via `runAsAction(fn, true, 60)`
- `src/agent/modes.js` — add `"action:progressTo"` to unstuck `excludeFromInterrupt`
