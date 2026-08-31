# Modes, interrupts and agent behaviour

The modes system, tool selection, who may interrupt whom, who owns a running action, and the
teleport detector. Every rule here was paid for by a bot that froze, dug a pit it could not
roof, or walked 7000 blocks in the wrong direction.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

#### Tools and modes

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


### Modes System

`modes.js`: drowning (air), self_preservation (health/hunger), unstuck (pathfinding), cowardice,
self_defense
Use `excludeFromInterrupt: ["action:fill"]` to prevent mode interruption during builds

**Every `execute()` call site must pass a timeout.** The parameter defaults to `-1`, which means
no timeout, and a mode action that cannot finish then pins `currentActionLabel` forever - after
which no action can ever start again. Nine call sites were missing one (2026-08-26);
`tests/modes.test.mjs` now fails the build if a new one appears.

**`night_safety` must never dig a hole it cannot roof, and must never become a metronome.**
Found while testing containers: on the bare stone pad, with no pickaxe and nothing to place, it
printed `Dug in at y=111 but could not seal the roof` **every twenty seconds all night**, and
each one interrupted whatever the bot was doing. Four separate faults:

- **It dug first and asked later.** `emergencyShelter` called `digDown(bot, 2)` and *ignored its
  return value*, then tried to seal regardless. `shelterFeasibility` now runs BEFORE any ground
  is broken and answers two questions: can we break the block below **and keep the drop**
  (`tools.canBreak` - `bot.canDigBlock` is not this question; stone is diggable bare-handed, it
  just drops nothing), and is there something to roof with, carried or minable from a wall.
  Every failure now names itself - `no tool for stone`, `nothing to seal with`, `nothing_to_dig`
  - where before every distinct failure printed the same "could not seal the roof".
- **Two blocks is the wrong depth on flat ground.** With the top solid block at `Y-1` and the
  bot's feet at `Y`, digging 2 leaves it at feet `Y-2` / head `Y-1` and puts the seal at `Y` -
  open sky, four air neighbours, `nothing to place on`. **Digging 3** puts the seal at `Y-1`,
  the old surface layer, walled on every side. It looked right for a long time because in
  natural terrain the bot usually dug into a slope, where that cell had neighbours anyway.
  `digOut` climbs 3 to match, or the bot is let out into a hole it still cannot leave.
- **The descent has to be measured after the bot lands.** `digDown` returns when the blocks are
  broken, not when the body has fallen through them: measured `Dug down 2 blocks.` immediately
  followed by `only got down 1.0 blocks`. `settleY` waits for two equal readings. Same class of
  mistake as counting a chest transfer the instant the deadline fires.
- **A failure must not be retried on a fixed beat.** The mode interrupts every action in the
  agent, so a flat 20s cooldown cancelled the bot's work three times a minute until dawn.
  Nothing about the ground or the inventory changes while the bot stands still, so the third
  identical failure is evidence: back off 20s, then 60s, then **give up for the night** with a
  named log line. Reset at dawn - and gate that reset on **full daylight**, not `!isNight`:
  those two predicates do not partition the day (`isNight` starts at 13000, dusk 600 ticks
  earlier), so resetting on `!isNight` clears the counter on every tick of exactly the window
  the mode is failing in. Measured as 35 attempts in 110s with the give-up never latching.

And whatever happens, **it climbs back out rather than leaving an open pit** - a roofless hole
is worse than the flat ground it started on: the bot is cornered in it and the terrain is spent.

Verified live (`scratchpad/night_test.mjs`, which pins the bot to a test pad - left alone the
agent picks up a goal and walks off onto different ground between attempts, and then the run
measures wandering): bare stone -> refuses before digging, gives up after 3, no pit; with a
pickaxe and dirt -> `VERIFIED SHELTER: sealed at (4566, 107, 4706)`, and at dawn
`Dug out of the shelter at dawn` back to the exact level it started from.

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

