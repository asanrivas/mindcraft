# Long journeys: `travelToward`, checkpoint marathons, and who owns an action

**Status:** shipped. 6/6 checkpoints, 880 blocks, on a surveyed route.
**Related:** [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) · [SWIMMING.md](SWIMMING.md) · [TESTING.md](TESTING.md)

---

## 1. The problem: a person driving `!travel` from chat

Long journeys were driven by sending `!travel` repeatedly and watching the output. That works
only if you wait for each `VERIFIED TRAVEL` line before sending the next one. An automated
driver that re-sent on a **fixed timer** instead spent **97 minutes interrupting its own
in-flight leg** — and the symptom is that the bot looks stuck, because every leg is cancelled a
few seconds after it starts.

The fix is not "tune the timer". It is to make **one action own the whole route**, so that a leg
finishes when the bot's *position* says so, not when a clock fires.

---

## 2. `skills.travelToward(bot, x, z, opts)` — the engine

`travelDirection` (`!travel`) is now a thin wrapper over it. Same tuned recovery ladder — swim
the river, walk around the ridge, stair up the cliff, trench the dune, sidestep the build — with
the heading generalised. **Two headings, deliberately:**

- **steering** uses a true unit vector toward the target;
- **digging** quantises it to the nearest of eight (`nearestCompass`), because every block-level
  helper indexes blocks as `p + d*n`, and a fractional `d` reads the wrong column.

**Progress along the leg is a *signed* projection.** The old form was
`|dx|*|dx_moved| + |dz|*|dz_moved|`, which scored a step backwards exactly like a step forwards.

### Measured

| route | result |
|---|---|
| good ground, one navigator leg | **48 blocks in 12 s** |
| surveyed route, checkpoint 1 | **84 blocks in 34 s, 0 blocks mined** — ~150 blocks/min |
| the old axis-locked `!travel` | ~25 blocks/min |
| bad ground (bot ends up in water) | **3 blocks in 20 minutes** |

The spread is almost entirely *whether the route puts the bot in water*. See
[SWIMMING.md](SWIMMING.md) §7.2 for the wading paralysis behind the worst case.

### The recovery ladder, and the rules that keep it honest

- **Never tunnel while underground.** More than 20 blocks below the surface, `travelToward`
  refuses to mine forward and calls `climbToSurface` instead. Blind forward mining is how the
  bot ended up 31 blocks down, and from there *every* route the planner can see is also
  underground. The threshold is 20 and not 8 because cutting through a ridge legitimately puts
  the bot "below the surface" for a while.
- **Walk around trees, never fell them.** A trunk is 1-2 blocks wide, so a detour is trivial;
  chopping is slower and wrecks the landscape. Priced at `treeDigCost 60` and excluded from
  `clearWayAhead`. **Leaves are not trunks** — they are cheap and unavoidable under a canopy,
  and are released at `stalls > 3` so a bot boxed in by jungle cannot deadlock.
- **Try placing before digging.** `climbLedgeByPlacing` pillars up and steps across a 2-3 block
  rise; placing leaves the terrain intact. Only fall back to cutting stairs when there is
  nothing to build with.
- **Check `interrupt_code` at the top of every step.** Each step in the ladder returns
  immediately when it is set, so a stale interrupt makes the whole ladder silently no-op —
  `climbBank` reporting `still wet after 0ms, gained 0.00` is the signature. That made four
  separate wiring fixes look like they did nothing.

---

## 3. Checkpoint marathons

```
!marathonPlan(6, 1000, 30)   # 6 checkpoints on a ring, <=1000 blocks of route, ring rotated 30 deg
!marathonRoute("4412,4934 4362,5021 ...", 1000)   # explicit, surveyed checkpoints
!marathonRun                 # run it, resuming wherever a previous run stopped
!marathonStatus              # per-checkpoint ledger
!marathonReset
```

`src/agent/library/marathon.js`. One action (`!marathonRun`) owns the entire route.

- **Arrival is judged on XZ only** (`ARRIVE_DIST = 4`). The checkpoint's Y is unknown when the
  route is drawn — the chunk is not loaded, so there is no surface height to aim at. The bot
  records the Y it actually arrived at.
- **State is written to `bots/<name>/marathon.json` after every checkpoint**, so a crash, a
  restart or a mode interrupt resumes at checkpoint 4 instead of at the start.
- `planLoop` solves the ring radius from the straight-line budget —
  `total = R + (count-1) · 2R · sin(π/count)` — and `!marathonPlan` **refuses** rather than
  quietly overspending it. `slack` (0.96) keeps a little back, because the bot walks around
  hills rather than through them.
- **`swimEnabled: false`.** A pond is a route the bot can enter and cannot leave. See
  [SWIMMING.md](SWIMMING.md) §9.
- **Nothing here teleports.** `!serverTp` deletes its own arming marker precisely so a route
  cannot be shortcut, and the marathon must never touch it — or the numbers stop meaning
  anything.

### Prefer `!marathonRoute` once you have surveyed the ground

A regular ring is convenient and often wrong. Around (4312, 4934) on this world, **no** rotation
of a hexagon at radius 100 or 120 puts all six vertices on dry land — two separate lakes sit in
the way. Survey first, then hand-pick six land bearings.

**Verify the midpoints too, not just the vertices.** The first attempt had every checkpoint on
land and a lake across leg 5→6.

`startAngleDeg` exists because terrain is not isotropic: around (4337, 4891) the R=160 ring is
land at every 30° bearing except 45/60/75 and 285, so starting at 30 puts all six vertices on
dry ground.

### Surveying without a bot (RCON)

