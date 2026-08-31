# Operational gaps — execution plan (2026-08-31)

Scope: the five small operational gaps from [README.md](README.md) "Gaps found 2026-08-29",
minus the two descent/below-target-Y items (owned elsewhere). Planning only — nothing here is
implemented. Static analysis; the live bot was not touched, no RCON, no restarts.

Partition rule honoured throughout: the only edits to `queries.js`/`actions.js` are one
appended command object and two one-sentence description string edits. Nothing in `skills.js`,
`index.js` or `modes.js` changes.

---

## 1. `!buildStatus` blueprint paths are unguessable

**Root cause.** `!buildStatus` (`src/agent/commands/queries.js:420-437`) and `!buildBlueprint`
(`src/agent/commands/actions.js:930-939`) both take a `file` param whose only documentation of
a real path is the *param description* (`queries.js:423`: `e.g. "blueprints/survival_base.json"`).
Compact docs mode renders params as `name:type` and **drops param descriptions entirely**
(CLAUDE.md "the param NAME is the only param documentation compact mode shows"), so the model
sees `file:string` and invents `"file.json"`. No query enumerates the directory. The directory
today holds exactly one file: `blueprints/survival_base.json`.

**Fix.** A new read-only query, appended at the END of `queryList` (purely additive):

```
name: '!blueprints'
description: 'List the blueprint JSON files available to !buildBlueprint and !buildStatus,
  with block counts and footprint. Use this first to get a valid file path.'
params: {}   // no params: nothing to get wrong
```

`perform` calls a new `listBlueprints(rootDir)` in `src/agent/library/blueprint_builder.js`
(which already owns blueprint file IO — `readFileSync` at `blueprint_builder.js:531,584`):
`readdirSync('blueprints')`, filter `*.json`, parse each with try/catch (a malformed file is
listed as `name (unreadable)` rather than hiding the readable ones), summarise placements
count + bounding box. Empty dir returns "No blueprints found in blueprints/." — a true answer,
not an error.

Plus two string-only edits so the cross-reference is bidirectional (the CLAUDE.md rule:
overlapping commands must cross-reference each other, and imperative sentences survive
compaction): append `Use !blueprints to list valid file paths.` to the descriptions of
`!buildStatus` (`queries.js:421`) and `!buildBlueprint` (`actions.js:931`). Both start with
"Use", so `compactDescription` keeps them.

**Pure / live split.**
- Pure: `formatBlueprintList(entries)` and `summarizeBlueprint(parsedJson)` — take data, return
  the report string / `{count, size}`.
- Live: the `readdirSync`/`readFileSync` shim in `listBlueprints`, ~5 lines.

**Tests** (`tests/blueprints_query.test.mjs`, no server):
- `summarizeBlueprint` on a real placements shape; on `[]`; on junk (throws → caught upstream).
- `formatBlueprintList` on: empty list, one entry, an unreadable entry mixed with good ones.
- In `tests/command_docs.test.mjs` style: `contains(compactDescription(<new buildStatus
  description>), 'Use !blueprints')` — pins the cross-reference against future compaction edits.

**Integration points:** `queries.js` (append one object), `actions.js`/`queries.js`
(two description strings), `blueprint_builder.js` (new exports). No settings change;
not hidden, not blocked.

**Effort:** ~1h.

---

## 2. Transient junk in memory Locations (`current@`, `nav_failures@`, …)

**Root cause — the writer is the summariser LLM following our own template.** The
`saving_memory` prompt in `andy.json` (line 37) instructs the Locations section format as
`[name@X:n,Y:n,Z:n — only coords worth remembering]`. The model dutifully writes lines like
`current@X:4721,Y:67,Z:4627`. `history.summarizeMemories` (`src/agent/history.js:184`) feeds
the summary to `importLegacyBlob`, whose non-prose parser (`src/agent/memory_store.js:418-423`)
splits on the first `:` — yielding keys like `current@X` — and stores them as LOCATION rows
(cap 12, `memory_store.js:58`). No filter distinguishes a place from episode state.

