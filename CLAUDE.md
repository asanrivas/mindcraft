# CLAUDE.md - Mindcraft AI Bot Framework

## Quick Reference

```bash
# Start/Stop
systemctl --user restart mindcraft       # Restart bot
tailgate                                 # LIVE combined view: bot + server console
tail -f logs/service.log                 # Bot log only

# RCON server console (mc -> tools/rcon.mjs; password in ~/.config/mc-rcon.env)
mc "msg andy <message>"                  # Send message to bot
mc "give andy cobblestone 640"           # Give items
mc "tp andy 1500 65 -900"                # Teleport
mc "difficulty normal"                   # World state (set 2026-08-22; was Peaceful)

# Development
bun install && bun run main.js           # Start manually
npx patch-package [pkg]                  # Patch node_modules
```

## Documentation

`CLAUDE.md` is the short version of everything. The long version — measurements, the bugs behind
each rule, and what is still open — lives in **[docs/README.md](docs/README.md)**:

| Doc | When you need it |
|---|---|
| [docs/NAVIGATION_REBUILD.md](docs/NAVIGATION_REBUILD.md) | Anything about movement, the A\* planner, or the cost model |
| [docs/CLIENT_REPLACEMENT.md](docs/CLIENT_REPLACEMENT.md) | Why/how we're replacing mineflayer with an owned client, `src/mc/`, `settings.mc_client` |
| [docs/SWIMMING.md](docs/SWIMMING.md) | Water, diving, oxygen, SwimAssist, climbing out onto a bank, the `drowning` mode |
| [docs/MARATHON.md](docs/MARATHON.md) | `travelToward`, checkpoint marathons, route surveying, action ownership |
| [docs/LLM_FAILOVER.md](docs/LLM_FAILOVER.md) | The backup brain and the circuit breaker |
| [docs/WORLD_TOOLS.md](docs/WORLD_TOOLS.md) | Seed/biome lookup, operator teleport, gamemode, block states |
| [docs/CREATIVE_MODE.md](docs/CREATIVE_MODE.md) | Creative inventory, the web item picker, and the item-id check |
| [docs/TESTING.md](docs/TESTING.md) | Running the suites, and driving the live bot without corrupting your results |

Note `docs/` is gitignored — it does not travel with the repo.

## Architecture

```
main.js → MindServer (:8080) + AgentProcess → Agent
  Agent: Mineflayer bot + LLM client + ActionManager + Modes
```

**Data flow**: Chat → Conversation → LocalClassifier (optional) → LLM → Commands → Skills → Mineflayer

**Key dirs**: `src/agent/commands/` (actions.js, queries.js), `src/agent/library/` (skills.js, world.js), `src/models/` (providers), `bots/[name]/` (runtime state)

## Commands

**Building**: `!fill(blockType, x1, z1, x2, z2, y, height)` - Fill area with blocks, height for walls
**Movement**: `!goToPlayer`, `!followPlayer`, `!goToCoordinates`
**Water**: `!swimTo`, `!dive`, `!surface`, `!swimProbe`
**Combat**: `!shoot(mob, "bow"|"crossbow"|"auto")` - ranged, refuses players
**World**: `!worldSeed`, `!locateBiome(biome)`, `!serverGive`, `!serverGamemode`, `!serverSpawnpoint` - operator
**Resources**: `!collectBlocks`, `!craftRecipe`, `!getCraftingPlan`
**Storage**: `!putInChest`, `!takeFromChest`, `!depositAll`
**Info**: `!inventory`, `!stats`, `!surroundings`, `!scanArea`

Aliases: `!ca`→fill, `!cb`→collectBlocks, `!cr`→craftRecipe, `!gcp`→getCraftingPlan, `!inv`→inventory

## Adding Commands

```javascript
// In src/agent/commands/actions.js
export const myCommand = {
    name: "!myCommand",
    description: "Description for LLM",
    params: { "arg1": {type: "string", description: "..."} },
    perform: async (agent, arg1) => { return "result"; }
}
// Register in index.js: actionsList = [..., myCommand]
```

## Configuration

**settings.js**: `host`, `port`, `max_messages`, `command_docs_mode` (full/compact/minimal)
**andy.json**: `model` config, `conversing` prompt, `saving_memory` prompt

**Prompt placeholders**: `$STATS`, `$INVENTORY`, `$MEMORY`, `$COMMAND_DOCS`, `$EXAMPLES`

## LLM Providers

18+ providers auto-discovered. Config: `{"api": "foundry", "model": "claude-sonnet-4-5", "url": "..."}`
Azure Foundry: URL ends with `/anthropic/`, key: `AZURE_FOUNDRY_API_KEY`

