# CLAUDE.md - Mindcraft AI Bot Framework

**This file keeps the RULES. `docs/` keeps the EVIDENCE.** A rule here is an imperative you must
obey; the measurement, the incident and the reasoning that produced it live in the linked doc. If a
rule looks arbitrary, read the doc before "simplifying" it — most of them were paid for by a bot
that froze, drowned, dug a canal, or walked 7000 blocks the wrong way.

**This file is short ON PURPOSE.** Rules buried past a few hundred lines do not get followed:
`food_supply` reproduced the fixed-beat-retry bug **53 times** while its cure was already written
here, at roughly line 1400 of 1900. If your addition runs past a few lines, it belongs in `docs/`
with a pointer from here. And **anything here that could be an assertion probably should be** — a
test is stronger than a paragraph, and the prose then only explains why the assertion exists. What
stays here is the class of rule no test can hold: live-state distinctions, discipline in reading
output, and coordination between sessions.

## Read this first — you are not alone in this repo

**THREE Claude sessions share this working copy and ONE live Minecraft world.** Treat every shared
resource as contended:

- **Announce before `systemctl --user restart mindcraft`** — it restarts BOTH bots and kills
  whatever the other sessions are measuring.
- **Announce before any world-modifying RCON command** (`fill`, `setblock`, `tp`, `give`,
  `difficulty`, `time set`). Another session's gym run is somebody's evidence.
- **Partition files.** Do not edit a file another session is live in. Say which files you own.
- **`package.json`'s `test` script is a single line every session edits.** Concurrent writes
  silently dropped **four suites**. Never hand-edit it — regenerate it from
  `glob('tests/*.test.mjs')` so a lost suite is impossible rather than merely unlikely. (53 suites /
  53 files as of 2026-08-31; if those numbers disagree, a write was lost.)

## Quick Reference

```bash
systemctl --user restart mindcraft       # ANNOUNCE FIRST - restarts BOTH bots
tailgate                                 # LIVE combined view: bot + server console
tail -f logs/service.log                 # Bot log only
bun install && bun run main.js           # Start manually
bun run test                             # All unit suites (no server needed)
npx patch-package [pkg]                  # Patch node_modules

# RCON server console (mc -> tools/rcon.mjs; password in ~/.config/mc-rcon.env)
mc "msg andy <message>"                  # Send message to bot
mc "give andy cobblestone 640"           # Give items
mc "tp andy 1500 65 -900"                # Teleport
mc "difficulty"                          # READ it - do not assume; it has changed 3x unannounced
```

**RCON: use ONE persistent connection.** Reconnecting per command stalls the server after ~13 rapid
cycles, and `socket.setTimeout` does not fire on it.

**NBT reads over RCON are unreliable.** `data get` truncates long values (~120 chars — a full
inventory read as empty, which looked like a bug in working code) and keys move between versions:
the respawn point is a `respawn` **COMPOUND** in 1.21.11, not `SpawnX`/`SpawnY`/`SpawnZ`. Verify by
name instead: `mc "clear andy <item> 0"`.

## Documentation

| Doc | When you need it |
|---|---|
| [docs/README.md](docs/README.md) | The index, and the recurring lessons list |
| [docs/NAVIGATION_REBUILD.md](docs/NAVIGATION_REBUILD.md) | Movement, the A\* planner, the cost model, jumping, bridging, cliffs and caves |
| [docs/SWIMMING.md](docs/SWIMMING.md) | Water, diving, oxygen, SwimAssist, climbing out onto a bank, `mode:drowning` |
| [docs/CLIENT_REPLACEMENT.md](docs/CLIENT_REPLACEMENT.md) | The owned-client seam, `src/mc/`, `settings.mc_client` |
| [docs/MARATHON.md](docs/MARATHON.md) | `travelToward`, checkpoint marathons, route surveying, driving long journeys |
| [docs/MODES.md](docs/MODES.md) | Modes, interrupts, action ownership, follow, tool selection, teleport detection |
| [docs/CONTAINERS.md](docs/CONTAINERS.md) | Chests, the owned container protocol, why mineflayer's is unusable |
| [docs/BLOCK_PLACEMENT.md](docs/BLOCK_PLACEMENT.md) | `block_io.js`, `place_packet.js`, why `bot.placeBlock` fails |
| [docs/MEMORY_AND_GOALS.md](docs/MEMORY_AND_GOALS.md) | Memory store, goals, reconnect policy, steering |
| [docs/WORLD_TOOLS.md](docs/WORLD_TOOLS.md) | Seed/biome lookup, world-edit guards, operator teleport, gamemode |
| [docs/OBEDIENCE.md](docs/OBEDIENCE.md) | Writing command descriptions the model will actually obey |
| [docs/LLM_FAILOVER.md](docs/LLM_FAILOVER.md) | The backup brain and the circuit breaker |
| [docs/CREATIVE_MODE.md](docs/CREATIVE_MODE.md) | Creative inventory, web item picker, the item-id check |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Duplicate-process crash loop, timelapse recording, web UI, common issues |
| [docs/TESTING.md](docs/TESTING.md) | Running the suites, and driving the live bot without corrupting results |
| [docs/gaps/](docs/gaps/) | Capability gap analyses and their execution plans (boats, food, nether, night safety, ranged combat, resource progression) |

