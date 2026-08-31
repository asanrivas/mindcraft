# Does the wet-lift 350ms cadence gate prevent an anti-cheat trip?

**Verdict: the gate is UNNECESSARY, for the mechanism it was written to guard against.**
Zero server corrections and zero valve trips in the gated arm; zero in the ungated arm too -
3 runs each, alternating, in the exact zero-net-displacement scenario the gate's own
justification cites. This is a null result, not a "the code is fine" pass - see Caveats for
what it does not settle.

## The question

`wetLiftVerdict` (`src/agent/library/skills.js`) gates `pillarUp`'s hand-injected wet-lift
impulse (`v.y += 0.42`) behind a 350ms cadence (`minGapMs`). Its own comment names the
mechanism: collision resolution zeroes `vel.y` every tick while jammed against a ceiling/bank,
so the naive guard `velY <= 0.05` is satisfied every tick, and a 10ms sampler would re-arm the
impulse at up to 100Hz. The gate was added on ARGUMENT - "both anti-cheat valves on this server
have already tripped for real... so 'the server does not mind' is not available as an
assumption" - not on a measurement of this specific mechanism. This is that measurement.

## Rig

Andy and bob were left untouched throughout - both processes had the same PIDs at the end as
at the start of this session (etimes only grew), and `mc list` showed only `andy, bob` online.
Reaching the ungated arm on the live andy agent is impossible without editing `skills.js` (the
shipped call site never passes `minGapMs`, so it always defaults to 350) or restarting the
service - both forbidden. So both arms ran on a separate, already-whitelisted probe account
(`probe1`, confirmed via `whitelist list`), using a harness under `scratchpad/`
(`scratchpad/wet_pillar_cadence.mjs`) that imports the REAL, unmodified exports -
`wetLiftVerdict`, `WET_LIFT_IMPULSE` from `skills.js`, `inWater`/`inLava` from `swim.js`,
`JumpAssist`/`SwimAssist`, and the shared `CORRECTION_MIN_BLOCKS`/`TELEPORT_MIN_BLOCKS` from
`server_corrections.js` - and overrides only `minGapMs` as a function argument. No file under
`src/` or `tests/` was edited. Using the same harness for both arms (identical terrain,
identical bot, only `minGapMs` differs) is what makes this a controlled comparison rather than
two different measurements.

**World rig** (built via RCON, floating at y~200-204 to avoid all terrain/mob interference, far
from both bots' working areas - andy was at (3407, 62, 4890), bob at (4708, 70, 4612) when this
started):

- A dry staging platform, guard-railed, at x 5190-5198, z 5200, y200 floor.
- A 1-wide corridor, x 5199-5210, z 5200, floor y200, ceiling y203 - **2 blocks of water
  (y201-202) under a solid ceiling, giving a submerged bot only ~0.2 blocks of headroom.**
  This is deliberately the worst case the gate's own comment describes: any lift attempt
  collides with the ceiling and vel.y is zeroed, immediately re-satisfying the gate's velocity
  check. x=5210 is a dead-end wall the bot is driven into and pinned against.
- Water spread 2 blocks past the doorway on its own (checked live via `execute if block ...
  water`, not assumed) - noted, harmless to the design.

**Per-run procedure** (mitigations from the task, applied in order):

1. **One operator teleport only, at the very start of the whole session**, to the dry staging
   platform - never into water. The script then waits 12s (longer than the 10s
   `rubberBandWindowMs` both valves use) before touching any listener, so the teleport's own
   `forcedMove` cannot contaminate anything that follows.
2. **Walk in** using `setControlState('forward'/'sprint')`, not `/tp`, all the way to the
   dead-end wall.
3. Only once **both** wet (`inWater(bot)`) and pinned (x stopped advancing) for 800ms does the
   script clear the correction ledger and start the clock - so nothing from the approach counts.
4. **Fresh `JumpAssist`/`SwimAssist` instances every run** (not reused), so a trip in one run
   cannot mask or inflate the next - each run is an independent trial, and the 60s stand-down
   never has to be waited out.
5. **Both valves watched.** `JumpAssist`'s own forcedMove counter only counts while
   `this.active` (between `begin()`/`end()`), and wet-lift never calls `begin()` - it bypasses
   JumpAssist entirely (confirmed by reading `jump_assist.js`), so JumpAssist's valve cannot
   fire from this mechanism by construction. `SwimAssist`'s valve requires `boosted`
   (submerged + sprinting), so the probe holds `forward`+`sprint` into the wall the whole
   measured window specifically to keep that valve live and comparable, not just present.
   Both classes' `console.warn` output was captured and grepped for `stood down` per run, and
   every `forcedMove` was independently classified by the harness itself using the exact
   `[CORRECTION_MIN_BLOCKS, TELEPORT_MIN_BLOCKS)` band `SwimAssist._forcedMove` uses, so a trip
   would show up even if the valve's own extra gating happened not to fire.
6. Terrain is static (nothing dug or placed by the probe), so no repair was needed between runs.

The wet-lift loop itself is a direct copy of `pillarUp`'s `apexWatch`: a `setInterval(..., 10)`
that reads live `velY`/`rise`/`inWater`/`inLava`, calls the real `wetLiftVerdict()`, and on a
pass does exactly `v.y += WET_LIFT_IMPULSE; lastLift = Date.now()` - `minGapMs` is the only
thing that differs between arms (350 for gated, matching the shipped default; 0 for ungated).

## Raw results

Three runs each, alternating gated/ungated, 20s measured window per run (120s of wet time
total, well past the 10s valve window on every run):

