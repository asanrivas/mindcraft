# Gap: Night safety

Status: **PLAN — nothing implemented**

A human sleeps through the night (which skips mob-time entirely), torches the work area, and
digs in when caught outside without a bed. Andy has none of the deciding machinery: `goToBed`
exists but has never slept live, `torch_placing` is a proximity heuristic that only runs near
idle, and `self_defense` is reactive melee. Nothing watches `bot.time.timeOfDay` and says
"night is falling, act now".

## 0. What exists today, and what is broken in it

| Piece | Location | State |
|---|---|---|
| `goToBed(bot)` | `src/agent/library/skills.js:3452` | **Three bugs, never verified live.** (a) Finds beds with `block.name.includes('bed')` — matches **bedrock**, the exact substring-matching bug CLAUDE.md bans (`isFallingBlockName` precedent). (b) Walks there via `goToPosition`, which is **mineflayer-pathfinder** — banned; cannot move the bot on this server. (c) `await bot.sleep(bed)` is uncaught: daytime (`bot is not sleeping` observed live), monsters-nearby, and occupied-bed rejections all throw out of the skill; the `while (bot.isSleeping)` wait is unbounded and never checks `bot.interrupt_code`; `bot.modes.pause('unstuck')` is never unpaused on the throw path. |
| `!goToBed` | `src/agent/commands/actions.js:956` | `runAsAction(fn)` with **default `timeout = -1`** — the exact pin-forever hazard documented in CLAUDE.md (11-minute freeze). Returns no VERIFIED string. |
| `torch_placing` mode | `src/agent/modes.js:443` | Places a torch at the bot's own position when no torch within 6 blocks. Light-level reads are bugged (`src/agent/commands/queries.js:52-54`, `world.shouldPlaceTorch` TODO at `src/agent/library/world.js:555`), so proximity-to-torch is the proxy. It has no concept of night. |
| `self_defense` | `src/agent/modes.js:294` | Reactive melee within 8 blocks, `interrupts: ["all"]`. |
| Time plumbing | `src/agent/agent.js:501-510` | `bot.on('time')` already emits `sunrise`/`noon`/`sunset`/`midnight` at exact ticks 0/6000/12000/18000. Nothing listens. |
| Bed placement | `skills.placeNearby` (`skills.js:4553`) | Works, handles the two-cell requirement for beds (`TWO_CELL_BLOCKS` regex, free-pair check). |
| Spawnpoint | `!serverSpawnpoint` + WORLD_TOOLS.md §6 | Bed + spawnpoint-on-solid-ground + survival is the documented recoverability recipe. |

## 1. New module: `src/agent/library/night.js`

All decision logic lives here as pure functions so it is testable without mineflayer
(pattern: `swimCostFor` in nav, `isFallingBlockName` in tools).

```javascript
export const DUSK = 12542;        // first tick a bed accepts you (clear weather)
export const MOBS_SPAWN = 13000;
export const DAWN = 23460;        // beds eject sleepers just before 0

export function isNight(timeOfDay)                 // 13000 <= t < 23000
export function canSleepAt(timeOfDay, thundering)  // t >= DUSK || thundering
export function isBedName(name)                    // name.endsWith('_bed') — NOT includes('bed'); 'bedrock' must fail
export function bedInInventory(items)              // first item whose name endsWith '_bed'
export function pickShelterSpot(blockAt, origin)   // pure over an injected blockAt(vec3) fn:
                                                   //   descend cell with solid floor 3 below, no water/lava
                                                   //   adjacent, no falling block (isFallingBlockName) above seal cell
export function torchRing(origin, radius = 6)      // candidate positions around a spot
```

`isBedName` also becomes the single bed test used everywhere (goToBed fix, inventory scan).

## 2. The `night_safety` mode (`src/agent/modes.js`)

Insert into `modes_list` **after `self_defense`, before `hunting`** (position 6).

Rationale for the slot:
- The update loop calls modes in order and `break`s at the first `active` mode. Everything
  above `night_safety` (drowning, self_preservation, unstuck, cowardice, self_defense) keeps
  updating while it is active — so a creeper at the bedside still triggers self_defense, and
  low air still triggers drowning. Everything below it (hunting, item_collecting,
  torch_placing) goes quiet during the sleep/shelter run, which is what we want.
- Above `hunting` because chasing a pig at dusk is how you meet a skeleton.

```javascript
{
    name: "night_safety",
    description: "At dusk, sleep in a bed (or place one), or dig in when there is no bed. Interrupts most actions.",
    interrupts: ["all"],
    // Never interrupt the survival modes above us, the command twins doing our job
    // (the !surface/drowning livelock lesson — SWIMMING.md §5.2), or protected builds.
    excludeFromInterrupt: [
        "mode:drowning", "mode:self_preservation", "mode:self_defense",
        "action:goToBed", "action:shelter", "action:surface",
        "action:fill", "action:plantTrees", "action:!stay",
    ],
    on: true,
    active: false,
    cooldownUntil: 0,
    sheltered: null,     // Vec3 of the seal block while dug in, else null
    update: async function (agent) { ... },
    unpause: function () { this.cooldownUntil = 0; },
}
```

