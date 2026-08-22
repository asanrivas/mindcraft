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
