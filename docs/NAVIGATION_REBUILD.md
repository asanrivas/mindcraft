# Navigation Rebuild — replacing mineflayer-pathfinder

**Index:** [docs/README.md](README.md) · **See also:** [SWIMMING.md](SWIMMING.md) · [TESTING.md](TESTING.md) · [WORLD_TOOLS.md](WORLD_TOOLS.md)

**Status:** complete and verified end-to-end.
**Verification run:** Andy walked **1018 blocks west** (x 4292 → 3274) on foot, full health,
no teleport. Final leg: `VERIFIED TRAVEL: moved 51/49 blocks (104.6%). Mined 0 block(s).`

---

## 1. Why this exists

The bot could not reliably move. Not "moved slowly" — it would stand still, or wedge against a
block face, indefinitely.

### Root cause

The server is **Minecraft 26.1 (protocol 775)**. Its ping *name* string says `Purpur 1.21.11`,
and `mcserver.js` regex-extracts the version from that name **while ignoring the protocol
number**. mineflayer caps at 1.21.11 (protocol 774), so the bot ran one-version-stale collision
data against a 26.x world.

Measured consequences:

| Symptom | Measurement |
|---|---|
| `onGround` unreliable | Reads `false` for seconds while the bot is provably standing (constant y, zero velocity) |
| No ground acceleration | `vel=(0.000, 0.000)` with `forward` held — physics withholds it because it thinks the bot is airborne |
| Jumps carry no momentum | 136 jump-ticks over 241 ticks, cleared the step height, finished **0.1 blocks** from the start |
| Pathfinder refuses to plan | Will not plan *any* route requiring a 1-block step |

### Why upstream can't fix it

Patching mineflayer's version gate works, but **`prismarine-chunk` has no 26.x chunk
implementation in any release** — latest checked 1.41.0 ships only `'1.0'`, `'1.10'`, `'1.20'`.

**Do not sink more time into the version bump.** The workaround below is built only on
primitives that still work: walking, raw jumping, block reads, and mining.

---

## 2. What was built

| File | Exports | Purpose |
|---|---|---|
| `src/agent/library/nav.js` | `planPath`, `followPath`, `navigateTo`, `scanAhead`, `surfaceY`, `nearestDryLand` | A* planner + lookahead executor |
| `src/agent/library/auto_jump.js` | `AutoJump` | Vanilla-style auto-jump, `onGround`-independent |
| `src/agent/library/tools.js` | `toolFor`, `equipBestTool`, `digWithTool`, `isFallingBlockName`, `FALLING_BLOCKS` | Tool selection + canonical block classification |
| `skills.js` | `travelDirection`, `climbToSurface`, `escapeWater`, `clearFallingBlocksAbove`, `pillarUp`, `hopForward` | Long-distance travel and recovery |
| `actions.js` | `!travel`, `!navTo`, `!climbOut`, `!serverTp` | Command surface |

### Planner

8-way movement, octile heuristic, binary min-heap, per-plan block cache.
**A 96-block plan takes ~430 ms.**

Cost model in units of "blocks walked" — `digCost: 14` literally means *walking 14 blocks
around beats mining through*:

```
digCost 14   treeDigCost 60   dropCost 5   climbCost 1.5   unknownCost 3
waterCost 2  waterEntryCost 6   (only when swimEnabled; otherwise 15)
planRange 96   horizon 10   maxDrop 3   stepUp 1   heuristicWeight 1.25
preferY / yBias 0.6 / yBiasCap 10
```

Two costs are deliberately non-obvious:

- **`dropCost` is high because descent is ASYMMETRIC.** Falling into a trench costs one move;
  climbing out costs many, or is impossible. At 1.5 the planner dived into old excavations and
  then routed **55 blocks the wrong way** to find an exit.
- **`waterCost` was 15 because "swimming barely functions here". That was never measured, and
  it is false.** Measured: 0.098 b/t = 1.96 blocks/s, roughly 4x this bot's overland speed. It
  is now 2 plus a one-off `waterEntryCost` of 6 on the dry-to-wet move, because the expense is
  the transition rather than the metres. Gated behind `swimEnabled`, which only
  `travelDirection` sets. Full numbers and reasoning: **[SWIMMING.md](SWIMMING.md)**.

### Executor

Steers at the furthest waypoint within a **10-block horizon** it can reach in a straight walk,
plus a string-pulling pass that collapses A*'s block-by-block staircase into long runs.

Because `onGround` lies, the executor **pulses jump when progress stalls** — airborne
acceleration still applies, so hopping is what actually converts held-forward into movement.
When hopping cannot free it, it digs the obstruction (the planner already priced that move);
when there is nothing to dig, it re-centres in its own cell to unwedge from a corner.

---

## 3. Bugs found and fixed

Every one confirmed from logged state, not inferred. Each produced a **completely stuck** bot.