**`docs/` is TRACKED, not gitignored.** (Verify: `git ls-files docs/`.) An earlier version of this
file said the opposite, which told several sessions their documentation was disposable. Write
documentation there and commit it.

## Two long-standing false beliefs, both now corrected

State these loudly. Their absence is what makes people rebuild the workarounds.

**1. `onGround` is NOT broken here.** A clean mineflayer bot (no agent, no assists) against this
very server: solid-below 60/60, `onGround` true **60/60**, plain jump apex **1.252** — the vanilla
figure, matched by a flying-squid control server. *What IS true:* prismarine-physics derives
`onGround = isCollidedVertically && oldVelY < 0`, so anything that zeroes `vel.y` (a server position
correction, the `negligeableVelocity` clamp) makes a standing bot read airborne for that tick —
real, but **situational**, never permanent. The stuck bots were real; the explanation was not. Do
not delete the workarounds on the strength of this (see the assists rule below), and do not add
another one without measuring that the flag is wrong **in your case**.

**2. THE SERVER IS 1.21.11. There is no version skew.** ViaVersion advertises protocol 775 in the
ping so newer clients can connect — that is its whole job — so `minecraft_version: "auto"` resolving
to 1.21.11 is exactly correct. Three independent checks agree: collision shapes 1166/1168
byte-identical with zero differing entries; a read-only world decode at identical coordinates on
both protocols disagreed on **0 of 24,389 blocks**; `viaversion list` shows both bots on the
server's native version. **Never attribute a movement bug to a version mismatch, and never "fix" one
by changing the connect version.** Evidence: docs/CLIENT_REPLACEMENT.md.

## The dominant bug shape in this codebase

**The code measures something true and concludes something false.** Nearly every expensive bug here
has that shape. Four real instances:

- An entity **leaving view distance** (24 blocks) fires the same `entity_destroy` as one dying, so
  `isValid === false` read as a confirmed kill and hunts "succeeded" with an empty bag. Cure:
  positive evidence only — `entityDead` (entity_status 3) or `health <= 0`.
- **No mode activity** read as "the modes are safe", when it meant the guard was never evaluated.
- A **missing `SpawnX` key** meant the NBT schema changed (1.21.11 stores a `respawn` compound), not
  that the bot had no spawn point.
- A prohibition **present in the source** but dropped by the 210-char compact-docs render cap read
  as "the model has been told". It had not been.

The cure is the same every time: **measure the thing you are concluding about, not a proxy for it**,
and make absence of evidence explicit rather than letting it default to "fine".

## Rules that cut across every subsystem

- **Measure before tuning — and measure the ASSIST, not its PREMISE.** `apex 0.000` sat in this file
  for days: it came from a sandbox that *forces* `onGround` false to reproduce the pathology, so it
  proved only "given a broken flag, no jump". Circular. Measuring the components themselves instead:
  `jump_assist` off → 1/4 (load-bearing); `ground_truth` off → 4/4 and *faster*. The same mistake
  was repeated within hours of finding it.
- **Do not disable `jump_assist` / `auto_jump` / `swim_assist`, and leave `ground_truth` off.**
  Enforced by `tests/jump.test.mjs:231-237`; the measurements, and the reason "`onGround` is fine"
  does NOT imply "the assists are unnecessary", live in the comment above those assertions and at
  `settings.js:185`. To experiment, flip a switch and run `scratchpad/updig_gym.mjs` — the
  assertions guard the committed DEFAULT, not your working tree, so just do not commit it flipped.
