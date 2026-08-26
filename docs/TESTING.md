# Testing Andy

How to run the unit tests, and how to drive the live bot without corrupting your own results.
**Related:** [SWIMMING.md](SWIMMING.md) · [LLM_FAILOVER.md](LLM_FAILOVER.md) · [WORLD_TOOLS.md](WORLD_TOOLS.md)

---

## 1. Unit tests

Plain `bun` scripts, no framework: arrays of `[input, expected]`, a `failures` counter,
`process.exit(1)` on any failure.

```bash
bun run test        # every tests/*.test.mjs
```

| Suite | Covers |
|---|---|
| `tests/tools.test.mjs` | `toolFor`, `isFallingBlockName`, `isTreeTrunk` |
| `tests/steering.test.mjs` | the steering directive store |
| `tests/fallback.test.mjs` | LLM failover, circuit breaker, recovery |
| `tests/swim.test.mjs` | water classifiers, `verticalIntent`, air-pocket geometry, `oxygen`, the A\* water cost model, probe verdicts, **`swimTo` yielding a macrotask** |
| `tests/action_owner.test.mjs` | who owns the running action, and **resume ownership across a mode interrupt** |
| `tests/modes.test.mjs` | every mode `execute()` call site passes a timeout |
| `tests/torch.test.mjs` | the torch-placing light check, all four light/time quadrants |
| `tests/teleport.test.mjs` | teleport detection: the threshold, and every branch that must NOT fire |
| `tests/memory_store.test.mjs` | durable memory, goal authority, and that summarisation cannot mint goals |

### The regression cases — keep them

- **`"sandstone".includes("sand")`** — the substring bug that froze the agent on
  `mode:self_preservation` for 11 minutes in a desert.
- **`water_cauldron` must not be swimmable** — the same mistake, in `nav.classify`.
- **`blockAt` returning `null` (unloaded chunk) must read as BLOCKED, never as air** — treating
  unknown as air is how a bot swims confidently into a ceiling it cannot see.
- **A mid-river cell must be charged `waterCost` once, not twice** — the double charge made a
  6-wide river lose to a 60-block detour.
- **`swimTo` must yield a real macrotask before any exit.** Its fast paths await only
  `bot.look(..., force)`, which resolves with no timer and no I/O, so a caller looping on it
  spins the event loop, the socket goes unserviced, and the SERVER drops the bot with
  `Timed out`. The test schedules a `setTimeout(…, 0)` and asserts it fired before `swimTo`
  resolved. See [SWIMMING.md](SWIMMING.md) §7.6.
- **A torch must not be placed in daylight.** Sky light is stored UNSCALED — a surface block
  reads 15 at midnight exactly as at noon — so it only means "daylight reaches here" when paired
  with `timeOfDay`. Without the pairing the check either disables torches underground or lets
  the desert spam back in, and each firing of `torch_placing` interrupts a follow.
- **An anti-cheat correction must never read as a teleport.** `forcedMove` fires on every
  server position packet; only distance separates a nudge from a `/tp`. The branches that must
  NOT fire (login, respawn, `!serverTp`, cheat mode, coalescing) are the ones worth testing.
- **Summarisation must not mint a goal.** The summariser is an LLM writing markdown under a
  template containing a `## Goal` header, so with goals allowed it re-creates one the user just
  ended, out of the very turns in which they ended it. Both call sites are asserted, because
  getting the flag backwards restores the bug with every other test still green.
- **A mode must not cancel the resume of the action it interrupted** — otherwise `torch_placing`
  *ends* a follow instead of pausing it. The paired case matters just as much: an action must
  still clear its OWN resume on clean completion, or the idle handler replays it forever. See
  [MARATHON.md](MARATHON.md) §4.1.

### Keep the fakes faithful

`tests/action_owner.test.mjs`'s fake agent originally implemented `clearBotLogs()` as
`bot.output = ''`, while the real `Agent` also resets `bot.interrupt_code`. A test that set
`interrupt_code = true` *before* an action then passed for the wrong reason — in the real code
`_executeAction` clears the flag right after `stop()`, so an interrupt must land **while** the
action runs. An unfaithful fake does not fail; it agrees with you.

## 2. Driving the live bot

Two channels exist:

**RCON — server console** (`mc "..."`), for world state: time, difficulty, summon, give, tp.
`~/.local/bin/mc` wraps `tools/rcon.mjs` (a dependency-free bun RCON client); the password
lives in `~/.config/mc-rcon.env` (mode 600), read from the server container's
server.properties. `mc "msg andy <text>"` also reaches Andy as chat.

**MindServer socket** — for driving Andy as a user would:

```js
// scratchpad/say.mjs   —   bun say.mjs "!swimProbe" 120
import { io } from 'socket.io-client';
const socket = io('http://localhost:8080');
socket.on('connect', () => {
    socket.emit('listen-to-agents');
    socket.emit('send-message', 'andy', { from: 'asanrivas', message: process.argv[2] });
});
socket.on('bot-output', (agent, msg) => console.log(`[${agent}] ${String(msg).trim()}`));
setTimeout(() => process.exit(0), Number(process.argv[3] ?? 45) * 1000);
```

A user message that *is* a command executes directly (`agent.js`), bypassing the LLM.

### Silence the bot before measuring — this is not optional

Andy's self-prompt loop reacts to every command's output and issues its own commands. It will
interrupt whatever you are measuring:

```
action "action:goToCoordinates" trying to interrupt current action "action:swimProbe"
```