Measured from the journals (read-only):
- `bots/bob/memory_store.json.journal.jsonl`: `location:current@X` ×65, `hold_spot@X` ×66,
  `target_cluster@X` ×34, `target@X` ×32, `nav_target@X` ×26, `nav_failures@X` ×25,
  `drop_zone@X` ×24, `dig_zone@X` ×15, `previous_drop_zone@X` ×13.
- `bots/andy/memory_store.json.journal.jsonl`: `location:Current` ×186 — the single most
  rewritten location key andy has; also `Target dry spot` ×57, `Follow target` ×11,
  `Previous teleport start/origin` ×8. andy's LIVE store holds `Current`, `Target dry spot`,
  `Nearby sandy area` in its 12 location slots right now.

**Fix — two prongs, because the gap doc's worry ("a denylist that rejects a real place is
worse than the junk") is right and each prong covers the other's misses.**

1. **Prompt language** (`andy.json` + `bob.json` `saving_memory`, text only): change the
   Locations bracket to `[name@X:n,Y:n,Z:n — durable places only: bases, beds, chests, ore
   veins, biomes. NEVER your current position, navigation targets, or failure spots — those
   are supplied live in STATS.]`. Cheap, and reduces the source.
2. **A narrow transient-key predicate at import time.** Pure
   `isTransientPlaceKey(key)` in `memory_store.js`, applied only to `KIND.LOCATION` inside
   `importLegacyBlob` (so `!rememberHere`/MemoryBank — `src/agent/memory_bank.js`, a separate
   store — is untouched, and a user can still deliberately save any name through it). Match a
   small, evidence-derived pattern set, on the *normalised* key:
   `^(current|position|pos)$`, `^(nav[_ ]?(target|failure|failures))`, `^(target|hold[_ ]?spot|
   drop[_ ]?zone|dig[_ ]?zone|target[_ ]?cluster)`, `^previous teleport`, `^follow target$`,
   `last seen$`-style player sightings stay ALLOWED (they are about someone else, and players
   have their own kind anyway). Skipped rows are counted and logged one line per
   summarisation, exactly like `skippedGoals` (`history.js:189-192`) — a silent filter on
   memory is how false lessons survive.

   Rejecting, not demoting: these keys are re-minted every summarisation while the episode
   lasts (186 writes of `Current`), so nothing durable is lost by dropping them, and `$STATS`
   already carries the live position.

**Pure / live split.** Entirely pure — `isTransientPlaceKey` and the `importLegacyBlob` branch
take strings. The only live surface is the existing log line.

**Tests** (extend `tests/memory_store.test.mjs`): the predicate against the REAL journal
corpus — must match: `current@X`, `Current`, `nav_failures@X`, `hold_spot@X`, `drop_zone@X`,
`previous_drop_zone@X`, `Target dry spot`, `Follow target`; must NOT match: `Base`, `Shaft`,
`5 chests`, `Desert bed (respawn)`, `DANGER`, `AVOID water cavity`, `Veins from shaft`,
`Nearby red_bed`, `ice_spikes`, `desert village@X`. The must-NOT list is the tested surface
that answers the denylist worry. Plus: an `importLegacyBlob` of a Locations section mixing
both kinds stores only the places and increments the skipped counter.

**Integration points:** `memory_store.js` (predicate + one branch), `andy.json`/`bob.json`
(prompt text), `tests/memory_store.test.mjs`. Coupled to item 3: run andy's compaction AFTER
this ships, or the next summarisation puts `Current` straight back.

**Effort:** ~1-2h including the corpus tests.

---

## 3. Andy's memory store — safe remediation procedure (NOT executed)

**State check first — the picture has changed since the gap was filed.** Static inspection
today (2026-08-31): `bots/andy/memory_store.json` holds **38 rows** (location 12, lesson 10,
player 8, note 8), i.e. exactly at the per-kind caps `memory_store.js:58` enforces at storage
(`_evict`, `memory_store.js:448-470`), mtime Aug 31 01:07. So andy has evidently been
restarted onto post-fix code since 08-29 and the 200-row saturation has been mechanically
trimmed by eviction. What has NOT happened is the one-time **fold** pass: there is no
`bots/andy/*.bak` (bob has `memory_store.json.prepollution.bak`, Aug 29), and eviction ≠
compaction — eviction dropped least-reinforced rows *without merging paraphrases or summing
their revisions* (`scratchpad/compact.mjs` does both), so the surviving 10 lessons may still
contain paraphrase overlap with understated reinforcement, and durable facts lost in the
200→38 trim are recoverable only from the 437KB journal.