- **WADING IS NOT AFLOAT.** Wading is *in water, standing on solid ground, head in air*. For
  PROPULSION that is **land**. Conflating the two leaves every subsystem individually correct and
  the bot completely paralysed: measured at `vel=(0.000, 0.000, 0.000)` with `forward` held, in one
  block of water, for twenty minutes across four process restarts, with dry land two blocks away. It
  recurred in a second place — `towerUpVerdict` (`nav.js`) refused on `isInWater` and deadlocked a
  bot in one block of water with `climbBank` jammed and both fallbacks standing down for it. Two
  independent recurrences make this a rule, not a war story: test for wading explicitly, never for
  `isInWater` alone.
- **Establish feasibility BEFORE committing to a destructive step.** Three subsystems got this wrong
  independently: `emergencyShelter` dug before checking it could seal (roofless pits); `placeOne`
  dug before checking a face existed to click against (a hole at foundation depth let a lake into
  the build footprint, and every later symptom pointed at the navigator); `decideFoodAction` chose
  "cook" with no furnace anywhere. Check first, then break ground.
- **Never retry a failure on a fixed beat.** Nothing about the world changes while the bot stands
  still, so the third identical failure is evidence. `night_safety` learned this (20s → 60s → give
  up for the night, with a named line); `food_supply` re-earned it at a measured **53** consecutive
  `Could not cook anything`. Back off, then give up naming the reason, and **reset on a change in
  the INPUTS** (a furnace appears, the inventory changes, the bot moves, full daylight), never on a
  clock.
- **Trust measured progress over the block scan.** A map that says "clear" cannot know the bot's
  hitbox is caught on a lip.
- **Never substring-match block or item names.** `"sandstone".includes("sand")` is true and
  sandstone does not fall — that froze the agent for 11 minutes in a desert. The canonical test is
  `isFallingBlockName` in `library/tools.js`; do not re-derive it locally.
- **One owner per control state.** Two subsystems writing the same key will fight, and the loser is
  silent. Assert against `bot.controlState.*`, never against a cached belief of your own — anything
  calling `bot.clearControlStates()` changes it behind your back.
- **A timing constant that gates a recovery must never exceed the window the recovery runs in.**
  `followPlayer`'s 1500ms leg against a 2500ms dig trigger meant following someone had *no* recovery
  at all. `tests/bridge.test.mjs` asserts the relationship.
- **`await` is not a yield.** A loop whose awaits are all microtasks starves the event loop and the
  server drops the client — which looks exactly like the bot dying in-world.
- **State that belongs to someone else is not yours to clear.** A mode's clean completion once wiped
  the resume belonging to the action it had interrupted, ending a follow instead of pausing it.
- **Doc text does not deter a capable model.** Real guards protect; descriptions only inform.

### Reading output — two disciplines that cost real time today

- **Log times are UTC; this host is +0800.** A last log line of `01:20` against a wall clock of
  `09:20` was concluded to be eight hours of silence and a dead bot. It was current to the second.
  The check that saves you: compare the file's **mtime** to its last line before believing a gap.
- **A negative read is not evidence until a positive control returns something.** `data get entity
  andy SpawnX` returned `Found no elements matching`, which was escalated to "andy has no spawn
  point" — an urgent hazard, on the strength of which world state was changed. `SpawnX` is the
  PRE-1.21 layout; 1.21.11 stores a `respawn` COMPOUND, and the control (querying a bot nobody had
  touched) showed the spawn point had been there all along. **Before reporting an absence, run a
  query you KNOW should return something.** This generalises far past NBT.

## Architecture

```
main.js → MindServer (:8080) + AgentProcess → Agent (mineflayer bot + LLM + ActionManager + Modes)
Chat → Conversation → LocalClassifier (optional) → LLM → Commands → Skills → Mineflayer
```

`src/agent/commands/` (actions.js, queries.js) · `src/agent/library/` (skills.js, world.js, nav.js,
swim.js, chest.js, block_io.js) · `src/models/` (providers) · `bots/[name]/` (runtime state) ·
`tests/` (pure suites) · `scratchpad/` (live gyms — tracked, they are the evidence behind the
numbers quoted here).

