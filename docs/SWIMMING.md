# Water: Swimming, Climbing Out, Diving and Oxygen

**Status:** shipped and measured. The climb-out gym passes 10/10. Two known failure modes,
documented at the bottom.
**Related:** [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) · [MARATHON.md](MARATHON.md) · [TESTING.md](TESTING.md) · [WORLD_TOOLS.md](WORLD_TOOLS.md)

---

## 1. Why this exists

Andy could not swim. Every water behaviour in the codebase was **avoidance**:

- `nav.js` priced water to route around it (`waterCost: 15`, charged **twice** for a mid-river
  cell — once for wet feet/head, again for a wet block below — so a river cell cost 30
  "blocks walked").
- `travelDirection` treated being in water as a stall to escape, and `bridgeWayAhead`
  **filled water in with placed blocks** rather than crossing it.
- The only drowning response was `modes.js`: `if (blockAbove.name === "water")` hold `jump`.
  It bypassed `execute()` (no timeout, never marked active), **never released the jump key**,
  and was gated on `bot.pathfinder.goal`, which this project no longer uses.
- `bot.oxygenLevel`, `bot.entity.isInWater` and `bot.entity.isInLava` had **zero** references
  anywhere in `src/`.

### The premise was wrong

`nav.js` justified `waterCost: 15` with a comment: *"with this server's physics the bot barely
moves while swimming."* That was never measured, and it is false.

Water is the one part of the physics stack that this server's broken `onGround` does **not**
touch:

| Claim | Evidence (`node_modules/prismarine-physics/index.js`) |
|---|---|
| Water detection ignores `onGround` | `isInWater` is recomputed each tick in `simulatePlayer` (:705-713) from an AABB block scan |
| Swim-up works | `if (control.jump) { if (isInWater \|\| isInLava) vel.y += 0.04 }` (:721-737) is checked **before** the `onGround` branch |
| Sprint does nothing in water | `control.sprint` is never read inside the fluid branch (:466-501). No `pose`/`swimming`/`crawling` in the file |
| **Pitch is not a movement input** | `applyHeading` (:420-436) uses `entity.yaw` only |

---

## 2. Measured, not assumed

`!swimProbe`, 7-block-deep water, five runs. See [TESTING.md](TESTING.md) for the procedure.

| | predicted from constants | measured |
|---|---|---|
| forward | 0.100 b/t | **0.098 b/t = 1.96 blocks/s** |
| forward + sprint | 0.100 (no-op) | **0.098** — confirms sprint is ignored |
| sprint boost @ 0.026 | 0.130 | **0.127** |
| rise, jump held | +0.175 | **+0.151** |
| sink, nothing held | −0.025 | **−0.025** exactly |

**1.96 blocks/s ≈ 118 blocks/minute, against ~25 blocks/min overland.** Swimming is roughly
**four times faster than walking** here. `!travel("west", 40)` across a river now reports
`moved 47/40 blocks (117.8%). Mined 0 block(s).`

---

## 3. The three wet states

Almost every bug in this document comes from conflating two of these. They need **opposite**
handling, and the distinction is not "is the bot in water".

| state | test | who owns the jump key | how to propel it |
|---|---|---|---|
| **afloat** | head submerged, or nothing solid under the feet | SwimAssist | `forward`; jump is buoyancy, never propulsion |
| **wading** | in water, standing on solid ground, head in air | nobody — it is **land** | `forward` + AutoJump's hop, exactly like dry ground |
| **at the surface** | floating, head in air, deep water below | SwimAssist | it **cannot rise at all** — see §5 |

The third is the nastiest: the bot is in neither physics regime. It is not "in water" enough for
prismarine-physics to grant the swim impulse, and `onGround` is false so the land jump branch is
dead. `swim.climbBank` exists entirely for that state.

---

## 4. The pieces