| # | Bug | Effect |
|---|---|---|
| 1 | `AutoJump` gated on `bot.entity.onGround` | Dead in exactly the state it was written for |
| 2 | Waypoint retirement was XZ-only | Discarded "drop down 3" waypoints while still above them, then steered into the cliff face |
| 3 | Drop move never checked the bot could *enter* the target column at its current height | Planned steps into walled columns; bot wedged at x=3987.71 against a block at x=3988 |
| 4 | Smoothing sampled the centre line, ignoring the bot's 0.6-block width | Merged diagonals clipped block corners and stopped the bot dead |
| 5 | `dropCost` symmetric with distance | Dived into pits, then routed 55 blocks the wrong way out |
| 6 | `travelDirection` measured progress as **total distance moved** | Wandering sideways counted as progress, so the dig-through fallback never fired — **15 minutes for 1 block** |
| 7 | `self_preservation.fall_blocks` matched by **substring** | `"sandstone".includes("sand")` → mode fired every tick in a desert |
| 8 | Mode `execute()` used `timeout = -1`, and `moveAway` used the broken pathfinder | One trigger pinned `currentActionLabel` on `mode:self_preservation` **forever**; no action could start again. Observed: 11 minutes motionless at full health |
| 9 | `bot.tool.equipForBlock` called unguarded in `collectBlocks` | `mineflayer-tool` is not loaded → live `TypeError`; every dig used whatever was in hand |
| 10 | `clearWayAhead` felled tree trunks rather than stepping round them | Slower than a 2-block detour, and needlessly destroyed jungle the bot was passing through |
| 11 | The "won't mine this" detour used `goToGoal` (mineflayer-pathfinder) | The detour itself could never move the bot; it also stepped purely sideways, making no forward progress |
| 12 | `pillarUp` slept a fixed 260ms before placing | Placed the block inside the bot's own cell, which silently fails — "climbed 0 blocks" against a clearable wall. Now polls until `y` has actually risen ≥ 0.5 |

Bugs **7 + 8 compounded**: the substring match fired the mode, and the missing timeout meant it
never released. That pair is what stalled the journey at 57%.

---

## 4. Capabilities added

Things the bot simply could not do before:

- **Climb out of caves** — `climbToSurface` cuts a staircase to daylight, falling back to
  **pillar-jumping** (`pillarUp`) when the bot is in an open chamber of its own excavation with
  no wall to stair against. Recovered y=27 → surface with no teleport.
- **Stair up cliffs instead of tunnelling** — when the top is 2–14 blocks up. This is the single
  biggest speed win: tunnelling a sandstone plateau ran **~1.5 blocks/min**; walking over the
  top ran **~25**.
- **Refuse to tunnel while underground** — blind forward mining is how the bot reached y=30;
  from down there every route the planner can see is also underground. Threshold is 20 blocks
  below surface, not 8, because cutting through a ridge legitimately dips below it.
- **Escape water** — head for the nearest dry bank. Pillaring cannot work while floating (no
  block to place under), and steering at the distant goal pushes the bot deeper in.
- **Dig instead of flee** — `self_preservation` now breaks the falling-block column above it
  (`clearFallingBlocksAbove`) rather than running away, which mid-journey undoes progress.
- **Equip the right tool** — `tools.js` picks the tool family per block and the best tier
  available (netherite → wooden).
- **Place blocks to climb ledges too tall to jump** — `climbLedgeByPlacing`. AutoJump clears
  exactly one block (`maxRise: 1`), so a 2-3 block rise stopped travel dead. The bot now pillars
  up and steps across, which leaves the terrain intact; cutting stairs into the cliff is the
  fallback when there is nothing in the inventory to build with. Wired into both
  `travelDirection`'s cliff branch and `nav.followPath`'s pinned handler (`climbAhead`), so it
  applies to `!navTo` and detours too, and is tried **before** digging.
  *Verified:* sealed inside a 3-high stone pen with a flat floor and no roof, the bot escaped
  with all four walls intact at y=64/65 — leaving behind a 3-block dirt pillar it had placed.
  `pillarUp` waits for measured clearance (`y` risen ≥ 0.5) before placing rather than sleeping
  a fixed 260ms; the fixed delay placed the block inside the bot and silently failed, measured
  as "climbed 0 blocks" against a wall it should have cleared.
- **Walk around trees instead of felling them** — a trunk is 1-2 blocks wide, so a detour is
  trivial, while chopping is slower and destroys the landscape the bot is only passing through.
  `isTreeTrunk` (logs, stems, hyphae, mangrove roots, bamboo) is excluded from `clearWayAhead`
  and from the pinned-unstick dig, and priced at `treeDigCost 60` in the planner. Leaves are
  **not** trunks — they are cheap to clear and often unavoidable under a canopy. The exclusion
  is released once `stalls > 3` so a bot boxed in by jungle cannot deadlock.
  Verified: two 60-block legs through dense jungle, `Mined 0 block(s)` on both.

---

## 5. Results

| Metric | Before | After |
|---|---|---|
| `navTo` 50 blocks | 2.4 blocks covered, **wrong direction** | 53 blocks, correct direction, climbed out of a pit unaided |
| Open-terrain travel | ~5 blocks/min | ~25 blocks/min |
| Sandstone plateau crossing | ~1.5 blocks/min (tunnelling) | walked over the top, **0 blocks mined** |
| Journey completion | stalled at 36% | **1018 blocks, 100%** |

Journey trace: 36% → 57% (navigator rebuild) → 91.8% (mode + tool fixes) → **100%**.

---

## 6. Invariants — read before changing this code

1. **Never wait on `onGround`.** It lies. Use a stable-y heuristic (`AutoJump._grounded`).
2. **Never substring-match block names.** `"sandstone".includes("sand")` is true and sandstone
   does not fall. Canonical test: `tools.js` → `isFallingBlockName`. Do not re-derive locally.
