# CLAUDE.md - Mindcraft AI Bot Framework

## Quick Reference

```bash
# Start/Stop
sudo systemctl restart mindcraft-andy    # Restart bot
sudo systemctl status mindcraft-andy     # Check status
tail -f /home/azureuser/mindcraft/logs/andy-service.log  # View logs

# RCON commands (mc alias)
mc "msg andy <message>"                  # Send message to bot
mc "give andy cobblestone 640"           # Give items
mc "tp andy 1500 65 -900"                # Teleport

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
| [docs/SWIMMING.md](docs/SWIMMING.md) | Water, diving, oxygen, SwimAssist, the `drowning` mode |
| [docs/LLM_FAILOVER.md](docs/LLM_FAILOVER.md) | The backup brain and the circuit breaker |
| [docs/WORLD_TOOLS.md](docs/WORLD_TOOLS.md) | Seed/biome lookup, operator teleport, gamemode, block states |
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

## Movement (IMPORTANT: do not "fix" by upgrading mineflayer)

Full story, measurements and bug list: **[docs/NAVIGATION_REBUILD.md](docs/NAVIGATION_REBUILD.md)**.

**The server is Minecraft 26.1 (protocol 775).** Its ping *name* string lies and says
`Purpur 1.21.11`, and `mcserver.js` regex-extracts the version from that name while ignoring
the protocol number. mineflayer caps at 1.21.11 (protocol 774), so the bot runs
one-version-stale collision data against a 26.x world.

**Upstream is blocked, not lazy.** Patching mineflayer's version gate works, but
`prismarine-chunk` has no 26.x chunk implementation in any release (latest checked: 1.41.0,
which ships only '1.0', '1.10', '1.20'). Do not sink more time into the version bump.

**`onGround` cannot be trusted here.** Traced directly: it reads false for seconds at a time
while the bot is provably standing (constant y, zero velocity), so prismarine-physics applies
no ground acceleration and the bot sits at `vel=(0,0)` with forward held. **Anything that
waits for `onGround` waits forever.** `followPath` pulses jump when progress stalls, because
airborne acceleration still works - that is what actually moves the bot. `mineflayer-pathfinder`
will not even *plan* a route over a 1-block step, so it simply stands still.

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

## Modes System

`modes.js`: drowning (air), self_preservation (health/hunger), unstuck (pathfinding), cowardice,
self_defense
Use `excludeFromInterrupt: ["action:fill"]` to prevent mode interruption during builds

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

## Web UI

- **MindServer**: http://localhost:8080 (set `mindserver_host_public: true` for LAN)
- **3D Viewer**: http://localhost:3000 (per agent: 3001, 3002...)
- **Map**: http://localhost:8090 (run `./regenerate_map.sh` first)

## Security

`allow_insecure_coding: true` enables `!newAction` (LLM code execution). Use Docker for safety.
