# Obedience: making the model pick the right command

Work of 2026-08-28/29. Three threads that turned out to be one problem: the model disobeys
when the information it needs was **deleted before it ever saw it** — by the docs renderer,
by a parameter name, by a dead provider, or by its own memory summariser.

**Status: SHIPPED and measured**, except the items in "Not done" at the bottom.

---

## 1. The compact docs renderer was deleting the disambiguation (DONE)

`command_docs_mode: "compact"` rendered each description as `description.split('.')[0]`
capped at 60 chars. Both halves were wrong:

- **The distinguishing clause lives in the SECOND sentence.** "Use this instead of
  !collectBlocks for ores", "Do NOT use to build structures", "not usable for travel",
  "Use when stuck underground" (the only thing separating `!climbOut` from `!goToSurface`) —
  all cut before the model saw them.
- **Splitting on a bare `.` breaks mid-abbreviation.** `!climbBankTest` rendered as
  *"Debug: repeatedly attempt swim"* (split inside `swim.climbBank`) — a debug harness
  reading as a swim command. `!marathonRoute` lost its `e.g. "4412,4934 4362,5021 ..."`
  example — the ONLY documentation of its argument format anywhere.

Now `compactDescription()` (`src/agent/commands/index.js`): split on `". "` followed by a
capital or `!command`; first sentence to 120 chars; keep following **imperative** sentences
(Use/Do NOT/Takes/Refused/Disabled/Pauses…) to 210 total. Prose second sentences still drop —
the budget is for choosing, not describing. `tests/command_docs.test.mjs` pins both bugs with
the real descriptions that produced them.

## 2. hidden_actions — visible to people, invisible to the model (DONE)

`blocked_actions` calls `blacklistCommands()`, which deletes from `commandMap` **for
everyone** — blocking `!swimProbe` would have broken the measurement workflow CLAUDE.md
documents. New `settings.hidden_actions`: omitted from the model's docs, still callable from
chat. Hidden: `!climbBankTest`, `!buildFooting`, `!swimProbe`, `!creativeIdSweep`, and
`!goToSurface` — which is `goToPosition` → `bot.pathfinder` (the executor `!goToCoordinates`
was blocked for) registered with **timeout −1**, so a hang pins `currentActionLabel` forever.
`!climbOut` does the same job on our navigator.

## 3. Aliases are a contract (DONE)

- `cf` meant **chestForget** — one letter from `cfi` = chestFind, opposite effects, not the
  `cp/cpn` prefix pattern. A model reaching for "find" deleted a saved chest name. `cf` now
  points at the read-only `chestFind`; **chestForget has no alias** (rare, only
  state-discarding command in the family; an unrecognised `!cfg` is a harmless error).
- `ca` → `!fill` and `gtc` → `!goToCoordinates` outlived their commands: both are in
  `blocked_actions`, which splices them out of `commandMap`, but `expandCommandAlias` resolves
  from its own table and never checks — the alias expanded into a name nothing could look up.
  Removed. `tests/command_docs.test.mjs` now fails the build on any alias that resolves to a
  missing or blocked command.

## 4. The parameter NAME is documentation — compact mode shows nothing else (DONE)

Compact docs render params as `name:type` and **drop the param descriptions entirely**. So
`!branchMine(depth:num, …)` reached the model with `depth` meaning the opposite of what it
does — it is an absolute `targetY` — while `!dive(depth:num)` nearby is genuinely
blocks-to-descend. The 9B filled the argument from the name: `!branchMine(64,10)` and
`(-64,10)`, both outside `domain: [-60,60]`, calls that could never run. Renamed to `y`,
semantics moved into the description ("absolute Y level… use -12 unless told otherwise").
Params are positional; nothing looks them up by name.

**If you add a command: the param name must be self-explanatory under `name:type` alone.**

## 5. Measured, before/after (DONE)

