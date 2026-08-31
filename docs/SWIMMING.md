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

---

## Moved here from CLAUDE.md (2026-08-31 restructure)

CLAUDE.md keeps the RULES; this file keeps the EVIDENCE. The text below is verbatim
from CLAUDE.md before it was compacted — the measurements, the incidents and the
reasoning behind the one-line rules that remain there. Heading levels are demoted by one.

#### Swimming, diving and oxygen

*(The `prismarine-physics` internals cited throughout this section - `simulatePlayer`,
`applyHeading`, `liquidAcceleration` - describe the layer `docs/CLIENT_REPLACEMENT.md`'s
`src/mc/physics/` is taking ownership of. Each behavior below must be reproduced or
deliberately diverged from there; `liquidAcceleration` in particular must stay a mutable field,
not a computed one - see that doc's "riskiest assumptions".)*

**Water is the one part of this server's physics that is NOT broken**, and the whole codebase
was built on the opposite assumption. Everything else here works around `bot.entity.onGround`
reading false while the bot is provably standing. Water does not care:

- `isInWater` is recomputed every tick in prismarine-physics `simulatePlayer` from an AABB block
  scan. It never reads `onGround`.
- Swim-up works because the jump handler checks `if (isInWater || isInLava) vel.y += 0.04`
  **before** it checks `onGround` - the branch that is dead on land is live in water.

##### Measured, not assumed (`!swimProbe`, 7-block-deep water, 5 runs)

| | predicted from the constants | measured |
|---|---|---|
| forward | 0.100 b/t | **0.098 b/t = 1.96 blocks/s** |
| forward + sprint | 0.100 (sprint is a no-op in water) | **0.098** - confirmed |
| sprint boost 0.026 | 0.130 | **0.127** |
| rise, jump held | +0.175 | **+0.151** |
| sink, nothing held | -0.025 | **-0.025** exactly |

**1.96 blocks/s is ~118 blocks/minute, against this bot's ~25 blocks/min overland.** Swimming is
roughly four times faster than walking here. `!travel("west", 40)` across a river now reports
`moved 47/40 blocks (117.8%). Mined 0 block(s).`

##### The pieces

| File | What it does |
|---|---|
| `library/swim.js` | `inWater`, `isSubmerged`, `inLava`, `oxygen`, `waterSurfaceY`, `airPocketAbove`, `nearestOpenColumn`, `deepestWaterNear`, `swimTo`, `dive`, `surface`, `swimForward`, `verticalIntent` |
| `library/swim_assist.js` | Always-on: buoyancy + the sprint-swim boost. Modelled on `auto_jump.js` |
| `library/swim_probe.js` | `!swimProbe` - the measurement harness above |
| `modes.js` -> `drowning` | First in `modes_list`. Surfaces before the air runs out |

Commands: `!swimTo(x,y,z)`, `!dive(depth)`, `!surface`, `!swimProbe`. `!stats` grows an
`In water: SUBMERGED, Air: 13 / 20` line **only while wet**, so the normal prompt costs nothing.

##### Invariants - read before changing this

- **Pitch is not a movement input.** prismarine-physics `applyHeading` uses `entity.yaw` only.
  Vertical control is a **jump duty cycle**, not a look angle. Set pitch for the head and for
  `bot.dig`; never as a control.
- **SwimAssist owns the jump key while the bot is wet.** Nothing else may touch it - not
  `followPath`, not AutoJump (which early-returns in water), not the idle `clearControlStates`
  in `modes.js`. Jump contention is what the old drowning code got wrong.
- **Its default mode is positive buoyancy.** That is deliberate: the failure mode of a crash
  anywhere in the swimming code is then a bot *floating*, not one on the seabed out of air.
- **Rising is 7x faster than sinking** (+0.175 vs -0.025 b/t), so vertical control is a
  hysteresis band (`verticalIntent`), not a proportional controller. Without the dead band the
  bot porpoises.
- **Never hop or dig while afloat.** Jump is buoyancy, not propulsion, so pulsing it makes the
  bot bob instead of advance; and mining and placing do nothing while floating, for the same
  reason pillaring does not.
- **`isInWater` and `isInLava` share the same physics branch** and can both be true at a
  boundary. Every swim entry point refuses on lava, and the boost requires `isInWater && !isInLava`.

##### WADING is not AFLOAT - and conflating them paralyses the bot completely

Found 2026-08-26, after a bot sat at **vel=(0.000, 0.000, 0.000) with `forward` held, in one
block of water, for twenty minutes and four process restarts** at (4281, 62, 4935), with dry
land two blocks away.

There are two wet states and they need opposite handling:

| | what it is | who owns the jump key |
|---|---|---|
| **afloat** | head submerged, or nothing solid under the feet | SwimAssist. Jump is buoyancy; hopping only makes the bot bob. |
| **wading** | in water, standing on solid ground, head in air - a puddle, a ford, a shoreline | *nobody was.* For propulsion this is **land**. |

Every subsystem refused, each of them correctly:

- `SwimAssist` `auto` mode presses jump only when the head is **submerged**. Wading, it releases.
- `AutoJump` bailed on **any** `entity.isInWater`, to avoid fighting SwimAssist over the key.
- `followPath`'s "hop to break the deadlock" branch was skipped for any `wet`, and it reset the
  stall timer too, so the hop could never fire.
- And `onGround` reads false while the bot is provably standing (see Movement, above), so
  prismarine-physics withholds ground acceleration.

Result: **no subsystem pressed jump, and jump is the only propulsion this server gives us.** The
bot could not move a millimetre in any direction, and every diagnostic said the terrain was fine.

All three now test for wading (`nav.js` `followPath`, `auto_jump.js` `_wading()`), so a bot in
shallow water is driven like a bot on land. Signature to recognise it again: `wet=true`,
`sub=false`, `jump=false`, `vel` exactly `(0,0,0)`, position identical to 12 decimal places.

##### A bot at the WATER SURFACE cannot rise at all

Also measured, and the reason `swim.climbBank` exists and is capped at `maxRise: 1`: holding
jump in `climb` mode against an adjacent **one-block** bank produced `gained 0.00` every time.
At the surface the bot is in neither regime - not "in water" enough for the swim impulse, and
`onGround` is false so the land jump is dead. `climbBank` therefore:

- searches the **forward cone** (heading +- 45 degrees), preferring the lowest step, because the
  bank dead ahead is often two blocks while the same shore half a step to the side is one;
- refuses a target it cannot **reach** - `corridorClear` - after it picked a real ledge three
  blocks east with two solid blocks in between and swam into the wall for eight seconds;
- **bails in 2.5s on measured progress**, not on its own block scan, the same invariant
  `riseUntilBreathing` had to learn.

**Consequence for the cost model: water is only cheap if you can get out of it.** `travelToward`
takes `swimEnabled`, and a checkpoint marathon sets it **false**. A river has a far bank and is
worth swimming; a pond is a route the bot can enter and cannot leave, and every attempt to mine
its way out just widens the pond - it dug a canal east and the water followed it in.

##### Sprint-swimming is ours, and it is capped at vanilla parity

prismarine-physics never reads `control.sprint` inside its water branch - the 1.13+ swimming
pose simply does not exist for this bot. SwimAssist restores it by raising
`bot.physics.liquidAcceleration` while submerged and sprinting (the library re-reads that
constant every tick, so the acceleration curve and strafing stay correct - adding to
`bot.entity.velocity` fights `negligeableVelocity` and produces jerk).

The ceiling is **vanilla parity and nothing more**: 0.032 gives 0.16 b/t, exactly what a real
player gets holding sprint underwater. Currently shipped at the conservative **0.026** (measured
0.127 b/t). A `forcedMove` valve disables the boost after 3 server corrections in 10s, so a
hostile anti-cheat degrades us to plain swimming rather than a kick. **Restore
`liquidAcceleration` on disable, on leaving water, and on death/respawn** - a leak silently
alters *lava* movement forever.

##### Bugs found by running it in survival - read these before touching SwimAssist

- **The jump key must be asserted against `bot.controlState.jump`, never a cached flag.**
  `_setJump` used to early-return when the requested state matched its own `holdingJump`
  belief. Anything else calling `bot.clearControlStates()` - the action manager on an
  interrupt, a mode, another skill's cleanup - then set jump false behind SwimAssist's back,
  and because the flag still said "holding", it never pressed again. **Buoyancy died silently
  while `!stats` reported `jump=true`.** Signature: `physics.isInWater=true`, `jump=true`,
  `vel.y=-0.005` - textbook sinking with the key supposedly held. This is why `!stats` now
  prints `[assist: ...] [physics.isInWater=... vel.y=...]` while wet: the failure is
  indistinguishable from a ceiling collision without those three numbers.
- **`!surface` and `mode:drowning` must not race.** Each interrupt sets `bot.interrupt_code`,
  which aborts the other's climb, and the two traded interrupts while the bot drowned:
  `mode:drowning` -> `action:surface` -> `mode:drowning`. Fixed on both sides - `drowning`
  carries `excludeFromInterrupt: ["action:surface"]`, and `!surface` stands down when the mode
  is already active.
- **A rise must be judged on measured progress, not on `airPocketAbove`.** The scan looks
  straight up from the *floored* position, so a bot whose 0.6-wide hitbox is caught on a
  neighbouring block reads as "column open" while being unable to ascend. `riseUntilBreathing`
  now gives up after 1.5s without vertical gain and hands over to the move-sideways and dig
  phases. Same invariant as walking: **trust measured progress over the block scan.**
- **`oxygen()` clamps.** `air_supply` keeps counting down past zero while drowning; it reached
  chat as `Air: -1 / 20`.
- **Known limitation, still unfixed:** a bot that swims into a horizontal crevice under an
  overhang can end up fully immobilised - `vel.y` zeroed by collision above, and blocked
  horizontally too. It holds jump, cannot rise, cannot slide out, and drowns. `unwedge` tries a
  sideways shove but does not always free it. Do not send the bot on deep `!swimTo` legs under
  an ice sheet without supervision.

##### The drowning safety net was blind - `bot.oxygenLevel` does not update here

`swim.oxygen()` reads `bot.oxygenLevel`, which mineflayer sets from the `air_supply` **entity
metadata** for the bot's own entity. That packet does not reliably reach this client:
`!stats` reported **`Air: 20 / 20` while the server's NBT had 13 ticks left**, so
`mode:drowning`'s `oxygen(bot) > threshold` guard never tripped, the mode never fired once, and
the bot drowned at (4322.60, 61.00, 5034.30) with its safety net silent from start to finish.

`mode:drowning` now **measures submersion itself** and fires on either signal: oxygen at or
below 8 bubbles, *or* 10 seconds of continuous submersion (vanilla air is 300 ticks = 15s).
Same principle as everything else here - trust measured state over reported state. The log line
says which trigger fired.

`swim.surface()` also had to be bounded: its phase 2 (swim to a neighbouring open column) was
allowed the whole remaining deadline, so when the bot was wedged and could not reach that
column, **phase 3 - the one that cuts through the ceiling - never ran at all**. Observed as
`surface()` returning `timeout, rose -0.2` with a single diggable stone block directly overhead.
Phase 2 is now capped at 4s.

##### The exit decision is made every tick, not after the stall ladder

`nav.waterExitVerdict()` - pure, `tests/water_exit.test.mjs`.

Getting out of water used to be decided by `followPath`'s stall ladder, whose branch order is
`progress -> waypointMs(6000) -> afloat -> pinnedMs(2500) && hops>=2 -> hop(700ms)`. From a dead
stop that is a hop at 700ms, a hop at 1400ms, and the **first climb attempt at 2500ms**. Measured
on one real bank at (4434, 62, 4682):

```
16:02:02  leg 3 ends
16:02:05  pinned   :07 pinned   :11 pinned   :13 pinned
16:02:14  leg 4: moved=-0.01 -> RECOVERY     <- 12s spent CONCLUDING it was stuck
16:02:14  climbBank attempt 1 -> jammed
16:02:20  climbBank attempt 2 -> OUT
```

**Twelve seconds of detection for six seconds of climbing.** And the routine the 2500ms branch
reaches is `climbAhead`, which only handles rises of **2 or 3** - so a ONE-block bank fell
through to `digAhead` and the bot mined the shore at water level. That is the canal-digging
behaviour, still live in the wading path; `swim.climbBank`, the routine that actually works, was
gated behind the 6000ms leg timeout and `travelToward`'s recovery ladder.

Every input the decision needs is already recomputed every tick (`isInWater` is an AABB scan,
block reads are synchronous), so it now runs on **every loop iteration (~100ms)** and routes
straight to `climbBank`. Gated by a 1200ms cooldown and a 3-attempt cap, because a failed climb
must not re-fire every 100ms and the existing ladder must still get its turn.

**A false positive costs a whole leg** - `climbBank` is an 8s commitment - so the refusals are
the tested surface: not wet, lava (both fluids share one physics branch), nothing solid ahead,
rise != 1, no landing, no headroom, bank further than 1.6 blocks.

##### climbBank maintains its standoff - it is not a one-shot back-off

The 400ms back-off was necessary and not sufficient: `forward` was then held for the whole climb,
so the bot walked straight back into the face it had just left. That made the climb a RACE
between rising (the `JUMP_IMPULSE` duty cycle) and closing (`forward` at ~0.1 b/t). Same target,
same heading, 4 seconds apart:

```
t=1.0s fwd=true pos=(4434.31, 62.42) vel=(0.000, 0.000, 0.000)  <- flush, ALL axes dead -> jammed
[retry] t=1.0s  pos=(4434.30, 62.72) vel=(0.000,-0.078, 0.001)  -> OUT
```

The face is x=4434.0 and the bot is 0.6 wide, so flush is 4434.30. **Both runs arrived flush; only
the height at contact differed - 62.42 vs 62.72.** Three tenths of a block decided it, which is
why retry counts looked like nondeterministic physics.

Now sequenced: hold `FACE_GAP + 0.30` while below the lip, press `forward` only once over it.
**The progress metric had to follow** - it was `rise + closing`, and backing off increases the
gap, so a correct back-off scored as negative progress and could trip the 2.5s jam bail on the
very move that unsticks the bot. Below the lip progress is height; above it, closing.

Measured live, gym lane 3, one-block bank: **2.8s end to end, one climbBank attempt of 413ms, no
`pinned` lines, 0 blocks mined** - against a 45.2s baseline for the same lane. One lane, one run;
the full 10-lane sweep has not been re-run.

##### The lip is TWO thresholds, and the step over it has to be DRIVEN (2026-08-27)

The 10-lane sweep, re-run: **10/10, every lane in 1-4s, one `climbBank` call per lane, zero
jams.** Getting there took three fixes, and the first sweep that passed 10/10 still had 15s,
20s and 43s outliers that moved lane to lane between runs - that flakiness was the real bug.

**A single `target.y - 0.05` was deciding two opposite questions.** Captured on lane 7:

```
t=2.0s pos=(4508.36, 111.05) wet=false   <- above the lip, so `forward` went on
t=3.0s pos=(4508.68, 110.97) wet=true    <- fell back in; STILL counted as "over"
t=4.1s pos=(4508.70, 110.97) vel=(0.000, -0.078, 0.000)  -> flush, jammed
```

At 111.05 the bot was five hundredths above the face and standing over WATER, with ~0.55 blocks
still to walk - six ticks, in which an unsupported body falls most of a block. It could never
have made it. Then, having fallen to 110.97, the same tolerance still read "over", so `forward`
stayed on and drove it flush, while the rise impulse - gated on `y < target.y - 0.05` - was
switched off by that very number. **A 0.05-block dead band in which the bot may not climb and
must not stop pressing.** Now `LIP_CLEAR` separates them: walking in needs real clearance, the
impulse keeps firing right up to it, and *dry and level with the face is not the same as
supported* - only a solid block under the feet (`standingOnSolid`) proves the bot is on the bank.

**`STEP_IN_SPEED` - the run-up, for the same reason `JUMP_IMPULSE` is the jump.** Over the lip
the bot is above the water and above nothing, so it has about a third of a second of fall to
cover the last half block - and `onGround` being false means prismarine-physics grants it only
AIRBORNE acceleration for the one moment it most needs to run. It reached y=111.46 with
`forward` held and moved **0.04 blocks** horizontally before falling back, five times in one
lane. 0.14 b/tick is a vanilla walk; this is not a boost, it is the run-up the broken ground
flag denies us, applied only while over the lip and only until the bot is over the target cell.

**The dip is ONE-SHOT.** `submergeUntil` alone was not, and that is what made the whole routine
stochastic: reaching submersion clears it, the next tick sees the bot still below the lip,
`!submergeUntil` is true again, and it arms another 1.5 seconds of *sinking*. Lane 5 fell to
y=109.20 from a start of 110.35 - a block the wrong way - and the same lane cleared in 0.4s on
one run and took 18s on the next. Nothing about it was depth-specific; it was whether a dip
happened to submerge.

##### Climbing out of the water onto a bank

Getting *out* of water was the single biggest source of stuck bots - it is what produced the
"Andy dug a canal" behaviour, because failing to climb a 1-block bank fell through to the dig
recovery and the bot mined through the bank instead of stepping over it.

`swim.climbBank(bot, dx, dz)` is the primitive. Three things make it work, and each was found
by measurement, not reasoning:

- **Supply the jump impulse directly.** A real player rises **+0.75 in a single tick** from
  `onGround=1` (captured from a live player trace, `tools/trace_player.mjs`). Our `onGround`
  reads false permanently, so prismarine-physics never grants that impulse and buoyancy alone
  (~0.16 b/t) tops out **~0.2 blocks short of the lip** - measured peaking at y=110.81 against a
  bank whose top face is 111.0, then falling back. `climbBank` adds `JUMP_IMPULSE = 0.42` to
  `velocity.y` whenever it is wet, below the target and not already rising.
- **BACK OFF THE WALL BEFORE CLIMBING.** Pressed flush against the bank the bot cannot rise
  *at all*. Measured, same lane, same depth: from **x=4508.70** (hitbox edge exactly on the
  block boundary at 4509.0) it held y=110.000 with **zero movement for 22 seconds**; from
  **x=4508.40** - a 0.3 block gap - it was out in **0.8s**. The collision resolution appears to
  cancel the entire move, vertical included, while the AABB is touching. `climbBank` now holds
  `back` for 400ms first when it starts within 1.05 blocks of the target.
- **Success requires being OVER the target, not merely dry and high.** The old test passed the
  moment the bot cleared the water line, which it does while still in the water column.

**`walkForward` must never run while wet.** It exists for a *land* problem - the pathfinder
refuses to plan a 1-block step, and AutoJump carries the bot over once it is walking - and
AutoJump early-returns in water. Wet, all it does is hold `forward` into the bank for 4
seconds, which is precisely the flush-against-the-wall state that makes the climb impossible,
and it delayed `climbBank` past the leg budget. Gating it on `!inWater(bot)` took the gym from
**2 of the first 3 depths failing to all of them passing**.

**Result: 10/10 depths climb out** (2026-08-27, 1-10 blocks deep, 16-37s each), against a
pre-fix baseline of **3/10** - depths 1, 2, 4, 6, 7, 8 and 10 all sat in the water until the
timeout. Every failure was the same flush-against-the-bank state; nothing here is depth-specific.

**Test rig**: `scratchpad/build_gym.mjs` builds 10 lanes of water 1-10 blocks deep against a
1-block bank; `gym_run.mjs` drives `!travel` through each and reports CLIMBED OUT / STUCK.
**Repair the lanes between runs** - a bot that mined a lane once will swim its own tunnel on
every later run and the suite reports a pass it did not earn.

##### Traps this cost real time

- **`forcedMove` fires on every server position packet**, including login and teleports. Counting
  them unconditionally tripped the anti-cheat valve during spawn, before the bot had seen water.
  Only corrections that arrive *while boosting* are evidence against the boost.
- **`setMode('off')` must mean hands off *everything*.** It originally skipped only the buoyancy
  logic while still rewriting `liquidAcceleration` every tick, which silently overwrote the
  probe's own value - so a boost that works measured as "no effect".
- **`!placeHere` placed blocks INSIDE the bot.** It passed the bot's own position to
  `placeBlock`, which cannot work - the body occupies that cell - and the failure surfaced as
  mineflayer's generic 500ms `blockUpdate` timeout, which reads like the known flake rather
  than "you asked me to place a block inside myself". A bed made it obvious by needing two
  cells. `skills.placeNearby` now picks a free neighbouring cell, and requires a free PAIR for
  beds and doors.
- **Andy's own self-prompt loop will interrupt a measurement.** It issued `!goToCoordinates` in
  reaction to each command's output and zeroed every probe phase. `!endGoal` plus a `!steer`
  directive is how to get a clean run.
- **Depth 1 is still a valid horizontal measurement.** The obvious story - "the bot is standing
  on the riverbed in the broken land-physics regime" - was tested and is false; the same
  one-block water read 0.098 b/t on a clean run. Only the *vertical* rates need depth.
- **Rise must be sampled in an early window.** At 0.175 b/t the bot reaches the surface in ~10
  ticks and then bobs, so a steady-state average over ticks 40-100 measures floating and reports
  "the bot cannot rise" when it plainly can.