| File | Purpose |
|---|---|
| `src/agent/library/swim.js` | `inWater`, `isSubmerged`, `inLava`, `oxygen`, `waterSurfaceY`, `airPocketAbove`, `nearestOpenColumn`, `deepestWaterNear`, `waterDepthBelow`, `swimTo`, `dive`, `surface`, `swimForward`, `verticalIntent`, **`bankTargetAhead`**, **`climbBank`** |
| `src/agent/library/swim_assist.js` | Always-on buoyancy + the sprint-swim boost |
| `src/agent/library/swim_probe.js` | `measureSwim`, `verdictFor`, `formatProbe` — the harness above |
| `src/agent/library/skills.js` | `travelToward`'s wet recovery ladder, `buildFootingBelow`, `escapeWater` |
| `src/agent/library/auto_jump.js` | `_wading()` — drives a wading bot like a land bot |
| `src/agent/library/nav.js` | `followPath`'s wading branch and the water cost model |
| `src/agent/modes.js` → `drowning` | First in `modes_list`; surfaces before the air runs out |
| `src/agent/library/tools.js` | `isWaterName`, `isSwimmable`, `isLavaName`, `isBubbleColumn` |

**Commands:** `!swimTo(x,y,z)`, `!dive(depth)`, `!surface`, `!swimProbe`.

`!stats` grows a water line **only while wet**, so the normal prompt costs nothing:

```
- In water: SUBMERGED, Air: 13 / 20 [assist: auto, jump=true, boost=false] [physics.isInWater=true vel.y=0.027]
```

Those last three numbers are not decoration — see §7.1.

---

## 5. Getting OUT of the water

This was the single biggest source of stuck bots, and the direct answer to *"why did Andy dig a
water canal?"* — **he could not climb a one-block bank, so `travelToward` fell through to its
dig recovery and mined the bank instead.** The water then followed him into the channel he had
just cut. Nothing in the log said "climb failed"; it just looked like a bot that had decided to
excavate.

### 5.1 A bot pressed flush against a block face cannot rise AT ALL

Not "rises slowly" — the collision resolution appears to cancel the **entire** move, vertical
component included, while the AABB is touching. Measured in the gym, same lane, same depth, the
only variable being the start x:

| start x | gap to the bank face at 4509.0 | result |
|---|---|---|
| **4508.70** | 0 (hitbox edge exactly on the boundary) | held `y=110.000`, **zero movement for 22 seconds** |
| **4508.40** | 0.3 blocks | **out in 0.8 s** |

`climbBank` therefore holds `back` for 400 ms before it starts climbing, whenever it begins
within 1.05 blocks of the target. **Make a gap, then climb.**

This is the fact that explains most of the older "the bot is grinding against the shore"
observations, and it is why several earlier fixes that were correct in isolation still produced
a stuck bot: something else was pressing the bot into the wall.

### 5.2 Supply the jump impulse by hand

A 20 Hz trace of a real person climbing out (`scratchpad/trace_player.mjs` →
`recordings/trace-asanrivas-*.tsv`) shows **+0.75 in a single tick from `onGround=1`**. Our
`onGround` reads false permanently, so prismarine-physics never grants it, and buoyancy alone
(~0.16 b/t) tops out short of the lip:

- against a bank whose top face is `y=111.0`, buoyancy peaked at **`y=110.81`** and fell back;
- in two-block water — where the bot can neither submerge (buoyancy holds it above `y=110`, so
  its head never goes under) nor jump — it topped out at **`y=110.34`**, 0.66 short, pinned at
  `x=4508.70`.

`climbBank` adds `JUMP_IMPULSE = 0.42` to `velocity.y` whenever it is wet, below the target and
not already rising. One impulse covers both the submerged and the stand-deep cases.

### 5.3 Success means being OVER the target, not merely dry and high

The old test passed the moment the bot cleared the water line — which it does while still in the
water column. Measured at both depths: the bot reaches exactly `y=111.003`, the bank's top face,
while sitting at `x=4508.85` — perched on the **lip**, hitbox half over the edge — and slides
back into the pool the moment the climb stops. The test is now an explicit XZ containment check
(`|x − (target.x+0.5)| < 0.6` and the same in z).

### 5.4 Pick the bank you can reach, not the one dead ahead

`bankTargetAhead` searches the **forward cone** (heading ±45°), lowest step first:

- **`maxRise` is 1, deliberately.** A floating bot rises only while its feet are still in water,
  so the highest foot cell it can ever enter is one whose floor is at the water surface — a
  one-block bank. Searching higher buys six seconds of swimming into a wall per attempt.
- **Cone, not exact heading.** Observed at (4279, 62, 4934): the bank due east was a two-block
  step and unclimbable, while the *same shore one block south* was a one-block step. Searching
  only the bearing declared that shoreline impassable and the bot ground against it for four legs.
- **`corridorClear` — a standable cell behind a wall is not a bank.** From (4280, 62, 4935) the
  search picked (4283, 63, 4935): a real ledge three blocks east, with two solid blocks in
  between. The bot swam into the wall for eight seconds and reported `still wet, gained 0.00`.

### 5.5 Bail on measured progress

Same invariant as walking: a bot whose 0.6-wide hitbox is jammed in a corner reads as "open bank
one block ahead" and cannot move a millimetre toward it — observed at (4282, 62, 4935), walled
east and south at feet level, holding jump and forward for a full eight seconds at `vel=(0,0,0)`.
`climbBank` gives up after **2.5 s without measured progress**, where progress is rise plus
horizontal closing.

### 5.6 `walkForward` must never run while wet

`walkForward` exists for a **land** problem: mineflayer-pathfinder refuses to plan a one-block
step, and AutoJump carries the bot over once it is walking. AutoJump early-returns in water, so
wet it does nothing at all except hold `forward` into the bank for four seconds — **which is
precisely the flush-against-the-wall state of §5.1** — and it consumed enough of the leg budget
that `climbBank` never got a turn.

Gating it on `!inWater(bot)` took the gym from *2 of the first 3 depths failing* to *all of them
passing*. This was the decisive fix: §5.1 was correct in isolation long before the bot could
actually use it.

### 5.7 When it still cannot climb: build a footing

`skills.buildFootingBelow` places a block on the pool floor under the bot's feet, making the
water shallow enough to **stand** in, after which the ordinary step-up does the rest. It sits
between `climbBank` and the swim-to-far-bank fallback in the recovery ladder.

It was added because the bot was measured grinding against a one-block bank at water depths 1-6
**while carrying 320 cobblestone it never thought to use**. Reference block must be the highest
solid in the column and within arm's reach (`dy` 2..4); it looks straight down before placing.

### 5.8 The wet recovery ladder, in order

In `travelToward`, when `inWater(bot) && !wading`:

1. **Surface, if submerged.** Nothing else can make progress until the head is out. A bot under
   an overhang — solid ceiling above, water at feet and head — cannot rise, cannot climb a bank
   and cannot walk out; buoyancy just presses it into the ceiling. Observed at (4322, 61, 5034).
2. **`climbBank`.** When the land we want is the bank in front of us, the move is to climb onto
   it — not to hunt a far bank, and certainly not to mine it.
3. **`buildFootingBelow`.**
4. **Swim to the far bank**, if the crossing is within `MAX_SWIM_LEG` (24).
5. **`escapeWater`** — head for the nearest dry land. Last, because it often heads *backwards*.

### 5.9 Result

**10/10 depths climb out** (2026-08-27, water 1-10 blocks deep against a one-block bank, 16-37 s
each), against a pre-fix baseline of **3/10** — depths 1, 2, 4, 6, 7, 8 and 10 all sat in the
water until the timeout. Every failure was the same flush-against-the-bank state; nothing here
is depth-specific, which is why one pair of fixes cleared all seven failing lanes.

See [TESTING.md](TESTING.md) §3 for the gym rig, including the trap that will silently inflate
your pass rate.

---

## 6. Invariants

1. **Pitch is not a movement input.** Vertical control is a **jump duty cycle**. Set pitch for
   the head and for `bot.dig`; never as a control.
2. **SwimAssist owns the jump key while the bot is AFLOAT.** Not `followPath`, not AutoJump, not
   the idle `clearControlStates` in `modes.js` or in `agent.js`.