## Commands

**Build** `!fill` · **Move** `!travel` `!navTo` `!goToPlayer` `!followPlayer` `!climbOut` ·
**Water** `!swimTo` `!dive` `!surface` `!swimProbe` · **Combat** `!shoot` (refuses players) ·
**World, operator** `!worldSeed` `!locateBiome` `!serverGive` `!serverGamemode` `!serverSpawnpoint`
· **Resources** `!collectBlocks` `!craftRecipe` `!getCraftingPlan` · **Storage** `!putInChest`
`!takeFromChest` `!depositAll` · **Info** `!inventory` `!stats` `!surroundings` `!scanArea`.
Aliases: `!ca`→fill, `!cb`→collectBlocks, `!cr`→craftRecipe, `!gcp`→getCraftingPlan,
`!inv`→inventory. **Prefer `!travel`/`!navTo` over `!goToCoordinates`.** Full list and params:
`src/agent/commands/`.

Adding one: export `{name, description, params, perform}` from `actions.js`, register in `index.js`.
Writing a description the model obeys is a measured skill (**docs/OBEDIENCE.md**); the two rules
broken most often:

- **The param NAME is the only param documentation compact mode renders** (`name:type` — per-param
  descriptions never appear), and the description itself is capped at **210 chars**
  (`DESC_TOTAL_MAX`). Anything past the cap was never shown to the model at all.
- **Prohibitions go on the TEMPTING command, not the right one**, and overlapping commands must
  cross-reference each other — that is what made selection *stable* rather than merely more often
  right. `settings.hidden_actions` hides a command from the model but keeps it chat-callable;
  `blocked_actions` deletes it for everyone. `tests/command_docs.test.mjs` enforces the alias and
  one-letter-apart rules.

## Configuration

**settings.js**: `host`, `port`, `max_messages`, `command_docs_mode` (full/compact/minimal),
`assists`, `hidden_actions`, `blocked_actions`, `viewer_first_person`. **andy.json**: `model`,
`backup_model`, `conversing` and `saving_memory` prompts. **Placeholders**: `$STATS`,
`$INVENTORY`, `$MEMORY`, `$STEERING`, `$COMMAND_DOCS`, `$EXAMPLES`.

## LLM providers and the backup brain

18+ providers auto-discovered. Current chain, the tiered copilot-mem0 router and the failover
measurements: **docs/LLM_FAILOVER.md**.

- **`src/models/fallback.js` is the only place that decides "the model is down."** Providers just
  throw; `FallbackModel` classifies, routes, and guarantees `sendRequest` resolves to a string —
  `promptCoding`/`promptMemSaving` have no try/catch, so a rejection there reaches the agent loop.
- **A provider must never return a placeholder string on error.** A placeholder reads as *success*
  and stops the failover chain. `llamacpp.js` and `fireworks.js` both used to do exactly that.
- An *availability* error (ECONNREFUSED, timeout, 5xx, hangup) opens a 60s breaker; other errors
  fail over without opening it. If every backup fails, the primary is retried once.
- **`applyContextBudget` must run BEFORE `new Prompter`** (providers copy params at construction,
  so a later `"auto"`→number mutation never reaches them) and must resolve `max_tokens: "auto"` for
  the **whole backup chain**, not just `profile.model`.
- `!stats` grows `- Brain: BACKUP (...)` only while failed over — without it, the sole symptom of
  an outage is that the bot suddenly writes differently.

## Movement and navigation

Cost model, geometry gotchas, the gyms and every measurement: **docs/NAVIGATION_REBUILD.md**.

- **Nothing EXECUTES on mineflayer-pathfinder.** Its *planner* is fine (`success, 3 nodes, 6ms` over
  a 1-block step); its *executor* cannot move this bot (`goto` timed out after 30s having moved 3.1
  blocks). Planning calls stay; execution goes through `nav.js`.
- **`setGoal(null)` + `stop()` before driving.** Pathfinder rewrites control states every tick and
  silently cancels ours. Stand it down; do not try to out-prioritise it.