**copilot-mem0** (`src/models/copilot_mem0.js`): GitHub Copilot + Claude + Mem0 cloud memory
- Token priority: 1) `~/.openclaw/credentials/github-copilot.token.json`  2) exchange `GITHUB_TOKEN` PAT
- Calls `https://api.githubcopilot.com/chat/completions` (OpenAI-compatible, vscode-chat integration)
- Models: `claude-haiku-4.5`, `claude-sonnet-4.5`, `claude-opus-4.5/4.6`, `gpt-5`, `gpt-5-mini`, `gemini-3-flash-preview`
- **Tiered routing**: set `"model": "tiered"` — haiku classifies complexity, routes to haiku/sonnet/opus
  - `simple` → haiku  (greetings, status, follow/stop)
  - `medium` → sonnet (crafting, mining, navigation, small builds)
  - `hard`   → opus   (large builds >20 blocks, multi-step plans, complex strategies)
  - Override via params: `tier_router`, `tier_simple`, `tier_medium`, `tier_hard`
- Augments every request with Mem0 semantic memory; stores conversation + events (user + system pool)
- Event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) match `Mem0Local` interface
- Profile: `profiles/copilot.json` | Keys needed: `MEM0_API_KEY` (+ `GITHUB_TOKEN` if openclaw token expired)

### Backup brain (failover when the local LLM is down)

Andy's primary model is a local llama-server reached over an SSH tunnel from a Windows box.
When that box sleeps or the tunnel drops, every request used to fail and Andy answered
`"My brain disconnected, try again."` forever. It now fails over to a cloud model.

```jsonc
// andy.json
"backup_model": { "api": "fireworks", "model": "deepseek-v4-flash-0731",
                  "params": { "max_tokens": 1024, "reasoning_effort": "low" } },
"backup_cooldown_secs": 60   // how long to stop dialling a primary that failed
```

`backup_model` takes one profile or an ordered list (tried left to right).
Key: `FIREWORKS_API_KEY`. Measured latency: **~1.4s**.

**`src/models/fallback.js` is the only place that decides "the model is down".** Providers
just throw; `FallbackModel` classifies the error, routes, and guarantees `sendRequest` always
resolves to a string - `promptCoding`/`promptMemSaving` in `prompter.js` have **no try/catch**,
so a rejection there propagates into the agent loop.

- A plain circuit breaker: an *availability* error (ECONNREFUSED, timeout, 5xx, socket hangup)
  opens it, so the next 60s of turns skip the dead primary instead of paying a connect timeout
  each turn. After the cooldown the primary is tried first again and recovery is automatic.
- Other errors (a 400, an empty completion) also fail over but do **not** open the breaker -
  the primary is still reachable, so keep using it.
- If every backup fails, the primary is retried once as a last resort before giving up.

Two provider changes this required: `llamacpp.js` and `fireworks.js` used to *swallow* errors
and return the "brain disconnected" placeholder. A placeholder reads as **success** and stops
the chain, so both now throw. `llamacpp.js` also gained a 120s timeout (`maxRetries: 0`) -
without one, a half-open tunnel hangs forever and the backup is never reached.

`!stats` grows a `- Brain: BACKUP (...)` line **only while failed over**, so the normal prompt
costs nothing. Without it the only symptom of an outage is that Andy suddenly writes differently.

Tests: `bun tests/fallback.test.mjs` (fakes, no network). Verified live against a genuinely
dead local server, and recovery verified with real sockets: down -> backup, back up but inside
cooldown -> still backup, after cooldown -> primary.

## Movement (the "version mismatch" was a myth - see below)

Full story, measurements and bug list: **[docs/NAVIGATION_REBUILD.md](docs/NAVIGATION_REBUILD.md)**.
Investigation that overturned the diagnosis: **[docs/CLIENT_REPLACEMENT.md](docs/CLIENT_REPLACEMENT.md)**.

### THE SERVER IS 1.21.11. There is no version skew. (Established 2026-08-23, with evidence.)

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

**`onGround` cannot be trusted here.** Traced directly: it reads false for seconds at a time
while the bot is provably standing (constant y, zero velocity), so prismarine-physics applies
no ground acceleration and the bot sits at `vel=(0,0)` with forward held. **Anything that
waits for `onGround` waits forever.** `followPath` pulses jump when progress stalls, because
airborne acceleration still works - that is what actually moves the bot.

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

### The stack we run instead

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

### Cost model - the tuning surface

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

### Geometry gotchas - do not "simplify" these away

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

### Cliffs, caves and water

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

### Swimming, diving and oxygen

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

#### Measured, not assumed (`!swimProbe`, 7-block-deep water, 5 runs)

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

#### The pieces

| File | What it does |
|---|---|
| `library/swim.js` | `inWater`, `isSubmerged`, `inLava`, `oxygen`, `waterSurfaceY`, `airPocketAbove`, `nearestOpenColumn`, `deepestWaterNear`, `swimTo`, `dive`, `surface`, `swimForward`, `verticalIntent` |
| `library/swim_assist.js` | Always-on: buoyancy + the sprint-swim boost. Modelled on `auto_jump.js` |
| `library/swim_probe.js` | `!swimProbe` - the measurement harness above |
| `modes.js` -> `drowning` | First in `modes_list`. Surfaces before the air runs out |