3. **Wading is not afloat.** A bot standing on solid ground in shallow water must be driven like
   a bot on land — see §7.2.
4. **Assert the jump key against `bot.controlState.jump`, never a cached flag.** See §7.1.
5. **SwimAssist's default is positive buoyancy.** Deliberate: the failure mode of a crash
   anywhere in the swimming code is a bot *floating*, not one on the seabed out of air.
6. **Rising is 7× faster than sinking** (+0.175 vs −0.025 b/t), so vertical control is a
   hysteresis band (`verticalIntent`), not a proportional controller.
7. **Never hop or dig while afloat.** Jump is buoyancy; mining and placing do nothing while
   floating, for the same reason pillaring does not.
8. **Trust measured progress over the block scan.** This killed a travel leg, a rise, and a
   bank climb, independently.
9. **Back off before climbing.** §5.1.
10. **`isInWater` and `isInLava` share the same physics branch** and can both be true at a
    boundary. Every entry point refuses on lava; the boost requires `isInWater && !isInLava`.
11. **Every loop that calls a swim primitive must yield a real macrotask.** See §7.6.

---

## 7. Bugs found, and what they cost

Ordered by how long each hid. Every one was found by running it, not by reading it.

### 7.1 The jump key was never actually pressed

`SwimAssist._setJump` early-returned when the requested state matched its own `holdingJump`
belief. Anything else calling `bot.clearControlStates()` — the action manager on an interrupt,
a mode, another skill's cleanup — set jump false behind its back, and the cache meant it never
pressed again. **Buoyancy died silently while `!stats` reported `jump=true`.**

```
before:  physics.isInWater=true  jump=true  vel.y=-0.005   <- sinking, key "held"
after:   physics.isInWater=true  jump=true  vel.y=+0.027   <- actually rising
```

This invalidated an earlier "buoyancy works" conclusion. It is why `!stats` now prints the
assist state *and* `physics.isInWater` / `vel.y`: a stuck bot looks identical whether the assist
is off, stuck sinking, or pressed against a ceiling.

### 7.2 WADING was owned by nobody, and the bot was paralysed completely

Found 2026-08-26, after a bot sat at **`vel=(0.000, 0.000, 0.000)` with `forward` held, in one
block of water, for twenty minutes and four process restarts** at (4281, 62, 4935) — with dry
land two blocks away and every diagnostic reporting the terrain was fine.

Four subsystems each refused, and **each of them was individually correct**:

| subsystem | why it stood down |
|---|---|
| SwimAssist | its `auto` mode presses jump only when the head is **submerged**; wading, it releases |
| AutoJump | bailed on **any** `entity.isInWater`, to avoid fighting SwimAssist over the key |
| `followPath` | its "hop to break the deadlock" branch was skipped for any `wet` — and it reset the stall timer too, so the hop could never fire |
| prismarine-physics | `onGround` reads false, so no ground acceleration from any source |

**Nobody pressed jump, and jump is the only propulsion this server gives us.**

All three now test for wading (`nav.js` `followPath`, `auto_jump.js` `_wading()`,
`skills.js` `travelToward`). Signature to recognise it again: `wet=true`, `sub=false`,
`jump=false`, `vel` exactly `(0,0,0)`, position identical to 12 decimal places.

Sending a wading bot through the *swim* ladder instead is its own bug: it surfaces, hunts banks
and calls `escapeWater`, which heads for the nearest dry land — often backwards. Measured: a bot
in a single block of water with open air on all four sides reporting `navMoved` −1.9, −3.0, −0.8
and drifting away from its checkpoint indefinitely.

### 7.3 The drowning safety net was blind — `bot.oxygenLevel` does not update here

`swim.oxygen()` reads `bot.oxygenLevel`, which mineflayer sets from the `air_supply` **entity
metadata** for the bot's own entity. That packet does not reliably reach this client:
**`!stats` reported `Air: 20 / 20` while the server's NBT had 13 ticks left.** So
`mode:drowning`'s `oxygen(bot) > threshold` guard never tripped, the mode never fired once, and
the bot drowned at (4322.60, 61.00, 5034.30) with its safety net silent from start to finish.