**`bot.game.difficulty` is a lie on Peaceful worlds, and it took THREE fixes.** Never read the
raw field - use `src/agent/difficulty.js` (`isPeaceful`, `difficultyName`), which is unit-tested
in `tests/difficulty.test.mjs`. Each failed attempt looked exactly like the last (the guard reads
`undefined`, `night_safety` digs the bot in at dusk on a world where nothing can hurt it, and
whatever a person asked for is cancelled):

1. **Peaceful is 0, which is falsy.** `lib/plugins/game.js` assigns with
   `if (packet.difficulty)`, so on a Peaceful world the field is never set. Any guard against it
   fails open. Fix: an `== null` test, not truthiness.
2. **The listener was attached too late.** It went in `startEvents()`, which runs from the
   `spawn` handler - long after the `login` and `difficulty` packets were dispatched, so it could
   never fire. Fix: wire it in the same synchronous block as `initBot`. Careful:
   **`bot.game` does not exist yet there** - mineflayer injects its plugins after `createBot`
   returns, and touching `this.bot.game.difficulty` at construction throws and kills the agent
   process before it logs in.
3. **The wire form is a STRING, and mineflayer overwrites us.** Captured on this server
   (protocol 774): the `login` packet has **no `difficulty` field at all** any more, and the
   `difficulty` packet carries `"peaceful"`, not an index. mineflayer's
   `difficultyNames[packet.difficulty]` is therefore `undefined` - and because its listener is
   registered during that late plugin injection, it always runs *after* ours and puts the
   `undefined` back a moment after we set the right value.

The third one cannot be won by registering later, so `installDifficultyField` makes the field
**ignore writes of `undefined`/`null`**: that means "this client could not parse the packet",
never "the difficulty is now unknown". Ordering stops mattering in both directions.

Verified live: `difficulty="peaceful"`, 38 guard evaluations across a full night, **0**
`night_safety` executions - against 3 per night before.

**`night_safety` does nothing on Peaceful.** Nothing hostile spawns, so a night shelter costs a
whole night and buys nothing - and because the mode interrupts everything, it was a pure tax on
any long journey. The check sits *after* the dawn dig-out branch on purpose: a bot that sealed
itself in while the world was on Normal must still be let out if the difficulty is lowered
overnight. (This is also what `bob.json` was working around by shipping the mode off.)

**Mode log lines are prefixed with the agent name.** Both bots share `logs/service.log`, and an
unattributed `Mode drowning finished executing` cannot tell you which bot is wet - or that only
one of them is. `mode:drowning` also logs air/submerged/inWater/pos at the moment it fires,
because it interrupts every action in the agent and a spurious trigger is expensive.

#### The model does not get to cancel what a person asked for

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

#### `elbow_room` killed a follow, and the pause that should have stopped it lands too late

Reported as *"check why he stopped following me just now"*. The bot then stood motionless on one
block until it was restarted. Log times are **UTC while this host is +0800** - read that offset
before concluding an event is hours old; it made a six-minute-old incident look like yesterday's.

```
00:32:51  pinned: pos=(4744.5, 65.50, 4810.7)                  <- stuck in sand
00:32:52  mode:elbow_room interrupts action:followPlayer
00:32:52  dig sand at (4744, 65, 4811): Digging aborted         <- the recovery, cancelled
00:32:52  pinned: nothing worked (climb=no bridge=nothing to build with dig=no) - recentring
00:32:55  mode:elbow_room interrupts action:followPlayer        (third time in 16 seconds)
00:32:57  follow resumes, target now out of entity range, REFUSES
```

Three faults compounded, and the mode is only the first:

- **`elbow_room` listed `action:followPlayer` in its `interrupts`.** Its own description says
  *"when idle"* - and being 0.5 blocks from the person you are FOLLOWING is the goal state, not a
  problem to fix. Worse, its remedy (shuffle half a block) competes with the navigator's stall
  ladder: it aborted the dig that was getting the bot out of the sand, three times.
