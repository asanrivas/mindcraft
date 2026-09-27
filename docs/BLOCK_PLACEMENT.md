# Block placement — we own it

Why `bot.placeBlock` is unusable for anything time-critical here, what `block_io.js` /
`place_packet.js` do instead, and the three defects that only fail in combination.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

### Block placement - we own it

Full engine: **`src/agent/library/block_io.js`** (and `place_packet.js`). Same decision as
`container_io.js`, and the same underlying defect: mineflayer wraps a fire-and-forget packet in
an await this server does not satisfy, then reports the missing confirmation as a failed action.

**Never call `bot.placeBlock` for anything time-critical.** Three defects, and they only fail in
combination - which is why none was visible alone:

- **It burns the whole window on an ack.** It writes the packet, then blocks up to 500ms on a
  `blockUpdate:` event (`place_block.js:13`) and throws if none arrives. A jump is ~900ms, so one
  failed attempt consumed the flight and there was never a retry. The packet had already gone.
- **`_genericPlace` awaits a SMOOTH `lookAt`** before writing the packet (`generic_place.js:36`,
  `forceLook` undefined). That multi-tick turn alone outlasts a jump's apex.
- **The body must clear the cell being filled.** Pillaring targets the feet cell and the bot is
  1.8 tall, so at +0.5 the hitbox overlaps and the server refuses - as a missing confirmation,
  the hardest failure to read.

A clean bot placing at +0.5 nonetheless succeeds 4/4 here, **by accident**: the smooth look
delayed the packet until the body had risen clear. Forcing the look broke placement, and that is
how the real clearance requirement surfaced. Do not "optimise" one of these without the others.