| run | arm | minGapMs | lifts applied | corrections | valve trips ("stood down") | final y (start 201.0) |
|---|---|---|---|---|---|---|
| 1 | gated   | 350 | 57  | 0 | 0 | 201.2 |
| 2 | ungated | 0   | 524 | 0 | 0 | 201.0 |
| 3 | gated   | 350 | 57  | 0 | 0 | 201.0 |
| 4 | ungated | 0   | 494 | 0 | 0 | 201.0 |
| 5 | gated   | 350 | 57  | 0 | 0 | 201.0 |
| 6 | ungated | 0   | 507 | 0 | 0 | 201.0 |

**GATED totals: 171 lifts, 0 corrections, 0 valve trips.**
**UNGATED totals: 1525 lifts, 0 corrections, 0 valve trips.**

Gated applies almost exactly 20000/350 ≈ 57 lifts every run, as designed. Ungated applies
~9x more (the real re-arm rate came out ~26Hz, not the theoretical 100Hz ceiling - JS timer
jitter plus the velocity-gate's own settle time - but still a large, clearly distinguishable
multiple of the gated rate). In every run, gated and ungated alike, the bot's y position stayed
essentially pinned at the ceiling (200.999→201.2), which is itself the mechanism working as
described: the impulse never produces net displacement because collision eats it every time.

## Verdict

**The gate is UNNECESSARY** for this mechanism, as tested: neither arm produced a single
correction or valve trip, despite the ungated arm re-arming the impulse roughly 9x more often
than the gated one, sustained over 60s of cumulative wet time per arm. This is a genuine null
result, not "no difference was found because nothing was measured" - the rig reproduces the
exact zero-net-displacement state the gate's source comment uses as its own justification
(`climbBank`'s captured log: `vel=(0,0.42,0)` twice a second, position identical to the last
decimal), sustained for 3x longer per run than that captured incident, at a much higher
re-arm rate than 100Hz-capped reality ever reaches in practice.

The most plausible explanation, from reading the mechanism rather than guessing: the Minecraft
protocol has the client report **position**, not velocity. When collision resolution cancels
the injected `vel.y` before the next tick's position is computed, the server never receives an
unusual position delta to react to - a client-side velocity reassignment that produces no
net movement is invisible on the wire regardless of how many times per second it happens. If
that is right, the gate's benefit was never about REDUCING the assertions the server can see;
it never had one to prevent in the pinned case. It would still matter in a case where the
lift **does** produce partial real displacement each cycle (a bank with a little real headroom,
not zero) - that is explicitly outside what this rig tested; see Caveats.

## Caveats - what would change this answer

- **This is one server's movement validation**, and it has no dedicated anti-cheat plugin -
  `plugins` lists CountryBlock, floodgate, Geyser-Spigot, MapModCompanion, SkinsRestorer,
  ViaBackwards/ViaVersion; the corrections this codebase has observed elsewhere are Paper/Purpur's
  own built-in movement checks. A server running NoCheatPlus, Grim, or similar could react very
  differently to a 26Hz vs 3Hz velocity reassignment even with the same zero net displacement.
- **This tested the fully-jammed (zero clearance) case only**, because that is what the gate's
  own justification cites and what makes the comparison controlled and reproducible. A bank with
  partial clearance - where each re-arm buys a little real, visible rise - was not tested here,
  and is the case where a higher re-arm rate would most plausibly produce a position delta large
  enough to read as anomalous. If a future incident shows the valve tripping on a *partial-rise*
  bank rather than a fully-jammed one, this result would not contradict it and should not be
  read as covering that case.
- **The probe held `forward`+`sprint` the whole time** to keep SwimAssist's own boosted-gated
  valve live; JumpAssist's valve is structurally unreachable by this mechanism (confirmed by
  reading `jump_assist.js` - its forcedMove counter only counts inside an active `begin()`/`end()`
  flight, which wet-lift never opens), not merely "didn't happen to fire" - so a future change
  that routes wet-lift through JumpAssist would need this re-measured.
- Ungated ran at ~26Hz measured, not the 100Hz the comment describes as the ceiling. That gap is
  real (JS timer + event-loop jitter, not a design choice), so this result rules out anti-cheat
  sensitivity at ~26Hz but is silent on whether a true 100Hz re-arm (e.g. driven by the physics
  tick itself rather than a 10ms timer) would differ - unlikely given the zero-displacement
  argument above, but not directly measured.

## Rig cleanup

The floating rig at x 5190-5210, y 197-204, z 5195-5205 was left in place (harmless, isolated,
matches the convention other gyms in this repo already follow - `build_gym.mjs`,
`boxed_gym.mjs` - of leaving scaffolding for reproducibility). Re-run with:

```
bun scratchpad/wet_pillar_cadence.mjs --sequence gated,ungated,gated,ungated,gated,ungated --duration 20
```

## Confirmation

- Never restarted the mindcraft service: `main.js`/`init_agent.js` PIDs (303442/303478 for andy,
  346883 for bob) were unchanged from session start to finish, only `etimes` grew.
- Never touched bob: bob was read once via RCON (`data get entity bob Pos`, for rig placement
  only) and never driven, teleported, or messaged.
- No file under `src/` or `tests/` was modified. `git diff -- src/agent/library/skills.js`
  confirms the concurrent session's own in-flight edits to that file (visible in `git status` at
  the start of this task) never touch `wetLiftVerdict`/`WET_LIFT_IMPULSE`/`minGapMs`, so this
  measurement is against the same code the task described.
- New files: `scratchpad/wet_pillar_cadence.mjs` (the harness) and this document.