3. **Always pass a timeout to mode `execute()`.** `-1` can wedge the agent permanently.
4. **Measure progress along the travel axis**, never as total distance moved.
5. **Sweep the bot's body width** in any line-of-sight check, never just the centre line.
6. **Drive one journey leg at a time**, waiting for `VERIFIED TRAVEL` before sending the next.
   A fixed-timer driver spent 97 minutes interrupting its own in-flight leg.
7. **Avoid large `!serverFill` near the bot.** Those repeatedly dropped it into pits, buried it
   in sand, and opened a cave under it — most of the "stuck" incidents were self-inflicted.

---

## 7. Testing

Pure-function unit tests (no server needed):

```bash
bun run test    # 52 cases: toolFor + isFallingBlockName + isTreeTrunk. Exits non-zero on failure.
```

The anchored `sandstone` cases in that file are the regression for bugs 7 and 9 — keep them.

Live checks:

```bash
# planner sanity — should report arrived=true with covered ≈ requested
!navTo(<x>, <y>, <z>)

# travel — should report VERIFIED TRAVEL with a low "Mined n block(s)" on open ground
!travel("west", 60)

# cave recovery
!climbOut
```

To trace the executor, set `debug: true` in the `navigateTo` opts (in `travelDirection` or the
`!navTo` command) and read `logs/service.log` for `[nav]` lines — position, aim index, target,
yaw, `onGround` and velocity per second. That trace is how bugs 1–4 were found; it is the tool
of choice for anything movement-related.

---

## 8. Known gaps

- **`!serverTp` remains** as an operator rescue hatch. It refuses unless
  `bots/<name>/ALLOW_RESCUE_TP` exists and deletes the marker on use, so the model cannot use
  it to skip a journey. Arm with `touch bots/andy/ALLOW_RESCUE_TP`.
- **Terrain damage not restored** — a drained lake, trenches, and a staircase around
  x=3966–3991 / y=31–56 / z=4852 are still in the world from debugging. Also a dirt platform
  over swamp water near x=2400–2426 / z=4428–4438, and a small ice platform plus bed at
  (-2580, 63, 5291) in the frozen ocean.
- **A bot can be immobilised in an underwater crevice** — see
  [SWIMMING.md](SWIMMING.md) §8. Not a navigator bug, but it is reachable from `!travel`.
- **`sprint` is enabled but unmeasured.** It is not known whether it helps given the physics
  mismatch; it has not been isolated in a benchmark.
- **The ~25 blocks/min figure is from open desert and jungle.** Barrier terrain (rivers, tall
  cliffs) is materially slower.
- **`scanAhead` reports `rise` capped at 1.** It detects that a wall exists but not how tall it
  is; `travelDirection` probes `surfaceY` separately to decide whether to stair up.

---

## Moved here from CLAUDE.md (2026-08-31 restructure)

CLAUDE.md keeps the RULES; this file keeps the EVIDENCE. The text below is verbatim
from CLAUDE.md before it was compacted — the measurements, the incidents and the
reasoning behind the one-line rules that remain there. Heading levels are demoted by one.

### Movement (the "version mismatch" was a myth - see below)

Full story, measurements and bug list: **[docs/NAVIGATION_REBUILD.md](docs/NAVIGATION_REBUILD.md)**.
Investigation that overturned the diagnosis: **[docs/CLIENT_REPLACEMENT.md](docs/CLIENT_REPLACEMENT.md)**.

#### THE SERVER IS 1.21.11. There is no version skew. (Established 2026-08-23, with evidence.)

Everything below used to say "the server is really 26.1 (protocol 775) and its ping *name*
lies." **That was backwards.** The ping *name* was telling the truth; the ping *protocol
number* is what misled us:

```
$ mc "purpur version"
This server is running Purpur version 1.21.11-2568-HEAD@f57bd86  (MC: 1.21.11)
$ mc "plugins"
Bukkit Plugins (8): ... ViaBackwards, ViaVersion, ViaVersion
$ mc "viaversion list"
[1.21.11] (2): [bob, andy]        <- our bots, on the server's NATIVE version
```

**ViaVersion advertises protocol 775 in the ping so that newer clients can connect.** That is
its entire job. The server core is natively **1.21.11 = protocol 774**. So
`minecraft_version: "auto"` resolving to `1.21.11` is not a stale fallback - it is **exactly
correct**, and connecting as 26.1 would be *worse*, since it would route every packet through
ViaVersion's translation layer.

Three independent checks, all agreeing:

1. **Collision data is not stale.** Diffed `blockCollisionShapes` between the 1.21.11 and 26.1
   minecraft-data sets: **1166/1168 blocks byte-identical, 0 differing entries, shapes table
   identical.** The only delta is two blocks that exist solely in 26.1 (`golden_dandelion`,
   `potted_golden_dandelion`) - and `golden_dandelion` maps to collision shape `[]`, i.e. no
   collision box at all. **There is no collision difference that could affect a bot.**
2. **World decode is identical across both protocols.** `tools/observe.mjs` connected read-only
   as 1.21.11 and again as 26.1, sampling the *same absolute coordinates*: **24,389 blocks
   across 22 block types (incl. stateful `wall_torch`, `furnace`, `chest`, `pink_petals`) - zero
   disagreements, zero decode errors, 557 chunk columns both times.**
3. The earlier "prismarine-chunk has no 26.x support" claim was *also* wrong (it misread a JS
   object literal) - but that no longer matters, because we should not be connecting as 26.1
   anyway.