Commands: `!swimTo(x,y,z)`, `!dive(depth)`, `!surface`, `!swimProbe`. `!stats` grows an
`In water: SUBMERGED, Air: 13 / 20` line **only while wet**, so the normal prompt costs nothing.

#### Invariants - read before changing this

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

#### WADING is not AFLOAT - and conflating them paralyses the bot completely

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

#### A bot at the WATER SURFACE cannot rise at all

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

#### Sprint-swimming is ours, and it is capped at vanilla parity

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

#### Bugs found by running it in survival - read these before touching SwimAssist

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

#### The drowning safety net was blind - `bot.oxygenLevel` does not update here

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

#### Climbing out of the water onto a bank

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

#### Traps this cost real time

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

### Tools and modes

`mineflayer-tool` is **not** loaded (see the `loadPlugin` list in `utils/mcdata.js`), so
`bot.tool.equipForBlock` throws. It was being called unguarded in `collectBlocks`. Use
`tools.js` -> `equipBestTool` / `digWithTool` instead.

**Never substring-match block names.** `"sandstone".includes("sand")` is true, and sandstone
does not fall. That exact bug made `self_preservation` fire every tick in a desert. The
canonical test lives in `tools.js` as `isFallingBlockName`; do not re-derive it locally.

**Mode `execute()` must pass a timeout.** With the default `-1`, a mode action that cannot
finish pins `currentActionLabel` forever and *no action can ever start again*. Combined with
the substring bug above, one trigger left the agent frozen on `mode:self_preservation` at full
health for 11 minutes. `self_preservation` now digs falling blocks out
(`skills.clearFallingBlocksAbove`) instead of fleeing, and `moveAway` uses our navigator.

### Finding places by seed

`!worldSeed` and `!locateBiome("frozen_ocean")` ask the **server**, via `bot.chat('/seed')` and
`/locate biome`. That uses the real world generator, so the answer is exact for this seed -
better than reproducing the biome maths against a minecraft-data copy that does not understand
26.1. Both need operator permission. `runServerCommand` (actions.js) sends the command and waits
on `messagestr` for a matching line, with a timeout so a missing permission cannot hang.

**It must skip player chat.** The agent narrates every command it runs (`*asanrivas used
worldSeed*`), and that echo matched the reply pattern before the real answer arrived - so the
first version returned Andy's own announcement as the server's response.

This world (seed `-5277008537596457581`):

| biome | x | z |
|---|---|---|
| ice_spikes | 2592 | 45 |
| frozen_river | 2560 | -51 |
| frozen_ocean | -2592 | 5293 |
| deep_frozen_ocean | -416 | -691 |

### Rescue teleport
`!serverTp(x, y, z)` exists only to recover a bot that terrain edits have sealed underground.
It refuses unless `bots/<name>/ALLOW_RESCUE_TP` exists, and **deletes the marker on use**, so
the model can never call it to skip a journey. Arm it by hand:
`touch bots/andy/ALLOW_RESCUE_TP`.

### Driving long journeys
Issue **one leg at a time** and wait for the `VERIFIED TRAVEL` line before sending the next.
An earlier driver re-sent `!travel` on a fixed timer and spent 97 minutes interrupting its own
in-flight leg - which reads as "the bot is stuck" when it is not. Also avoid large
`!serverFill` operations near the bot: those repeatedly dropped it into pits, buried it in
sand, and opened a cave under it.

### Checkpoint marathons

```
!marathonPlan(6, 1000, 30)   # 6 checkpoints on a ring, <=1000 blocks of route, ring rotated 30 deg
!marathonRoute("4412,4934 4362,5021 ...", 1000)   # explicit, surveyed checkpoints
!marathonRun                 # run it, resuming wherever a previous run stopped
!marathonStatus              # per-checkpoint ledger
!marathonReset
```

**Prefer `!marathonRoute` once you have surveyed the ground.** A regular ring is convenient and
often wrong: around (4312, 4934) on this world, *no* rotation of a hexagon at radius 100 or 120
puts all six vertices on dry land - two separate lakes sit in the way. `ring2.mjs`-style
surveying (see the RCON recipe below) reports which start angles are all-land, and when none
are, hand-pick six land bearings and feed them in. Verify the **midpoints** too, not just the
vertices: the first attempt had every checkpoint on land and a lake across leg 5-6.

**One action owns the whole route.** That is the point: the "one leg at a time" discipline above
is what a *person* has to do when driving `!travel` from chat, and it is exactly what the 97
minute self-interrupting driver got wrong. `runMarathon` knows a leg is finished because it
measures the bot's XZ distance to the checkpoint, not because a timer fired, and it writes
`bots/<name>/marathon.json` after every checkpoint - so a crash, a restart or a mode interrupt
resumes at checkpoint 4 instead of at the start.

