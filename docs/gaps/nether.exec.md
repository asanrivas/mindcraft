# Nether — execution plan (2026-08-31)

Supersedes `docs/gaps/nether.md` (2026-08-22). Verified against the working tree on
`feature/llm-failover`. **Bottom line first: build the ~20% that is pure or protective now
(§9 phase A, roughly two days), ship the portal builder only when someone asks for a portal,
and DEFER traversal, the nether nav profile, and lava crossing until resource progression
ships and there is a demonstrated need.** The lava section (§3) is the reason: the navigator
is *designed* to refuse the terrain the Nether is made of, and resolving that well is a
design decision, not a bug fix — it should not be rushed to justify the rest of the plan.

---

## 1. Staleness audit — what in the old plan is dead, done, or drifted

### 1.1 DEAD PREMISE: the protocol-775 story

The old plan's whole §0 feasibility argument is framed as "this is NOT the same hard blocker
as the version bump" — i.e. it argues *against* a theory (server is really 26.1/protocol 775,
we connect through a translation layer, prismarine-chunk lacks 26.x) that CLAUDE.md
"Movement" has since overturned entirely. The server core is natively 1.21.11 = protocol 774;
ViaVersion advertises 775 in the ping so *newer* clients can join; the prismarine-chunk claim
was a misread of a JS object literal.

Consequences for this plan:

- The old §0 failure taxonomy ("PartialReadError while parsing respawn in the wrong
  dialect", "26.x nether blocks translated to the 774 dialect", risk #10) is **void**. There
  is no dialect. A dimension switch is a `respawn` packet plus a fresh chunk stream in the
  client's native version, which is also the server's native version.
- The old plan says "`settings.js:2` pins 1.21.11". It does not — `settings.js:2` is
  `minecraft_version: "auto"`, and **its comment is itself stale**: it still narrates the
  dead 775 story ("Server protocol is 775 (MC 26.1) but its ping name says Purpur 1.21.11").
  Flagged here; fixing that comment is out of this plan's write scope.
- The mineflayer plumbing the old plan cites is real and re-verified, at drifted line
  numbers: `switchWorld()` is `node_modules/mineflayer/lib/plugins/blocks.js:513`, invoked
  from the login and respawn handlers at `blocks.js:550` and `:569` (old plan said 553-570);
  `bot.game.dimension` is set from the packet string in
  `node_modules/mineflayer/lib/plugins/game.js:40-47` (1.21 sends a string); the client
  `respawn` packet emits bot `'respawn'` at
  `node_modules/mineflayer/lib/plugins/health.js:6-8`, and `'death'` does not fire on portal
  traversal. All of that survives — it just no longer needs the defensive framing.
- The Phase-0 RCON probe is still worth 10 minutes before any traversal code — but for
  mundane reasons (chunk reload, `minY` on return, physics resume), not protocol ones.

### 1.2 The onGround-flavoured caveats

The old plan repeatedly routes around mineflayer internals "because the mover is broken":

- §1 caveat: "`placeBlock`'s internal approach moves use mineflayer-pathfinder
  (`skills.js:991-1007`), the known-broken mover — pre-position with `nav.navigateTo` before
  each pour". **Stale twice over.** (a) `goToGoal` now tries the `navToGoal` seam first
  (CLAUDE.md "Nothing EXECUTES on mineflayer-pathfinder any more"), so `placeBlock`'s
  internal approach at `skills.js:1050` (`goToGoal(bot, new pf.goals.GoalNear(...), 15000)`)
  already runs on our navigator. (b) The placement itself no longer goes through
  `bot.placeBlock` at all — `skills.js:1095` routes through
  `blockIO.placeVerified(bot, buildOffBlock, faceVec, { expectName: blockType })`.
- The plan predates **`block_io.js`** (owned placement: write the packet, snap the look,
  verify by reading the world, pace at `MIN_PLACE_GAP_MS = 250`, `block_io.js:73`) and
  **`build_guard.js`** (protect a build's cells from the navigator's own dig ladder,
  `build_guard.js:48` `protectBuild(cells)`). Both change the portal design for the better:
  frame placement builds on `placeVerified` (`block_io.js:133`), and the finished frame gets
  registered with `protectBuild` so a later stall next to the portal does not mine the
  obsidian it just cast (the exact asymmetry build_guard exists for — see its header comment
  and the measured `brown_carpet` incident).
- The plan predates teleport detection (`agent.js:714` `expectTeleport`, `agent.js:774`
  `forcedMove` handler, `TELEPORT_MIN_BLOCKS = 8` at `agent.js:42`). **A portal traversal is
  a forced move of hundreds of blocks** (coordinates divide by 8), so without
  `expectTeleport` the detector will cancel the running `!enterNether` action *and its
  resume* and tell the model it was teleported and must not walk back. The old plan could
  not have known; any traversal implementation must call `agent.expectTeleport(...,
  'portal')` before stepping in. This is a new hard requirement, not a nice-to-have.

### 1.3 Already done since the plan was written

- **`soul_fire` in `classify` — the old plan's §3 "bug found" is FIXED.** `nav.js:186-190`
  classifies `isLavaName(n) || 'lava_cauldron' || 'fire' || 'soul_fire' || 'magma_block' ...`
  as HAZARD, with a comment crediting this very gap review.
- **Beds and night policy are already dimension-aware.** `skills.js:3552-3554` refuses to
  sleep outside the overworld ("beds explode"), and the pure
  `decideNightAction` returns `'shelter'` for any non-overworld dimension
  (`night.js:102`), unit-tested in `tests/night.test.mjs`. The old plan listed neither.
- **`canBreak` now has a harvest-tier guard.** `tools.js:60-67` calls
  `block.canHarvest(heldItemId)` after equipping the best tool. The old plan's claim
  "`digWithTool` has NO harvest-tier guard" is **half stale**: `digWithTool`
  (`tools.js:70-84`) itself still digs without checking harvestability (an iron pick will
  grind obsidian ~50s for no drop), but the canonical guard exists — the obsidian *mining*
  path just has to consult `canBreak` first instead of inventing a new tier table.

### 1.4 Line-number drift (evidence the plan predates major churn)

`fillBucket` 3561→`skills.js:3912`; `useToolOnBlock` 3972→`skills.js:4383`;
`travelDirection` 4227→now a wrapper over `travelToward` at `skills.js:4638`;
`nearestDryLand` 427→`nav.js:484`; `swimCostFor` 198→`nav.js:240`; actions.js "append
before line 1178"→the file is 1593 lines and commands live inline in `actionsList`
(`actions.js:81`); the self_preservation fire/water-bucket branch modes.js 117-120→
`modes.js:178-190`. None of these invalidate the referenced *content*, but every citation in
the old plan must be re-resolved before use.

---

## 2. Dependency graph — what must exist before each piece is worth starting

```
pure geometry (portal.js)  ──────────────────────────── no dependencies. Ship any time.
dimension gates (surfaceY/climb) ────────────────────── no dependencies. Protective TODAY
                                                        (an operator /tp into the nether
                                                        already breaks travelToward — §4.2).
!stats dimension line ───────────────────────────────── no dependencies.
        │
!buildPortal (overworld, casting path) ─── needs: iron buckets + flint_and_steel
        │                                  (flint + iron; !craftRecipe/!smeltItem exist),
        │                                  a lava pool near water. NOT diamond-gated.
        │                                  Mining path additionally needs diamond pickaxe
        │                                  → resource-progression gap (#5).
        │
!enterNether / !returnOverworld ─────────── needs: !buildPortal, expectTeleport wiring,
        │                                  awaitDimensionChange, the Phase-0 probe GO.
        │
nether nav profile + lava policy (§3) ───── needs: traversal working, a live nether to
        │                                  measure in, AND a resolved design decision.
ghast/survival policy ───────────────────── needs: all of the above; ranged-combat gap
                                           for anything beyond "hide behind cobble".
fire resistance ─────────────────────────── brewing: deferred gap, out of scope.
```

The only overworld prerequisite the casting path cannot dodge is bucket iron — 3 per bucket
plus 1 for flint_and_steel. That is inside today's capability set, so **the portal builder
does not wait on the resource-progression gap**; only the obsidian-mining alternative does.

---

## 3. The lava conflict — the navigator is designed to refuse the Nether

CLAUDE.md is emphatic, and the code agrees, that lava is a refusal *everywhere*, because a
miss costs the bot AND its inventory. Inventory of the refusals, verified:

| Layer | Where | Effect in the Nether |
|---|---|---|
| `classify` | `nav.js:186-190` — lava, fire, soul_fire, **magma_block** are HAZARD | magma shores are hazard terrain |
| `swimCostFor` | `nav.js:241` — `feet/head/below === HAZARD → null` | the bot cannot *stand* on magma, or on anything directly over lava. Every lava shoreline is a wall of unstandable cells for A* |
| `digCostAt` | `nav.js:264-266` — refuses any cell whose feet/head/below is HAZARD | no tunnelling adjacent to lava; the dig ladder stops at the shore |
| `jumpVerdict` | `nav.js:1155` in-lava refusal; `nav.js:1188` `hazardBelow` — "lava or fire under the gap" | never jumps any gap over lava, however narrow |
| `bridgeVerdict` | `nav.js:1000` in-lava refusal; `nav.js:1003-1004` requires a standable landing within `BRIDGE_REACH = 8` | a lava ocean has no landing within 8 → refuse. "Never bridge into the unknown" |
| `waterExitVerdict` | `nav.js:908` | climb-out refuses lava (correct there) |
| swim stack | `swim.js:313-314, 377, 437, 788`; `swim_assist.js:160-162` | every swim entry point refuses lava; SwimAssist stands down in it |

**Net behaviour, stated plainly: in the Nether the bot will path competently through
netherrack caves and across soul-sand valleys, and it will REFUSE — silently, via "no plan"
and stall-ladder exhaustion — to cross or even closely skirt any lava.** That is not a bug
to fix; it is the safety invariant doing exactly what it was tuned to do, applied to a
dimension where lava is the ocean. It is the real blocker, ahead of anything protocol- or
physics-shaped.

Options:

- **A. Accept it.** Nether travel is cave-and-shore only; lava oceans are terminal. Honest,
  zero code, and badly limiting — fortress runs routinely require a crossing.
- **B. Automate the crossing** (netherMode: magma→SOLID-with-cost, relax `hazardBelow`,
  teach bridging to extend past `BRIDGE_REACH`). **Rejected.** It moves "a miss costs the
  bot and its inventory" from a rare edge into every autonomous leg, and it violates two
  documented invariants at once (never bridge into the unknown; hazard floors are refused
  however narrow). The waterCost lesson also applies: repricing hazard changes which nodes
  win the whole A* frontier, not just the lava ones.
- **C. Escalate the decision.** Keep every navigator refusal exactly as it is. Add one
  deliberate, bounded, *explicitly invoked* primitive — a lava causeway: place blocks INTO
  the lava surface one cell ahead (lava sources are replaceable, so `placeVerified` against
  the previous causeway block works), verify each placement by world read before stepping,
  latch sneak while walking the causeway (sneak prevents walking off edges,
  `prismarine-physics/index.js:175`; no jumps are needed on a flat causeway, so the latched-
  sneak trap does not bite — but it MUST be cleared in a `finally`, same as `jumpAcross`
  does), refuse to start unless the far shore is confirmed within a stated budget or the
  caller passed an explicit span. One command, never fired by the stall ladder or a mode.

**Recommendation: C**, and only in the deferred phase. Magma reclassification (the mild half
of B) can be revisited *after* live measurement shows shore-skirting actually burns the node
budget — "measure before tuning" — and if adopted it must go through a `netherCostFor`
sibling of `swimCostFor` so the decision stays pure and unit-tested.

---

## 4. What I plan, concretely

### 4.1 New module `src/agent/library/portal.js` — pure core, thin live shell

```js
// ---- PURE (no bot, no Vec3 import needed — plain {x,y,z}) ----

/** The 10 frame cells, 6 interior cells, 4 optional corners of a 4x5 portal.
 *  anchor = the lower-left FRAME block; axis = 'x' | 'z' (the wide direction). */
export function framePlan(anchor, axis)
    // -> { frame: [10], interior: [6], corners: [4], standCell: {x,y,z} }

/** Frame completeness + lit state from a name callback. Pure; getName(x,y,z) -> string|null. */
export function validateFrame(getName, anchor, axis)
    // -> { ok: boolean, missing: [{x,y,z}], lit: boolean, litCount: number }

/** Ordered casting schedule for the lava-and-water obsidian cast: bottom row, then side
 *  columns upward, top row last. Every entry carries the mold cells that must be solid
 *  BEFORE its pour (closed bottom and back). */
export function castPlan(anchor, axis)
    // -> [{ cell, pourAgainst: {x,y,z}, requiresSolid: [{x,y,z}] }]

/** Dimension-name predicate: 'the_nether', 'minecraft:the_nether', Bukkit 'world_nether'. */
export function isNetherDimension(name)   // -> boolean

/** 8:1 coordinate pairing, floor semantics (negatives!). Y passes through. */
export function overworldToNether(pos)    // -> { x: floor(x/8), y, z: floor(z/8) }
export function netherToOverworld(pos)    // -> { x: x*8, y, z: z*8 }

/** Where to head for the return trip. The recorded portal position ALWAYS wins; coordinate
 *  math is only a search hint when nothing is recorded (÷8 pairing links to ANY portal
 *  within 128 nether blocks — the old plan's rule, kept). */
export function portalReturnTarget({ remembered, hereDim, herePos })
    // -> { target: {x,y,z}, source: 'remembered' } | { target, source: 'coord-hint' }
    //    | { refuse: string }

// ---- LIVE (deferred phase for the last three) ----

/** Build the frame from inventory obsidian via blockIO.placeVerified, register the cells
 *  with build_guard.protectBuild, un-protect in a finally. method 'place' only in v1;
 *  'cast' drives castPlan with fillBucket/placeBlock; 'mine' gated on tools.canBreak. */
export async function buildPortalFrame(bot, anchor, axis, { method = 'place' } = {})

/** flint_and_steel on a base frame block via skills.useToolOnBlock (skills.js:4383), then
 *  poll validateFrame(...).lit for <= 2s. */
export async function lightPortal(bot, anchor, axis)

/** Resolve when predicate(bot.game.dimension) && bot.blockAt(bot.entity.position) is
 *  non-null && one 'chunkColumnLoad' seen. Caller must have armed agent.expectTeleport. */
export async function awaitDimensionChange(bot, predicate, timeoutMs = 20000)
```

### 4.2 Dimension gates in existing code (additive, three call sites + one query line)

- `skills.js:4676-4681` (`travelToward`): `surfaceY(bot, x, z, 140, ...)` under the nether's
  bedrock roof finds the TOP OF THE ROOF (y≈128 is air-over-bedrock, standable), reads the
  bot as ">20 blocks underground", and calls `climbToSurface` — which digs at bedrock
  forever. Gate: `if (portal.isNetherDimension(bot.game.dimension))` skip the climb-out and
  set `preferY = null`. **This is live-reachable TODAY** via any operator
  `execute in the_nether run tp` — it does not wait for portal code.
- `skills.js:4485` (`climbToSurface`) and its `surfaceY(..., 140, ...)` calls at
  `skills.js:4517-4521`: refuse with a named reason in the nether ("no sky to climb to").
- `skills.js:4302` (`goToSurface`): same refusal (it is already in `hidden_actions`,
  `settings.js:144`, so only chat callers see it).
- `queries.js` `!stats` (after the Biome line, `queries.js:30`):
  `if (bot.game.dimension !== 'overworld') res += '\n- Dimension: ...'` — the same
  costs-nothing-normally pattern as the In-water line (`queries.js:34`) and the Brain line
  (`queries.js:84`). `full_state.js:65` already reads the field; this is its second consumer.
- Deferred, with traversal: `modes.js:178-190` — self_preservation's on-fire branch reaches
  for `water_bucket`; in the nether the water flashes to steam. Gate the bucket use on
  `bot.game.dimension === 'overworld'`, fall through to the existing moveAway branch.

Navigator internals need **no change** for correctness: `planPath`'s block cache is per-plan
(`ctx.cache` created inside `planPath`, `nav.js:314`), so a dimension switch cannot serve
stale overworld blocks. mineflayer unloads and rebinds the world (`blocks.js:513`).
`MemoryBank` (`memory_bank.js:1-24`) is a dimension-blind name→[x,y,z] map; v1 handles that
by naming convention (`portal_overworld` / `portal_nether`) plus announcing coordinates in
chat so they survive into `$MEMORY` — no restructuring.

---

## 5. PURE / LIVE split

**Pure (unit-tested, zero server — the `tests/water_exit.test.mjs` pattern):** `framePlan`,
`validateFrame`, `castPlan` + its support invariant, `isNetherDimension`,
`overworldToNether` / `netherToOverworld`, `portalReturnTarget`, and (if ever built)
`netherCostFor`. This is deliberately the bulk of the surface: geometry, scheduling, and
every refusal decision.

**Live (bounded, verified by world reads):** `buildPortalFrame` (rides `placeVerified`,
which already verifies + paces), `lightPortal` (poll ≤2s), `awaitDimensionChange` (timeout
20s), the traversal commands, the causeway. Nothing live makes a decision a pure function
could make.

## 6. Test cases — `tests/portal.test.mjs` (append to the chain at `package.json:58`)

Acceptances: framePlan both axes (10/6/4 cells, no overlaps, interior strictly inside);
validateFrame complete, lit (6/6 `nether_portal`), partially lit counts; castPlan covers all
10 frame cells exactly once and — the invariant test — every entry's `requiresSolid` cells
are either mold or already-scheduled frame cells; coordinate mapping round-trips, and
`overworldToNether({x:-17}).x === -3` (floor, not trunc); `portalReturnTarget` prefers
`remembered` whenever present.

Refusals (they carry more weight, per house style): `validateFrame` with one missing frame
block → `ok:false` + names the cell; corners absent → still `ok:true`; `isNetherDimension`
on `'overworld'`, `''`, `null`, `'nether_wastes'` (a biome, not a dimension) → false;
`portalReturnTarget` with nothing remembered and no coord hint → `refuse`; getName returning
null (unloaded chunk) → `ok:false, missing` lists it rather than throwing. Deferred-phase:
causeway refuses without explicit span/landing, refuses when not against lava, clears sneak
in `finally` (assert on a fake bot, the `tests/swim.test.mjs` fake style).

## 7. Integration points (partition constraint honoured)

| Shared file | Footprint |
|---|---|
| `skills.js` | 3 added dimension guards (§4.2), each 2-4 lines, no restructure; deferred: `enterPortal` wrapper |
| `commands/actions.js` | deferred phase only: append ≤3 entries inside `actionsList` (`actions.js:81`) |
| `commands/index.js` | untouched (actions register via actionsList) |
| `commands/queries.js` | 1 line in `!stats` |
| `modes.js` | deferred: one `dimension === 'overworld'` guard at `modes.js:184-190` |
| new files | `src/agent/library/portal.js`, `tests/portal.test.mjs` — all the real mass |

## 8. Command doc text (compact-mode rules: ≤120ch first sentence; imperative follow-ups
survive; bare param names are the only param docs; prohibitions on the TEMPTING command)

