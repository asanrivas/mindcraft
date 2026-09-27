# Gap: Replace free-form `!newAction` with Playbooks

Status: **PLAN — nothing implemented.** Motivated by a live failure: `!newAction("Walk to the
door and enter the igloo")` generated code that **took the bot process down** (connection lost,
watchdog re-login 25s later) while it was trying to do something the navigator already does.

## The problem with `!newAction` — but keep what it is FOR

`!newAction` is the only escape hatch the model has when no command fits. That is genuinely
necessary and must not be removed. But as built it is the worst possible shape for a 9B model
on a broken-physics server:

| | `!newAction` today |
|---|---|
| **Blank page** | The model writes arbitrary JS against a ~100-function API from memory |
| **No reuse** | Every invocation starts from zero; yesterday's working code is gone (`action-code/` resets to `0.js` each boot and is never read back) |
| **Unbounded blast radius** | It can call anything, including the pathfinder that cannot move this bot, and crash the process |
| **Wrong altitude** | Asked to "walk through a door", it wrote movement code instead of calling `nav.navigateTo` |
| **Unverifiable** | Success = "the code ran without throwing", which is not the same as the goal being met |
| **Silent 9B tax** | Odyssey measured that an 8B model is *largely incapable* of generating executable code unaided; this repo's own note is that the write gate proves code RAN, not that it was CORRECT |

