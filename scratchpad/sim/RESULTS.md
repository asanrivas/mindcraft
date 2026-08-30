# Jump calibration — measured, not chosen

`bun scratchpad/sim/sanity.mjs`, `jump_sweep.mjs`, `lead_window.mjs`.
Headless `prismarine-physics` — the same engine the bot runs — with `onGround` forced false after
every tick to reproduce this server. Milliseconds per sweep instead of 45s per live lane.

## The sandbox is faithful

| | apex | travelled (30 ticks) |
|---|---|---|
| vanilla, standing jump | **1.252** (textbook 1.25) | 0.00 |
| vanilla, sprint-jump | 1.252 | 8.86 |
| **this server**, sprint-jump | **0.000** | 5.80 |

With `onGround` stuck false the bot **cannot jump at all**. That is the whole problem, reproduced.

## Mechanism: hybrid wins

| | apex | liftVy | clears | no sprint |
|---|---|---|---|---|
| A `onGround` — assert the flag for the takeoff tick | 1.25 | 0.333 | ≤3 | fails at 3 |
| B `impulse` — `vel.y = 0.42` + axial top-up | 1.25 | 0.333 | ≤3 | ok |
| **hybrid — assert the flag AND top up the axial speed** | **1.25** | **0.333** | **≤4** | **ok** |

Asserting the flag buys the engine's real impulse *and* its `+0.2` sprint-jump boost
(`prismarine-physics/index.js:725`); the axial top-up supplies the run-up the broken flag denies.
Neither alone is enough. `followPath` only sprints when aiming far ahead, so "works without
sprint" is not optional.

**A first sweep measured apex 0.87, not 1.25**, because mechanism B used `vel.y += 0.42` from a
velocity the engine had already made negative. The engine *assigns*. `+=` costs a third of the jump.

## Take-off window — the number that decides what is safe to ship

`jump_sweep` reports the *best* lead, which flatters everything. What matters is how many leads
work, because on a live server the tick the decision lands on is not ours to choose.

**Level gaps** (leads 0.02 … 1.00, 11 sampled):

| width | sprint | no sprint |
|---|---|---|
| 0–2 | 11/11 | 11/11 |
| 3 | 11/11 | 10/11 |
| 4 | 7/11 | never |
| 5 | never | never |

**Rise 1** (step up across a gap): widths 0–2 at 11/11; width 3 drops to 7/11.
**Rise 2**: never, at any width or lead — the honesty refusal, confirmed empirically rather than
argued from 1.25 blocks.
**Drops 1–3**: 11/11 at widths 1 and 3. Landing lower is the easy direction.

## Shipped constants

```
mechanism      hybrid
JUMP_IMPULSE   0.42     assigned, never added
JUMP_AIR_SPEED 0.32     vanilla sprint-jump takeoff; physics.sprintSpeed is 0.30
JUMP_REACH     3        width 4 is reachable but only in a narrow window - a coin flip live
JUMP_RISE      1        and a rise costs a block of reach: 2 with rise 1
TAKEOFF_LEAD   0.30     safely inside every passing window
```

`JUMP_REACH` is deliberately one below the measured maximum. A wasted plank is recoverable; a leap
into a ravine is not.

## Fidelity caveat

The sim models the client exactly and the server not at all — no anti-cheat, no lag, no
rubber-banding. It also shows the bot *walking* at ~70% of vanilla speed, where the live bot is far
slower than that, so the approach to the lip will be less crisp than these numbers suggest. The
ballistics transfer; the acceptance does not. That is what the live gym and the `forcedMove` valve
are for.
