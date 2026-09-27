# Resource progression — execution plan (2026-08-31)

Supersedes the design half of [resource-progression.md](resource-progression.md) (drafted
2026-08-22). That plan's *shape* — pure resolver, inventory-diff verification, one command,
re-plan every iteration — survives review. Its facts largely do not: since it was written the
repo shipped `src/agent/library/mining.js` (branch mining, `!branchMine`), overturned the
`onGround` premise, took ownership of block placement (`block_io.js`) and containers
(`container_io.js`/`chest.js`), and measured how command descriptions must be written
(`docs/OBEDIENCE.md`). Also folded in here: the two 2026-08-29 gaps from
[README.md](README.md) — the `staircaseDown` stall and the missing "below target Y" awareness
— because they are the mining half of this workstream.

Scope note: planning only. Nothing here has been run against the live bot; every claim below
is static, with file:line evidence from the working tree on `feature/llm-failover`.

---

## 1. What is stale in the old plan

**a. §3 "new `branchMine`" already exists — do not write it again.**
`src/agent/library/mining.js` (493 lines) ships `staircaseDown`, `mineCorridor`,
`harvestExposedOres`, `branchMine`, `formatMineReport`, with `!branchMine` registered at
`src/agent/commands/actions.js:1544` and tests in `tests/mining.test.mjs` +
`tests/shaft.test.mjs`. But its signature is **area-based**, not count-gated:
`branchMine(bot, { targetY, mainLength, branchLength, branchSpacing, deadlineMs, returnHome })`
(mining.js:356-365) — nothing like the plan's `branchMine(bot, blockNames, count, {targetY})`.
The progression executor needs a thin **count-gated wrapper** (`mineUntil`, §3 below) over the
existing primitives, not a second mining engine.

**b. The `collect`/harvest dispatch through `collectBlock` is broken for exactly this job.**
The old plan's step table executes both `collect` and the ore harvest via
`collectBlock`. `collectBlock` still reaches blocks through `bot.collectBlock.collect(block)`
(skills.js:777) → mineflayer-collectblock → the pathfinder **executor**, which cannot move
this bot; mining.js:6-15 documents three live `!collectBlocks` calls for ores producing
**zero output of any kind**, and the command's own description now says "Do NOT use for ores -
use !branchMine" (actions.js:857). The harvest step is `mining.harvestExposedOres`
(mining.js:320, nav+digWithTool based) — already written. Surface wood/stone through
`collectBlock` is **unverified**: logs are not in `mustCollectManually` (mcdata.js:145-152),
so they take the same collectblock/pathfinder path. Task 7 measures this before trusting it.

**c. `smeltItem` is treated as proven; it sits on the container path this repo declared
unusable.** `smeltItem` calls `bot.openFurnace(furnaceBlock)` (skills.js:342) — the furnace
flavor of `bot.openContainer`, the no-deadline `await once(bot, 'windowOpen')` that CLAUDE.md
documents as "every reason the server declines to send a window is an infinite hang", and which
pinned `currentActionLabel` and killed the process for chests. Its `furnace.putFuel` /
`putInput` / `takeOutput` (skills.js:385-394) ride the same `clickWindow` →
`waitForWindowUpdate` awaits that never settle on 1.17+ and the frozen-`bot.inventory` window
state. The chest rule — "nothing outside chest.js may call bot.openContainer" — has a
furnace-shaped hole. Progression's smelt step needs `furnace_io.js` (§3) built on
`container_io.js`'s fire-and-forget primitives (`fireClick`, `moveItems`, container_io.js:139,
179 — they operate on any window, and a furnace window is just slots 0=input/1=fuel/2=output).

**d. Placement claims predate `block_io.js`.** "Seal with cobblestone (`placeNearby`)" and any
pillaring at depth must go through the owned engine (`src/agent/library/block_io.js`) —
`bot.placeBlock`'s three defects (500ms ack burn, smooth-look delay, body-clearance) are
documented in CLAUDE.md "Block placement - we own it". The lava-seal step in `mineUntil` uses
`block_io`, not `placeNearby`.

**e. Every line reference has shifted.** mcdata.js: `getDetailedCraftingPlan` 503→**462**,
`craftItem` 542→**501**, `isBaseItem` 538→**497**, `getItemSmeltingIngredient` 352→**311**.
skills.js: `collectBlock` 580→**659**, `craftRecipe` 116→**125**, `smeltItem` 291→**300**,
`digDown` 3896→**4245**, `climbToSurface` 4136→**4485**. modes.js unstuck
`excludeFromInterrupt` 199→**271**.