What we do instead: write the packet, snap the look, wait for the hitbox to clear, confirm by
**reading the world**, and pace the packets - the server rate-limits interactions and silently
drops the excess (`blueprint_builder.js` found the same independently: *"the API can throw after
a successful placement - re-read before believing it"*).

Measured: `PILLAR TEST: +5.00 of 5` where the old path managed +0.00.

Pure parts are unit-tested in `tests/block_io.test.mjs` (`bodyClearsCell`, `placeGapRemaining`)
and `tests/place_packet.test.mjs`.


---

# Building a blueprint: the three things that are not placement

`block_io.js` answers "can this one block be put here". A blueprint asks three further questions,
and each one was a separate expensive failure on the Wizard Tower (`blueprints/wizard_tower.json`,
8,335 cells, origin 4570/63/4594).

## 1. Is the block facing the way the blueprint asked?

Every verification in `blueprint_builder.js` compared the block NAME and nothing else - `placeOne`'s
return value, `blueprintStatus`'s match count and the final `VERIFIED BUILD` tally - so a tower of
correctly-named, wrongly-facing stairs reported as a clean build and `!buildStatus` agreed. The
repo's dominant bug shape exactly: measure something true, conclude something false.

Root cause was one line below this file's subject. `bot.look(yaw, pitch, true)` rotates the entity
**locally** and does not write a `look` packet; the physics tick sends one eventually, but
`block_place` had already overtaken it, so the server derived `facing` from the rotation left over
from the PREVIOUS placement. `block_io.snapLook` now writes the packet itself.

Measured with `tools/facing_probe.mjs`: **4/28** look-steered facings correct before, **22/27** with
the packet write alone, **33/33** with the write plus one physics tick. The predicate that made any
of it visible is `orientationMismatch` (`tests/facing_verify.test.mjs`); it deliberately ignores
`shape`, `waterlogged` and slab `type`, all of which the server derives, because a false positive
there re-places a correct block on every pass forever.

### 1a. Visible is not fixed: the skip that froze 339 cells

`orientationMismatch` made wrong facings visible and the reporting duly showed **339 of the wizard
tower's 8335 cells (4.1%)** holding the right block pointing the wrong way. They then survived four
more runs and nine retry rounds, because `placeOneCore` opened with

```js
if (existing.name === p.name) return { ok: true, skipped: true };
```

One line, comparing the NAME only, in front of every retry and every resume. Each pass looked at
those cells, saw a `spruce_stairs` where a `spruce_stairs` belonged, and reported `skipped: already
correct`. **The reporting could see the defect and the repair path could not reach it** - and the fix
for the underlying misplacement had already shipped (4/28 → 33/33), so they were repairable the whole
time and nothing ever tried. The decision now lives in the exported `cellIsDone`, asserted directly
in `tests/facing_repair.test.mjs`: a mutation restoring the old line leaves a suite that tests only
`orientationMismatch` **fully green**, which is why the skip itself has to be the thing under test.

The repair is bounded at `FACING_MAX_REPAIRS = 2` per cell, because it is destructive - it digs a
block that is at least the right kind, and a re-place that fails leaves a hole where a merely
wrongly-oriented block stood.

### 1b. The angle comes from the blueprint, not from where the bot stands

`lookVecFor(p)` has always known the exact horizontal direction the server must see. The mistake was
*how* that was applied: walk to a stand point on the far side of the cell, look naturally at the
click point, and let the yaw fall out. But `goNear(approach)` is allowed to fail and fall through to
`goNear(P)`, which reaches the cell from whatever side happens to be open - so the facing came from
the approach direction, unsteered and unrecorded. Inside a tower that is the common case.

Yaw and the click cursor are **independent fields** of the place packet, so the angle is simply sent:
`snapLook(bot, point, yawOverride)` takes the horizontal angle from the caller and still aims the
**pitch** at the click point, leaving the cursor - which carries `half`, the hinge and the clicked
face - untouched.

The comment that used to justify position-steering cited "94% blockUpdate timeouts with a horizontal
forced yaw", read as the server rejecting an implausible click ray. **That reading does not survive
what this file documents elsewhere:** a missing `blockUpdate` is this server's NORMAL answer to a
correctly-predicted placement, and routing around that same unsatisfiable await is why `block_io`
writes the packet itself. Those timeouts were never evidence of rejection.

### 1c. Not every orientation comes from the yaw

Classifying all 339 by the mechanism the server actually uses:

| derived from | cells | fix |
|---|---|---|
| the player's **yaw** (stairs, trapdoors, doors, gates, chests, barrels, bookshelves, pots, anvil) | 273 | send the blueprint's angle |
| the **clicked axis** (logs, stripped logs/wood, chains) | 45 | restrict the candidate faces |
| the **clicked face** (amethyst buds and clusters, lightning rods, buttons, skulls, grindstone) | 21 | restrict the candidate faces |

The mix inside a single class is the diagnostic: `spruce_stairs` came back 8x inverted AND 8x
perpendicular. A class wrong on all four cardinals is a sign error in `lookVecFor`; a class wrong
*inconsistently* is the approach point, which is what pointed at 1b.

For the other 66, `chooseFaces` was treating its face list as "ways to get the block in, best first"
and `placeOneCore` walks it on a refusal. For a block whose state is read **off the clicked face**
that is wrong: an alternate face is not another way to satisfy the blueprint, it is a way to place
the wrong block. So those lists are now filtered, and **may come back empty** - which fails the cell
into the retry pass as `no solid neighbor`, the honest description, where later layers routinely
supply the missing neighbour.

The amethyst case shows why the filter had to be added rather than just applied: the buds want
`facing: down` (hanging from a ceiling) but carry **no `face` and no `hanging` property**, so both
branches that handle ceiling attachment missed them, and the generic order clicked the floor below -
`facing: up`, every time.

### 1d. Before any of it: what has to come OUT

`grass_block -> dirt` was the largest single difference the verifier reported (149 cells) and it is
not a placement fault at all. The clear phase was gated on the resume check:

```js
const resuming = sampled >= 20 && presentPct >= 25;
if (meta.size && !resuming) { ...clear natural terrain from the lower layers... }
```

"The site is 95% built" is true. "Therefore no terrain intrudes" does not follow, and the two are
independent: a tower can stand finished to its roof while its bottom layers are still buried in the
hillside it was sited on. The preflight had been saying so on every run —

```
origin y=63 is 3 below grade (median surface 66) - about 4725 cells of terrain to clear
```

— and every run then resumed at 95% and skipped the clear. **1304 of the blueprint's 1999
`grass_block` cells sit at local y=0**, under three blocks of untouched ground.

Read back from the live world at `(4571,63,4595)`, a `grass_block` cell: y=64 **solid**, y=65 air,
y=66 air — and the blueprint places nothing at local `(1,1,1)`, so that solid block is leftover
ground rather than part of the build. It cost twice over: the cell is unreachable, because a flying
bot cannot hover inside rock (`out of reach (no clear hover within range)` was pass 1's largest
failure class), and grass with an opaque block directly above decays to dirt.

The clear now runs regardless of resume. That is close to free when there is nothing to do — the
scan is `blockAt`, local and synchronous, and the bot only flies to cells it actually found holding
terrain. `tests/build_clear.test.mjs` covers `layerClearTargets` **and the call site**, because the
bug was never in the helper: restoring the `!resuming` guard left every assertion about the helper
passing.

**A correction worth recording, since it nearly caused a wrong fix.** The first diagnosis here was
"the blueprint asks for grass under grass, so 1083 cells are unsatisfiable and the real ceiling is
87%". That was wrong twice: vanilla `GrassBlock.canBeGrass` inspects **only the block directly
above** (darkness alone does not kill grass, it only stops it spreading), and the check that
produced 1083 scanned the whole column. Measured properly against `minecraft-data`'s `filterLight`,
**zero** of the blueprint's grass cells have an opaque blueprint block above them. The blueprint was
fine; the ground was in the way.

### 1e. Where to build: act on the preflight, do not log it and carry on

The preflight has long computed the right origin and then built at the wrong one. The cathedral,
2026-09-24, was started at y=63 because that is where bob was standing when asked:

```
preflight: origin y=63 is 3 above grade (median surface 60) - the base will float or need fill.
           Suggested origin y: 60
```

Logged, then ignored. What it cost, measured: **3,055 foundation columns** needing ~3 blocks of
cobblestone each — roughly 9,200 blocks and four hours — to fill a gap that does not exist at grade.
The fill also ran down through a pond at y=61, which is how bob ended up submerged and how the
drowning interrupt killed the process. It had been started once already, at (892,64,4653), twenty
blocks away with overlapping footprints, because the model picked coordinates from wherever bob
stood each time.

`decideSite` now decides, before a block moves, **for a fresh site only**:

- **Off grade → build at the grade**, and say so in the log and the final report. Only y moves;
  x and z are where the build was asked for.
- **Wet → refuse**, with the count and "pick dry ground". The water check traces exactly what
  `placeFoundation` will fill — down from the base to the first solid block, up to 8 deep — because
  checking only the base plane is how the cathedral's pond went unseen: its plane at y=63 was dry.
  A puddle (fewer than `wetLimit`: 2 columns, or 2% of the sample) is filled; a pond is refused.

**A site already under way is never moved or refused** — that strands the work. "Fresh" needs
positive evidence: at least 20 readable cells and under 5% of the blueprint already standing. An
unloaded site is not a fresh one.

`bots/<name>/build_sites.json` records where each blueprint was started. A later request for the
same blueprint whose footprint **overlaps** the recorded one resumes there instead of starting a
second copy beside it. The test is exact — footprints intersect — not a radius.

Pure and tested (`tests/build_site.test.mjs`), including the call site's order of operations: the
ledger is read before `ctx` derives anything from `origin`, and a refusal returns before flight
begins, so there is nothing to stand down but the mode pauses.

- **Out of reach → refuse.** `placeFoundation` fills at most `FOUNDATION_DEPTH` (8) below the
  base, then skips the column — and used to do so silently. Measured on the cathedral, 2026-09-25,
  from the live world: of 3,055 ground-layer cells, 1,927 dry and supportable, 511 wet but in reach,
  and **617 over a lake 9 to 26 blocks deep**. `foundation: 2607 support blocks placed` was true;
  the 617 it could not reach were never mentioned, and the passes then failed on them one at a time
  (802× `no solid neighbor (... below=water ...)`) until the watchdog stopped the build at 5.9%.
  Water or air makes no difference to that fault — a dry cliff edge deeper than the reach fails
  identically, and the water check alone would have passed one — so the trace now counts columns
  with no ground in reach as their own reason to refuse, and the foundation reports every column it
  skips. An unloaded column is reported as unreadable, never as out of reach.

### 1f. Watching a build while it runs

Every question that decides what to do about a running build — how fast, how long left, placing or
only failing, which failure dominates *now*, is it stuck — used to be answerable only by grepping a
shared log, after the fact. A crash, a hang and a watchdog stop all looked identical from outside: a
status file that stopped changing. Now one telemetry object per build
(`src/agent/library/build_telemetry.js`) feeds four views:

| where | what | for |
|---|---|---|
| the web UI, `http://<host>:8080` | a build panel above the agent cards: phase, progress, rate, pass ETA, dominant failures, a placements-per-minute chart | watching |
| `bun tools/build_status.mjs [--watch] [--json]` | the same snapshot in a terminal, with a trend sparkline | a session, a script |
| `bots/<name>/BUILD_STATUS.json` | the current snapshot, rewritten at most once a second | watchers |
| `bots/<name>/BUILD_METRICS.jsonl` | one sample every 30s, rotated at 5 MB | trends after the fact |

Things it gets right on purpose, each learned the hard way within minutes of shipping:

- **The rate is a 5-minute sliding window**, never a since-start average: a build that ran fast for an
  hour and then stopped placing must read as zero, not 25/min.
- **Every phase that does per-cell work records attempts** — the terrain clear and the foundation
  too, not only the passes. The first version counted only the passes, so the foundation reported
  `50 placed` beside `0/min` and a flat trend. It also wrote its status every 25th placement, so a slow
  stretch looked like a hang to the stall watcher. Status writes are now per attempt, and
  `writeStatus` throttles itself to once a second.
- **Staleness is the file's mtime**, not a timestamp compared against a clock read another way. The
  terminal tool says `STALE` outright rather than printing an old snapshot as if it were current.
- **How it ended is recorded** — done, stopped by the watchdog, interrupted by a mode, threw, refused —
  because otherwise every one of those is just silence.
- **The ETA covers the current pass only**, from the attempt rate. Across passes it cannot be known —
  the retry rounds' size depends on how many cells fail — so it is not pretended.

## 2. What order, and the two problems people conflate

Sorting by `y, x, z` is wrong twice over, for two unrelated reasons.

**Travel.** A raster crosses the whole footprint on every row and each crossing is a flight leg that
can wedge. `orderForBuild` slices by layer, does infill before perimeter, and chains nearest-first:
survival_base 10718 → 5803 blocks (54%), wizard_tower 29422 → 13285 (45%), cathedral 331214 → 73156
(22%). Asserted per blueprint in `tests/build_order.test.mjs`, with per-footprint ceilings rather
than one blanket ratio - the raster penalty grows with the footprint.

**Buildability.** A nearest-neighbour chain rings out to a fresh cluster whose first cell has no
placed neighbour, which produced `161x"no solid neighbor (self=air below=air/empty)"` - 45% of all
failures. `grow()` fixes it: a cell is READY when the layer below holds a blueprint cell or a
same-layer neighbour was already emitted, and ready cells are taken nearest-first. Under 3% of cells
then start a region with nothing beside or below.

Interleaving walls and interior fittings at the same height is the third-order version of the same
mistake: the shell closes around the bot while it is still working inside, and it has to fly back
INTO a sealed room. That cost 23 hours on 2026-09-21 - 5,238 `flyNear ... failed` lines and
`140-216x out of reach (no clear hover within range)` per pass.

## 3. One pass is not a build — and the retry gate was inverted

**31% of the cells in layers 6-14 have no blueprint cell below them.** Three runs stopped at the
same wall; the last said so in one line - **1,887 of 1,969 failures (96%) `no solid neighbor`**,
watchdog-stopped at **46% verified (3,815/8,285)**.

The obvious reading is that the geometry is unbuildable. It is wrong, and the correction is the
most useful thing in this section. Replaying the real build order over the real blueprint
(`tests/build_support.test.mjs`), placing a cell only when something solid is already beside or
below it and - crucially - **not** adding a cell that could not be placed:

```
pass  1: + 2569  total 2569/8335 (30.8%)
pass  2: + 5214  total 7783/8335 (93.4%)
pass  3: +  452  total 8235/8335 (98.8%)
pass  4: +   37  total 8272/8335 (99.2%)
...
pass 11: +    0  total 8306/8335 (99.7%)   <- fixed point
```

A blueprint is built from the ground up, so a cell whose support has not been placed **yet** fails
for a reason the next pass removes. Pass 1 lands at 30.8%; the live run landed at 28%, which is what
makes the rest of the curve credible. **Only 29 cells of 8,335 are genuinely impossible.**

So why did the live build stop at one pass? The retry was gated on
`failures.length < buildable.length / 4`, with the comment *"if MOST blocks failed the problem is
systemic and retrying thousands of 20s fly-and-wait attempts would pin the agent for days"*. The
instinct is right; the test is exactly backwards. **The more cells fail for want of a support, the
more the next pass has to gain** - so the gate switched the retry off precisely in the case it
exists for. At 3,453 failures of 8,285 (42%) the retry list was empty on all three runs.

The honest stopping rule is the one this repo already states for retries: **reset on a change in the
INPUTS, never on a clock or a count.** A pass that placed blocks changed the inputs for every cell
that touches them, so it earns another. A pass that placed nothing did not, and no number of further
passes can learn what it failed to. `progressVerdict` still bounds the inside of each pass;
`MAX_RETRY_ROUNDS` (14, against a measured fixed point of 10) bounds the outside.

### Temporary supports: the last 0.3%

`planSupportChain` is a breadth-first search from the target through cells that are empty **and not
reserved by the blueprint**, stopping at the first one with something solid beside it. It returns
the chain anchor-first, so placing it in order gives every link the previous one to click against.

**They are a last resort, and the ordering is worth real money.** Supporting a cell the moment it
reports `no solid neighbor` spends a flight leg, a placement and a dig on a face the next pass was
about to produce for free. Measured on the same tower, both finishing 8,335/8,335:

| when supports are allowed | rescues | temporary blocks |
|---|---|---|
| eagerly, from pass 1 | 99 | 114 |
| only once retrying stops paying | **10** | **13** |

So `buildBlueprint` sets `ctx.allowSupports` only when a whole retry round has gained nothing, and
gives it one more round.

Three things must not happen, and each is handled differently:

- **A support standing in a cell the blueprint wants** would be dug out at teardown and read as a
  hole. Prevented by construction - `isFree` excludes `ctx.occupied`.
- **A support left standing** is an unwanted block in a finished build that the verified percentage
  cannot see, because it is not a blueprint cell. Every support is recorded the moment it lands;
  teardown runs in a `finally`, clears the record only after **re-reading the cell**, and treats an
  unloaded chunk as "not yet", never as "gone". Anything still on the books gets a sweep once the
  build is over and a line in `VERIFIED BUILD` if it survives that.
- **A block that only stands up BECAUSE of its support** - a torch, a sign, a lantern, sand - would
  be placed, verified and destroyed on every pass forever. A name list catches the obvious cases so
  they never cost a round trip, but a list cannot know which of 8,335 cells depends on a neighbour,
  so it is **measured**: the block is re-read after teardown, and a name that does not survive goes
  into `ctx.supportUnsafe` and is never supported again this run.

**Why dirt and not scaffolding.** Scaffolding is the obvious material and it does not work here.
Measured with `tools/scaffold_probe.mjs`: `tower 1/6 | climb 1.00 | chain-break YES | reach 1`. One
block places on any solid support and breaking the bottom of a column clears the whole thing in one
dig - both ideal - but **stacking is refused**: clicking a scaffolding block while holding
scaffolding is rejected, acked in 16-59ms so it is a decision and not a timeout, identically through
our own packet path AND mineflayer's. `/setblock` holds the same stack happily, so the position is
legal; it is the placement that is refused, because scaffolding is self-replaceable and the click
resolves onto the block you aimed at rather than the cell beside it. Dirt stacks, `scaffoldTo`
proves it every run, and in creative it costs nothing now that `restockPillar` tops it up.

## Say it before a block moves, and stop when nothing is moving

`preflightBuild` reads the site and reports in one line each: names this version cannot place, the
origin against the median surface (with the corrected y), water at the base plane, and columns
standing on built blocks. It would have caught, at zero cost, all three of: `chain`→`iron_chain` and
`grass`→`short_grass` renamed by Mojang (45 placements across two blueprints, traced by hand); an
origin one block below grade (two full terrain-clear layers over a 45x35 footprint, found by looking
at a screenshot); and a footprint overlapping an existing build.

`progressVerdict` stops the build after 200 consecutive attempts that placed nothing and names the
dominant reason. It is what turned the third tower run from a grind into a diagnosis. Its companion
`normaliseWhy` matters more than it looks: the failure tally keyed on the raw string, so one cause
reported as its own top three - `20x"refused by server (ack 42ms)" 14x"...(ack 41ms)"
12x"...(ack 40ms)"`. Ack timings, coordinates and counts are collapsed; genuinely different causes
are not.

Both are pure over injected probes and asserted in `tests/build_preflight.test.mjs`, including the
cases that must stay QUIET - a preflight that cries wolf on good ground, or a watchdog that stops a
build which is merely slow, would each be worse than nothing.

## 1g. One block with nothing to attach to: `!placeWithSupport`

`!placeWithSupport("oak_log[axis=z]", x, y, z)` (creative only) places ONE block through the same
path a blueprint's retry rounds use (`placeWithSupport` in `blueprint_builder.js`): try it plainly;
if there is no face to click, build a temporary dirt chain from the nearest solid block to a face
the block may be clicked FROM (`supportDirs` - a log's axis end, a wall block's wall), place it,
tear the chain down, and re-read the world. Blocks that fall or pop off without their support
(anvils, sand, torches, levers...) are refused up front - they need a permanent support.

Why it exists: the cathedral finished at 99.6% with ~70 window grilles hanging in air, and the
support chain was only reachable from inside a build. Why `supportDirs` exists: a support that ends
below an axis=z roof beam is useless - `chooseFaces` only lets the beam be clicked on a z face -
which is how 412 supports rescued 3 placements before it (2026-09-26); after it, 18 of 18.
Verified live on (914, 68, 4650): pane placed, support cell back to air, by `execute if block`.
Tests: `tests/temp_support.test.mjs`, `tests/build_support.test.mjs`.