- **Arrival is judged on XZ only.** The checkpoint's Y is unknown when the route is drawn: the
  chunk is not loaded, so there is no surface height to aim at. The bot records the Y it
  actually arrived at.
- `planLoop` solves the ring radius from the straight-line budget -
  `total = R + (count-1) * 2R * sin(pi/count)` - and `!marathonPlan` **refuses** rather than
  quietly overspending it.
- `startAngleDeg` rotates the ring, because terrain is not isotropic. Around (4337, 4891) the
  R=160 ring is land at every 30-degree bearing except 45/60/75 and 285; starting at 30 puts all
  six vertices on dry ground. Survey before planning - see the RCON probe recipe below.
- Nothing here teleports. `!serverTp` deletes its own arming marker precisely so a route cannot
  be shortcut, and the marathon must never touch it.

**`skills.travelToward(bot, x, z, opts)`** is the engine, and `travelDirection` is now a thin
wrapper over it. It is the same tuned recovery ladder (swim the river, walk around the ridge,
stair up the cliff, trench the dune, sidestep the build) with one thing generalised: the
heading. Two headings, deliberately:

- **steering** uses a true unit vector toward the target;
- **digging** quantises it to the nearest of eight (`nearestCompass`), because every block-level
  helper indexes blocks as `p + d*n` and a fractional `d` reads the wrong column.

Progress along the leg is now a **signed** projection. The old form was `|dx|*|dx_moved| +
|dz|*|dz_moved|`, which scored a step backwards exactly like a step forwards.

Measured on this world, 2026-08-26, on ground that suits it: **48 blocks per navigator leg in
12s**, and checkpoint 1 of a surveyed route reached in **34 seconds over 84 blocks with 0 blocks
mined** - roughly 150 blocks/min, against the ~25 blocks/min this doc records for the old
axis-locked travel. On bad ground the same code covered 3 blocks in 20 minutes; the difference
is entirely whether the route puts the bot in water (see the wading section under Swimming).

**Surveying a route before you draw it** (RCON, no bot needed):
`forceload add <x> <z>` then `execute if block <x> <y> <z> air` -> "Test passed"/"Test failed".
Scan the column **downward**; do not bisect. Columns are not monotonic here - caves and ravines
put air under stone - and a bisection over [-64, 250] converges on a cave roof 50 blocks below
the real surface. Use ONE persistent RCON connection: reconnecting per command stalls the
server after ~13 rapid cycles, and `socket.setTimeout` does not fire on it.

## Creative mode

Full story: **[docs/CREATIVE_MODE.md](docs/CREATIVE_MODE.md)**.

`!creativeGive(item, count)`, `!creativeKit(building|mining|survival|all)`, `!creativeClear`,
`!creativeStatus`, `!creativeIdSweep`. A web item picker lives behind the **Items** button on
each agent card (`public/js/creative-panel.js`) and composes those same commands.

- **mineflayer DOES support creative inventory.** `bot.creative` is a core auto-loaded plugin.
  No `/give`, no operator permission, no chat round-trip.
- **Every creative command refuses outside creative mode**, so the survival work stays honest.
- **Never pass `waitTimeout: 0` to `setInventorySlot`.** mineflayer leaks its per-slot busy flag
  on that path and every later write to that slot throws for the life of the process. It bricked
  all 37 slots once. `WRITE_ACK_MS = 60` is a correctness constant, not a tuning knob.
- **Item ids ride the wire as numbers**, resolved from 1.21.11 tables against a 26.1 server. A
  registry shift would silently produce the wrong item and **no in-process check can see it** —
  the server sends no ack, so our own echo confirms itself. Verify server-side by NAME:
  `!creativeIdSweep` then `mc "clear andy <item> 0"`. Swept 2026-08-23, ids 150–1458, all correct.
- **RCON truncates long NBT.** `data get entity andy Inventory` cut off at ~120 chars and made a
  full bag look empty, which read as a bug in working code. Use `clear <player> <item> 0`.

## World-edit guards (do not route around these)

`!serverFill` / `!serverSetblock` refuse edits that would:
- **destroy an irreplaceable block** - beds, chests, furnaces, spawners, doors, signs... (`world_guard.js` `PROTECTED_*`)
- **entomb the bot** - a solid fill over the cells its own body occupies
- **overwrite its respawn point**

Escape hatches exist and are separately named: `!forceFill`, `!forceSetblock`. They report what
the guard would have said, so an override is never silent.

**Why this exists.** One night, two unguarded edits cost everything:

```
11:40:25  !serverSetblock("snow_block", -2572, 63, 5269)   <- its own bed, "making a path to the bed"
11:44:51  !serverFill snow_block -2573 63 5268 -> -2571 65 5270   <- solid, over itself
```