```
forceload add <x> <z>
execute if block <x> <y> <z> air     ->  "Test passed" / "Test failed"
```

- **Scan the column downward; do not bisect.** Columns are not monotonic here — caves and
  ravines put air under stone — and a bisection over [-64, 250] converges on a cave roof 50
  blocks below the real surface.
- **Use ONE persistent RCON connection.** Reconnecting per command stalls the server after ~13
  rapid cycles, and `socket.setTimeout` does not fire on it.

### Reporting

`onLeg` reports **`navMoved`, not `moved`** — what the *navigator* leg covered. Whatever the
recovery ladder manages afterwards (digging out of a bank, swimming a crossing) lands in the
*next* leg's starting position, so a leg can honestly report `navMoved 0.0` while `to go` drops
by four. Calling it "moved" made a run that was progressing by mining look frozen.

---

## 4. Who owns the running action

**The model does not get to cancel what a person asked for.**

Observed live: a user typed `!marathonRun`, and six seconds later the model's own next turn
emitted `!travel("west", 500)` from a stale conversational thread. That cancelled the marathon
and walked the bot 290 blocks in the *opposite* direction — and nothing in the log named what
had been cancelled.

- `ActionManager` records `action_author` (`'user'` / `'model'` / `'mode'`) for the running
  action, and `resume_author` so a resumed leg is still the user's.
- `agent.js` refuses a **model-emitted** action while a user-owned action is running.
- **Queries are untouched**, so the model can still `!stats` and answer questions about what is
  happening. The guard first used `isAction` — "is it in the action list" — which includes
  read-only commands, so the model asked `!marathonStatus` to find out what was going on and was
  told it could not. That is the opposite of the point. It now uses `takesOverBot`.
- **Modes are deliberately exempt.** They pass `author: 'mode'`, so drowning and self-defence
  still interrupt everything, including a user's marathon.

`tests/action_owner.test.mjs` covers all of it, including the leak that would make a safety mode
inherit `'user'` and become uninterruptible itself.

### 4.1 A mode must not END the action it interrupted

Reported live as *"Andy stops following me when torch placement is enabled."*

`mode:torch_placing` lists `action:followPlayer` in its `interrupts`, so it stops the follow,
places one torch, and completes **cleanly**. The clean-completion branch of `_executeAction`
then called `cancelResume()` **unconditionally** — wiping the resume state that belonged to
`followPlayer`, not to the mode.

So the follow *ended* rather than pausing. `should_reprompt` then fired an
`(AUTO MESSAGE) your previous action was interrupted by torch_placing` at the model, which
guessed its way through `!goToPlayer` → `!navTo` (0 args) → `!entities` → `!lookAtPlayer` and
never got back to following. Every ~5 seconds. In daylight. Captured verbatim in the log:

```
16:24:00  action "mode:torch_placing" trying to interrupt current action "action:followPlayer"
16:24:00  Placed torch at (4803, 72, 4764).
16:24:00  received message from system : (AUTO MESSAGE)Your previous action
          'action:followPlayer' was interrupted by torch_placing.
16:24:05  Generated response: ... !goToPlayer("asanrivas", 5)
16:24:07  ... !entities
16:24:12  ... !lookAtPlayer("asanrivas", "same direction")
```

Andy even diagnosed it himself — *"Let me turn off torch placing so it stops interrupting me
while following you"* — and turned the mode off twice.

**The rule: a resume belongs to whoever registered it.** A mode is a transient interruption, not
a new intent — that is the entire reason `resume` exists. The cancel is now conditional on the
completing action actually owning the resume, unless the caller is a real command (a new user or
model command *is* a change of intent and should clear it). Both the clean path and the `catch`
path carry the guard; `torch_placing` calling `placeBlock` into an occupied cell throws
routinely.

### 4.2 ...and it should not have been firing in daylight anyway

The resume fix turns the follow-killer into a brief pause, but `torch_placing` was still firing
every 5 s on open ground because `world.shouldPlaceTorch` had no light check at all — only "no
torch within 6 blocks", behind a `// TODO: block.light is broken`.

`block.light` is broken; the **chunk** light data is not, and is reachable synchronously
(`bot.world` is prismarine-world's `.sync` view: `getBlockLight`, `getSkyLight`). Two traps:

- **Sky light is stored UNSCALED.** A surface block reads 15 at midnight exactly as at noon —
  the client applies the time-of-day factor. It only means "daylight reaches here" when paired
  with `bot.time.timeOfDay`.
- **An unloaded chunk returns 0 from both getters**, indistinguishable from a pitch-dark cave.
  The check fails **open**: any doubt falls back to the old behaviour rather than silently
  disabling a mode.

Verified live: `block=0 sky=14 timeOfDay=17697`. The decision is the pure
`world.torchIsWorthIt(blockLight, skyLight, timeOfDay)` so every quadrant is unit-tested — a
live check only exercises whichever one the world is in at the time.

---

The unconditional cancel was not gratuitous — it was fixing a real bug in the other direction:
a finished action that leaves resume state behind is re-run by the idle handler on every tick,
and a `!navTo` to the bot's own position re-ran every second for hours, hammering the LLM and
filling GPU VRAM. Both directions are now covered by tests.

---

## 5. Driving a journey by hand

- **Issue one leg at a time** and wait for the `VERIFIED TRAVEL` line before sending the next.
- **Avoid large `!serverFill` operations near the bot.** Those repeatedly dropped it into pits,
  buried it in sand, and opened a cave under it.
- **Prefer `!travel` / `!navTo` over `!goToCoordinates`** for anything non-trivial.