**Consequence: do NOT attribute movement bugs to a version mismatch, and do not "fix" them by
changing the connect version.** That theory is dead. `src/mc/` (the BotClient seam) is still
useful as a clean construction seam, but its original justification is void - see
`docs/CLIENT_REPLACEMENT.md` for what was actually established and what to investigate instead.

**CORRECTION (2026-08-30): `onGround` is NOT broken here. Read this before acting on anything
below that says it is.** The claim this section used to make - that the flag reads false for
seconds while the bot is provably standing, so nothing may ever wait on it - is false as a
general statement, and a great deal of the movement stack was built on it.

Measured with a CLEAN mineflayer bot (no agent, no assists, `tools/place_probe.mjs`-style rig)
against this very server:

```
=== localhost:25565 v1.21.11 ===
  solid below        : 60/60 (100%)
  onGround true      : 60/60 (100%)
  isCollidedVertically: 60/60 (100%)
  PLAIN JUMP APEX    : 1.252   (vanilla 1.252)
```

A flying-squid control server (1.21.4, no Purpur, no ViaVersion, no anti-cheat) gives the same
1.252. `!groundProbe` inside the agent reports the same 60/60 on flat ground, and `GroundTruth`
- which corrects the flag from the world - fires on **0 of 60** ticks there.

**What IS true:** prismarine-physics derives the flag as
`onGround = isCollidedVertically && oldVelY < 0` (`index.js:301`), so it needs a downward
velocity going into the move. When something zeroes `vel.y` - a server position correction, the
`negligeableVelocity` clamp - the test fails and a standing bot reads airborne for that tick.
That is a real but SITUATIONAL fault, not a permanent one, and `library/ground_truth.js` exists
to correct exactly it.

**The stuck bots were real; the explanation was not.** Do not delete the workarounds on the
strength of this - but do not add another one without first measuring whether the flag is
actually wrong in your case. `followPath` still pulses jump, and that has not been re-measured.

**Correction (2026-08-26): pathfinder PLANS fine. It is the EXECUTOR that is broken.** This doc
previously said "mineflayer-pathfinder will not even *plan* a route over a 1-block step". That
is false, and it mattered - it is the stated reason the whole `nav.js` A* planner exists.
Measured with `tools/pathfinder_probe.mjs`, which separates the two on purpose:

```
testing a 1-block step: (4730, 71, 4725) -> (4727, 72, 4722)
plan:  status=success  nodes=3  in 6ms          <- planning is FINE
goto:  timeout after 30.0s, moved 3.1 blocks    <- execution is not
VERDICT: planning OK but execution PARTIAL - onGround=false
```

So the root cause is the same `onGround` bug as everything else: pathfinder's *executor* waits on
it. **Consequence: the custom executor (`followPath`, with its jump pulsing) is doing the load
bearing work; the custom PLANNER may be redundant.** A plausible simplification is
pathfinder-plan + our `followPath` executor. Not attempted yet - one measurement at one location,
and `planPath` also carries the tuned cost model (dig/water/drop pricing) that pathfinder has no
equivalent for. Re-measure before ripping anything out.

**The measurements above are real; only the explanation was wrong.** With the version theory
ruled out, the remaining suspects are server-side: Purpur/Paper movement validation or
anti-cheat correcting the client (`swim_assist.js` already carries a `forcedMove` valve that
disables its boost after 3 server corrections in 10s - direct evidence the server *does* correct
us), the `position`-packet rate limiting the 50ms throttle in `src/mc/backends/mineflayer.js`
exists to survive, or ViaVersion sitting in the packet path. **Investigate the server, not the
client library.**

#### Nothing EXECUTES on mineflayer-pathfinder any more

`settings.js` already blacklisted `!goToCoordinates` with the note *"mineflayer-pathfinder ...
cannot move this bot"* - but **the blacklist only hid the COMMANDS**. Every skill that walked
somewhere still reached the same executor through `goToGoal` -> `bot.pathfinder.goto`. Reported
as *"andy didn't jump when I ask followme"*; the truth was he was barely being driven at all.

**Only the EXECUTOR is broken. Planning is fine.** So these stay and are not bugs:

| still calls pathfinder | why it is correct |
|---|---|
| `getPathTo` - `world.isClearPath`, `goToGoal`'s destructive/non-destructive probe, `moveAway`'s cheat branch | planning works: `status=success nodes=3 in 6ms` |
| `stop()` / `setGoal(null)` - `followPath`, `agent.js`, `hopForward`, `walkForward`, `followPlayer` | this STANDS PATHFINDER DOWN. It rewrites control states every tick and silently cancels ours, so it must be stopped, not out-prioritised. The cure, not the disease. |

**`navToGoal` (skills.js) is the seam.** It translates a pathfinder goal into a target our
navigator can steer at - `GoalBlock`, `GoalNear`, `GoalXZ`, `GoalNearXZ`, `GoalFollow` (re-reading
the entity: `GoalFollow` caches x/y/z at construction and the target moves). `goToGoal` tries it
first, so nine functions converted in one edit: `goToPosition`, `goToPlayer`, `pickupNearbyItems`,
`breakBlockAt`, `placeBlock`, `tillAndSow`, `fillBucket`, `activateNearestBlock`,
`findAndGoToVillager`.