`mode:drowning` now **measures submersion itself** and fires on either signal:

- oxygen at or below **8 bubbles**, or
- **10 s of continuous submersion** (vanilla air is 300 ticks = 15 s).

The log line says which trigger fired, because the mode interrupts every action in the agent and
a spurious trigger is expensive. It also carries a 1.5 s cooldown after a successful surface —
air refills over about a second, so without one it re-fired four times in ten seconds — and a
5 s backoff after a failure, or it spins every tick and pins `currentActionLabel` exactly like
the bug it replaced.

**Same principle as everything else here: trust measured state over reported state.**

### 7.4 `!surface` and `mode:drowning` fought each other

Each interrupt sets `bot.interrupt_code`, which aborts the other's climb:

```
mode:drowning   interrupts  action:surface
action:surface  interrupts  mode:drowning
mode:drowning   interrupts  action:surface   ...
```

Observed at 2 hearts of drowning damage. Fixed on both sides — `drowning` carries
`excludeFromInterrupt: ["action:surface"]`, and `!surface` stands down when the mode is active.

### 7.5 `surface()` never reached the phase that would have saved it

Its phase 2 (swim to a neighbouring open column) was allowed the whole remaining deadline, so
when the bot was wedged and could not reach that column, **phase 3 — the one that cuts through
the ceiling — never ran at all**. Observed as `surface()` returning `timeout, rose -0.2` with a
single diggable stone block directly overhead. Phase 2 is now capped at 4 s.

### 7.6 `followPlayer` spun the event loop until the server dropped the bot

Reported live as *"died in water during follow"*. The bot did not drown — the **server timed the
client out**: `andy lost connection: Timed out`, 70 seconds into a follow.

`followPlayer` has a swim branch, because mineflayer-pathfinder cannot follow anyone underwater
(two literal `if (blockC.liquid) return // dont go underwater` guards in
`mineflayer-pathfinder/lib/movements.js:541,561`). That branch ended in a bare `continue` that
deliberately skipped the 500 ms poll — "a diver moves faster than that".

But every await on its fast paths is a **microtask**, not a macrotask:

- `swim.swimTo` returns `arrived` on its first loop iteration when the bot is already inside
  `arrive`, having awaited only `bot.look(..., force)` — and mineflayer's `look` returns from
  the force branch *before* awaiting `lookingTask.promise`, and returns even earlier when the
  look delta is zero (`mineflayer/lib/plugins/physics.js:329`);
- its lava refusals return without awaiting anything at all.

A loop of pure microtasks never lets the event loop reach its timer and I/O phases, so the
socket went unread and unwritten. **Trigger is entirely ordinary: stand in water within
`follow_dist` of the bot.**

Fixed in two places, because the primitive should be safe for any caller:

- `swimTo` now yields one `tickMs` before any exit is reachable;
- `followPlayer`'s swim branch always awaits `SWIM_POLL_MS` (100 ms) before looping, and skips
  the pointless `swimTo` entirely when it is already at follow distance.

Regression test in `tests/swim.test.mjs`: schedule a `setTimeout(…, 0)`, run the fast path, and
assert the timer fired before `swimTo` resolved.

### 7.7 A rise was judged on the block scan

`airPocketAbove` looks straight up from the **floored** position, so a bot whose 0.6-wide hitbox
is caught on a neighbouring block reads as "column open" while unable to ascend. The old code
held jump against the ceiling until the deadline, then reported `no_air_pocket` **with no
blocker to name**. `riseUntilBreathing` now gives up after 1.5 s without vertical gain and hands
over to the move-sideways and dig phases.

### 7.8 `oxygen()` returned negative values

`air_supply` keeps counting down past zero while drowning; it reached chat as `Air: -1 / 20`.
Now clamped to 0..20, with tests.

### 7.9 The anti-cheat valve tripped during spawn

`forcedMove` fires on **every** server position packet, including login and teleports. Counting
them unconditionally disabled the sprint boost before the bot had seen water. Only corrections
arriving *while boosting* count.

