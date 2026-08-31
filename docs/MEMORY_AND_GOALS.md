# Memory, goals, reconnect and steering

What the bot remembers, what it is allowed to remember, how a goal ends, what happens on
reconnect, and the user-authored standing instructions that shape every prompt.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

### Memory

**Active systems:**
- `bots/[name]/memory.json`: Named chest locations (loaded on startup via ChestMaster, always active)
- `MemoryBank` (`src/agent/memory_bank.js`): In-memory spatial store for `!rememberHere`/`!goToRememberedPlace` — lost on restart
- `src/models/mem0_local.js`: Mem0 cloud integration (sdk: `mem0ai`, key in `keys.json`) — **NOT active**: only loads when `"api": "mem0"` in profile; Andy uses `"api": "azure"`

**Active (openclaw-style):**
- `use_memory_saving: true` in `andy.json` — when `max_messages` (30) is hit, oldest turns are distilled by LLM into structured memory (Goal/Locations/Lessons/Players sections, max 1000 chars)
- `load_memory: true` in `settings.js` — memory + saved_places restored from `memory.json` on every restart
- `$MEMORY` injected into `conversing` prompt — Andy always sees its curated memory in every response

**To enable Mem0:** Change `andy.json` model to `"api": "mem0"` and set model/url to Azure Foundry endpoint. Mem0 event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) are already wired in `agent.js` and `actions.js` — they become active automatically.

#### A stuck bot narrates its loop into memory - the store now folds paraphrases (2026-08-29)

bob spent ~2h oscillating in bedrock; every summarisation restated the episode, and the store
grew to 101 rows of which **90 were lessons** - six spellings of "on reconnect read memory
first", six of "non-terminating code killed at 10s". Only 10 lessons ever render; the rest sat
in storage queued to evict real facts, because `KIND_CAPS` bounded the RENDER only and the
global 200-row eviction drops the OLDEST agent rows - the durable facts - for the newest noise.

`memory_store.js` fixes, all unit-tested:

- A lesson's identity is its **set of content words** (`proseTokens`/`proseSimilarity`, fold
  at Jaccard >= 0.6): labels stripped, stopwords out, order ignored - so a reworded
  restatement UPDATES the row. Digits are kept ("10s", "Y=-58" ARE the identity) and
  sentences under 5 content words never fold - both guards exist because tests caught the
  false merges without them.
- `KIND_CAPS` enforced at **storage** - a runaway section can only crowd out itself.
- Eviction is **least-reinforced first** (a fold bumps `revision`), then oldest. Recency
  eviction handed the whole section to the current bad episode; revision eviction keeps what
  was independently re-learned.

One-time compaction for an already-polluted store: `scratchpad/compact.mjs <store.json>` (bot
stopped, `.bak` first; sums revisions on fold). bob done, 102 -> 21 rows; **andy still needs
this** and a restart to pick up the new code. Before deleting a "false" lesson, check the
bot's gamemode - "broke bedrock" is TRUE in creative.

#### Ending a goal - there are TWO of them

`!endGoal` used to stop only the self-prompt LOOP. The goal ALSO lives as a record in the typed
memory store, which renders into `$MEMORY` - injected into **every** conversing prompt. So a
goal the user had verbally ended was handed back to the model on every turn and it kept resuming
the work, and `load_memory` restored it after a restart. On disk:

```
memory.json        self_prompt: null, self_prompting_state: 0     <- the loop really did stop
memory_store.json  goal:current "Mine minerals below the base..." <- still there, origin "user"
```

Worse, a **user-origin** goal is immune to agent writes and deletes by design
(`memory_store.js`), so the model could not drop it either - that is the
`[History] memory store rejected 1 agent write(s)` line. `setUserGoal` had one caller and no
counterpart, so nothing anywhere could clear it.

- `!endGoal` now also calls `history.clearGoal(by)`. **Authority is asymmetric**: from a user it
  deletes the record; from the model it stops the loop only and says so, because the model must
  never be able to erase what a person asked for. Same rule `!goal` already uses.
- **Memory summarisation must not mint goals.** `importLegacyBlob` takes `allowGoal`, defaulting
  to **false**, and only the one-time legacy migration passes true. Without that the fix above
  lasts about one summarisation: the summariser is an LLM writing markdown under a template that
  literally contains a `## Goal` header, so it re-created the cleared goal out of the very turns
  in which it was ended. The store already refused to let the model OVERWRITE a user's goal;
  nothing stopped it INVENTING one where none stood.
- A goal is a **directive**, not a memory. It arrives through `!goal` or not at all.

#### On reconnect, the last thing a PERSON said wins

Reported as *"after a restart Andy still does the past task even though I asked it to stop
before restarting"*. Two separate mechanisms, both of which had to go.

**`settings.init_message` asked the model to decide.** It read, on every single reconnect:

> "Check your MEMORY for an unfinished task: if there is one, resume it right now with
> `!goal("<the task>")` instead of greeting."

`$MEMORY` is a summarised blob of lines like `Forest target: 4140,111,5132` and
`Target dry spot: 4465,62,4685`. **A small model told to find an unfinished task in that will
always find one** - nothing was ever *stored* as a goal, one was invented from ambient memory.
It is the same failure as "Memory summarisation must not mint goals" above, through a different
door, and a person's "stop" a minute earlier had no way to be heard at all.