**`GoalInvert` is the one shape the seam cannot translate** - it means "get AWAY from", so there
is no target to steer at. `skills.fleeFrom(bot, from, distance)` supplies the missing half, a
flee HEADING, and then steers at a point along it. It **fans out** (0, +-45, +-90 degrees) rather
than committing to the directly-opposite bearing, because the straight-away line is very often
into the wall the bot was cornered against, and it is XZ-only because "away" is a compass
direction - insisting on a Y makes every retreat fail on a slope. Converted:
`moveAwayFromEntity`, `avoidEnemies`, `defendSelf` (both the close and the back-off branch), and
`placeBlock`'s two "step clear of the cell I am about to fill" retreats.

**`useDoor` was worse than slow - it was silently skipping the walk.** It did
`setGoal(GoalNear, 1)` and then polled `while (bot.pathfinder.isMoving())`. That never becomes
true here, because the executor never starts moving, so the poll fell through instantly and the
bot reached for a door it was still 16 blocks from. `navigateTo` is synchronous-until-arrival,
so the wait IS the walk; it now also verifies reach before activating, since activating a block
out of range fails silently and reads as "the door is stuck".

`followPlayer` keeps its swim branch untouched, **including the macrotask yield** - a bare
`continue` there starved the event loop and the server dropped the bot
(`andy lost connection: Timed out`, 70s into a follow). The new land leg carries the same yield
for the same reason: `navigateTo` can return through pure microtasks when already inside
`arriveDist`.

Two `pathfinder.goto` calls remain, in `gotoWithTimeout` and `goToGoal`, as the fallback for a
goal shape the seam cannot express. **No caller constructs one any more**, so they are dead
defensive paths rather than live routes.

Measured live after the conversion: a 1-block step that the pathfinder-driven command cannot
climb at all is cleared in **1.4s** (`y` 111 -> 112.25 mid-step, plan 6ms), and `!moveAway(8)`
covers 7.6 blocks in ~2s across that same step.

#### The stack we run instead

Built only on primitives that *do* work here - walking, raw jumping, block reads, mining:

| File | What it does |
|---|---|
| `library/nav.js` | A* planner + lookahead executor: `planPath`, `followPath`, `navigateTo`, `scanAhead`, `surfaceY`, `nearestDryLand`. 8-way moves, octile heuristic, binary heap, per-plan block cache. A 96-block plan takes **~430ms**. |
| `library/auto_jump.js` | Jumps ~0.9 blocks *before* a step so the bot still has momentum when it leaves the ground. Does **not** gate on `onGround`; treats a stable y with no vertical motion as standing. |
| `library/tools.js` | Tool selection + `digWithTool`, and the canonical `isFallingBlockName`. |
| `skills.travelDirection` (`!travel`) | Long-distance travel: climbs cliffs, trenches, bridges, detours, climbs out of caves. Reports `VERIFIED TRAVEL: moved n/m`. |

`followPath` stands mineflayer-pathfinder fully down first (`setGoal(null)` + `stop()`) - it
rewrites control states every tick and silently cancels ours.

Prefer `!travel` / `!navTo` over `!goToCoordinates` for anything non-trivial.

#### Cost model - the tuning surface

Units are "blocks walked", so `digCost: 14` literally means *walking 14 blocks around beats
mining through*.

```
digCost 14   treeDigCost 60   dropCost 5   climbCost 1.5   unknownCost 3
waterCost 2  waterEntryCost 6   (only when swimEnabled; otherwise water costs 15)
planRange 96   horizon 10   maxDrop 3   stepUp 1   heuristicWeight 1.25
preferY / yBias 0.6 / yBiasCap 10   (per-move penalty for being below the surface)
```

- **`dropCost` is high because descent is ASYMMETRIC.** Falling into a trench costs one move;
  climbing back out costs many, or is impossible. At 1.5 the planner dived into old
  excavations and then routed 55 blocks the *wrong way* to find an exit.
- **`waterCost` USED to be 15 because "swimming barely works here". That was never measured,
  and it is false** - see the Swimming section below. It is now 2, plus a one-off
  `waterEntryCost` of 6 charged on the dry-to-wet transition, because what costs in a river is
  getting in and out of it, not the metres between. Never set it to 0: free water lets A* burn
  its whole node budget on open ocean and route the bot out to sea.
- **The water charge is applied ONCE per cell.** It used to be charged twice - once for wet
  feet/head and again for a wet block below - so a mid-river cell cost 30 "blocks walked" and
  even a 6-wide river lost to a 60-block detour. `swimCostFor` is the pure, unit-tested version.
- **`swimEnabled` is off by default.** Only `travelDirection` turns it on. `!navTo`, `moveAway`
  and every mode-driven move keep the land-only model that has a 1018-block journey behind it -
  changing the water price changes which nodes win the *whole* A* frontier, not just the wet ones.

#### Geometry gotchas - do not "simplify" these away

Each of these cost real debugging time and each produced a *totally stuck* bot, not a slow one:

- **Waypoint retirement must consider Y.** An XZ-only test discards a "drop down 3" waypoint
  while the bot is still standing above it; the bot then steers into the cliff face.
- **The drop move must check the bot can *enter* the target column** at the height it is
  leaving from, not just that the cells below are clear. Otherwise it wedges on the block face.
- **Smoothing must sweep the bot's 0.6-block width** (`bodyClear`), not the centre line. A
  centre-clear diagonal still clips block corners and stops the bot dead.
- **Progress must be measured along the travel axis**, not as total distance moved. Otherwise
  wandering sideways around an obstacle counts as progress and the dig-through fallback never
  fires (observed: 15 minutes for 1 block).