`update()` logic, in order:
1. `if (Date.now() < this.cooldownUntil) return;`
2. `if (agent.bot.isSleeping) return;` — already handled.
3. **Dawn path**: if `!night.isNight(timeOfDay)` and `this.sheltered` — `execute(this, agent, digOut, 1)`,
   clear `sheltered`, done. Otherwise if not night, return.
4. `if (swim.inWater(agent.bot)) return;` — water is drowning-mode territory (same rule as `unstuck`).
5. **Hostile stand-off**: if `world.getNearestEntityWhere(bot, e => mc.isHostile(e), 12)` return —
   self_defense/cowardice own that tick. This plus the cooldown is the anti-livelock pair: night_safety
   never fights self_defense for the controls, it waits out the fight and re-fires.
6. `execute(this, agent, () => skills.nightRoutine(agent.bot, this), 3);` — **timeout 3 minutes,
   never `-1`** (the 11-minute pin). On any failure inside, set `this.cooldownUntil = Date.now() + 20000`
   so a hopeless situation (no bed, no blocks, bare fists on stone) retries every 20s instead of every tick.

**Wake behaviour is deliberately not "wait all night inside execute()".** If the server skips the
night (all players slept), `bot.wake` fires within seconds. If it does not (human players awake,
`playersSleepingPercentage`), `sleepUntilMorning` gives up holding the action after 90s and returns
with the bot still in bed — `bot.isSleeping` stays true, step 2 keeps the mode quiet, and the
`'wake'` event or the dawn path picks it up. This keeps `currentActionLabel` free instead of
pinning `mode:night_safety` for a 7-minute real-time night.

## 3. Sleep flow: rewrite `skills.goToBed` + new `skills.nightRoutine`

In `src/agent/library/skills.js`:

```javascript
export async function goToBed(bot) // repaired, same export
```
1. Find: `world.getNearestBlocksWhere(bot, b => night.isBedName(b.name), 48, 1)` (kills the
   bedrock match).
2. Walk: `await nav.navigateTo(bot, bedPos, { arriveDist: 2 })` — the custom navigator
   (`nav.js:695`), **not** `goToPosition`. Check `res.arrived`; on failure log and return false.
3. Re-read the block (`bot.blockAt`), then `try { await bot.sleep(bed) } catch (err)`:
   - message matches `/monsters nearby/i` → return `{ slept:false, reason:'monsters' }` so the
     caller can fight or shelter; **do not retry in a tight loop**.
   - `/not sleeping|day|no sleep/i` (the observed daytime rejection) → `{ slept:false, reason:'daytime' }`.
   - occupied/too far → try the next bed once, then give up.
4. On success: `bot.modes.pause('unstuck')` **inside try/finally with unpause**, then
   `sleepUntilMorning(bot, 90_000)`: loop on `bot.isSleeping` in 500ms steps, exit on
   `bot.interrupt_code`, deadline, or wake. Return a result object, and log a
   `VERIFIED SLEEP: slept at (x,y,z), woke at timeOfDay=N` line (the outcome-string convention).

```javascript
export async function nightRoutine(bot, modeState)
```
1. **Dimension guard first**: `if (bot.game.dimension !== 'overworld') → shelter path only`
   (beds explode in the nether/end — see Risks).
2. Try `goToBed(bot)`. If `reason:'monsters'` → return false (mode cools down; self_defense
   handles the mob; retry next window).
3. No bed found but `night.bedInInventory(bot.inventory.items())` → `await skills.placeNearby(bot, bedItem.name)`
   (handles the two-cell pair), then sleep it. Placement doubles as base-building: the bed persists.
4. No bed at all → `emergencyShelter(bot, modeState)`.
5. Either way, finish with one `skills.placeNearby(bot, 'torch')` if a torch is in inventory
   (§5).

## 4. Emergency shelter: new `skills.emergencyShelter` / `digOut`

The classic dig-in-and-seal, on primitives that verifiably work here (mining works, placing
works via `placeNearby`/`placeBlock`):