- `!buildPortal(anchor_x, anchor_y, anchor_z, axis)` — "Build and light a nether portal
  frame at the anchor using obsidian from inventory. Takes axis 'x' or 'z'. Refused without
  10 obsidian and a flint_and_steel."
- `!enterNether()` — "Walk into the nearest lit nether portal and wait for the dimension
  change. Do NOT use for ordinary travel - use !travel or !navTo. Refused when no lit portal
  is within 16 blocks."
- `!returnOverworld()` — "Return to the overworld through the remembered nether-side portal.
  Refused when no portal position is remembered - build or find one first."
- Cross-reference rule: add "Do NOT use to reach the Nether - use !enterNether" to nothing
  yet; no existing command is tempting for this. Revisit if `!serverTp` bait patterns recur.

## 9. Ordered tasks

**Phase A — useful WITHOUT the Nether (ship now):**
1. `portal.js` pure core + `tests/portal.test.mjs` in the chain. Accept: `bun test` green.
2. §4.2 dimension gates in `skills.js` + the `!stats` line. Accept: unit test on the
   extracted predicate; grep shows no `surfaceY(bot, x, z, 140` call reachable in a
   non-overworld dimension without a guard. (Protects against operator tp today.)

**Phase B — overworld-only, on demand:** 3. `buildPortalFrame('place')` + `lightPortal` +
`!buildPortal`, with `build_guard.protectBuild` on the frame. Accept:
`VERIFIED PORTAL: frame 10/10, interior 6/6 nether_portal at (x,y,z)` on a live overworld
run; guard released in `finally`. 4. `'cast'` method driving `castPlan` via
`fillBucket`/`placeBlock`. Accept: cast portal from buckets, zero diamond tools involved.

**Phase C — needs the full dependency chain (DEFER; do not start on spec):** 5. Phase-0 RCON
round-trip probe (chunks, minY on return, physics). 6. `!enterNether`/`!returnOverworld` +
`awaitDimensionChange` + `expectTeleport` wiring. Accept: round trip, teleport detector logs
zero cancellations. 7. Lava policy per §3-C (`!lavaBridge`), then any `netherCostFor`
repricing only after measured node-burn. 8. modes.js water-bucket gate; ghast cover policy.