- **`followPlayer` already pauses `elbow_room` when within `distance + 2` - but that line sits at
  the BOTTOM of a loop iteration that blocks for seconds inside `navigateTo`.** A player walking
  up to a stuck bot beats the pause every time. The pause stays as belt-and-braces; `interrupts:
  []` is what actually fixes it. **A pause applied after a blocking await is not a guard.**
- **`followPlayer` captured the target entity ONCE**, before its loop
  (`let player = playerObj.entity`). mineflayer DESTROYS a player's entity across render distance
  and builds a new object on return, so that reference becomes an orphan frozen at the last
  position it saw - the bot chases a ghost, confidently, with nothing in chat to say so. Same
  shape as the `GoalFollow` bug `navToGoal` had to fix. It is re-read every iteration now.

**A mode interrupt tears the follow down and restarts it from the top**, so the entry check runs
constantly - and a target who keeps walking will be out of entity range during one of those gaps.
Refusing there threw away a position the bot knew perfectly well a second earlier, which is what
made the failure permanent. `lastSeenPos` (module-level, `skills.js`) now survives across calls,
so a resumed follow walks to where it last saw you and re-acquires. Only *no entity **and** no
memory* refuses.

The decision is the pure `followVerdict` (`tests/follow.test.mjs`): `follow` / `seek` / `lost` /
`gone`. Giving up needs **both** conditions - arrived at the last-seen spot AND still nothing
there. Time alone abandons a chase mid-walk; distance alone abandons it the instant the target
teleports from right beside the bot. `gone` is checked first: a player who quit is not out of
render distance, and walking to their last position would end in a timeout instead of a reason.

`tests/modes.test.mjs` asserts `elbow_room` interrupts nothing, and that `hunting`,
`item_collecting` and `torch_placing` still DO interrupt a follow - those are deliberate, since
`followPlayer` pauses them by distance ("these modes slow down the bot, and we want to catch up").

#### A mode must PAUSE an action, not END it

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

#### `await` is not a yield - followPlayer spun until the server dropped the bot

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

#### Follow has to leave the water on its own - the follow distance hides the problem

`followPlayer`'s land leg is gated on `distance_from_player > max(1.5, distance)`. With the
default `distance` of 4, **a bot treading water three blocks off the bank the player is standing
on has already arrived**: it asks the navigator for nothing, and `nav.followPath` - which carries
the per-tick water-exit branch - is only ever reached by way of a plan. Following works
perfectly; the bot just never comes ashore.

So `followPlayer` now runs its own water exit, *before* the distance check and regardless of it,
whenever the bot is wet and the player is not. Gated on `swim.bankTargetAhead` actually finding a
bank (pure block reads, ~free) rather than on calling `climbBank` and letting it refuse - mid-lake
there is nothing to climb, and spinning on refusals there would stop the bot swimming toward the
player at all. Capped at 3 consecutive failures so a bank the bot genuinely cannot climb falls
back to normal driving, which has a whole dig/detour/bridge ladder behind it.

Measured on gym lane 5, **with the other player PINNED** at 3.1 blocks: **15.6s without this
branch, 1.0-1.5s with it.** It is not a deadlock, and the 15.6s is the interesting half - what
eventually freed the bot was DRIFT. It sank to y=109, which pushed the 3D distance past 4 and
finally earned it a leg. That is a coincidence rather than a recovery, and it arrives in the
worst possible state: the first climb from down there reported `no reachable bank in the forward
cone`, because sinking had put the bank out of `bankTargetAhead`'s one-block reach.

**Pin the other player when testing this.** The first control run measured nothing: bob is a live
agent, and four seconds in he issued `!navTo(3371, 62, 4845)` and walked off - which pushed andy
outside the follow distance and quietly converted the inside-follow-distance case into the
ordinary one. `scratchpad/follow_water.mjs` re-teleports him every 500ms and reports the maximum
gap actually observed, so a contaminated run is visible in the output rather than passing as a
result.


### Andy notices when he is teleported

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