That zeroed **every phase** of a swim probe and produced a completely wrong reading
(`fwd=0.021` instead of `0.098`), which then sent me chasing a nonexistent physics problem.

```
!endGoal                                                    # stop self-prompting
!steer("Never issue movement or travel commands yourself.")  # stop it re-issuing movement
...run your test...
!unsteer("all")                                             # clean up afterwards
```

### Only `log()`-free output reaches the service log

`skills.log(bot, msg)` appends to `bot.output` and **never** writes to the console. Those
messages come back through the socket as `Action output`, not in `logs/service.log`. If you grep
the log for them you will find nothing and wrongly conclude the code path never ran.

### One leg at a time

Wait for the `VERIFIED ...` line before sending the next command. A fixed-timer driver once
spent 97 minutes interrupting its own in-flight travel leg — which reads as "the bot is stuck"
when it is not.

## 3. Live procedures

### Swimming

```
!travel to water, or !serverTp into it
!swimProbe                # the gate: needs depth >= 3 for vertical numbers
!dive(12)                 # should auto-surface unaided afterwards
!surface
```

`!swimProbe` reports `deeper water: Nb at (x, y, z)` when the current spot is too shallow.

### The climb-out gym

Ten lanes of water, 1 to 10 blocks deep, each against a **one-block bank** — the exact geometry
that used to make the bot mine a canal instead of stepping out. It is the only test here that
exercises the real `!travel` path end to end.

```bash
node scratchpad/build_gym.mjs                       # build the lanes
node scratchpad/gym_run.mjs andy 45000 1,2,3,4,5,6,7,8,9,10
# ->  depth  outcome        secs   final position
#         1  CLIMBED OUT    37.2   (4511.2, 111.00, 4702.5)
```

**Baseline 3/10 → now 10/10** (2026-08-27). Failures are reported as `STUCK` with the position
the bot gave up at; a stuck lane always reads `y≈110.x` at `x=4508.7`, flush against the bank.

Three procedural traps, each of which will hand you a result you did not earn:

- **REPAIR THE LANES BETWEEN RUNS.** A bot that mined a lane once will swim its own tunnel on
  every later run, and the suite reports a pass that is really a hole in the terrain.
  `scratchpad/seal_gym.mjs` / `verify_gym.mjs` exist for this.
- **Do not give the climb a free head start.** An early version of `scratchpad/climb_exp.mjs`
  teleported the bot to `111.5 - depth` — half a block *above* the pool floor. Use `111 - depth`.
  (The conclusion survived the correction, but only because it was re-run.)
- **Isolated success is not path success.** `climb_exp.mjs` passed while the real `!travel` route
  still failed, because `walkForward` was pressing the bot flush against the bank *before*
  `climbBank` ever ran. Always confirm through `gym_run.mjs`, not just the isolated harness.

### Failover

Stop the local llama-server (or let the tunnel drop) and send any message. Expect
`[fallback] primary chat model ... is down` followed by a normal reply from the backup.

### Survival / drowning

See [WORLD_TOOLS.md](WORLD_TOOLS.md) §6 for the bed-then-spawnpoint-then-survival order.
**Oxygen never depletes in creative** — 17 recorded probe runs all read `oxygen 20->20`, which
made every drowning test vacuous until the bot was switched to survival.

## 4. Instrument before you guess

The single biggest time sink in the swimming work was diagnosing "the bot will not rise" from
outside. It looks identical whether the assist is off, stuck sinking, or pressed against a
ceiling. Three numbers settled it in one reading:

```
[assist: auto, jump=true, boost=false] [physics.isInWater=true vel.y=-0.005]
```

`jump=true` with `vel.y=-0.005` is sinking with the key supposedly held — a state desync, not a
physics problem. Add the diagnostic **before** the third wrong hypothesis, not after.

## 5. Running a long live test without killing it

The gym suite takes ~6 minutes. Two traps, both of which truncate a run and make a passing fix
look partial:

- **A foreground shell call that hits its timeout kills its whole process group.** `nohup … &
  sleep 300` in one call returned exit 143 and took the detached run down with it, at lane 3 of
  10. Use `setsid … & disown`, then poll the log file separately.
- **Poll with an `until` loop, not a bare `sleep`.**

```bash
setsid node scratchpad/gym_run.mjs andy 45000 1,2,3,4,5,6,7,8,9,10 > gym.log 2>&1 & disown
until ! pgrep -f gym_run.mjs >/dev/null; do sleep 15; done; cat gym.log
```

Also: **the bot must be reachable for the whole run.** Restarting the service mid-suite silently
invalidates every remaining lane, and the harness cannot tell the difference between "the bot is
stuck" and "the bot is not connected".

## 6. Service control and live visibility

```bash
systemctl --user restart mindcraft
tailgate            # combined live view: bot (cyan) + server console (yellow), alerts in red
tailgate bot        # just Andy's brain
tailgate server     # just the server console
tailgate chat       # just in-game chat
```

`~/.local/bin/tailgate` merges `logs/service.log` with `docker logs -f geyser-minecraftbe-1`,
strips the console's cursor-control junk and our own RCON thread churn, and highlights
errors/deaths/drowning. The `-u` on every sed is load-bearing: without it the pipeline
buffers and the "live" view shows nothing for minutes.

Restarting resets in-memory state (SwimAssist mode, breaker state, steering is reloaded from
disk). If you are debugging live state, capture it *before* restarting.