8 confusable prompts, old docs vs new: `bun scratchpad/obedience_ab.mjs` (drives the local
model with andy.json's own params; re-run it after any description change).

| model | OLD | NEW |
|---|---|---|
| gemini flash (4 runs) | 5–6/8 | **7/8 every run** |
| qwen3.5-9B local, andy.json params (5 runs) | 5–6/8 | **7–8/8** |

Signal, not noise: before the fix the NEW score bounced because `!scanArea`/`!gridView`
traded the miss between runs — the cross-references stabilised the choice. The one
reproducible miss is the harness's own fault (`!buildStatus` is a defensible answer for
"check my build"; see Not-done §c for the real defect it exposed).

Reproducible singles:

- **"I want diamonds, go mine some"**: OLD → `!collectBlocks("diamond_ore",…)` 5/5;
  NEW → `!branchMine(-12/-58, …)` 5/5. The redirect only worked once the "Do NOT use for
  ores" line sat **on `!collectBlocks`** — the command being wrongly picked — not on
  `!branchMine`. Prohibitions go on the tempting command, not the right one.
- **"just teleport yourself over here"**: the 9B took the `!serverTp` bait 4/4 on OLD and
  answered `!navTo` 4/4 on NEW — the "not usable for travel" line the renderer used to
  delete is load-bearing *for the small model*. Flash ignores it either way (4/4 bait both
  docs): doc text does not deter the big model; the `ALLOW_RESCUE_TP` marker file is the
  actual guard, exactly as designed.
- Verified **in-game** through bob: `!branchMine(-58, 20)`, `!navTo(500,70,500)` on the
  bait, `!creativeGive` for logs (correct — he is in creative, rule 10).

## 6. Model plumbing fixed on the way (DONE)

- **`"max_tokens": "auto"` reached llama-server as the literal string** → 400 on every
  request → the local model could not serve as primary and the agent silently lived on its
  backup. Two causes, both fixed: `applyContextBudget()` ran AFTER `new Prompter()` (LlamaCpp
  shallow-copies params at construction, so the later mutation never reached it) — now runs
  before; and it only resolved `profile.model`, never `backup_model` — a backup on "auto"
  would 400 at exactly the moment failover needed it. Now walks the whole chain.
- **DigitalOcean returns 402 on ALL models** — open-weight and proprietary alike, while
  `/models` still answers 200. Account-level billing, not tier-locking (tier locks are 403
  with a distinct body, per `src/models/digitalocean.js`). Removed from both bots'
  `backup_model`. Chains are now `llamacpp/qwen3.5-9b-uncensored` (primary, direct to
  `http://amyasan:8000/v1` — tunnel disabled, `llama-tunnel.service` stopped+disabled) →
  `google/gemini-2.5-flash`.
- **Failover validated live, unplanned**: llama-server died on the Windows box mid-test
  (external stop — its own log ends on a clean request); breaker opened, gemini served,
  `Start-ScheduledTask LlamaServer` brought it back, breaker closed itself:
  `recovered after 0.5 min and 2 failed attempt(s)`. The whole loop, no restart.

## 7. Memory pollution: the summariser mints paraphrases (DONE)

A stuck bot narrates its loop every summarisation. bob's store: **90 of 101 rows were
lessons**, six spellings of "on reconnect read memory first", six of "non-terminating code
killed at 10s". Only 10 render; the rest were dead weight queued to evict real facts, because:

- `normalizeKey` folds names, not sentences — every rewording minted a new row;
- `KIND_CAPS` was **render-only**; storage capped only globally (200);
- global eviction drops **oldest** agent rows — the durable facts — for the newest noise.

Fixed in `src/agent/memory_store.js`:

- **`proseTokens`/`proseSimilarity`**: a lesson's identity is its SET of content words —
  leading label stripped (`**Drop Loops**:` vs `**Nav Failures**:` had identical bodies),
  stopwords out, order ignored, fold at Jaccard ≥ 0.6. Guards learned from test failures:
  digits are kept (they ARE the identity: "10s", "Y=-58"), and sentences under 5 content
  words never fold (two short lessons sharing a word must not merge).