Losing the bed silently moved the respawn to world spawn. The next death teleported the bot
**7000 blocks away** at night, where it died again and lost its inventory. A model cannot see
that the cell it is overwriting holds the thing its life depends on - **so the edit has to
notice, not the prompt.**

`bot.spawnPoint` is `(0,0,0)` until a `spawn_position` packet arrives; the guard treats that
placeholder as "unknown" rather than refusing every edit near world origin.

## Modes System

`modes.js`: drowning (air), self_preservation (health/hunger), unstuck (pathfinding), cowardice,
self_defense
Use `excludeFromInterrupt: ["action:fill"]` to prevent mode interruption during builds

**Every `execute()` call site must pass a timeout.** The parameter defaults to `-1`, which means
no timeout, and a mode action that cannot finish then pins `currentActionLabel` forever - after
which no action can ever start again. Nine call sites were missing one (2026-08-26);
`tests/modes.test.mjs` now fails the build if a new one appears.

**`night_safety` stands down whenever sheltering cannot pay for itself.** It interrupts every
action in the agent, so a needless trigger cancels whatever the bot was asked to do - observed
killing a user's marathon 12 seconds after it started. It now skips when:

- **the world is Peaceful** (see below);
- **a person is online and awake** - the bot cannot skip the night alone, since vanilla needs
  every player in bed, so digging in changes nothing about when morning comes and costs the bot
  the night. Other agents deliberately do NOT count, or two bots each stop because the other is
  "online";
- **it is already deep underground** (>8 blocks below the surface);
- **it is already under a roof** - a dungeon, a building, a shallow cave, an overhang. The depth
  test alone misses a bot standing inside a room at surface level, which then digs a hole in the
  floor of a structure it was already safe in.

All of these sit AFTER the dawn dig-out branch, so a bot sealed in last night is always let out.

**`bot.game.difficulty` is a lie on Peaceful worlds - mineflayer bug.** `lib/plugins/game.js`
assigns it with `if (packet.difficulty)`, and **peaceful is 0, which is falsy** - so on a world
that was already Peaceful when the bot logged in, the field is NEVER set and reads `undefined`.
Every guard written against it fails open. That is exactly how the Peaceful check below appeared
to work and did not. `agent.js` now re-reads the `login` and `difficulty` packets itself with a
`!= null` test. If you add a difficulty check anywhere, do not trust the raw field.

**`night_safety` does nothing on Peaceful.** Nothing hostile spawns, so a night shelter costs a
whole night and buys nothing - and because the mode interrupts everything, it was a pure tax on
any long journey. The check sits *after* the dawn dig-out branch on purpose: a bot that sealed
itself in while the world was on Normal must still be let out if the difficulty is lowered
overnight. (This is also what `bob.json` was working around by shipping the mode off.)

**Mode log lines are prefixed with the agent name.** Both bots share `logs/service.log`, and an
unattributed `Mode drowning finished executing` cannot tell you which bot is wet - or that only
one of them is. `mode:drowning` also logs air/submerged/inWater/pos at the moment it fires,
because it interrupts every action in the agent and a spurious trigger is expensive.

### The model does not get to cancel what a person asked for

`agent.actions.isUserOwned()`. Observed live: a user typed `!marathonRun`, and six seconds later
the model's own next turn emitted `!travel("west", 500)` from a stale conversational thread. That
cancelled the marathon and walked the bot 290 blocks in the *opposite* direction, and nothing in
the log named what had been cancelled.

- `ActionManager` records `action_author` ('user' / 'model' / 'mode') for the running action, and
  `resume_author` so a resumed leg is still the user's.
- `agent.js` refuses a **model-emitted action** while a user-owned action is running. Queries are
  untouched, so the model can still `!stats` and answer questions about what is happening.
- **Modes are deliberately exempt** - they pass `author: 'mode'`, so drowning and self-defence
  still interrupt everything, including a user's marathon.

`tests/action_owner.test.mjs` covers all four cases, including the leak that would make a safety
mode inherit "user" and become uninterruptible itself.

### A mode must PAUSE an action, not END it

Reported as *"Andy stops following me when torch placement is enabled."*

`mode:torch_placing` lists `action:followPlayer` in its `interrupts`, so it stops the follow,
places a torch, and completes **cleanly**. The clean-completion branch of `_executeAction` then
called `cancelResume()` **unconditionally** - wiping the resume state that belonged to
`followPlayer`, not to the mode. So the follow *ended*. `should_reprompt` fired an
`(AUTO MESSAGE) your previous action was interrupted`, and the model guessed its way through
`!goToPlayer` -> `!navTo` (0 args) -> `!entities` -> `!lookAtPlayer` without ever resuming.
Every ~5 seconds, in daylight, until the user gave up. Andy diagnosed it himself and turned the
mode off twice.