- The stack: `nav.js` (A\* planner + lookahead executor — `planPath`, `followPath`, `navigateTo`,
  `climbAhead`, `bridgeAhead`, `digAhead`), `auto_jump.js`, `jump_assist.js`, `tools.js`,
  `skills.travelToward`/`travelDirection`. `navToGoal` is the seam from a pathfinder goal to a
  target we can steer at; `GoalInvert` is the one shape it cannot express, so `skills.fleeFrom`
  supplies a flee *heading* fanned ±45/±90° — the directly-opposite line is usually into the wall
  the bot was cornered against.
- **Re-read a followed entity every iteration.** mineflayer destroys a player's entity across render
  distance and builds a new object on return; a captured reference is a ghost frozen at its last
  position. Bit both `GoalFollow` and `followPlayer`.
- **Jump limits are honest refusals, not bugs.** `JUMP_REACH = 3` (width 4 is 7/11 at best); rise 2
  is refused at every width and lead; any gap over lava or a hazard floor is refused however narrow.
  `JUMP_FALL_SAFE` (8) must EXCEED `maxDrop` (3) or the rule contradicts itself.
- **Bridging is the LAST resort, and never into the unknown** — build only toward a standable cell
  we can see at our own level. The planner cannot express a gap at all (every move is
  cell-to-adjacent-cell), which is why bridging is an executor-level fix; teaching the planner to
  place blocks was rejected because it would change which nodes win the whole A\* frontier.
- **Trees are walked around, never felled** (`treeDigCost 60`); leaves are cheap and are cleared.
- **Cost-model units are "blocks walked"**: `digCost: 14` means *walking 14 blocks around beats
  mining through*. `dropCost` is high because descent is asymmetric. `swimEnabled` is off by default
  (only `travelDirection` turns it on), and `waterCost` must never be 0 — free water routes the bot
  out to sea.

## Swimming

All measurements and the still-open failure modes: **docs/SWIMMING.md**.

- **Water is the part of this server's physics that works**: **0.098 b/t** forward (~118 blocks/min)
  against ~25 blocks/min overland — ~4× faster than walking. `waterCost` sat at 15 on an unmeasured
  assumption; it is 2 now, plus a one-off `waterEntryCost` of 6, because what costs in a river is
  getting in and out of it.
- **SwimAssist owns the jump key while the bot is wet.** Nothing else may touch it — not
  `followPath`, not AutoJump, not the idle `clearControlStates` in `modes.js`. (Wet is not one
  state: see WADING IS NOT AFLOAT, above.)
- **Pitch is not a movement input** — `applyHeading` uses `entity.yaw` only. Vertical control is a
  jump duty cycle with a hysteresis band; rising is 7× faster than sinking (+0.175 vs −0.025 b/t).
- **Never hop, dig or place while afloat**, and **never run `walkForward` while wet**: it holds
  `forward` into the bank, and pressed flush the bot cannot rise at all — 22s of zero movement at
  x=4508.70 versus out in 0.8s from x=4508.40. `swim.climbBank` maintains that standoff throughout.
- **`bot.oxygenLevel` does not update here.** `!stats` reported `Air: 20 / 20` while the server's
  NBT had 13 ticks left and the bot drowned with `mode:drowning` silent throughout; the mode
  measures submersion itself now. **Trust measured state over reported state.**
- **Restore `liquidAcceleration` on disable, on leaving water, and on death/respawn.** A leak
  silently alters *lava* movement for the life of the process.

## Block placement and containers — we own both protocols

`block_io.js` + `place_packet.js` (**docs/BLOCK_PLACEMENT.md**); `chest.js` (policy) +
`container_io.js` (protocol) (**docs/CONTAINERS.md**). Same underlying defect in both: mineflayer
wraps a fire-and-forget packet in an await this server never satisfies, then reports the missing
confirmation as a failed action.

- **Never call `bot.placeBlock` for anything time-critical.** Three defects that only fail in
  combination: it blocks up to 500ms on a `blockUpdate` ack that does not come; `_genericPlace`
  awaits a *smooth* `lookAt` that outlasts a jump's apex; and the body must clear the cell being
  filled (pillaring targets the feet cell, and the bot is 1.8 tall). Instead: write the packet, snap
  the look, wait for the hitbox to clear, confirm by **reading the world**, and pace the packets —
  the server rate-limits interactions and silently drops the excess. Measured `PILLAR TEST: +5.00 of
  5` where the old path managed +0.00.