The insight this repo keeps re-learning: **reliability came every single time from moving
reasoning out of the prompt and into deterministic code** (VERIFIED TRAVEL, the `!endGoal`
verification gate, `!progressTo`'s resolver). Free-form codegen moves it the other way.

## The idea: a playbook is a recipe, not a program

A **playbook** is a named, parameterised, *declarative* sequence of existing commands with an
explicit success test. The model does not write code — it **fills in a form**. Think of it as
the difference between "write me a program that makes a shelter" and "here is the shelter
recipe; tell me where."

```yaml
# playbooks/igloo.yml
name: igloo
description: Build a snow shelter with a door, big enough to sleep in.
params:
  x: {type: int, doc: centre x}
  z: {type: int, doc: centre z}
  y: {type: int, doc: floor level, default: surface}
requires:                                    # checked BEFORE anything runs
  - blocks: snow_block, count: 250           # or creative
steps:
  - do: serverFill(snow_block, x-3, y,   z-3, x+3, y,   z+3)   # floor
  - do: serverFill(snow_block, x-3, y+1, z-3, x+3, y+4, z+3)   # shell
  - do: serverFill(air,        x-2, y+1, z-2, x+2, y+3, z+2)   # hollow
  - do: serverFill(air,        x,   y+1, z-3, x,   y+2, z-3)   # door
  - do: navTo(x, y+1, z)                                       # walk in
verify:                                      # the playbook is DONE only if this passes
  - region(x-2, y+1, z-2, x+2, y+3, z+2) is air     >= 95%
  - bot.inside(x-3, y+1, z-3, x+3, y+4, z+3)        == true
on_fail:
  - say: "Igloo incomplete: {reason}"
```

The model's entire contribution is `!play("igloo", x=-2573, z=5269)`. Everything hard — the
geometry, the ordering, the verification — is authored once by a human (or by *me*, with review)
and then reused forever.

### Why this beats codegen for a 9B model

1. **Filling a form is the easy task; writing a program is the hard one.** Parameter
   substitution is exactly what small models are reliable at.
2. **Verification is built in, not remembered.** `verify:` is a first-class field, so "done"
   means the world says so — the same gate that stopped Andy claiming a 60×60 floor it never
   built.
3. **Reuse compounds.** Today's igloo becomes tomorrow's `shelter` primitive. The Voyager result
   this repo already cites: the *library* transfers (+40%); the *self-authoring* does not.
4. **Bounded blast radius.** A playbook can only invoke registered commands — it cannot call the
   broken pathfinder, cannot spawn threads, cannot crash the process.
5. **Reviewable and diffable.** A recipe is a text file in git. Generated code was written to a
   directory that resets on boot and is never read again.
6. **Cheap in prompt tokens.** One line per playbook in `$COMMAND_DOCS` instead of ~100 function
   signatures in `$CODE_DOCS`.

### Outside-the-box bit: playbooks are *learned*, not just authored

The interesting move is closing the loop **without letting the model write code**:

- **Record mode.** When the operator or the model drives a successful sequence by hand, the
  agent already has the transcript. `!recordPlaybook("igloo")` snapshots the commands that ran
  between start and a passing verification, and offers them as a draft recipe — coordinates
  auto-generalised into parameters by diffing against the bot's position.
- **The model may PROPOSE, never EXECUTE unreviewed.** A drafted playbook lands in
  `playbooks/proposed/` and is inert until promoted. That is the same posture as the steering
  system: *"a self-prompting loop rewriting its own standing instructions is self-corruption"*.
- **Promotion is earned by evidence**: a proposed playbook must pass its own `verify:` block N
  times before it becomes callable. Failure counts are recorded per playbook (`S/F` tallies, as
  in the XENON finding this repo cites — algorithmic correction 0.97 vs LLM self-correction
  0.12–0.30).

This gives the *benefit* people want from codegen — the agent gets better at things it has done
before — with none of the "9B writes a program at 2am and kills the process" risk.

### `!newAction` keeps a job, a smaller one

Do **not** delete it. Narrow it:

- It becomes the **last** resort, documented as such, after "is there a playbook?" and "is there
  a command?".
- Give it the `code_timeout_mins` it already has plus a **hard process guard**: run generated
  code with the pathfinder API absent from its compartment endowments (it cannot move the bot
  the broken way), and with `bot._client.write` blocked (it cannot forge packets).
- On success, prompt the *operator*: "that worked — save as a playbook?" Codegen becomes a
  **playbook factory**, not a runtime.

## Sketch of the implementation

| Piece | Where |
|---|---|
| `playbooks/*.yml` | new top-level dir, in git, reviewed like code |
| `src/agent/library/playbook.js` | pure: parse, validate params, expand expressions (`x-3`), resolve step list. Unit-testable with zero bot. |
| `src/agent/library/playbook_runner.js` | executes steps via the existing command registry, checks `verify:`, returns a VERIFIED line |
| `!play(name, args...)`, `!playbooks` | `actions.js`, `runAsAction(fn, true, 30)` |
| `verify:` predicates | reuse `verifyRegion` (already exists and already gates `!endGoal`) plus inventory diffs |
| `!recordPlaybook(name)` | reads the action transcript the agent already keeps |

Expression support stays deliberately tiny: integer arithmetic on parameters (`x+3`), nothing
Turing-complete. The moment a playbook needs a loop, that is a signal it should be a *skill* in
`skills.js`, written by a human, not a recipe.

## Verification

- Pure tests: parameter substitution, arithmetic expansion, missing-param rejection, unknown
  command rejection, `verify:` predicate evaluation against a fake world.
- Live: `!play("igloo", x=..., z=...)` on flat ground must produce the same result the manual
  sequence did today, and must **fail loudly** if snow runs out mid-build.
- Regression: a playbook referencing a non-existent command must be rejected at *load* time, not
  at step 4 of 5 in the field.

## Risks

- **Recipe rot**: a playbook referencing a renamed command breaks silently → validate every
  playbook against the command registry at boot, and fail the boot loudly.
- **Over-parameterisation**: recipes that take 12 arguments are programs in disguise. Cap it.
- **The model calls the wrong playbook**: same failure mode as calling the wrong command, and
  the same mitigation — good `description:` fields, which are what gets embedded and retrieved.
- **False confidence from `verify:`**: a weak predicate ("some snow exists") is worse than none.
  Every playbook's verify must be able to *fail* the thing it checks; test that it does.