**A resume belongs to whoever registered it.** A mode is a transient interruption, not a new
intent - that is the entire reason `resume` exists. The cancel is now conditional on the
completing action owning the resume, unless the caller is a real command (a new user/model
command IS a change of intent). Both the clean path and the `catch` path carry it -
`torch_placing` throws routinely when `placeBlock` hits an occupied cell.

Do not simply drop the unconditional cancel: it was fixing the opposite bug. A finished action
that leaves resume state behind is replayed by the idle handler every tick, and a `!navTo` to
the bot's own position re-ran every second for hours. Both directions are tested.

**And `torch_placing` should not have been firing at all.** `world.shouldPlaceTorch` carried a
`// TODO: check light level instead of nearby torches, block.light is broken` and was gated only
on "no torch within 6 blocks" - so it fired in a bright desert at dawn. `block.light` really is
broken, but the CHUNK light data is fine and synchronous: **`bot.world` is prismarine-world's
`.sync` view**, which exposes `getBlockLight` and `getSkyLight`. Verified live on this server:
a surface block reads `block=0 sky=14 timeOfDay=17697`.

- **Sky light is stored UNSCALED** - a surface block reads 15 at midnight exactly as at noon,
  because the client applies the time-of-day factor. So sky light alone cannot tell you whether
  daylight is reaching a block; it has to be paired with `bot.time.timeOfDay` (night is roughly
  13000-23000). Getting this wrong disables torches underground or re-enables the desert spam.
- **An unloaded chunk returns 0 from both getters**, which is indistinguishable from a pitch-dark
  cave. The check **fails OPEN** - missing accessor, throw, or unloaded column all fall back to
  the old behaviour rather than silently disabling a mode.
- The decision is the pure `world.torchIsWorthIt(blockLight, skyLight, timeOfDay)`, so all four
  quadrants are unit-tested (`tests/torch.test.mjs`) - a live check only ever exercises whichever
  one the world happens to be in.

### `await` is not a yield - followPlayer spun until the server dropped the bot

Reported as *"died in water during follow"*. **The bot did not drown - the server timed the
client out**: `andy lost connection: Timed out`, 70s into a follow.

`followPlayer` has a swim branch because mineflayer-pathfinder cannot follow anyone underwater
(two literal `if (blockC.liquid) return // dont go underwater` guards in
`mineflayer-pathfinder/lib/movements.js:541,561`). That branch ended in a bare `continue` that
deliberately skipped the 500ms poll - "a diver moves faster than that". But every await on its
fast paths is a **microtask**: `swimTo` returns `arrived` on its first iteration when already
inside `arrive`, having awaited only `bot.look(..., force)` - which returns *before*
`lookingTask.promise` (`mineflayer/lib/plugins/physics.js:329`), and earlier still on a zero
delta - and `swimTo`'s lava refusals await nothing at all. A loop of pure microtasks never lets
the event loop reach its timer/IO phases, so the socket goes unread and unwritten.

**Trigger is entirely ordinary: stand in water within `follow_dist` of the bot.**

Fixed in both places, because the primitive must be safe for any caller: `swimTo` now yields one
`tickMs` before any exit is reachable, and `followPlayer`'s swim branch always awaits
`SWIM_POLL_MS` (100ms) and skips the pointless `swimTo` when already at follow distance.
`tests/swim.test.mjs` schedules a `setTimeout(...,0)` and asserts it fired before `swimTo`
resolved.

**`SwimAssist owns the jump key` applies to `agent.js` too.** The `bot.on('idle')` handler called
`bot.clearControlStates()` unguarded - it fires after *every* action completes, which is most of
the time a floating bot is idle at all - and jump is buoyancy, not a movement input. It now
carries the same `!swim.inWater(bot)` guard that `self_preservation`'s idle branch already had.

## Memory

**Active systems:**
- `bots/[name]/memory.json`: Named chest locations (loaded on startup via ChestMaster, always active)
- `MemoryBank` (`src/agent/memory_bank.js`): In-memory spatial store for `!rememberHere`/`!goToRememberedPlace` — lost on restart
- `src/models/mem0_local.js`: Mem0 cloud integration (sdk: `mem0ai`, key in `keys.json`) — **NOT active**: only loads when `"api": "mem0"` in profile; Andy uses `"api": "azure"`

**Active (openclaw-style):**
- `use_memory_saving: true` in `andy.json` — when `max_messages` (30) is hit, oldest turns are distilled by LLM into structured memory (Goal/Locations/Lessons/Players sections, max 1000 chars)
- `load_memory: true` in `settings.js` — memory + saved_places restored from `memory.json` on every restart
- `$MEMORY` injected into `conversing` prompt — Andy always sees its curated memory in every response