- **Re-read the world before believing a placement failed** — the API can throw after a success.
- **Nothing outside `chest.js` may call `bot.openContainer`.** It has no timeout, so every reason
  the server declines to send a window is an infinite hang — and a never-returning action pins
  `currentActionLabel` forever, after which no action can ever start again.
- **Nothing anywhere calls `win.deposit`, `win.withdraw` or `bot.transfer`.** Every chest click ends
  in an unbounded await (the server answers only when the client's prediction is *wrong*), and
  `transfer` is cursor-based: a desync throws with items still on the cursor, which the server drops
  on the floor at close. Shift-click (mode 1) is the workhorse; it never touches the cursor.
- **`bot.inventory` is FROZEN while a window is open** (slots are copied back only in
  `closeWindow`). Every number must come from `window.slots`, which is live. **Counts are measured,
  never requested**: count before and after, report the difference.
- **A double chest is ONE container** (`findBlocks` returns both halves); reading one half over
  RCON invents phantom missing items. **A transfer must never empty the source on spec** — survey
  the destination first, bound the withdraw by it, put back anything refused. **Deposit-all
  aggregates BY NAME, not by slot**, and `none_held` is not `full`.

## Modes

`drowning, self_preservation, night_safety, food_supply, unstuck, cowardice, self_defense,
elbow_room, hunting, item_collecting, torch_placing`. Every incident: **docs/MODES.md**.

- **Every `execute()` call site must pass a timeout.** It defaults to `-1` = none, and a mode action
  that cannot finish pins `currentActionLabel` forever. Nine sites were missing one;
  `tests/modes.test.mjs` fails the build if a new one appears.
- **A mode must PAUSE an action, not END it** — a resume belongs to whoever registered it. (Do not
  drop the cancel entirely: a finished action leaving resume state behind is replayed forever.)
- **The model does not get to cancel what a person asked for.** `ActionManager` records
  `action_author` ('user'/'model'/'mode') and `agent.js` refuses a model-emitted action while a
  user-owned one runs. **Modes are exempt on purpose** — drowning and self-defence must still
  interrupt a user's marathon. `tests/action_owner.test.mjs`.
- **A pause applied after a blocking await is not a guard.** `followPlayer` paused `elbow_room` at
  the bottom of a loop that blocks for seconds inside `navigateTo`; `interrupts: []` is the real
  fix, and `elbow_room` now interrupts nothing, by test.
- **`night_safety` stands down whenever sheltering cannot pay for itself**: Peaceful, an awake human
  online, already deep underground, already under a roof — all AFTER the dawn dig-out branch, so a
  bot sealed in last night is always let out. Dig 3, not 2, or the seal is open sky.
- **Read difficulty via `src/agent/difficulty.js` (`isPeaceful`), never `bot.game.difficulty`.**
  Three compounding bugs: Peaceful is 0 and mineflayer assigns with `if (packet.difficulty)`; our
  listener was attached after the packet had been dispatched; and the wire form is the **string**
  `"peaceful"`, which mineflayer decodes to `undefined` and writes back over us — so the field now
  ignores writes of `undefined`/`null`. `tests/difficulty.test.mjs`.
- **`mineflayer-tool` is not loaded** — `bot.tool.equipForBlock` throws. Use `tools.js` →
  `equipBestTool`/`digWithTool`.
- **`torch_placing` needs real light data.** `block.light` is broken; chunk light via `bot.world` is
  fine and synchronous. Sky light is stored UNSCALED, so pair it with `bot.time.timeOfDay`; an
  unloaded chunk returns 0 from both getters, so the check **fails OPEN**.
- **Prefix mode log lines with the agent name.** Both bots share `logs/service.log`.

## Memory, goals and steering

Full detail: **docs/MEMORY_AND_GOALS.md**.

- **A goal is a directive, not a memory** — it arrives through `!goal` or not at all, and memory
  summarisation must never MINT one (`importLegacyBlob` takes `allowGoal`, default false; without it
  the summariser re-created a goal out of the very turns in which the user ended it).
- **There are TWO goals**: the self-prompt loop, and the record in the memory store that renders
  into `$MEMORY` every turn. `!endGoal` clears both. Authority is asymmetric — from a user it
  deletes the record; from the model it stops the loop only, and says so.
- **On reconnect, the last thing a PERSON said wins.** `resume_policy.js` decides from STATE and
  hands the model the answer, never the question: a small model told to "find an unfinished task in
  your memory" always finds one. The agent restarts its own loop and must never delegate that to the
  model — `!goal` from the model against a user-authored goal is refused outright.
- **The memory store folds paraphrases.** A stuck bot narrated its loop into 90 lessons that were
  six spellings of two things. Identity is the set of content words; caps are enforced at
  **storage**, not render; eviction is **least-reinforced first**, never oldest-first.
- **Steering is rendered verbatim and never re-ingested** (`bots/<name>/steering.json`, the
  `$STEERING` placeholder, late in the prompt where small models obey best). Bounded at 8 directives
  / 120 chars / 600 total, and **not model-writable while self-prompting**.

## World edits, seed lookup, rescue teleport

Full detail: **docs/WORLD_TOOLS.md**.

- **`!serverFill`/`!serverSetblock` refuse edits that would destroy an irreplaceable block** (beds,
  chests, furnaces, spawners, doors, signs), **entomb the bot, or overwrite its respawn point.**
  `!forceFill`/`!forceSetblock` are the separately-named escape hatches and report what the guard
  would have said. **Do not route around these.** Two unguarded edits once destroyed the bot's own
  bed, moving the respawn to world spawn — the next death cost a full inventory 7000 blocks away.
  A model cannot see that the cell it is overwriting holds the thing its life depends on, so the
  edit has to notice, not the prompt.
- **`!serverTp` refuses unless `bots/<name>/ALLOW_RESCUE_TP` exists, and deletes the marker on
  use**, so the model can never call it to skip a journey; arm it by hand. A capable model took the
  bait through every wording of the description — the marker protects, the description informs.
- **Avoid large `!serverFill` near the bot**: it has repeatedly dropped it into pits, buried it in
  sand, and opened a cave underneath it.
- `!worldSeed`/`!locateBiome` ask the **server**, so the answer is exact for this seed; both need
  operator permission, and the reply matcher must skip the agent's own chat echo. This world's
  surveyed biome coordinates are in docs/WORLD_TOOLS.md.

## Creative mode and operations

**docs/CREATIVE_MODE.md**, **docs/OPERATIONS.md**.

- **mineflayer DOES support creative inventory** (`bot.creative` is core) — no `/give`, no operator
  permission — and **every creative command refuses outside creative mode**, so survival work stays
  honest.
- **Never pass `waitTimeout: 0` to `setInventorySlot`** — mineflayer leaks its per-slot busy flag
  and every later write to that slot throws for the life of the process. It bricked all 37 slots
  once. `WRITE_ACK_MS = 60` is a correctness constant, not a tuning knob.
- **Item ids ride the wire as numbers and no in-process check can validate them** — the server sends
  no ack, so our own echo confirms itself. Verify server-side by name (`!creativeIdSweep`, then `mc
  "clear andy <item> 0"`). Swept 2026-08-23, ids 150–1458, all correct.
- **Two `main.js` processes = an endless bot crash-loop**: a bot joining and leaving every ~14s
  forever (`multiplayer.disconnect.duplicate_login` + the 5s auto-restart), while `mc "list"` shows
  only ONE bot. Diagnose with `ps -eo pid,etimes,cmd | grep -E "bun (run main|.*init_agent)"` — two
  mains, or a second MindServer on 8082. Kill the **parents** first; `main.js` respawns a dead agent
  by itself. **Anchor any `ps | grep` guard at the executable**, or it matches the shell running the
  check. **A new bot must be whitelisted** or it crash-loops too.
- **Re-run `bun tools/setup_viewer_assets.mjs` after every `bun install`** — the viewer patches all
  live in `node_modules`, and without them 107 block types render wrong or vanish. Timelapse and
  web-UI ports: docs/OPERATIONS.md.

## Common issues

| Symptom | Cause |
|---|---|
| Command parsed with 0 args | Curly quotes — use ASCII `"` |
| Bot joins/leaves every ~14s | Two `main.js` processes |
| `Air: 20 / 20` while drowning | `bot.oxygenLevel` does not update here |
| A log gap of exactly 8 hours | Logs are UTC; this host is +0800 |
| Measurement contaminated | The bot's self-prompt loop interrupts probes — `!endGoal` and a `!steer` first, and pin any other agent involved |

## Security

`allow_insecure_coding: true` enables `!newAction` (LLM code execution). Use Docker for safety.