```javascript
export async function emergencyShelter(bot, modeState)
```
1. Pick the spot with `night.pickShelterSpot(p => bot.blockAt(p), bot.entity.position.floored())`.
   Refuses cells over water/lava (reuse `digDown`'s checks) and cells whose seal position has a
   falling block above (`isFallingBlockName` — a sand seal pours onto the bot's head).
2. `await skills.digDown(bot, 2)` (`skills.js:3896` — already stops on lava/water/voids).
3. Seal overhead: `await skills.placeBlock(bot, pick, x, y+2, z, 'side')` where `pick` is the
   first `STACKABLE` item held (`skills.js:4626` — deliberately excludes gravity blocks). If the
   bot has **no** placeable block, mine one wall block of the hole first (cobble/dirt drops from
   digging down are usually already in inventory).
4. Verify: block above head is solid → log `VERIFIED SHELTER: sealed at (x,y,z)`, set
   `modeState.sheltered = sealPos`, return. **Do not wait for morning inside this action** —
   the mode's step 3 (dawn path) digs out.
5. `digOut(bot, sealPos)`: `breakBlockAt` the seal, jump/pillar out (the hole is 2 deep;
   `pillarUp` for 1 block), clear `sheltered`.

Torches inside the shelter are unnecessary (a 1×1×2 sealed hole cannot spawn mobs).

## 5. Torch policy

First, **verify the light bug before building on it** (repo rule: measure first). One-off
diagnostic: at night, `console.log(bot.blockAt(pos).light, .skyLight)` beside a placed torch vs
3 blocks away. Expected per `queries.js:52-54`: garbage. If it is actually usable in 26.1,
switch `world.shouldPlaceTorch` to `light < 1`; **otherwise keep the proximity proxy** —
no-torch-within-6-blocks approximates "this spot spawns mobs" well enough, since a torch's
spawn-suppression radius at floor level is ~6-7 blocks in modern light rules.

Changes either way, in `world.shouldPlaceTorch` (`world.js:552`) and the `torch_placing` mode:
- Add a night/underground gate: only place when `night.isNight(bot.time.timeOfDay)` **or**
  the bot is below `nav.surfaceY` — daytime surface torch-spam wastes sticks and coal.
- `torch_placing` keeps its slot and 5s cooldown, but its `execute` should place via
  `skills.placeNearby(bot, 'torch')` rather than `placeBlock` at the bot's own cell —
  torches are non-solid so the current call happens to work, but `placeNearby` is the
  canonical "next to me, verified" path.
- `nightRoutine` places one torch at the bed/shelter site itself (step 5 above), so the
  respawn point is lit even when the mode-driven torching never visited it.

## 6. Morning resume — how interrupted work continues

No new machinery needed; document and rely on what `execute()` already does (`modes.js:554-586`):

- **Resumable actions** (`!travel`, `!fill`, anything registered with `runAsAction(fn, true, t)`):
  `agent.actions.resume_func` survives the interruption. When the mode action finishes and the
  bot goes idle, the `'idle'` handler (`agent.js:605-614`) calls `actions.resumeAction()` after
  1s. Sleep-then-resume-travel needs zero code.
- **Non-resumable actions**: `should_reprompt` fires and the LLM gets
  `(AUTO MESSAGE) Your previous action 'action:X' was interrupted by night_safety...` with the
  behavior log — which will contain the `VERIFIED SLEEP` / `VERIFIED SHELTER` line, so the model
  knows it is morning and why it stopped.
- **Caveat to note in code**: `execute()` calls `agent.self_prompter.stopLoop()` — a
  self-prompt goal is stopped by nightfall, and the AUTO MESSAGE is what restarts deliberation.
  That is acceptable behaviour, but say so in a comment; it is not a bug.
- After `digOut`, `say(agent, "Morning — dug out of my shelter.")` so the behavior log is
  self-explanatory in the reprompt.

## 7. Command surface (`src/agent/commands/actions.js`)

- **Fix `!goToBed`** (`actions.js:956`): `runAsAction(fn, false, 3)` — never default `-1`.
  Stand-down guard, mirroring `!surface` (`actions.js:186`):
  `if (agent.bot.modes.isActive('night_safety')) return 'Night safety is already handling bed/shelter - leaving it to finish.';`
  Return the VERIFIED string from the skill. (Both sides of the livelock fence: the guard here,
  `"action:goToBed"` in the mode's `excludeFromInterrupt`.)
- **New `!shelter`**: `runAsAction(async (agent) => skills.emergencyShelter(agent.bot, ...), false, 3)`
  with the same stand-down guard, so a user/LLM can force a dig-in.
- Register both in `src/agent/commands/index.js`'s `actionsList`.

## 8. Pure tests: `tests/night.test.mjs` (bun, no network — pattern of `tests/tools.test.mjs`)

- `isBedName`: `red_bed` true, `bedrock` **false** (the regression that motivated the rewrite),
  `oak_bed` true, `bed_of_lies` false.
- `canSleepAt`: 12000 false, 12542 true, 23000 true, 500 false; thundering true at noon.
- `isNight` boundaries: 12999/13000/22999/23000.
- `pickShelterSpot` with a scripted `blockAt`: rejects water floor, rejects sand above seal,
  accepts plain dirt column.
- `torchRing` geometry: count and radius.
- Mode-shape test (import `modes.js`, no bot): night_safety exists, sits after self_defense and
  before hunting in `modes_list`, `excludeFromInterrupt` includes `mode:self_defense` and
  `action:goToBed` — cheap insurance against reorderings.

## 9. Live verification procedure

Setup per WORLD_TOOLS.md §6 (`!placeHere("red_bed")` → `!serverSpawnpoint` → survival), then
drive one scenario at a time, watching the service log:

1. **Happy path**: `time set 13000` with a bed 20 blocks away → expect walk via nav
   (no pathfinder log lines), `VERIFIED SLEEP`, night skipped, wake log.
2. **Monsters-nearby rejection**: summon a zombie near the bed, then `time set 13000` →
   expect sleep rejection caught, self_defense engages, night_safety cools down and retries
   after the kill. **Watch specifically for the livelock signature**: alternating
   `mode:night_safety` / `mode:self_defense` interrupts more than twice in 30s = fail.
3. **No bed, blocks in inventory**: remove beds, give dirt 64 → expect
   `VERIFIED SHELTER: sealed`, quiet night, `time set 0`, dig-out within one mode tick.
4. **No bed, bed in inventory**: give red_bed 1 in open field → expect
   `placeNearby` pair-placement then sleep.
5. **Resume**: start `!travel("west", 200)`, `time set 12600` mid-leg → expect sleep, then
   travel auto-resumes (resume_func path), `VERIFIED TRAVEL` completes.
6. **Server does not skip night**: keep a human player awake → expect the 90s hold release,
   bot stays in bed, no `currentActionLabel` pinned (check `!stats` still answers).
7. **Idempotence**: leave it running two full day cycles unattended; count night_safety
   triggers (should be ≤2/night) and confirm no torch spam.

## 10. Risks

- **Sleeping while a task timer runs.** `runAsAction` timeouts keep counting in bed. `!travel`'s
  45-min ceiling absorbs a night easily, but tighter timeouts (e.g. a 3-min action interrupted
  at dusk on a non-skipping server) will expire and report timeout instead of resuming. Accepted
  for v1; the AUTO MESSAGE explains what happened. Mitigation if it bites: `cancelResume()` is
  NOT called, so re-issue is one command away.
- **Bed explosion outside the overworld.** `bot.sleep` on a nether/end bed detonates for ~5
  hearts. Guard in `nightRoutine` step 1 on `bot.game.dimension !== 'overworld'`; also guard the
  repaired `goToBed` itself, since the command is LLM-callable. (No nether logic exists yet —
  see [nether.md](nether.md) — so this is cheap future-proofing.)
- **Mob aggro during the walk to the bed.** self_defense (8-block trigger) interrupts the walk;
  the mode's hostile stand-off + 20s cooldown prevents thrash. Residual risk: a skeleton at
  10-16 blocks shoots without triggering self_defense; cowardice covers part of that band. If
  deaths happen here, the fix is raising night_safety's hostile-check radius, not fighting.
- **Livelock with `!goToBed`/`!shelter`** — fenced on both sides (§7), same shape as the
  documented `!surface`/drowning fix. Any new night-adjacent command must get the same pair.
- **`bot.time.timeOfDay` trust.** The 26.1-vs-774 mismatch has burned every "obvious" bot state
  read (`onGround`, `block.light`). agent.js already switch-cases on exact tick values and the
  status query buckets on it, so it is presumed good — but verify once live (log timeOfDay vs
  an opped client's `/time query daytime`) before trusting the thresholds.
- **Spawnpoint drift.** Sleeping in a new bed moves the respawn. That is usually desirable, but
  after `!serverSpawnpoint` was set deliberately on solid ground (WORLD_TOOLS §6), a bed placed
  on a cliff edge can regress it. Note in the doc; do not auto-set spawn from the mode.

### Critical Files for Implementation
- `src/agent/modes.js` — new `night_safety` entry (after `self_defense`), torch_placing tweak
- `src/agent/library/skills.js` — repair `goToBed` (~3452), add `nightRoutine`, `emergencyShelter`, `digOut`; reuse `placeNearby` (~4553), `digDown` (~3896)
- `src/agent/library/night.js` — NEW: pure predicates (`isNight`, `canSleepAt`, `isBedName`, `pickShelterSpot`, `torchRing`)
- `src/agent/commands/actions.js` — fix `!goToBed` (~956: timeout + stand-down guard), add `!shelter`
- `src/agent/library/world.js` — `shouldPlaceTorch` night/underground gate (~552)

---

*Reviewer note (added on save): the original draft drove live scenarios with rcon (`mc "..."`).
There is no rcon on this machine — drive Andy over the MindServer socket (docs/../TESTING.md §2)
and issue `/time set` etc. from an opped client or a narrow operator command. Everything else
stands.*