**To enable Mem0:** Change `andy.json` model to `"api": "mem0"` and set model/url to Azure Foundry endpoint. Mem0 event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) are already wired in `agent.js` and `actions.js` — they become active automatically.

### Ending a goal - there are TWO of them

`!endGoal` used to stop only the self-prompt LOOP. The goal ALSO lives as a record in the typed
memory store, which renders into `$MEMORY` - injected into **every** conversing prompt. So a
goal the user had verbally ended was handed back to the model on every turn and it kept resuming
the work, and `load_memory` restored it after a restart. On disk:

```
memory.json        self_prompt: null, self_prompting_state: 0     <- the loop really did stop
memory_store.json  goal:current "Mine minerals below the base..." <- still there, origin "user"
```

Worse, a **user-origin** goal is immune to agent writes and deletes by design
(`memory_store.js`), so the model could not drop it either - that is the
`[History] memory store rejected 1 agent write(s)` line. `setUserGoal` had one caller and no
counterpart, so nothing anywhere could clear it.

- `!endGoal` now also calls `history.clearGoal(by)`. **Authority is asymmetric**: from a user it
  deletes the record; from the model it stops the loop only and says so, because the model must
  never be able to erase what a person asked for. Same rule `!goal` already uses.
- **Memory summarisation must not mint goals.** `importLegacyBlob` takes `allowGoal`, defaulting
  to **false**, and only the one-time legacy migration passes true. Without that the fix above
  lasts about one summarisation: the summariser is an LLM writing markdown under a template that
  literally contains a `## Goal` header, so it re-created the cleared goal out of the very turns
  in which it was ended. The store already refused to let the model OVERWRITE a user's goal;
  nothing stopped it INVENTING one where none stood.
- A goal is a **directive**, not a memory. It arrives through `!goal` or not at all.

## Andy notices when he is teleported

Nothing consumed `forcedMove` at all outside the swim code, so `/tp andy asanrivas` left the bot
carrying on toward wherever it had been walking - the in-flight leg keeps its original target,
so it walks straight back. Observed: `/tp andy asanrivas` at 00:22:57 and 00:36:28, each time
followed by the bot heading back for a base 7000 blocks away.

