# Testing Andy

How to run the unit tests, and how to drive the live bot without corrupting your own results.
**Related:** [SWIMMING.md](SWIMMING.md) · [LLM_FAILOVER.md](LLM_FAILOVER.md) · [WORLD_TOOLS.md](WORLD_TOOLS.md)

---

## 1. Unit tests

Plain `bun` scripts, no framework: arrays of `[input, expected]`, a `failures` counter,
`process.exit(1)` on any failure.

```bash
bun run test        # all four suites
```

| Suite | Covers |
|---|---|
| `tests/tools.test.mjs` | `toolFor`, `isFallingBlockName`, `isTreeTrunk` |
| `tests/steering.test.mjs` | the steering directive store |
| `tests/fallback.test.mjs` | LLM failover, circuit breaker, recovery |
| `tests/swim.test.mjs` | water classifiers, `verticalIntent`, air-pocket geometry, `oxygen`, the A\* water cost model, probe verdicts |

### The regression cases — keep them

- **`"sandstone".includes("sand")`** — the substring bug that froze the agent on
  `mode:self_preservation` for 11 minutes in a desert.
- **`water_cauldron` must not be swimmable** — the same mistake, in `nav.classify`.
- **`blockAt` returning `null` (unloaded chunk) must read as BLOCKED, never as air** — treating
  unknown as air is how a bot swims confidently into a ceiling it cannot see.
- **A mid-river cell must be charged `waterCost` once, not twice** — the double charge made a
  6-wide river lose to a 60-block detour.

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

## 5. Service control and live visibility

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
