# Swimming, Diving and Oxygen

**Status:** shipped and measured. One known failure mode, documented at the bottom.
**Related:** [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) · [TESTING.md](TESTING.md) · [WORLD_TOOLS.md](WORLD_TOOLS.md)

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

Water is the one part of the physics stack the protocol-775 mismatch does **not** touch:

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

## 3. The pieces

| File | Purpose |
|---|---|
| `src/agent/library/swim.js` | `inWater`, `isSubmerged`, `inLava`, `oxygen`, `waterSurfaceY`, `airPocketAbove`, `nearestOpenColumn`, `deepestWaterNear`, `waterDepthBelow`, `swimTo`, `dive`, `surface`, `swimForward`, `verticalIntent` |
| `src/agent/library/swim_assist.js` | Always-on buoyancy + the sprint-swim boost |
| `src/agent/library/swim_probe.js` | `measureSwim`, `verdictFor`, `formatProbe` — the harness above |
| `src/agent/modes.js` → `drowning` | First in `modes_list`; surfaces before the air runs out |
| `src/agent/library/tools.js` | `isWaterName`, `isSwimmable`, `isLavaName`, `isBubbleColumn` |

**Commands:** `!swimTo(x,y,z)`, `!dive(depth)`, `!surface`, `!swimProbe`.

`!stats` grows a water line **only while wet**, so the normal prompt costs nothing:

```
- In water: SUBMERGED, Air: 13 / 20 [assist: auto, jump=true, boost=false] [physics.isInWater=true vel.y=0.027]
```

Those last three numbers are not decoration — see §5.

---

## 4. Invariants

1. **Pitch is not a movement input.** Vertical control is a **jump duty cycle**. Set pitch for
   the head and for `bot.dig`; never as a control.
2. **SwimAssist owns the jump key while the bot is wet.** Not `followPath`, not AutoJump (which
   early-returns in water), not the idle `clearControlStates` in `modes.js`.
3. **Assert the jump key against `bot.controlState.jump`, never a cached flag.** See §5.
4. **Its default mode is positive buoyancy.** Deliberate: the failure mode of a crash anywhere
   in the swimming code is a bot *floating*, not one on the seabed out of air.
5. **Rising is 7× faster than sinking** (+0.175 vs −0.025 b/t), so vertical control is a
   hysteresis band (`verticalIntent`), not a proportional controller.
6. **Never hop or dig while afloat.** Jump is buoyancy, not propulsion; mining and placing do
   nothing while floating, for the same reason pillaring does not.
7. **Judge a rise on measured progress, not on `airPocketAbove`.** Same invariant as walking.
8. **`isInWater` and `isInLava` share the same physics branch** and can both be true at a
   boundary. Every entry point refuses on lava; the boost requires `isInWater && !isInLava`.

---

## 5. Bugs found, and what they cost

Ordered by how long each hid. Every one was found by running it, not by reading it.

### 5.1 The jump key was never actually pressed

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

### 5.2 `!surface` and `mode:drowning` fought each other

Each interrupt sets `bot.interrupt_code`, which aborts the other's climb:

```
mode:drowning   interrupts  action:surface
action:surface  interrupts  mode:drowning
mode:drowning   interrupts  action:surface   ...
```

Observed at 2 hearts of drowning damage. Fixed on both sides — `drowning` carries
`excludeFromInterrupt: ["action:surface"]`, and `!surface` stands down when the mode is active.

### 5.3 A rise was judged on the block scan

`airPocketAbove` looks straight up from the **floored** position, so a bot whose 0.6-wide hitbox
is caught on a neighbouring block reads as "column open" while unable to ascend. The old code
held jump against the ceiling until the deadline, then reported `no_air_pocket` **with no
blocker to name**. `riseUntilBreathing` now gives up after 1.5 s without vertical gain and hands
over to the move-sideways and dig phases.

### 5.4 `oxygen()` returned negative values

`air_supply` keeps counting down past zero while drowning; it reached chat as `Air: -1 / 20`.
Now clamped to 0..20, with tests.

### 5.5 The anti-cheat valve tripped during spawn

`forcedMove` fires on **every** server position packet, including login and teleports. Counting
them unconditionally disabled the sprint boost before the bot had seen water. Only corrections
arriving *while boosting* count.

### 5.6 `setMode('off')` did not mean hands off

It skipped the buoyancy logic but still rewrote `liquidAcceleration` every tick, silently
overwriting the probe's own value — so a boost that works measured as "no effect". All three
boost phases read back SwimAssist's 0.026.

---

## 6. Sprint-swimming: ours, capped at vanilla parity

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

## 7. Navigator integration

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
- `followPath` holds sprint while wet and does **not** hop or dig; `arriveXZ` widens to 1.2
  because buoyancy makes the bot overshoot.
- `travelDirection` swims crossings up to `MAX_SWIM_LEG` (24) instead of bridging them.

See [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) for the rest of the cost model.

---

## 8. Known limitation — read before sending the bot under ice

**A bot that swims into a horizontal crevice under an overhang can be fully immobilised.**
`vel.y` is zeroed by collision above, and it is blocked horizontally too. It holds jump, cannot
rise, cannot slide out, and drowns. `unwedge` attempts a sideways shove but does not always free
it.

Reproduced three times at y≈53 in a frozen ocean during a deep `!swimTo` leg; each time the bot
had to be recovered with `!serverTp`. **Do not send the bot on deep `!swimTo` legs under an ice
sheet without supervision.**

Also unverified: the `surface()` fallback ladder's *dig-through-ice* phase has never succeeded
in the live world. It is covered by unit tests against a fake world only.