#### "Andy can't reach me with blocks around him"

Two independent faults, one of which made following a person **completely** unable to dig.

##### The recovery ladder must fit inside the leg the caller asked for

`followPlayer` passes `waypointMs: 1500`, because the target moves and it wants to re-evaluate
often. But digging, climbing and bridging are gated on `pinnedMs` (2500) **plus two hops 700ms
apart** - so the leg always broke first and the follow silently had **no recovery whatsoever**.
Not slow: absent. The bot walked into the wall, the leg timed out, `navigateTo` spent its 2
replans, `followPlayer` polled, and nothing ever reached for the pickaxe.

Measured, boxed in behind a one-block wall, with the same rig either side of the change:

| | `!followPlayer` |
|---|---|
| before | **STUCK, moved 0.0 blocks in 45s** |
| after | out in **9.0s** |

The trigger now scales to the budget the caller actually gave (`shortLeg` -> `pinnedAt` at 45% of
`waypointMs`, and one hop instead of two, because on a short leg requiring two is the same as
requiring none). On a default 6000ms leg nothing changes.

**The general rule: a timing constant that gates a recovery must never exceed the window the
recovery has to run in.** Nothing enforced that, and nothing complained - the ladder just never
ran. `tests/bridge.test.mjs` now asserts the relationship.

##### `goToPlayer` claimed to have arrived when it had not

It logged `You have reached <player>` unconditionally, discarding `goToGoal`'s return value. A bot
sealed in a box twelve blocks away announced that it had arrived. It measures the distance now,
and when it has genuinely failed it names the obstacle:

```
digAhead: 0:stone dig-failed, 1:stone dig-failed
I am walled in 10 blocks from bob with no pickaxe, so digging out is very slow.
```

`nav.enclosed(bot)` exists only for that sentence - the ladder digs out fine and the planner
routes through a wall in 1ms, so nothing *decides* anything on it.

##### What the boxed gym measures

`scratchpad/boxed_gym.mjs` seals the bot six ways and asks it to walk 12 blocks east;
`scratchpad/sim/boxed.mjs` asks the planner the same question offline, in 1ms per case.
**7/8 escape**: walls 2 high (10s), walls + roof (10s), walls 3 high (12s), walls 2 thick (23s),
fully buried in solid stone (17s), and both follow cases (~9s).

The one failure is **no pickaxe**, and it is not a logic bug: bare-handed stone runs about **35
seconds a block** on this server, so a two-block wall exceeds any sane timeout. The bot does get
out eventually; what was wrong was that it said nothing for minutes, which is why the message
above matters more than the digging does.

**The planner was never the problem.** It routes a dig through the wall in every configuration -
walls, roof, two-thick, fully buried - in 1ms. Every failure here was in the executor or the
reporting.

#### Jumping - and the headless sandbox that calibrated it

`nav.jumpVerdict` / `probeJump` / `jumpAcross`, driven by `src/agent/library/jump_assist.js`.
Tried BEFORE bridging: a jump costs nothing, leaves the terrain untouched, and is what a player
does. Bridging remains the fallback for anything out of reach.

**This bot could not jump at all** - *and that turned out to be wrong; see the correction under
"onGround cannot be trusted", above.* Every jump in prismarine-physics is gated on
`entity.onGround` (`index.js:725`), and so is ground acceleration (`:545`), both of which are
true. The figure that used to sit here - "vanilla apex 1.252, this server's apex **0.000**" -
was measured in `scratchpad/sim/`, which **forces `onGround` false in order to reproduce the
pathology** and then measures no jump. That is circular: it establishes what happens IF the flag
is false, never that it is. A clean bot on this server jumps **1.252**, the vanilla figure.

JumpAssist still earns its place - a jump ARRIVES at a lip slower here than a player's, and the
axial top-up is what fixes that - but its stated justification was a measurement of its own
premise.

##### Which assists are actually load-bearing (measured 2026-08-30)

With the `onGround` premise overturned, the obvious question is how much of this stack is still
earning its place. `settings.assists` turns each one off individually; the climb gym, four stone
cases per arm:

| arm | result | note |
|---|---|---|
| baseline, all on | **4/4** | 34.2 / 57.2 / 66.3 / 34.2s |
| `auto_jump` off | 3/4 | loses `stone 12`; faster on the ones it clears |
| **`jump_assist` off** | **1/4** | 3 cases end at exactly +4.0 and stop |
| `ground_truth` off | **4/4** | and FASTER in 3 of 4 (22.1 / 48.2 / 58.2 / 36.2s) |

Two conclusions, and the second is the uncomfortable one:

- **`jump_assist` is load-bearing and stays.** 1/4 without it, with three cases dying at
  identical +4.0. Even though a clean bot jumps a vanilla 1.252 here, inside the agent the
  asserted take-off is what makes a pillar step reliable. The `apex 0.000` justification was
  wrong; the component is not.
- **`ground_truth` is NOT.** It was added the same day on the strength of a mechanism (a server
  correction zeroing `vel.y` defeats `oldVelY < 0`) that is real but rare - it fires on 0 of 60
  ticks on flat ground - and the gym is no worse without it. Now **off by default**. The
  measurement that justifies an assist has to be of the assist, not of its premise; that is the
  exact mistake `apex 0.000` represents, and it was repeated within hours of finding it.

`swim_assist` was not in the sweep: water is not in question here and it owns the jump key while
wet for reasons the Swimming section documents separately.

