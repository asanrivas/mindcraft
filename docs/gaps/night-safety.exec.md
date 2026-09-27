# Night safety — execution plan (2026-08-31)

Supersedes the accounting in `docs/gaps/night-safety.md` (drafted 2026-08-22, header still says
"PLAN — nothing implemented"). **That header is now false: nearly all of it shipped.** This doc
is (1) the audited SHIPPED/PARTIAL/NOT DONE table against current code, and (2) a plan for the
genuine remainder only.

All claims below were verified by reading the code, not CLAUDE.md. Line numbers are as of
branch `feature/llm-failover` @ 3f00431 (plus uncommitted working-tree state).

---

## 1. Accounting: the 2026-08-22 plan vs. the code today

| # | Old-plan item | Status | Evidence (file:line) |
|---|---|---|---|
| §1a | Pure module `night.js`: `DUSK`/`MOBS_SPAWN`/`DAWN`, `isNight`, `canSleepAt` (thunder), `isBedName` (suffix, not includes), `bedInInventory` | **SHIPPED** | `src/agent/library/night.js:15-49`. `isBedName` is `endsWith('_bed')` (night.js:43-45); `bedrock` fails, tested. Bonus not in plan: `isDuskApproaching` (:33) and the `decideNightAction` decision table (:94-106). |
| §1b | `pickShelterSpot` (injected blockAt; refuse water/lava floor, falling-block roof, unloaded chunks) | **SHIPPED** | `night.js:62-91`; `UNSAFE_FLOOR` set :53, `isFallingBlockName(aboveSeal)` :86, `null` (unloaded) → skip :83. |
| §1c | `torchRing(origin, radius)` geometry | **NOT DONE** | No such export in `night.js` (only 8 exports, :15-94). Nothing else provides ring/grid torch geometry. |
| §2a | `night_safety` mode, after `self_defense` / before `hunting`, `interrupts:["all"]`, the planned `excludeFromInterrupt` list | **SHIPPED** | `src/agent/modes.js:411-546`; slot comment :407-410; exact planned exclude list :417-421 (`mode:drowning/self_preservation/self_defense`, `action:goToBed/shelter/surface/fill/plantTrees/!stay`). |
| §2b | Cooldown on failure, `execute(..., 3)` never `-1`, hostile stand-off, water deferral, dawn dig-out path | **SHIPPED, improved** | Water :481; hostile stand-off + 8s cooldown :500-503; dawn dig-out :450-455; `execute` timeout 3 at :536. Improvement over the plan's flat 20s: escalating `[20000, 60000]` backoff then `gaveUp` latch after 3 failures (:512-535), reset only in FULL daylight (:445-449, the `!isNight && !isDuskApproaching` fix), `unpause()` clears the latch (:538-544). |
| §2c | Wake behaviour: don't pin the action all night; 90s hold release | **SHIPPED** | `sleepUntilMorning(bot, 90000)` `src/agent/library/skills.js:3617-3624`; called from goToBed :3597; mode's `if (bot.isSleeping) return` modes.js:433. |
| §2d (unplanned, added later) | Stand-downs: Peaceful world; human online & awake; already deep (>8) underground; already under a roof — all AFTER the dawn dig-out | **SHIPPED** | `isPeaceful(bot.game)` modes.js:466 (via `src/agent/difficulty.js`, tests/difficulty.test.mjs); `humanAwakeOnline` def :57-67, call :478 (skips other agents via `convoManager.isOtherAgent`); depth via `nav.surfaceY` :488-493; `hasRoofOverhead` def :48-55, call :497. Ordering asserted in tests/modes.test.mjs:70-71,168-170. |
| §3a | `goToBed` rewrite: `isBedName` matcher, walk via `nav.navigateTo` not pathfinder, catch/classify `bot.sleep` errors, unstuck pause in try/finally, `VERIFIED SLEEP` line, result object | **SHIPPED (code)** | `skills.js:3548-3607`: findBlocks with `night.isBedName` :3557-3561; `nav.navigateTo(..., {arriveDist:2})` :3569; monsters/daytime/occupied classification :3581-3593; `pause('unstuck')` :3595 with `unpause` in `finally` :3602; `VERIFIED SLEEP` :3599. Dimension guard :3552-3555. |
| §3b | `nightRoutine`: dimension guard, bed → place-bed → shelter ladder | **SHIPPED** | `skills.js:3797-3838`; drives the pure `decideNightAction` (dimension handled at night.js:100-101 → `'shelter'`); sleep→shelter fall-through :3821-3826; place_bed via `placeNearby` (two-cell aware, `TWO_CELL_BLOCKS` skills.js:5199, `placeNearby` :5211) :3828-3833. |
| §3c | `nightRoutine` step 5: one torch at the bed/shelter site | **NOT DONE** | `nightRoutine` (skills.js:3797-3838) contains no torch placement. (Marginal: a sealed 1×1 hole can't spawn mobs, and a wake at dawn is daylight. See remainder R4 — demoted to optional.) |
| §4 | `emergencyShelter`/`digOut` | **SHIPPED, superseded (better)** | `skills.js:3697-3793`. Beyond the plan: `shelterFeasibility` BEFORE ground is broken (:3666-3694, incl. `tools.canBreak` keep-the-drop test and harvest-a-wall-block fallback), depth **3 not 2** (:3730-3741 with rationale), `settleY` measured descent (:3639-3652, `descended < 2.5` :3742), never-leave-an-open-pit climb-back-out (:3745-3782), `digOut` climbs 3 (:3785-3792). All asserted in tests/modes.test.mjs:115-151. |
| §5a | Verify light bug; use real light if usable | **SHIPPED** | Chunk light IS usable: `world.torchIsWorthIt(blockLight, skyLight, timeOfDay)` `src/agent/library/world.js:569-577` (pure); `isDarkEnoughForTorch` :598-627 reads `bot.world.getBlockLight/getSkyLight`, fails OPEN on unloaded/missing/throw; wired into `shouldPlaceTorch` :630-642. Verified live per world.js:562-563 (`block=0 sky=14 timeOfDay=17697`). |
| §5b | Night/underground gate on torching | **SHIPPED (via light, better than the plan's gate)** | `torchIsWorthIt` handles all quadrants: underground skyLight≈0 → torch any time; surface day → no; surface night → yes; unscaled-sky-light + timeOfDay pairing world.js:573-576. tests/torch.test.mjs covers all four quadrants + boundaries 12999/13000/22999/23000. |
| §5c | `torch_placing` to place via `placeNearby` instead of `placeBlock` at own cell | **NOT DONE (dropped, acceptable)** | modes.js:679-691 still `skills.placeBlock(..., pos.x, pos.y, pos.z, "bottom", true)`. The old plan itself noted torches are non-solid so this works; no observed failure since. Do not spend time here. |
| §6 | Morning resume via existing machinery (mode pauses, doesn't end; resume ownership) | **SHIPPED** | `src/agent/action_manager.js:170-172,191`: `ownsResume` check — a mode-authored completion no longer wipes another action's resume. Plus `resume_author` :16,77. (This landed for torch_placing-vs-follow; night_safety rides the same rail.) |
| §7a | `!goToBed` fixed: timeout 3 (never -1), stand-down guard, VERIFIED-ish string | **SHIPPED** | `src/agent/commands/actions.js:1248-1258`: guard `modes.isActive('night_safety')` :1252-1254; `runAsAction(fn, false, 3)` :1257. Alias `gtb` `src/agent/commands/index.js:61`. |
| §7b | New `!shelter` with same guard | **SHIPPED** | `actions.js:1260-1268`; same guard; timeout 3; returns `VERIFIED SHELTER: sealed.` / reason. |
| §8a | Pure tests: `isBedName`, `canSleepAt`, `isNight` boundaries, `pickShelterSpot`, decision table | **SHIPPED** | `tests/night.test.mjs` (103 lines): bedrock regression, clock boundaries, thunder-at-noon, full `decideNightAction` table incl. nether/end refusals, shelter siting (water/lava/sand-roof/unloaded refusals, step-aside). `tests/torch.test.mjs` (57 lines). Mode structure: tests/modes.test.mjs:66-151 (Peaceful, backoff, daylight reset, feasibility-before-dig, dig-3, settleY, climb-back-out). |
| §8b | Mode-shape test: order (after self_defense, before hunting) and `excludeFromInterrupt` contents (`mode:self_defense`, `action:goToBed`) | **PARTIAL** | modes.test.mjs slices `night_safety`→`hunting` (:67), which only implicitly pins "before hunting". Nothing asserts "after self_defense", nothing asserts the excludeFromInterrupt entries, nothing asserts the actions.js-side stand-down guards. Remainder R5. |
| §8c | `torchRing` geometry test | **N/A → NOT DONE** | Function doesn't exist (see §1c). |
| §9 | Live verification, 7 scenarios | **PARTIAL** | Verified live (per CLAUDE.md + `scratchpad/night_test.mjs`, which exists and pins the bot to a pad): scenario 3 shelter success (`VERIFIED SHELTER: sealed at (4566,107,4706)` + dawn dig-out), the bare-stone refusal + give-up (3 attempts, no pit), and the Peaceful stand-down (38 guard evals, 0 fires). **NOT evidenced live**: scenario 1 happy-path sleep (no `VERIFIED SLEEP` recorded anywhere), 2 monsters-rejection, 4 place-bed-then-sleep, 5 resume-after-sleep, 6 non-skipping-server 90s release, 7 two-cycle idempotence. Remainder R2. |
| §10a | Bed-explosion dimension guard | **SHIPPED** | Both layers: skills.js:3552-3555 (command path) and night.js:100-101 (mode path); tested (nether/end rows in night.test.mjs). |
| §10b | timeOfDay trust verified once live | **SHIPPED (implicitly)** | The live torch reading (`timeOfDay=17697`, world.js:563) and the Peaceful-night run exercise the same clock. |
| §10c | Spawnpoint-drift note | **SHIPPED (doc-only, as planned)** | Risk note only; no code intended, none present. |

**Counts: 17 SHIPPED, 2 PARTIAL (§8b tests, §9 live), 3 NOT DONE (§1c torchRing, §3c torch-at-site, §5c placeNearby-for-torch — the last dropped deliberately).**

Conclusion: the mode, the skills, the pure layer, the commands, and the refusal tests all exist
and are in most places *better* than the plan (feasibility-first, dig-3, escalating give-up,
four stand-downs). The genuine remainder is small and listed below. **Do not re-implement
anything in the table above.**

---

## 2. Remainder — what is actually left

### R1 (new, found during this audit): join a human's sleep vote — the sleep ↔ "human online" interaction

**The gap.** Vanilla skips the night only when EVERY player is in bed — bots included. Walk the
current guard chain (modes.js:432-513) for the case "a human just got into bed":

- `humanAwakeOnline` (modes.js:57-67) correctly *skips* sleeping players, so it stops standing
  the mode down — good.
- But **`isPeaceful` at :466 returns first on this server**, so on Peaceful the bot never even
  reaches `nightRoutine` → never gets into a bed → **the awake bot blocks the human's night
  skip forever** (unless the server sets `playersSleepingPercentage`, which we must not assume).
- Even on Normal, `hasRoofOverhead` (:497) and the >8-deep check (:488) return before
  `nightRoutine` — a bot standing inside the shared base (the common case at bedtime) never
  joins the vote. `this.gaveUp` (:513) blocks it too after a bad shelter night.

Joining a sleep vote is a *different goal* from self-protection: it is worth doing on Peaceful,
under a roof, underground, and after giving up on shelter — every guard that correctly blocks
*sheltering* wrongly blocks *voting*. So it needs its own branch, placed after the dawn dig-out
and **before** `isPeaceful`.

**PURE (night.js, append):**

```javascript
/**
 * Should the bot get into a bed to complete a night-skip vote a human has started?
 * Distinct from decideNightAction: voting is worth it on Peaceful, under a roof, underground -
 * everywhere self-sheltering is not. The only hard refusals are physical.
 * @returns {'join'|'no'}
 */
export function sleepVoteVerdict({ anyHumanSleeping, timeOfDay, thundering = false,
                                   isSleeping = false, dimension = 'overworld',
                                   inWater = false, hasBed = false }) {
    if (isSleeping) return 'no';                 // already voting
    if (!anyHumanSleeping) return 'no';          // nobody to join
    if (dimension !== 'overworld') return 'no';  // beds explode
    if (inWater) return 'no';                    // drowning mode's territory
    if (!canSleepAt(timeOfDay, thundering)) return 'no';  // server would reject the sleep anyway
    if (!hasBed) return 'no';                    // nothing to vote WITH (nearby bed or one in the bag)
    return 'join';
}
```

**LIVE (modes.js, append one helper next to `humanAwakeOnline` + one guarded block inside
`night_safety.update`):**

```javascript
/** Is a real person currently in bed? Mirror of humanAwakeOnline; other agents excluded. */
function anyHumanSleeping(bot) {
    const players = bot.players ?? {};
    for (const [name, p] of Object.entries(players)) {
        if (name === bot.username) continue;
        if (convoManager.isOtherAgent(name)) continue;
        if (p?.entity?.isSleeping || p?.entity?.metadata?.isSleeping) return true;
    }
    return false;
}
```

Inserted in `update()` **between the dusk gate (:456) and `isPeaceful` (:466)** — additive, no
existing line moves:

```javascript
// A HUMAN IS IN BED: join the vote. Vanilla skips the night only when EVERY player
// sleeps, and this bot counts as a player - an awake bot silently holds a person's
// night hostage. Voting is worth it even on Peaceful / under a roof / after gaveUp,
// which is why this sits above every one of those stand-downs.
if (anyHumanSleeping(bot)) {
    const bedNearby = bot.findBlocks({
        matching: (b) => night.isBedName(b.name), maxDistance: 48, count: 1 }).length > 0;
    const verdict = night.sleepVoteVerdict({
        anyHumanSleeping: true, timeOfDay: t, thundering: bot.thunderState > 0,
        isSleeping: bot.isSleeping, dimension: bot.game.dimension,
        inWater: swim.inWater(bot),
        hasBed: bedNearby || !!night.bedInInventory(bot.inventory.items()),
    });
    if (verdict === 'join') {
        this.cooldownUntil = Date.now() + 30000;   // a failed join must not metronome
        execute(this, agent, async () => {
            if (!bedNearby) {
                const bedItem = night.bedInInventory(bot.inventory.items());
                if (bedItem) await skills.placeNearby(bot, bedItem.name);
            }
            const r = await skills.goToBed(bot);
            say(agent, r.slept ? `Joining the sleep vote.` : `Could not join the sleep: ${r.reason}.`);
        }, 3);
        return;
    }
    // 'no' with a human asleep: fall through to the normal chain (Peaceful etc.). Do NOT
    // return here - the ordinary stand-downs must still run for the non-vote case.
}
```

Notes anchored in existing invariants:
- `goToBed` already handles no-bed/unreachable/daytime gracefully and pauses/unpauses `unstuck`
  in a `finally` (skills.js:3595-3603), so no new failure surface.
- The 30s `cooldownUntil` reuses the existing field; a bed-less bot near a sleeping human costs
  one interrupted action per 30s at worst, and only during the vote window.
- `bot.isSleeping` short-circuit at modes.js:433 keeps the mode quiet once in bed;
  `sleepUntilMorning`'s 90s release (skills.js:3617) already prevents the pin.
- `!goToBed`'s stand-down guard (actions.js:1252-1254) already fences the command side.

### R2: live-verify the sleep path (`goToBed` has never produced a `VERIFIED SLEEP` live)

Not code — procedure, to be run by a human/driver session later (this planning session must not
touch the live bot). What Peaceful does and does not permit:

| Scenario | Verifiable on Peaceful? | Why |
|---|---|---|
| Happy-path `!goToBed` sleep + `VERIFIED SLEEP` line | **YES** | Beds work at night on Peaceful; the *command* bypasses the mode's `isPeaceful` return (actions.js:1248 calls `skills.goToBed` directly). Place bed, `/time set 13000`, `!goToBed`. |
| R1 sleep-vote (human in bed → bot joins → night skips) | **YES — Peaceful is the exact target case** | The vote branch sits above `isPeaceful` by design. This is the one live test where Peaceful makes it MORE meaningful, not less. |
| 90s hold release (server not skipping) | **YES** | Human stays out of bed while bot sleeps via `!goToBed`; watch `still in bed` in the VERIFIED SLEEP line and confirm `!stats` still answers (label not pinned). |
| `!shelter` command success / refusal | **YES** | Command bypasses the mode; already has a rig (`scratchpad/night_test.mjs`). Already verified once — re-run only if the code changes. |
| monsters-nearby sleep rejection | **NO** | No hostiles exist on Peaceful; summoned ones despawn instantly. Covered pure (regex branch skills.js:3581-3584); live check requires a temporary `difficulty normal` window — defer, and never toggle difficulty while other agents share the server without coordinating. |
| mode-driven dusk trigger firing | **NO** | `isPeaceful` return (modes.js:466) is working as designed; its non-firing IS the verified behaviour (38 evals / 0 fires). |
| resume-after-sleep (scenario 5) | **PARTIAL** | The resume rail is generic and already tested (action_manager.js:170-172, tests/action_owner.test.mjs); a Peaceful live pass of `!travel` + `!goToBed` mid-leg exercises the plumbing without needing the mode. |

Deliverable: one driver script `scratchpad/sleep_test.mjs` in the mould of `night_test.mjs`
(pin the bot, place bed via RCON, `time set`, drive `!goToBed` over the MindServer socket, grep
`VERIFIED SLEEP` from `logs/service.log`, and for the vote case put a *fake human* — the
operator's own client — in bed and assert `time query daytime` jumps). scratchpad is a parallel
workstream surface too, so this is a NEW file, touching nothing.

### R3: deliberate area torching — `!torchArea(radius)`

Today torching is only an idle habit (`torch_placing`, modes.js:671-696): one torch at the
bot's own feet, only when idle-ish, only where it happens to be standing. There is no way to
*ask* for an area to be secured (a base pad, a bed site) — the concrete capability the old
plan's `torchRing` was for.

**PURE (night.js, append):**

```javascript
/**
 * Candidate torch positions covering a square area: origin plus a grid at `spacing`, ordered
 * nearest-first. Torch light is 14 and mobs need light 0, so spacing 5 leaves no dark cell
 * between two torches at floor level. Geometry only - the caller filters by world light.
 * @returns {{x,y,z}[]} XZ offsets applied to origin; y copied from origin (caller re-grounds).
 */
export function torchGrid(origin, radius = 8, spacing = 5)
```

(Deterministic, no world access: rows `-radius..radius` step `spacing` in x and z, deduped,
sorted by `hypot`. Cap the return at 25 spots so a huge radius cannot make the command
unbounded.)

**LIVE (skills.js, append one function):**

```javascript
/**
 * Torch the area around the bot so mobs cannot spawn in it. Walks a nearest-first grid; at
 * each spot re-grounds to the walkable surface, asks world.torchIsWorthIt with the REAL chunk
 * light (the same check torch_placing uses - never re-derive it), and places one torch.
 * @param {number} radius   blocks (2..16)
 * @param {number} maxTorches  hard cap; also bounded by torches carried
 * @returns {Promise<string>} `VERIFIED TORCHES: placed n of m spots (k skipped as already lit).`
 */
export async function torchArea(bot, radius = 8, maxTorches = 12)
```

Behaviour, each point reusing an existing verified primitive:
- Refuse with a named reason when: no torches in inventory (`bot.inventory.findInventoryItem('torch')`
  — same probe as world.js:639); radius out of 2..16; bot in water (`swim.inWater` — placing
  while afloat does not work, CLAUDE.md invariant).
- Per spot: `nav.navigateTo(bot, spot, {arriveDist: 1.5})` (skills already do this pattern);
  on arrival re-check light via the same gate `shouldPlaceTorch` uses — expose nothing new:
  call `world.torchIsWorthIt(bot.world.getBlockLight(feet), bot.world.getSkyLight(feet), t)`
  guarded exactly like world.js:598-621 (fail OPEN). Skip lit spots; count them.
- Place with `placeBlock(bot, 'torch', x, y, z, 'bottom')` — the same call torch_placing has
  used safely for months (modes.js:682-690).
- Bail on `bot.interrupt_code` between spots; stop when out of torches; always return the
  measured tally (count torches by inventory delta, not by placements requested — the
  "counts are measured, never requested" chest rule).

**Command (actions.js, append one entry; index.js optional alias `ta`):** see §5 below for the
doc text. `runAsAction(fn, false, 5)` — five minutes for up to 25 short legs, never `-1`.

### R4 (optional, do last or drop): one torch beside a freshly placed bed

In `nightRoutine`'s `place_bed` branch (skills.js:3828-3833) only: after a successful
`placeNearby(bot, bedItem.name)`, if a torch is carried and `torchIsWorthIt` says dark, one
`placeNearby(bot, 'torch')`. Three lines, additive, inside a function this workstream owns.
Explicitly NOT in the shelter path (a sealed 1×1 hole cannot spawn mobs — old plan §4 already
concluded this) and NOT after waking (dawn is daylight; `torchIsWorthIt` would refuse anyway —
which is the pure test that keeps this honest).

### R5: the missing structural tests (old plan §8b) + tests for R1/R3

See §3 below.

### R6: command-doc text per the obedience rules

See §5 below.

---

## 3. Tests to add

All pure/no-network, `bun tests/<f>`. Refusal cases first — for night work the mode that must
NOT fire matters more than the one that must (the Peaceful-tax, elbow_room, and metronome
incidents were all wrong-firing, not non-firing). **Peaceful-vacuity rule**: every test below is
pure or source-structural, so the live server's difficulty cannot make any of them vacuous; the
only Peaceful-sensitive claims are quarantined in R2's live table.

### tests/night.test.mjs (append)

`sleepVoteVerdict` — refusals first:
- no human sleeping → `'no'` (the control: the branch must not exist without a vote to join);
- already sleeping → `'no'`;
- nether/end with human sleeping and bed in hand → `'no'` (bed explosion outranks the vote);
- in water → `'no'`;
- noon, no thunder → `'no'` (server would reject; don't burn an interrupt on it);
- human sleeping at 12100 (before DUSK) → `'no'` boundary; at `DUSK` exactly → `'join'`;
- no bed nearby and none in inventory → `'no'`;
- happy path: human sleeping, night, overworld, dry, bed → `'join'`;
- thunder at noon + human sleeping + bed → `'join'` (thunderstorm sleep is legal).

`torchGrid`:
- radius 8 spacing 5 → contains origin; all offsets within radius; no duplicates;
- sorted nearest-first (first element is origin);
- cap: radius 16 spacing 5 returns ≤ 25 spots;
- radius smaller than spacing → exactly the origin.

### tests/modes.test.mjs (append — source-structural, same style as the existing file)

- **R1 placement**: in the `night_safety` slice, `anyHumanSleeping` appears BEFORE
  `isPeaceful(` (`night.indexOf('anyHumanSleeping') < night.indexOf('isPeaceful')`) — the whole
  point of R1; and AFTER `digOut` (a sealed bot is let out before it votes).
- **R1 must not fire alone**: the vote block is guarded by `anyHumanSleeping(bot)` and calls
  `night.sleepVoteVerdict` (the decision is not re-derived inline); it sets `cooldownUntil`
  (no metronome); its `execute` carries a numeric timeout (the existing every-execute-has-a-
  timeout scan at :28-41 will also catch this automatically — verify it does by count).
- **§8b backfill**: `modes_list` order — index of `name: "self_defense"` < `name:
  "night_safety"` < `name: "hunting"`; night_safety's `excludeFromInterrupt` contains
  `"mode:self_defense"`, `"action:goToBed"`, `"action:shelter"`, `"action:surface"`.
- **§8b command side**: read `actions.js`; both `!goToBed` and `!shelter` slices contain
  `isActive('night_safety')` (the livelock fence has two sides; only the mode side is currently
  asserted anywhere). Also assert `!torchArea`'s slice, once added, does NOT contain that guard
  — torching does not compete with night_safety and must not refuse at dusk.
- `anyHumanSleeping` excludes other agents (`isOtherAgent` inside its function body — slice it,
  don't match the whole file; `humanAwakeOnline` already matches).

### tests/torch.test.mjs (append)

- R4 honesty pair: `torchIsWorthIt(0, 15, /*dawn*/ 23500)` → false (the wake-at-dawn no-op that
  justifies leaving R4 out of the wake path); already partly covered by `23000 is day again` —
  add the explicit dawn tick.

No changes to existing assertions anywhere.

---

## 4. Integration points (partition constraint: minimal, purely additive)

| File | Change | Nature |
|---|---|---|
| `src/agent/library/night.js` | append `sleepVoteVerdict`, `torchGrid` | owned by this workstream; pure |
| `src/agent/library/skills.js` (SHARED) | append `export async function torchArea(bot, radius, maxTorches)` at end of the night section (after `nightRoutine`, before `tillAndSow`); R4 = 3 lines inside `nightRoutine`'s `place_bed` branch | additive; no existing function's signature or body otherwise touched |
| `src/agent/modes.js` (SHARED) | append `anyHumanSleeping` helper directly after `humanAwakeOnline` (:67); insert the R1 block between modes.js:456 and :466 inside `night_safety.update` | additive block insert; zero existing lines edited; the surrounding guards keep their order |
| `src/agent/commands/actions.js` (SHARED) | append one `!torchArea` command object after `!shelter` (:1268); doc-text-only edits to the `!goToBed`/`!shelter` `description` strings (§5) | one new entry + two string literals |
| `src/agent/commands/index.js` (SHARED) | optionally one alias line `'ta': 'torchArea'` next to `'gtb'` (:61) — must survive `tests/command_docs.test.mjs` (resolves to a real unblocked command; not one letter from a destructive command — check against the current alias table before choosing) | one line |
| `tests/*` | appends per §3 | additive |
| `scratchpad/sleep_test.mjs` | new driver rig (R2) | new file |

Nothing in `queries.js`, `settings.js`, `agent.js`, `nav.js`, `world.js` changes. `!torchArea`
is model-visible (not `hidden_actions`) — securing an area is exactly the kind of request a
person makes in chat.

---

## 5. Command doc text (per CLAUDE.md "Writing a description the model will obey")

Compact mode keeps the first sentence plus imperative follow-ups (Use/Do NOT/Takes/Refused...),
and renders param NAMES only — so the names carry the units.

**New `!torchArea`:**
```javascript
{
    name: '!torchArea',
    description: 'Place torches in a grid around the bot so mobs cannot spawn in the area. '
        + 'Use to secure a base, bed, or work site. Refused without torches in inventory. '
        + 'Do NOT use for a single dark spot - the torch_placing mode already handles that.',
    params: {
        'radius': { type: 'int', description: 'Half-width of the area in blocks.', domain: [2, 16] },
    },
    perform: runAsAction(async (agent, radius) => {
        return await skills.torchArea(agent.bot, radius);
    }, false, 5),
}
```
(`radius` is self-explanatory bare — the compact-mode param rule. Every retained sentence is
imperative. The prohibition sits on the tempting command: nothing about `!torchArea` goes on
other commands because nothing else overlaps it; the cross-reference to the mode prevents the
model spamming it per-dark-block.)

**`!goToBed` (revised description string only):**
```
'Go to the nearest bed and sleep through the night. Use at dusk, or when another player is in bed so the night can skip. Refused outside the overworld - beds explode there. Use !shelter when there is no bed.'
```

**`!shelter` (revised description string only):**
```
'Dig in and seal a one-block shelter for the night. Use only when there is no bed - prefer !goToBed. Refused over water or lava, and when there is nothing to seal the roof with.'
```
(The pair now cross-reference each other — the rule that made command selection *stable*.)

---

## 6. Ordered tasks with acceptance tests

1. **R1 pure**: `sleepVoteVerdict` in night.js + full refusal table in tests/night.test.mjs.
   ✓ `bun tests/night.test.mjs` passes; every `'no'` row present before the `'join'` rows.
2. **R1 live wiring**: `anyHumanSleeping` + the vote block in modes.js (between :456 and :466).
   ✓ `bun tests/modes.test.mjs` with the new placement/guard assertions (task 3) green;
   ✓ the existing execute-timeout scan still reports every call site timed.
3. **R5 structural tests**: modes.test.mjs appends (§3) including the §8b backfill (order,
   excludeFromInterrupt contents, command-side guards).
   ✓ Tests fail if the R1 block is moved below `isPeaceful`, if `night_safety` is reordered
   around `self_defense`/`hunting`, or if a command-side guard is dropped.
4. **R3 pure**: `torchGrid` in night.js + geometry tests.
   ✓ cap, dedupe, nearest-first, degenerate-radius cases green.
5. **R3 live**: `skills.torchArea` + `!torchArea` command + doc text (§5) + optional alias.
   ✓ `bun tests/command_docs.test.mjs` green (alias resolution, no near-collision);
   ✓ refusal paths return named reasons (`no torches`, `radius`, `afloat`) — assert by source
   scan in modes.test.mjs style or a small pure `torchAreaRefusal(...)` if extraction is free.
6. **R6 doc strings** for `!goToBed`/`!shelter` (two string literals).
   ✓ `bun tests/command_docs.test.mjs` green; compact render keeps the Use/Refused sentences
   (eyeball via the test's renderer or `command_docs_mode: "compact"` unit path).
7. **R4 (optional)**: torch-beside-placed-bed in `nightRoutine` + the dawn-tick torch test.
   ✓ `bun tests/torch.test.mjs` green; skip freely if time is tight.
8. **R2 live rig** `scratchpad/sleep_test.mjs` — written now, RUN LATER by a driver session
   with the bot owner's say-so (this session must not drive the live bot).
   ✓ Acceptance when run: `VERIFIED SLEEP` in service.log for the command path; for the vote
   path, operator client in bed + bot joins within 60s + `time query daytime` shows the skip —
   **on Peaceful, which is the target condition for R1, not a limitation of the test.**
   What stays unverifiable while Peaceful: the monsters-nearby rejection and any mode-driven
   dusk trigger — both covered pure, both documented as deferred, neither blocked on.

Run order for the suites after each task: `bun tests/night.test.mjs tests/modes.test.mjs
tests/torch.test.mjs tests/command_docs.test.mjs` (all pure; no server, no bot).