`src/agent/resume_policy.js` decides from STATE and hands the model the answer instead of the
question. Three outcomes, all pure and unit-tested (`tests/resume_policy.test.mjs`):

- a **stand-down** since the goal was set: quote the person back to themselves and forbid
  resuming;
- a **real goal record or a live self-prompt**: quote it verbatim, and say *do not invent a
  different task from your memory*;
- **neither**: say so plainly, and that memory is a record of where things are, **not a list of
  work**.

`settings.init_message` is now only an on/off switch; the text is replaced at spawn.

**The self-prompt loop is the teeth.** Telling the model not to resume is not enough. `!stop`
leaves self-prompting running *by design* ("Agent stopped. Self-prompting still active."), the
loop is persisted to `memory.json`, and `handleLoad` restarts it on the next boot - that is the
bot carrying on regardless of what the prompt says. `agent.js` now skips that restart when a
stand-down stands. **The goal RECORD is deliberately left intact**: deleting a user-authored
goal is `!endGoal`'s authority, not something a fuzzy text match should do behind the user's
back. `!stop` says so now.

**And the agent restarts its own loop - it must never delegate that to the model.** The
reconnect message first read "resume exactly that with `!goal(...)`", and for a **user-authored**
goal that instruction cannot succeed: `!goal` from the model is refused outright
(`Kept the existing goal: ... `) and the refusal path never reaches `self_prompter.start`. So
the one case where resuming matters most is exactly the case where asking the model to do it
cannot work. Caught by the CONTROL half of the test, not the case half: the model obeyed,
emitted `!goal("count to ten out loud")`, and the loop never started.

Two supports underneath it:

- **`save_data.self_prompt` is not a reliable signal on its own.** It is written as
  `isStopped() ? null : prompt`, so whether a restart finds a task at all depended on *when* the
  last save happened to be taken - and `!endGoal` forces one while the loop is down, persisting
  null with the goal record still standing. `agent.js` falls back to the **goal record**, which
  is the durable statement of what a person asked for.
- **`SelfPrompter` now persists on its own transitions** (`start`/`stop`), so the file tracks
  the loop instead of sampling it.

Verified live in all three states: persisted loop -> replayed; goal record with `self_prompt`
forced to null (the exact shape of the bug) -> `restarting the self-prompt loop from the goal
record`; stand-down -> neither.

Details that matter:

- **"Last message" means the last one, not the last stand-down.** Someone who says "stop", then
  "now go mine", then restarts must come back to the mining. `standDownIsCurrent` compares the
  directive's timestamp against the goal record's `updated`.
- **A message that ISSUES a command is an instruction, whatever words it contains.** Caught live:
  the test goal read `!goal("count to ten out loud and stop")`, and the prose matcher classified
  the very message that created the task as cancelling it. An explicit `!stop`/`!endGoal`/`!stfu`
  /`!stay` still outranks the rest of the line.
- **A stand-down is saved the moment it arrives.** The ordinary `history.save()` sits at the
  bottom of `handleMessage` and is never reached for a message that is a command - `!stop`
  returns from the forced-command branch above it - which is exactly the case this exists for.
- Only humans count. A system prompt is our own words coming back, and another bot's chatter is
  not an instruction.

Verified live, both directions: goal + `stop` + restart -> `reconnect: ... Do NOT resume`, loop
not restarted, `"Hello, I'm Andy! What can I do for you?"`. Goal + restart with no stop -> loop
restarted and the task continued. **The control matters as much as the case**: a fix that stops
the bot resuming anything has removed the feature, not fixed the bug.


### Steering (user-authored standing instructions)

Give Andy standing instructions that shape how it talks and acts. They persist across restarts
and are injected into every prompt.

```
!steer("be brief, no questions")   # add a directive
!steering                          # numbered list of active directives
!unsteer(2)                        # remove #2
!unsteer("all")                    # clear them all
```

- Stored in `bots/<name>/steering.json`, loaded in `agent.js` **before** the first prompt is
  built, so the first reply after a restart is already steered.
- Rendered by `steering.js` -> `render()` into the `$STEERING` placeholder, which sits **late**
  in the `conversing` prompt (after `$SELF_PROMPT`, just before `Conversation:`). Late on
  purpose: recency is where small models follow instructions most reliably.
- **Bounded on purpose**: 8 directives, 120 chars each, 600 chars total. Small models sit on the
  exponential decay branch of instruction following, so an unbounded list would quietly degrade
  the rules that already matter.
- **Not model-writable in autonomous mode.** `!steer`/`!unsteer` refuse while `self_prompter` is
  active. Relaying a user's request is the point of the command; a self-prompting loop rewriting
  its own standing instructions is the same self-corruption that wrecked `history.memory`.

Distinct from `$MEMORY`: memory is written BY the model and drifts; steering is rendered
verbatim and is never summarised or re-ingested.

**How well it works depends on the directive.** A mechanical instruction is followed reliably
(verified: "always end your reply with BANANA" -> every reply ended with BANANA, and stopped
once removed). A *stylistic* one competes with the numbered rules: "keep replies to one short
sentence" was initially ignored because rule 9 tells Andy to be proactive and offer next steps.
`render()` now states explicitly that steering overrides those rules, which shortened replies
substantially but not to the letter. This is a 9B local model - treat steering as a strong
nudge, not a hard constraint, and prefer directives that add or remove a concrete behaviour over
ones that fight an existing rule.