### 7.10 `setMode('off')` did not mean hands off

It skipped the buoyancy logic but still rewrote `liquidAcceleration` every tick, silently
overwriting the probe's own value — so a boost that works measured as "no effect". All three
boost phases read back SwimAssist's 0.026.

### 7.11 `!placeHere` placed blocks inside the bot

It passed the bot's own position to `placeBlock`, which cannot work — the body occupies that
cell — and the failure surfaced as mineflayer's generic 500 ms `blockUpdate` timeout, which
reads like the known flake rather than "you asked me to place a block inside myself". A bed made
it obvious by needing two cells. `skills.placeNearby` now picks a free neighbouring cell, and
requires a free **pair** for beds and doors.

---

## 8. Sprint-swimming: ours, capped at vanilla parity

prismarine-physics never reads `control.sprint` in water, so the 1.13+ swimming pose does not
exist for this bot. SwimAssist restores it by raising `bot.physics.liquidAcceleration` while
submerged and sprinting — the library re-reads that constant every tick, so the acceleration
curve and strafing stay correct. Adding to `bot.entity.velocity` also works but fights
`negligeableVelocity` and produces jerk.

**The ceiling is vanilla parity and nothing more:** 0.032 → 0.16 b/t, exactly what a real player
gets holding sprint underwater. Currently shipped at the conservative **0.026** (measured 0.127
b/t). A `forcedMove` valve disables the boost after 3 corrections in 10 s, so a hostile
anti-cheat degrades us to plain swimming rather than a kick.

**Restore `liquidAcceleration` on disable, on leaving water, and on death/respawn** — a leak
silently alters *lava* movement forever.

---

## 9. Navigator integration

Gated behind `swimEnabled`, which only `travelDirection` turns on. `!navTo`, `moveAway` and
every mode-driven move keep the land-only model that has a 1018-block journey behind it —
changing the water price changes which nodes win the *whole* A\* frontier, not just the wet ones.

```
waterCost 2   waterEntryCost 6      (swimEnabled)
waterCost 15                        (default, unchanged)
```

- The water charge is applied **once** per cell (`swimCostFor`, pure and unit-tested).
- The real expense is the **transition**, not the metres, hence a one-off entry charge on the
  dry→wet move. A 6-wide river costs `6×2 + 6 = 18`, beating a 60-block detour; a 500-cell ocean
  costs 1006 and loses to any land route.
- **Never set `waterCost` to 0** — free water lets A\* burn its whole node budget on open ocean
  and route the bot out to sea.
- **Water is only cheap if you can get out of it.** A river has a far bank and is worth swimming;
  a pond is a route the bot can enter and cannot leave, and every attempt to mine its way out
  just widens the pond — it dug a canal east and the water followed it in. A checkpoint marathon
  therefore sets `swimEnabled` **false**.
- `followPath` holds sprint while afloat and does **not** hop or dig; `arriveXZ` widens to 1.2
  because buoyancy makes the bot overshoot. While **wading** it does all of those, like land.
- `travelDirection` swims crossings up to `MAX_SWIM_LEG` (24) instead of bridging them.

See [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) for the rest of the cost model.

---

## 10. Known limitations — read before sending the bot under ice

**A bot that swims into a horizontal crevice under an overhang can be fully immobilised.**
`vel.y` is zeroed by collision above, and it is blocked horizontally too. It holds jump, cannot
rise, cannot slide out, and drowns. `unwedge` attempts a sideways shove but does not always free
it.

Reproduced three times at y≈53 in a frozen ocean during a deep `!swimTo` leg; each time the bot
had to be recovered with `!serverTp`. **Do not send the bot on deep `!swimTo` legs under an ice
sheet without supervision.**

Also unverified: the `surface()` fallback ladder's *dig-through-ice* phase has never succeeded
in the live world. It is covered by unit tests against a fake world only.

**Banks taller than one block are out of scope for `climbBank`** by design (§5.4). Those are the
traveller's job — `skills.climbLedgeByPlacing` pillars up and steps across, falling back to
cutting stairs when there is nothing to build with.