`agent._wireTeleportDetection()` samples position every physics tick and, on `forcedMove`,
compares. **The threshold is the whole design.** `forcedMove` fires on EVERY server position
packet - login, respawn, and the routine anti-cheat corrections this server sends constantly
(counting them unconditionally is what tripped SwimAssist's boost valve during spawn). Only
distance separates a correction from a teleport: `TELEPORT_MIN_BLOCKS = 8`.

On a real teleport it **cancels the running action AND its resume** - cancelling the action
alone is not enough, because the idle handler replays the resume and the bot walks back anyway -
then tells the model where it was moved from and to, and not to walk back.

Suppressed for: the login packet (5s grace), respawn (`expectTeleport` from the death handler),
`!serverTp` (which would otherwise cancel its own rescue), and `cheat` mode. Repeated moves
coalesce into one message. The decision is the pure `teleportVerdict()`, so every branch is
tested - the ones that must NOT fire matter more than the one that must.

Verified live: `TELEPORTED 230 blocks (3393, 62, -1797) -> (3601, 80, -1700) during
action:navTo`, 1 detection and 0 false positives.

## Steering (user-authored standing instructions)

Give Andy standing instructions that shape how it talks and acts. They persist across restarts
and are injected into every prompt.

```
!steer("be brief, no questions")   # add a directive
!steering                          # numbered list of active directives
!unsteer(2)                        # remove #2
!unsteer("all")                    # clear them all
```

- Stored in `bots/<name>/steering.json`, loaded in `agent.js` **before** the first prompt is
  built, so the first reply after a restart is already steered.
- Rendered by `steering.js` -> `render()` into the `$STEERING` placeholder, which sits **late**
  in the `conversing` prompt (after `$SELF_PROMPT`, just before `Conversation:`). Late on
  purpose: recency is where small models follow instructions most reliably.
- **Bounded on purpose**: 8 directives, 120 chars each, 600 chars total. Small models sit on the
  exponential decay branch of instruction following, so an unbounded list would quietly degrade
  the rules that already matter.
- **Not model-writable in autonomous mode.** `!steer`/`!unsteer` refuse while `self_prompter` is
  active. Relaying a user's request is the point of the command; a self-prompting loop rewriting
  its own standing instructions is the same self-corruption that wrecked `history.memory`.

Distinct from `$MEMORY`: memory is written BY the model and drifts; steering is rendered
verbatim and is never summarised or re-ingested.

**How well it works depends on the directive.** A mechanical instruction is followed reliably
(verified: "always end your reply with BANANA" -> every reply ended with BANANA, and stopped
once removed). A *stylistic* one competes with the numbered rules: "keep replies to one short
sentence" was initially ignored because rule 9 tells Andy to be proactive and offer next steps.
`render()` now states explicitly that steering overrides those rules, which shortened replies
substantially but not to the letter. This is a 9B local model - treat steering as a strong
nudge, not a hard constraint, and prefer directives that add or remove a concrete behaviour over
ones that fight an existing rule.

## Common Issues

| Issue | Fix |
|-------|-----|
| Command 0 args | Check quote format (use ASCII `"` not curly `"`) |
| embed not function | Check embedding model has `embed()` method |
| Bot stuck | Check modes.js unstuck, reduce area size |
| Vision blank | Expected in Docker/headless |

## Recording a run (bird-view timelapse)

```bash
bun tools/setup_viewer_assets.mjs          # once, and after every `bun install`
# settings.js: viewer_first_person: false  # then restart the bot
bun tools/timelapse.mjs --seconds 1800 --interval 5   # --height defaults to 16
# -> recordings/timelapse-3000-<timestamp>.mp4  (recordings/ is gitignored)
```

**The viewer renders the wrong blocks out of the box.** prismarine-viewer ships textures and
block states only up to **1.21.4**, and its prebuilt browser bundle only carries minecraft-data
for those versions - against this 1.21.11 server that is **107 block types** rendering as the
wrong block or vanishing: pale oak (every variant), copper chest, copper golem statue, firefly
bush, cactus flower, leaf litter, wildflowers, dried ghast, dry grass, the whole shelf family.

`tools/setup_viewer_assets.mjs` fixes it, and it is idempotent. What it does, and why each step
is needed:

1. Fetches `minecraft-assets` into `.viewer-assets-cache/` - kept OUT of the project's own
   dependencies because it unpacks to ~142MB.
2. Builds the atlas and block states. It must NOT call `require('minecraft-assets')('1.21.11')`:
   that package's own version table stops at 1.21.8, so it silently returns the **1.21.8**
   directory. The real `data/1.21.11` exists on disk and the generators only need
   `directory`, `blocksStates` and `blocksModels`, so the script builds that object itself.
3. Registers the version in `viewer/lib/version.js`.
4. Patches `lib/index.js` to expose `window.pv` - see below.
5. **Rebuilds the browser bundles.** This is the step that is easy to miss: adding the version
   without rebuilding gets you `Using version: 1.21.11` followed by
   `Error: Do not have data for 1.21.11` and a null world - the viewer renders *nothing*, which
   is worse than wrong textures. The worker bundle grows 63MB -> 121MB and takes ~4.5 min; the
   index bundle alone is ~6s.

**Everything above lives in `node_modules`, so `bun install` wipes it.** Re-run the script.

### Why the timelapse tool needs `window.pv`

The client keeps `viewer` and `controls` as module locals, and in third person it aims
`controls.target` at the bot **only on the first position update** - so a headless screenshotter
has no way to place the camera, and the bot walks out of frame within seconds. The patch exposes
the scene graph and tracks the latest position, and `birdCam(height)` parks the camera directly
overhead. That is what makes it a follow-cam instead of a fixed shot of the starting point.

`viewer_first_person` (settings.js) must be **false**: first person makes the client *dispose*
the OrbitControls the camera driver depends on. It defaults to true because `!vision` screenshots
this same viewer and wants the bot's own eyes - so flip it for a recording run and flip it back.

**Cost.** Headless Chromium has no GPU here, so the viewer's WebGL runs on SwiftShader at about
**6.7 of this machine's 8 cores** while the scene renders. That is why frames are taken on an
interval, not continuously. Shorten `--interval` only while watching server tick health.

**The efficient path is closed.** prismarine-viewer has a proper headless renderer
(`lib/headless.js`, node-canvas-webgl straight into ffmpeg, no browser) - but it needs `gl`, a
NAN native module, and this project runs on **bun**, where `node` on PATH is bun's shim. It dies
with `undefined symbol: _ZN2v816FunctionTemplate16InstanceTemplateEv`. Only real Node would fix it.

Measured: 15 frames at 960x600 -> 2.0MB MP4. Entity models are still 1.16.4 only (a separate
prismarine-viewer limitation) - blocks are correct, mobs may not be.

## Web UI

- **MindServer**: http://localhost:8080 (`mindserver_host_public: true` is set, binds 0.0.0.0)
- **From a phone via Twingate**: connector `twingate-abiding-jerboa` runs on this host
  (network=host). Add a Resource in the Twingate admin for this machine (`cbx3` / LAN IP)
  with ports 8080 + 3000, assign it to your user, then open http://cbx3:8080 in the phone's
  browser with the Twingate app connected. (Tailscale was tried first and torn down.)
- **3D Viewer**: http://localhost:3000 (per agent: 3001, 3002...)
- **Map**: http://localhost:8090 (run `./regenerate_map.sh` first)

## Security

`allow_insecure_coding: true` enables `!newAction` (LLM code execution). Use Docker for safety.