##### Simulate first - with prismarine-physics, NOT three.js

`scratchpad/sim/` runs the *same engine the bot runs*, headless, with `onGround` forced false to
reproduce the pathology. A whole sweep is milliseconds against 45s per live lane, so the constants
are **measured, not chosen**. Full working in `scratchpad/sim/RESULTS.md`.

**But know what it can and cannot settle.** Forcing the flag false is an assumption the sim
cannot test, and treating its output as a fact about the server is how "apex 0.000" entered this
document and stayed for days. The sim answers *"given a broken flag, what constants work?"* -
never *"is the flag broken?"*. For that, and for whether the SERVER accepts a movement, use a
clean bot against the live server and a flying-squid control server.

A general physics engine under three.js would have been the wrong tool: it would model *different*
physics from the one the bot actually experiences, so every constant calibrated there would be
wrong on arrival. **What the sim cannot tell you is whether the SERVER accepts the movement** -
that is the live gym's job, and the `forcedMove` valve's.

##### The mechanism is a hybrid, and neither half is sufficient

| | apex | clears | without sprint |
|---|---|---|---|
| assert `onGround` for the take-off tick | 1.25 | ≤3 | **fails at 3** |
| hand-injected impulse + axial top-up | 1.25 | ≤3 | ok |
| **both** | **1.25** | **≤4** | **ok** |

Asserting the flag buys the engine's real impulse *and* its `+0.2` sprint-jump boost; the axial
top-up supplies the run-up the broken flag denies (the same thing `STEP_IN_SPEED` does over a bank
lip). "Works without sprint" is not optional - `followPath` only sprints when aiming far ahead.

**A first sweep measured apex 0.87, not 1.25**, because the injection used `vel.y += 0.42` from a
velocity the engine had already made negative. The engine *assigns*. `+=` costs a third of the jump.

##### What the take-off window says about what is safe to ship

Reporting the *best* take-off lead flatters everything; what matters is how many leads work, since
the tick a decision lands on is not ours to choose. Level gaps, 11 leads sampled: widths 0-2 at
11/11, width 3 at 11/11 (10/11 without sprint), width 4 at **7/11**, width 5 never. Rise 1: 0-2 at
11/11. **Rise 2: never, at any width or lead** - the honesty refusal, confirmed rather than argued.

So `JUMP_REACH = 3`, one below the measured maximum: width 4 is a coin flip once server lag is
involved, and **a jump is the only recovery in this navigator that cannot be undone**.

##### Three constants the live gym corrected

- **`span` meant the wrong thing.** It counted cells-to-traverse, which is gap width + 1, so a
  2-wide gap reported `span=3` and was refused. It is the gap width now, matching the sweep.
- **`JUMP_FALL_SAFE` must EXCEED `maxDrop`.** At 4 against a `maxDrop` of 3 the rule contradicted
  itself: the planner walks down into any drop of 3 or less, so every gap it refuses to enter is
  deeper than 3 - and every one of those was a gap we refused to jump. There was no gap geometry in
  between. It is 8 now: vanilla fall damage is `distance - 3`, so an 8-block miss costs 2.5 hearts.
- **Lava is not a long drop.** They shared a threshold, and the gym duly jumped a 2-wide gap over
  lava. A missed jump into a ravine costs health, which the bot recovers; into lava it costs the
  bot *and* its inventory. Any gap over a hazard floor is refused now, however narrow. Water is
  the opposite case - a benign floor the swim stack recovers from.

##### Verified live

**9/9 crossings** at widths 1-3 over three repeats, one jump each, 2-3s, **zero blocks laid**,
full health - and `apex=1.25` in every log line, the exact vanilla figure on a server where the
bot previously could not leave the ground. Rise 1 crosses 3/3 at widths 0-2 (the standstill step
included). Refused, with zero attempts and zero damage: rise 2 (*"too tall to jump"*), lava at any
width, a 3-wide gap over a lethal drop, and no far side at all.

**Jump and bridge cooperate.** Width 5, with dirt in the bag: jump refused (no landing within 3),
plank laid, refused again, plank laid - and now the gap is 3, so the jump takes it. The bridging
gym still crosses 6/6 and now spends **two fewer blocks per span**; widths 1-2 spend none.

##### Traps

- **AutoJump must stand down without RELEASING the key.** Clearing `holding` is right; pressing
  `jump` false would land on the take-off tick - the one tick in the flight that matters.
- **A leaked `active` flag mutes AutoJump permanently**, destroying the one-block step the whole
  navigator is built on. Three guards: the caller's `finally`, `JumpAssist` self-expiring `active`
  on its own tick, and `!stats` showing it.
- **Refusals must be logged.** The first live run attempted zero jumps and the refusal path was
  silent, which is indistinguishable from the branch never running. Bounded by `maxJumps`, so it
  cannot flood the way a per-tick line would.
- **Overshooting a landing is success**, not a timeout. Demanding the bot finish within 0.6 of the
  landing cell's centre reported `TIMEOUT axial=14.21` for a jump that had crossed fourteen blocks
  earlier.
- Sneak *prevents walking off a block edge* (`prismarine-physics/index.js:175`), so a latched sneak
  cancels every take-off and looks exactly like broken physics. `jumpAcross` clears it explicitly.

#### Bridging a gap - the one thing pathfinder did that we lost