- **KIND_CAPS enforced in `_evict`** — a runaway section can only crowd out itself.
- **Eviction is least-REINFORCED first** (then oldest): a fold increments `revision`, so a
  lesson independently re-learned across episodes outranks one narrated once. This flipped
  the outcome on real data: recency-eviction kept 10 rows of stuck-loop narration; revision-
  eviction kept the rev-55/43/39 facts.

bob's store compacted 102 → 21 rows with the same rules (revisions summed on fold); backups
at `bots/bob/memory_store.json.prepollution.bak`. Note his "broke bedrock" lessons are TRUE —
he is in creative (`playerGameType: 1`); checked before almost deleting them as false.

---

## Not done — open gaps, newest first

**a. Andy's store is saturated and evicting good facts RIGHT NOW.** 200/200 rows, 150
lessons. He runs as a manual `bun run main.js` predating the memory fix, so: restart him to
get the new fold/eviction, and run the compactor
(`scratchpad/compact.mjs bots/andy/memory_store.json`, bot stopped, after a `.bak`).

**b. The descent executor gives up and the model freelances into bedrock.** The bedrock
episode's real root cause: `staircaseDown` returned `no descent progress` at Y=−45 after
digging 1 block in 4s (`[mine] descent done (4529,-45,4715) reached=false`), `!branchMine`
reported the failure honestly — and the model then improvised with `digDown`/`navTo` from
−45 to −63 into the bedrock layer, oscillating there for ~2h (~570 `pinned` events).
Two sub-gaps: WHY did the staircase stall (uninvestigated — `pickOpenDirection`? a fluid
refusal? the same executor stall as land travel?), and the model has no concept of "you are
BELOW the target Y" — nothing in `$STATS` or the mine report says it, so it kept trying to
dig DOWN to a layer above its head.

**c. `!buildStatus` invents file paths.** The model answers "check my build" with
`!buildStatus("file.json", …)` — it has no way to learn a real blueprint path. Either a
query that lists `blueprints/*.json`, or fold available paths into the description.

**d. Transient junk in Locations.** `current@`, `nav_failures@`, `previous_drop_zone@` are
episode state, not places, but they occupy location rows (capped at 12) and steer future
navigation. Needs either summariser-prompt language or a transient-name heuristic on put —
deferred because a denylist that rejects a real place is worse than the junk.

**e. Two ways to run andy, one port.** `mindcraft.service` and a hand-run `bun run main.js`
fight over :8080 — this produced a crash-loop (restart counter 5, `Start request repeated
too quickly`) that looked like a code bug. bob's split (`mindcraft-bob.service`, :8082,
`PROFILES` env) is the model to copy. Pick one way to run andy; the service is stopped
until then.

**f. The local primary has no supervisor on the box side.** `run_llama.bat` restarts a
crashed exe, but the *scheduled task* was stopped externally and nothing restarted it — both
bots quietly failed over to paid gemini. If the box sleeps, same story. Consider: task
trigger on boot/wake, or accept gemini absorbing outages.

**g. `!goToPlayer` / `!followPlayer` still ride mineflayer-pathfinder** and can hang exactly
like blocked `!goToCoordinates` (CLAUDE.md documents this; unchanged this session).

**h. Obedience harness exists but nothing runs it.** Promoted to
`scratchpad/obedience_ab.mjs` (2026-08-29, verified: OLD 7/8, NEW 8/8 from the repo path) —
but it needs a live model and RCON-free manual invocation, so description drift still goes
unmeasured until someone remembers. Open: run it as a gate on command-description changes.

**i. `docs/gaps/README.md` ground rules still cite the dead protocol-775 theory.** CLAUDE.md
corrected this 2026-08-23 (the server IS 1.21.11; `onGround` is broken for other reasons).
The gap plans' *constraints* are still right — build on primitives that work — but the
stated reason is stale in that file and in several plan headers.