**f. `craftItem`'s steps are prose, not structure.** The plan said the recursion "accumulates
`{required, steps, leftovers}`" as if steps were data; they are pushed as strings —
`crafted.steps.push('Craft ${stepIngredients} -> ${totalProduced} ${item}')` (mcdata.js:555).
The split must restructure that push into `{produces, count, ingredients}` objects and move the
string rendering into `formatPlan`; slightly more surgery than "split it", same idea.

**g. Alias `'pt'` collides.** `'pt': 'plantTrees'` (commands/index.js:62). Use **`'prg'`** —
no existing alias within one edit (nearest are `'ph'`, `'pt'`, two edits away is fine; the
enforced rule is about destructive-beside-read-only, tests/command_docs.test.mjs).

**h. The framing about `onGround`/version skew is overturned.** The plan inherits README.md's
2026-08-22 ground rules; CLAUDE.md "Movement" has since established there is no version skew
and `onGround` is only situationally wrong. The *constraint* — build on nav.js/digWithTool,
never on the pathfinder executor — still stands (the executor really is broken here); only the
stated cause is dead. mining.js's own header (mining.js:12-14, "pathfinder will not even plan
over a 1-block step") repeats the disproven planning claim; correct it in passing (comment-only).

**i. "branchMine always exits via `climbToSurface`" — the shipped one doesn't.** It returns
home via `nav.navigateTo` with `allowDig` (mining.js:444-449). Also `!goToSurface` is now in
`hidden_actions` (settings.js:144-151) because it rides pathfinder with timeout −1. `progressTo`
inherits branchMine's return-home behavior; `climbToSurface` (skills.js:4485) stays the
deep-recovery fallback only.

**j. The unstuck exclusion never happened — for `branchMine` either.** The plan required
`action:progressTo` in unstuck's `excludeFromInterrupt`; the shipped `!branchMine` is **not in
the list** (modes.js:271-274: fill, plantTrees, travel, navTo, marathonRun, swim*, goToBed,
shelter — no branchMine). A bot parked on a vein for >20s can be interrupted by unstuck
mid-mine today. Fix for both names in one append (§6).