mineflayer-pathfinder could span a gap because **scaffolding lived in its MOVEMENT GENERATOR**:
the plan already contained the placements, so every `goto` had it for free. We replaced that
executor (its own cannot move this bot at all) and the capability went with it. `travelToward`
kept a `bridgeWayAhead` step in its recovery ladder; `navigateTo` - which is `!navTo`,
`followPlayer`, `moveAway`, the chest approach and every mode-driven move - had **none**, so a
one-block gap stopped the bot dead.

`nav.bridgeVerdict` / `bridgeAhead`, and it is deliberately the **last** resort: placing costs
materials and permanently alters ground the bot is only passing over, so climbing, digging and
walking round are all preferable when they work.

**The planner cannot express a gap at all, and that is why the executor-level fix was not
enough.** Every move it has is cell-to-adjacent-cell, so with the neighbouring cell unstandable
there is simply no move and the search fails - or worse, returns a stub. Measured:
`[navTo] plan took 4ms length=2 first=last=(4614.5, 111, 4701.5)` against a goal ten blocks
further on. So `followPath`'s bridge step never fires, because followPath is only ever reached by
way of a plan. `navigateTo` therefore bridges on **a leg that went nowhere with the goal still
ahead** - by which point the hop, climb and dig ladders have all had their turn. Teaching the
PLANNER to place blocks was rejected on purpose: it would change which nodes win the whole A\*
frontier, not just the ones over gaps - the same trap `waterCost` carries.

Three things each cost a run of the gym:

- **Find the EDGE; do not assume the bot is standing on it.** A leg ends when the bot is within
  `arriveDist` of its last waypoint, so it habitually stops a block short of the drop - measured
  halting at x=4613.5 with the gap starting at 4615. Probing only the adjacent cell reads "solid
  ground ahead" and refuses to bridge a gap it is looking straight into. `EDGE_REACH = 3`.
- **Refund the replan.** Laying a plank is progress, not a wasted attempt, and the leg that
  discovers the gap always costs one - so a 3-block span burned four of the six replans and the
  loop exited with the bridge FINISHED and the bot standing on it.
- **Refund the step ONTO the plank too.** Otherwise the replan budget, not `maxBridge`, is what
  decides how wide a gap can be: widths 1-5 crossed while 6 and 8 stopped with five planks laid,
  the bot on the end of its own unfinished bridge. Laying a block and walking onto it is one unit
  of progress, not two.

**Never bridge into the unknown.** We only build toward a standable cell we can SEE, at our own
level - `BRIDGE_REACH` (8) is kept equal to `maxBridge` so the look-ahead and the build budget
agree; promising a span we would refuse to finish leaves a half-built ledge to walk off, which
is worse than refusing. The other refusals are the tested surface (`tests/bridge.test.mjs`):
nothing to build with, afloat (placing does not work while floating, same as pillaring), lava, a
wall (that is `digAhead`'s job), a step (that is `climbAhead`'s), and a floor already there.

**Gap gym**: `scratchpad/gap_gym.mjs` cuts a walkway with gaps of a given width and drives
`!navTo` across. **7/7 at widths 1-6 and 8, one block per width, 3-7s each.** `--noblocks` and
`--void` prove the refusals: both stop at the lip with 0 blocks laid and **the walkway west of
the gap intact** - no mining the floor apart looking for material.

*(Probe gotcha: `execute if block <pos> <block> run say OK` is NOT echoed back over RCON, so
every column reads as missing and it looks like the bot destroyed the terrain. Use
`execute if block <pos> <block>` and match "Test passed".)*

#### Cliffs, caves and water

- **Cliffs**: `travelDirection` stairs *up* a ridge rather than boring through it when the top
  is 2-14 blocks up. Tunnelling a sandstone plateau ran ~1.5 blocks/min; walking over the top
  ran ~25.
- **Caves**: `!climbOut` (`skills.climbToSurface`) cuts a staircase to daylight, falling back
  to **pillar-jumping** (`pillarUp`) when the bot is in an open chamber of its own excavation
  with no wall to stair against. `travelDirection` calls it automatically when >20 blocks below
  the surface and **refuses to tunnel** in that state - blind forward mining is how the bot
  ended up 31 blocks down, and from down there every route the planner can see is also
  underground. (Threshold is 20, not 8: cutting through a ridge legitimately puts the bot
  "below the surface" for a while.)
- **Ledges too tall to jump**: `skills.climbLedgeByPlacing` pillars up and steps across.
  AutoJump clears exactly one block, so a 2-3 block rise otherwise stops travel dead. Tried
  **before** digging (placing leaves the terrain intact); falls back to cutting stairs when
  there is nothing to build with. Available to `!travel` *and* `!navTo` via `nav.climbAhead`.
  `pillarUp` polls for real clearance before placing - a fixed delay places the block inside
  the bot and silently fails.
- **Trees**: walked around, never felled. A trunk is 1-2 blocks wide, so a detour is trivial;
  chopping is slower and wrecks the landscape. `isTreeTrunk` is excluded from `clearWayAhead`
  and from the pinned-unstick dig, and priced at `treeDigCost 60`. **Leaves are not trunks** -
  they are cheap to clear and unavoidable under a canopy. Released at `stalls > 3` so a bot
  boxed in by jungle cannot deadlock.
- **Water**: the bot swims across now rather than retreating or filling it in. See the
  Swimming section below. `skills.escapeWater` remains the fallback for water too wide to
  cross; pillaring cannot work while floating - there is nowhere to place a block underneath.