**Procedure (operator, reviewable, ~15 min; every step reversible until step 6):**

1. **Identify how andy is running** — gap "e" (two ways to run andy) makes this the dangerous
   step: `ps -eo pid,etimes,cmd | grep -E "bun (run main|.*init_agent)"` and
   `systemctl --user status mindcraft`. Note which one owns him.
2. **Stop that one** (`systemctl --user stop mindcraft` OR kill the manual `main.js` parent —
   killing `init_agent.js` alone respawns, per CLAUDE.md). Verify with the same `ps` that
   nothing survived. Do not proceed with a live writer.
3. **Backup:** `cp bots/andy/memory_store.json bots/andy/memory_store.json.prepollution.bak`
   (bob's naming) and `cp bots/andy/memory_store.json.journal.jsonl{,.bak}`.
4. **Compact:** `bun scratchpad/compact.mjs bots/andy/memory_store.json`. It reuses the
   unit-tested `proseTokens`/`proseSimilarity` and prints the kept-lessons list.
5. **Review the printout before restarting.** Check each surviving lesson against reality —
   and per CLAUDE.md, check gamemode before deleting a "false" one ("broke bedrock" is TRUE
   in creative). Hand-prune any remaining loop-narration rows by editing the JSON (safe while
   stopped; the store tolerates hand edits — `loadSnapshot` re-derives ids). Optionally
   salvage: grep the journal `.bak` for high-value rows the 08-29 saturation evicted (biome
   coords, chest names) and re-add as agent-origin rows.
6. **Restart the ONE chosen runner**, then verify: `!stats` normal, memory renders with
   Locations that are places, and the next summarisation logs folds rather than growth.

**Rollback:** stop, restore the `.bak`, restart.

**Pure / live split:** no new code — `compact.mjs` exists and its identity rules are already
unit-tested in `tests/memory_store.test.mjs`. This item is purely an operator procedure.

**Ordering constraint:** do it after item 2 lands (or accept re-doing the location slots), and
resolve gap "e" (pick one runner) in step 1 rather than around it.

---

## 4. Wiring the obedience harness so description drift is caught

**Root cause.** `scratchpad/obedience_ab.mjs` (62 lines) drives the REAL local model
(`LlamaCpp('qwen3.5-9b-uncensored', 'http://amyasan:8000/v1', ...)`) over 8 confusable
prompts against the live rendered docs; baseline NEW 7-8/8. Nothing invokes it:
`tests/command_docs.test.mjs` pins `compactDescription`'s *mechanics* against canned strings,
but if someone edits a real description in `actions.js`/`queries.js` — deleting "Do NOT use
for ores" from `!collectBlocks`, say — every existing test still passes and the 9B quietly
regresses to 5/8.

**Fix — two tiers, honestly split by what needs a model.**

**Tier 1 (offline, pure, joins the ordinary `bun tests/` run): a doc-contract test.** New
`tests/obedience_contract.test.mjs` (new file — keeps the shared `command_docs.test.mjs`
footprint additive-only). It renders the REAL docs the way the harness does
(`setSettings(real)` → `blacklistCommands` → `getCommandDocs(agent)` with real
`hidden_actions`) and asserts, per confusable family, that the load-bearing clause is present
in the *rendered* line — not in the source string, so a compaction change that silently drops
it also fails:
- `!collectBlocks` line contains `Do NOT` + `!branchMine`; `!branchMine` contains
  `!collectBlocks`; `!scanArea` ↔ `!gridView` cross-reference; `!climbOut` contains
  `Use when stuck underground`; `!placeHere` contains `Do NOT use to build structures`;
  chest list/find/named cross-references.
- The hidden harness commands (`settings.js:144`) do NOT appear in the rendered docs.
- `!branchMine`'s param renders as `y:` not `depth:` (the measured 5/5 failure).
This catches the drift class that A/B measurement actually found, with zero model calls.
It is a *necessary* condition, not sufficient — it cannot see a new ambiguity, only the loss
of known disambiguators. Say so in the file header.

**Tier 2 (needs the model; a gate, not a test).** A docs-hash freshness check:
- `obedience_ab.mjs` grows ~10 lines: hash the rendered NEW docs (sha256), write
  `scratchpad/obedience.last.json` = `{docsHash, score, date}` after a run
  (`scratchpad/*.json` is gitignored — fine, this is per-machine state; the *baseline
  requirement* "NEW ≥ 7/8" is what's checked in).
- `tests/obedience_contract.test.mjs` ends with a NON-FATAL freshness check: recompute the
  docs hash; if it differs from `obedience.last.json` (or the file is absent), print a loud
  `WARN: command docs changed since the last measured obedience run — bun
  scratchpad/obedience_ab.mjs` and still exit 0. It becomes FATAL only when the file exists,
  hashes match, and `score < 7` — i.e. a measured regression is a build failure; an
  unmeasured change is a nag.
- Why not blocking on staleness: the harness needs amyasan up, and per CLAUDE.md the whole
  point of the failover work is that the box is *routinely* down. A dead LLM box must not
  block unrelated commits; a warning that persists until someone runs the harness keeps the
  debt visible without lying about what was checked. A git pre-push hook was considered and
  rejected for the same reason (and hooks don't travel with clones).

**Pure / live split.** Tier 1 wholly pure (imports settings + command modules, no network).
The hash function pure. Tier 2's score production is irreducibly live — it is measuring a 9B
model's behaviour, which no offline test can proxy.

**Tests:** tier 1 IS the test. For tier 2, unit-test the hash-freshness verdict as a pure
function `obedienceVerdict(currentHash, last)` → `fresh-pass | fresh-fail | stale | unmeasured`
so all four branches are covered without a model.

**Integration points:** `scratchpad/obedience_ab.mjs` (append hash/score dump), new test file,
one line in CLAUDE.md's "Writing a description" section: "after changing any description, run
`bun scratchpad/obedience_ab.mjs`".

**Effort:** ~2h. Recommend shipping tier 1 even if tier 2 is skipped.

---

## 5. llama-server wake/boot supervision — detection first, wake carefully

**Root cause.** The failover chain works (`src/models/fallback.js`), but every signal it emits
is passive: one `[fallback] primary ... is down` warn on the FIRST trip (`fallback.js:99-103`),
a `- Brain: BACKUP ...` line in `!stats` (`queries.js:82-88`) that only a person who asks
sees, and a recovery log. `run_llama.bat` restarts a crashed exe on the Windows box, but a
stopped `LlamaServer` scheduled task or a sleeping box is invisible from there — the 16-hour
outage in `fallback.js`'s own header comment (178 trips, zero recoveries) is the measured
shape. Meanwhile gemini-2.5-flash absorbs every turn at real cost.

**Fix (a) — detection/alerting for sustained failover. Two layers, because the bot process
itself can be down or restarting:**

1. **In-process escalation** in `FallbackModel`: pure
   `failoverAlertDue(status, lastAlertAt, now, {afterMs: 10*60_000, repeatMs: 60*60_000})`.
   Checked inside `_dispatch` after a backup serves a request (no new timer — the probe timer
   at `fallback.js:122-136` already runs while open; piggyback there too so an idle bot still
   alerts). When due: one distinct, greppable line —
   `[fallback] SUSTAINED FAILOVER: <label> on <backup> for <n> min (<trips> trips) — check
   the LlamaServer task on amyasan` — at most hourly. Optionally (flag
   `settings.failover_announce`, default off) the agent says one chat line, so the person
   playing with the bot learns without asking `!stats`.
2. **Out-of-process probe** (survives bot restarts, catches "bot down too"):
   `tools/brain_health.mjs` — GET `http://amyasan:8000/v1/models` with a 2.5s abort (same
   shape as `llamacpp.js:40` `healthCheck`), append state TRANSITIONS only (up→down,
   down→up, with duration) to `logs/brain_health.log`, exit 0/1. Run it from a systemd
   **user timer** every 5 min. It is the thing that notices at all when nobody is playing.

**Fix (b) — automatic wake attempt. Deliberately conservative; this touches someone else's
machine and real money is the SMALLER risk:**

- `tools/wake_llama.sh`, invoked ONLY by the out-of-process watcher after N=3 consecutive
  down probes — **never from inside the bot process**: `FallbackModel` is on the model's
  request path, and a path from LLM activity to `ssh` on a remote box must not exist.
- Guards, in order: (1) an arming marker à la `ALLOW_RESCUE_TP` — e.g.
  `~/.config/mindcraft/ALLOW_LLAMA_WAKE` must exist; absent means the watcher only alerts.
  (2) a stamp file rate limit: at most one attempt per 30 min, and at most 3 per 24h — a
  wake that didn't stick twice is a human's problem, not a retry loop's. (3) every attempt
  and its outcome logged.
- The attempt itself: `ssh <windows-host> "powershell -Command Start-ScheduledTask -TaskName
  LlamaServer"` with a hard `ConnectTimeout=10`, then re-probe after 90s.
  **If ssh itself times out, STOP.** The box is asleep or off; `Start-ScheduledTask` cannot
  reach it, and Wake-on-LAN is explicitly out of scope here — waking a sleeping personal
  Windows machine is a policy decision for its owner, not something a supervisor script
  should decide (and per CLAUDE.md the accepted alternative — "gemini absorbing outages" —
  is cheap: ~1.4s latency and flash pricing). If the owner later wants WoL, it slots in as a
  second, separately-armed marker.

**Pure / live split.** Pure and unit-testable: `failoverAlertDue` schedule (extend
`tests/fallback.test.mjs`, which already fakes providers/clock), the probe's
transition-detection (`nextLogState(prev, ok)`), and `shouldAttemptWake(probeHistory,
stamps, now)` with its rate/cap arithmetic. Live: the fetch, the ssh, systemd units.

**Tests:** `failoverAlertDue` — not due before threshold, due once at threshold, repeats
hourly not per-request, resets on `_reset()`; `shouldAttemptWake` — unarmed never, 2 fails
never, 3 fails yes, 4th within 30 min no, 4th attempt in 24h no. The negative cases are the
tested surface — a wake that fires spuriously is the failure mode that matters.

**Integration points:** `fallback.js` (+pure fn, +2 call sites), `queries.js` untouched
(`!stats` already shows it), `tools/brain_health.mjs` + `tools/wake_llama.sh` (new),
`~/.config/systemd/user/brain-health.{service,timer}` (outside the repo; document in
docs/LLM_FAILOVER.md).

**Effort:** detection ~2h; wake ~2h more. Ship detection alone if time is short — the stated
cost ("nobody notices") is entirely a detection problem.

---

## Ranking (value / effort) and recommendation

| # | Item | Value/effort | Call |
|---|---|---|---|
| 1 | **(2) Transient junk filter** | Highest — tiny pure change, evidence-rich test corpus, stops ongoing pollution of a 12-slot resource that steers navigation | **Do first** |
| 2 | **(1) `!blueprints` query** | High — one additive query kills a call that is wrong 100% of the time | Second |
| 3 | **(3) andy compaction** | Moderate — value dropped since the restart already trimmed 200→38, but it's 15 operator-minutes and closes the ledger; sequence AFTER (2) | Third |
| 4 | **(5a) failover detection** | High value, modest effort; the money leak is a visibility problem | Fourth |
| 5 | **(4 tier 1) doc-contract test** | Good — pure, catches the known drift class | Fifth |
| 6 | **(5b) auto-wake** | Low — gemini absorbing outages is cheap and the ssh path adds real risk; ship only behind the arming marker, or defer entirely | Optional |
| 7 | **(4 tier 2) LLM gate** | Lowest — depends on a box whose unreliability is the premise of this whole branch | Recommend NOT making it blocking; non-fatal staleness warning only |

First action: item 2's `isTransientPlaceKey` + prompt-text change, then run item 3's
procedure at the next convenient bot downtime.