**k. Command-doc rules now exist and would have bitten the plan's draft.** Compact mode renders
only param NAMES and imperative-leading sentences (CLAUDE.md "Writing a description the model
will obey", measured 2026-08-29 — after the plan). §7 rewrites the description to survive
compaction, and adds the cross-references the obedience work showed are what make selection
stable.

**l. Y-table detail: diamond at −59 is what the bedrock incident punishes.** `DEFAULT_MINE_Y`
is −12 (mining.js:68). The ORES table survives, but its diamond entry becomes **−53**: bedrock
noise starts near −60, the 2026-08-29 episode was the model oscillating at −45..−63, and
`resolveProgression` clamps every `targetY` to ≥ −53 so no plan can send the executor into the
layer the model got lost in.

Still valid and kept: the resolver refactor (§1 of the old plan), the pure `progression.js`
module, inventory-diff verification, one-command design, re-plan-per-iteration, the risks list
(minus the night-safety caveat — `night_safety` shipped, and the world is Peaceful).

---

## 2. Root-cause hypothesis: the `staircaseDown` stall at Y=−45

Incident (docs/OBEDIENCE.md "Not done" b): `staircaseDown` returned `no descent progress` at
(4529,−45,4715) after digging **1 block in 4 seconds**; `!branchMine` reported it honestly; the
model then freelanced `digDown`/`navTo` into bedrock and oscillated ~2h.

**Hypothesis: the staircase walked into open air — a cave — that its own direction heuristic
steered it toward, and it has no move for that geometry.** Chain of evidence:

1. **The direction is chosen once and never reconsidered.** `const dir = pickOpenDirection(bot)`
   sits *outside* the loop (mining.js:220); the stall branch only counts
   (mining.js:245-251) — it never turns.
2. **`pickOpenDirection` prefers air.** `if (isAir(name)) score += 1` (mining.js:267). That is
   correct for starting a corridor (less digging) and precisely wrong for a descent: air ahead
   means nothing to cut a step into. At Y=−45 — prime deepslate-cave altitude — the airiest
   direction is very often a cave mouth.
3. **Each step inspects only 3 cells** — feet, head, floor-below (mining.js:233) — and **never
   the landing support** at `ahead.offset(0,−2,0)`. Over a cave, the three digs return
   `'skipped'` (already air, mining.js:170-171), dug stays ~0, and the step target
   `(ahead, y−1)` hangs over open air.
4. **The planner then has no move into that column, and fails in milliseconds.** `navigateTo`
   → `planPath`: a level move needs `standCost ≠ null` (solid below — nav.js:366), the drop
   scan needs a standable cell within `maxDrop` (nav.js:385-395), and the dig fallback needs a
   solid cell to price (nav.js:399-402). An open column offers none, so the plan is null or a
   sideways stub — and `yBefore − y < 0.5` trips a stall (mining.js:245).
5. **The timing fingerprint only fits this branch.** Three stalls in ~4s is only reachable if
   digs were `'skipped'` and navs failed at *plan* time (~ms each). The competing hypotheses
   predict different signatures: a tool/hardness stall means `'blocked'` digs at the 8s
   `DIG_TIMEOUT_MS` each (mining.js:143) — ≥24s for three stalls; lava or an unloaded chunk
   returns `reason: 'unsafe cell'` (mining.js:236), a different string than the one logged.

**Cheapest experiment to confirm or kill** (in order; none touch the live bot's behavior):

- **Pure, now**: extract `descentStepVerdict` (§3) and encode the cave geometry in
  `tests/descent.test.mjs` — proves the logic hole exists, not that it fired.
- **Terrain probe, ~5 min, no bot** (when live ops are allowed again): `forceload add 4529 4715`
  then `execute if block 4529±d −44..−48 4715±d air` down the four cardinal columns 1-6 blocks
  out (match "Test passed"; remember the RCON echo trap). If the airiest direction from
  (4529,−45) opens into air below foot level → confirmed. If all four are solid rock →
  **killed**, fall back to instrumentation. Caveat: 2h of freelance digging may have chewed the
  site; check for obviously bot-shaped tunnels before trusting a "cave" reading.
- **Offline gym**: `scratchpad/descent_gym.mjs` builds two lanes at depth — (A) solid
  deepslate, (B) a cave pocket one block ahead of the start. Expect A `reached: true`, B
  `no descent progress` with `dug ≤ 1` in seconds. If B descends fine, the hypothesis is dead;
  then add one log line per stall (the three `digCell` results + plan length + `movedY`) and
  re-run live — that line also stays in permanently, because the incident's log said nothing
  about *why*.

**The fix, shaped by the hypothesis** (Task 2): a descent-specific direction chooser that
prefers **solid** rock (the opposite of `pickOpenDirection`), a landing-support check in the
per-step verdict, and **turn-on-stall** — rotate through the remaining directions before
declaring `no descent progress`. A bot in an open cavern with no solid wall in any direction
refuses with a *named* reason (`'open cavern'`), which is what the model needed to hear instead
of a generic stall it "fixed" with `digDown`.

---

## 3. New files and signatures

### `src/agent/library/progression.js` — NEW, entirely pure

No `bot`, no imports from skills.js/mining.js; recipe lookups injected via `deps`.

```js
// The tech tree, in code. targetY values are mining Y levels, clamped ≥ -53 (see §1.l).
export const ORES = {
  coal:     { blocks: ['coal_ore','deepslate_coal_ore'],       targetY: 44,  tool: 'wooden_pickaxe' },
  raw_iron: { blocks: ['iron_ore','deepslate_iron_ore'],       targetY: 16,  tool: 'stone_pickaxe'  },
  raw_gold: { blocks: ['gold_ore','deepslate_gold_ore'],       targetY: -12, tool: 'iron_pickaxe'   },
  diamond:  { blocks: ['diamond_ore','deepslate_diamond_ore'], targetY: -53, tool: 'iron_pickaxe'   },
};

// Ordered acquisition ladder; mirrors TIERS in tools.js:16 (the authority, not harvestTools).
export const TOOL_GATES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'];

/**
 * Resolve target -> ordered steps against an inventory count map.
 * @param {string} targetItem   e.g. 'iron_pickaxe'
 * @param {number} count
 * @param {Object<string,number>} inv        world.getInventoryCounts shape
 * @param {object} deps { getCraftingPlanSteps, isBaseItem, getItemSmeltingIngredient, fuelBurns }
 * @returns {{ steps: Step[], satisfied: boolean, error?: string }}
 *   Step = { kind:'collect'|'craft'|'smelt'|'mine', item, count }
 *        & (mine:  { blocks, targetY, requiredTool })
 *        & (smelt: { input, fuel: {name, count} })
 */
export function resolveProgression(targetItem, count, inv, deps)

/** First step the inventory does not satisfy; null = plan satisfied. Pure. */
export function firstUnsatisfied(steps, inv)

/** 'bare'|'wood'|'stone'|'iron'|'diamond' from an inventory count map alone. Pure. */
export function progressionTier(inv)

/** Render the outcome line (VERIFIED PROGRESSION / PROGRESSION INCOMPLETE, with counts). Pure. */
export function formatProgressReport(r)
```

### `src/utils/mcdata.js` — additive exports (zero behavior change to `!getCraftingPlan`)

```js
export function getCraftingPlanSteps(targetItem, count = 1, inventory = {})
// -> { required: {item: n}, craftSteps: [{produces, count, ingredients: {item: n}}],
//      leftovers: {item: n}, satisfied: boolean, error?: string }
export function isBaseItem(itemName)   // promote the private at mcdata.js:497
```

`craftItem`'s `steps.push(string)` (mcdata.js:555) becomes a structured push; `formatPlan`
renders the strings from the objects. Byte-identical output is the acceptance test.

### `src/agent/library/mining.js` — additive

```js
/** PURE. Given the relative reader safeToBreak already uses (mining.js:105), decide one
 *  descent step: which cells to dig, whether the landing (0,-2,0) supports a step, or turn. */
export function descentStepVerdict(at)
// -> { ok: true, cells: [[dx,dy,dz]...] }            dig-and-step
//  | { ok: false, turn: true,  reason: 'open landing'|'no floor ahead' }
//  | { ok: false, turn: false, reason: 'lava adjacent'|'unloaded chunk'|... }  (fatal, from safeToBreak)

/** PURE core + thin live wrapper. Prefers SOLID rock ahead (a staircase wants something to cut
 *  into); refuses fluid/unloaded directions the way pickOpenDirection does. */
export function pickDescentDirection(bot, exclude = [])

/** PURE. {above: n} | {below: n} | {at: true} — the "below target Y" primitive. */
export function depthDelta(y, targetY)

/** PURE. One advisory line or null. Fires only underground where it matters (y < 0);
 *  below -53 it says the hard part: "BELOW the diamond band; digging down reaches only
 *  bedrock - dig UP." Null on the surface, so the normal prompt costs nothing. */
export function depthAdvisory(y)

/** LIVE. Count-gated mining: staircase to ORES-appropriate depth, corridor+branches until
 *  `count` of any name in `blockNames`' DROPS are held, or deadline. Composes staircaseDown /
 *  mineCorridor / harvestExposedOres; never a second engine. Returns a branchMine-shaped
 *  report plus { wanted, got }. Never throws. */
export async function mineUntil(bot, blockNames, count, { targetY, deadlineMs = 900000, requiredTool } = {})
```

`staircaseDown` itself changes minimally: per-step it consults `descentStepVerdict`, and on a
`turn` verdict (or a stall) re-picks direction via `pickDescentDirection(bot, tried)` before
counting toward `MAX_STALLS`; all four directions exhausted → `reason: 'open cavern'`. Its
return gains `targetY` so callers can render the delta. `formatMineReport` renders
`depthDelta`: "descent stopped 33 above target −12" / "y=−61 is 8 BELOW target — do not dig
further down".

### `src/agent/library/furnace_io.js` — NEW

Owned furnace protocol over `container_io.js` primitives (`fireClick`, `moveItems`,
`clearCursor`, `safeClose`-equivalent), same design as chest.js: never await mineflayer's
click, every count read from `window.slots`, bounded by `withTimeout`.

```js
/** PURE. Arithmetic only: how much fuel for n smelts, is the held fuel enough, expected output. */
export function planSmelt({ count, fuelName, fuelCount, fuelBurns })
// -> { ok, fuelNeeded, reason? }

/** LIVE. Open (bounded), load input+fuel via slot writes, poll the OUTPUT SLOT (window.slots
 *  is live), take output, close in finally. Verifies by inventory diff after close (the bag
 *  is frozen while open - count before and after, never during). Returns { smelted, reason }. */
export async function smeltVerified(bot, furnaceBlock, { inputName, count, fuelName })
```

### `src/agent/library/skills.js` — appended exports only

```js
/** The executor loop: resolve -> first unsatisfied -> dispatch -> verify by inventory diff ->
 *  re-plan. Bounded: runAsAction timeout, max 3 consecutive failures of the SAME step,
 *  bot.interrupt_code every iteration. Sets bot.last_verification on exit. */
export async function progressTo(bot, itemName, num = 1)

/** Nav-based surface collection (contingent on Task 7's measurement): nearest matching block
 *  via world.getNearestBlocksWhere, approach via nav.navigateTo, digWithTool, pickupNearbyItems.
 *  Only written if collectBlock measures broken for logs/stone. */
export async function collectNearby(bot, blockNames, count)
```

Step dispatch inside `progressTo`: `collect` → `collectBlock` or `collectNearby` (Task 7
decides); `craft` → `craftRecipe` (skills.js:125, works — rides the navToGoal seam);
`smelt` → `furnace_io.smeltVerified`; `mine` → `mining.mineUntil`.

---

## 4. PURE / LIVE split

**PURE (unit-tested with fixtures, no bot, no minecraft-data instance):**
- All of `progression.js`: `resolveProgression`, `firstUnsatisfied`, `progressionTier`,
  `formatProgressReport`, `ORES`/`TOOL_GATES` tables. The whole state machine — what tier am
  I, what is the next acquisition — is a function of an inventory count map + injected recipe
  deps. This is the maximal pure surface: the executor contains **no tech-tree knowledge at
  all**, only dispatch and verification.
- `mcdata.getCraftingPlanSteps` (deps still module-level there, but callable with a plain
  inventory object; progression tests inject a handcrafted recipe fixture via `deps` and never
  touch mcdata).
- `mining.descentStepVerdict`, `depthDelta`, `depthAdvisory`, the direction-scoring core of
  `pickDescentDirection`, and `formatMineReport`'s new delta rendering — same
  relative-reader pattern `safeToBreak` already proves testable (mining.test.mjs).
- `furnace_io.planSmelt`.

**LIVE (thin, built only on proven primitives, verified by gyms + inventory diffs):**
- `skills.progressTo` loop (dispatch + before/after `world.getInventoryCounts`, world.js:408).
- `mining.mineUntil`, the `staircaseDown` turn-on-stall wiring.
- `furnace_io.smeltVerified` window driving.
- `collectNearby` if needed.

The rule from tests/water_exit.test.mjs and tests/follow.test.mjs applies throughout: every
*decision* is a pure verdict function; the live code only gathers inputs and acts on the verdict.

---

## 5. Tests

### `tests/progression.test.mjs` (new; handcrafted recipe fixture via `deps`)
- Empty inventory → full ordered plan for `iron_pickaxe`: planks before sticks before pickaxe;
  crafting_table before any table-craft; `stone_pickaxe` gate before the `raw_iron` mine step;
  furnace + fuel steps before the smelt.
- Partial inventories shrink the plan (has 3 planks; has a wooden pick); satisfied inventory →
  `satisfied: true, steps: []`.
- Tool gates: a `diamond` plan inserts `iron_pickaxe` unasked; delete the pickaxe from the
  fixture inventory, re-resolve, assert it reappears (breakage = re-plan).
- `firstUnsatisfied`: skips satisfied prefixes; null at completion.
- `progressionTier` over count maps for all five tiers.
- ORES sanity: every `tool` ∈ TOOL_GATES, every block ends `_ore` or is a real drop source,
  **every `targetY` ≥ −53**.
- **Must NOT fire**: no `mine` step when the ore/drop is already held in count; no
  `crafting_table` craft when one is in the inventory; no `smelt` step for a plain craftable;
  an `iron_pickaxe` plan contains **no** diamond-tier step; unknown item → `{error}`, never a
  throw, never an empty "satisfied" plan.
- `formatProgressReport`: success line starts `VERIFIED PROGRESSION` with counts; a run that
  acquired nothing must **NOT** say VERIFIED (the vacuous-success rule from formatMineReport).
- `getCraftingPlanSteps` regression: `getDetailedCraftingPlan` output **byte-identical** before
  and after the split for pickaxe/table/stick cases.

### `tests/descent.test.mjs` (new; relative-reader fixtures like mining.test.mjs)
- `descentStepVerdict`: solid rock all around → `ok` with the 3 dig cells; **landing open**
  (air at (0,−2,0) under the step) → `turn: 'open landing'`; whole column ahead open →
  `turn: 'no floor ahead'`; lava in any of the six neighbours of a dig cell → fatal, not turn;
  unloaded anywhere → fatal ('unloaded chunk'); gravel above a dig cell → refused (delegates
  to `safeToBreak`, same reasons).
- **Must NOT fire**: plain solid deepslate does NOT turn; sandstone above does NOT read as
  falling (the canonical bug); a landing of solid stone under 1 air is a normal step.
- `pickDescentDirection` scoring: solid beats air (the inversion of `pickOpenDirection` —
  assert both on the same fixture so the difference is the test); fluid/unloaded directions
  refused; `exclude` honoured; all four excluded → null.
- `depthDelta` all three shapes; `depthAdvisory`: null at y=70 and y=5 (must NOT pollute the
  surface prompt), advisory below 0, the "dig UP" wording below −53, and monotone: never says
  "below" when above.

### `tests/mining.test.mjs` (extend)
- `formatMineReport` with `targetY`: descent-short run renders "N above target"; a below-target
  y renders "BELOW target — do not dig further down"; at-target renders **neither**.

### `tests/furnace_io.test.mjs` (new)
- `planSmelt`: coal burns 8 → 3 iron needs 1 coal; insufficient fuel → `{ok:false}` named;
  zero count refused. Must NOT: never plans fractional fuel, never `ok` with no fuel name.

### `tests/command_docs.test.mjs`
- Already sweeps every command + alias automatically; `!progressTo` and `'prg'` are covered by
  registration. Add nothing unless the sweep demands it.

---

## 6. Integration points (shared-file footprint — purely additive)

- **`src/agent/library/skills.js`**: append `progressTo` (and `collectNearby` if Task 7 says
  so) at end-of-file; two import lines (`progression.js`, `furnace_io.js`). No existing
  function touched. (`smeltItem` itself is left alone — other callers keep it; `progressTo`
  simply doesn't call it.)
- **`src/agent/commands/actions.js`**: append ONE command object, `!progressTo` (§7), using the
  existing `runAsAction(fn, true, 60)` wrapper (actions.js:47).
- **`src/agent/commands/queries.js`**: ONE conditional line in `!stats`, following the
  in-water/jump pattern (queries.js:32-53 — costs nothing when it doesn't apply):
  `const depth = mining.depthAdvisory(pos.y); if (depth) res += '\n- ' + depth;`
  plus the `import * as mining` line. This is the "below target Y" fix reaching `$STATS`
  (prompter.js:283-318 builds `$STATS` from this very query).
- **`src/agent/commands/index.js`**: append `'prg': 'progressTo'` to `COMMAND_ALIASES`.
- **`src/agent/modes.js`**: append `"action:branchMine", "action:progressTo"` inside unstuck's
  existing `excludeFromInterrupt` array (modes.js:271) — both carry their own stall detection
  and deadlines, the same argument as `action:travel`. Nothing else in modes.js changes;
  `self_preservation`/`drowning`/`self_defense` still interrupt.
- **Not shared / free to edit**: `mining.js`, new `progression.js`, new `furnace_io.js`,
  `mcdata.js` (the split is additive-plus-one-refactor with a byte-identical output gate).
- **Two description sentences on existing commands** (flagged: the only non-append edits, both
  single-sentence appends to a string, justified by the measured cross-reference rule): on
  `!getCraftingPlan` — "Use !progressTo to actually acquire the item; this only prints the
  plan."; on `!digDown` — "Do NOT use to reach an ore layer - use !progressTo or !branchMine,
  which stop at the right depth." The prohibition goes on the tempting command, per OBEDIENCE.

---

## 7. Command doc text (compact-mode proof: first sentence ≤120ch; follow-ups start imperatively; param names self-explanatory bare)

```js
{
    name: '!progressTo',
    description: 'Acquire an item via the full tech tree: gather, craft, smelt and mine every prerequisite automatically. '
               + 'Use for tool or gear targets like iron_pickaxe. '
               + 'Do NOT drive the steps yourself with !collectBlocks or !craftRecipe - one call runs the whole chain and reports VERIFIED counts. '
               + 'Takes up to 60 minutes; interrupting it is safe, it resumes.',
    params: {
        'item': { type: 'ItemName', description: 'The item to acquire, e.g. iron_pickaxe.' },
        'quantity': { type: 'int', description: 'How many. Default 1.', domain: [1, 64], optional: true }
    },
    perform: runAsAction(async (agent, item, quantity = 1) => { ... }, true, 60)
}
```

Compact render check: sentence 1 is 109 chars; sentences 2-4 begin "Use", "Do NOT", "Takes" —
all survive `compactDescription`. Params render as `item:ItemName, quantity:int` — both
meaningful bare (the `!branchMine` depth/y lesson: no param whose bare name invites the wrong
domain).

---

## 8. Ordered task list (each sized for one engineer)

**T1 — Descent verdict, pure.** Extract `descentStepVerdict` + `pickDescentDirection` scoring
into mining.js (no behavior change yet: `staircaseDown` calls the verdict but still only
aborts/stalls as today); add `tests/descent.test.mjs`; fix the stale planning claim in
mining.js's header comment. *Accept*: new tests green; `bun tests/mining.test.mjs` +
`tests/shaft.test.mjs` unchanged-green.

**T2 — Descent recovery + gym.** Wire turn-on-stall and the landing check into
`staircaseDown`; `reason: 'open cavern'` when all directions refuse; one diagnostic log line
per stall (digCell results, plan length, movedY). Write `scratchpad/descent_gym.mjs` (solid
lane + cave lane). *Accept*: gym lane A reaches target; lane B either descends (turned) or
refuses named — never a bare `no descent progress`; the §2 terrain probe run and its result
recorded here once live ops are allowed.

**T3 — Depth awareness.** `depthDelta` + `depthAdvisory` (pure, tested incl. must-NOT-fire),
`targetY` in the staircase/branchMine report, `formatMineReport` delta rendering, the one
`!stats` line, the modes.js excludes append. *Accept*: tests green; a hand-driven `!stats`
at depth shows the line and on the surface does not (live check deferred with T8's window).

**T4 — mcdata split.** Structured `getCraftingPlanSteps`, `isBaseItem` export, `formatPlan`
over structs. *Accept*: byte-identical `getDetailedCraftingPlan` output on a fixture set
(snapshot in tests/progression.test.mjs).

**T5 — `progression.js` resolver.** Full pure module + tests. *Accept*:
`bun tests/progression.test.mjs` green, including every must-NOT case.

**T6 — `furnace_io.js`.** `planSmelt` pure + `smeltVerified` on container_io primitives;
`tests/furnace_io.test.mjs`; live rig `scratchpad/furnace_rig.mjs` (place furnace, smelt 3
raw_iron, assert inventory diff = 3, nothing on the floor, no hang). *Accept*: pure tests
green; rig deferred until live ops allowed, then 3/3.

**T7 — Measure `collectBlock` on the surface.** One live measurement (when allowed):
`!collectBlocks("oak_log", 3)` and `("stone", 5)` from beside the resources. If verified counts
move → `progressTo` uses it and `collectNearby` is not written. If silent-fail (the ore
signature) → write `collectNearby` per §3. *Accept*: the measurement recorded here; whichever
branch, `progressTo`'s collect dispatch has a proven backend.

**T8 — Executor + command + live run.** `skills.progressTo`, `mining.mineUntil`, the
`!progressTo` command object, `'prg'` alias, the two cross-reference sentences. *Accept*:
`bun tests/command_docs.test.mjs` green; then the old plan's live gate, unchanged: from an
empty survival inventory, `!progressTo("iron_pickaxe")` ends with the VERIFIED line and
`!inventory` shows the pickaxe, target ≤45 min, actual number recorded here; stretch
`diamond_pickaxe` afterwards — which is also the end-to-end regression for T1-T3, since it
must descend past Y=−45 country and come home.

Order rationale: T1-T3 are the incident fixes and are independently shippable; T4-T5 are pure
and parallelizable with them; T6-T7 clear the two unproven backends before T8 composes
everything. Nothing before T8 touches the shared files except T3's two appends.
