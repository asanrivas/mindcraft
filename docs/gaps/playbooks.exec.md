# Execution plan: safe autonomy for `!newAction`

Status: **PLAN — nothing implemented.** Supersedes the open question in
`docs/gaps/playbooks.md` (2026-08-22) with a decision and an ordered task list.
Written 2026-08-31 from static analysis only; the live bot was not touched.

The recorded failure: `!newAction("Walk to the door and enter the igloo")` generated code that
took the bot process down (connection lost, watchdog re-login ~25s later) while doing something
`nav.navigateTo` already does. bob's memory store accumulated six paraphrases of
"non-terminating code killed at 10s" — the generated-code loop has the exact signature
`docs/OBEDIENCE.md` records for the stuck-bot-narrates-its-loop failure.

---

## 1. How `!newAction` actually works today

**Entry** — `src/agent/commands/actions.js:83-105`. Gated only by
`settings.allow_insecure_coding` (`settings.js:90`, currently **true**). The perform calls
`agent.coder.generateCode(agent.history)` inside
`agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins})`
(`actions.js:102`); `code_timeout_mins` is **10 minutes** (`settings.js:152`).

**Generation loop** — `src/agent/coder.js:66` `generateCode`: up to 5 attempts. Each attempt is
linted (`_lintCode`, `coder.js:161` — unknown `skills.*`/`world.*` names against the skill docs,
then plain ESLint), staged (`_stageCode`, `coder.js:203`), and executed.

**The sandbox that is and isn't there** — `_stageCode` evaluates the code in an SES
`Compartment` (`src/agent/library/lockdown.js:34`) endowed with only `skills` (84 exports),
`world` (26 exports), `Vec3`, `log`, `Math`, `Date` (`coder.js:234-240`). That genuinely blocks
`fs`, `process`, `require`, network. **But the compartment guards the globals, not the
capability**: execution is `await executionModule.main(this.agent.bot)` (`coder.js:123`) — the
FULL mineflayer bot object as an argument. Through `bot` the generated code can reach:

- `bot.chat('/fill ...')`, `/setblock`, `/tp`, `/give` — **bypassing every world_guard check**
  (the guard is enforced only in the command layer: `actions.js:966,1157,1173,1195`) **and the
  ALLOW_RESCUE_TP marker**. The repo's own rule — "a real guard protects; a description only
  informs" — is void for generated code today.
- `bot.pathfinder.goto` / `setGoal` — the executor CLAUDE.md establishes cannot move this bot,
  and which rewrites control states every tick, fighting our navigator.
- `bot._client.write` — raw packet forgery.
- `bot.on(...)` / `bot.once(...)` — listeners that outlive the run.
- Unbounded awaits: `bot.openContainer` has no deadline (the exact hang `chest.js` was built to
  contain — but generated code doesn't go through `chest.js`).

**How it is bounded** — two mechanisms, both porous:

- *Interrupt injection*, `coder.js:213`: every `;\n` in the source is rewritten to
  `; if(bot.interrupt_code) {log(bot,"Code interrupted.");return;}`. This is a **string**
  transform: a single never-resolving `await`, a `for(;;)`, a loop body without `;\n`, or any
  callback (the adjacent comment at `coder.js:212` admits callbacks are a problem) never
  observes the flag.
- *Action timeout*, `action_manager.js:129-131` + `_startTimeout` at `:228-235`: after 10
  minutes it calls `this.stop()`.

**What happens on throw** — a synchronous/awaited throw from `main()` is caught in
`generateCode`'s try/catch (`coder.js:139-160`), fed back to the model, and retried (up to 5).
A throw escaping that is caught by `_executeAction`'s catch (`action_manager.js:182-209`). But
an **async throw from a listener the code registered** (`bot.on`) escapes both, and there is
**no `process.on('uncaughtException'/'unhandledRejection')` anywhere in src/ or main.js** —
that path is an instant process death.

**Precisely how it killed the process** — two distinct paths, both reachable from ordinary
generated code:

1. **`ActionManager.stop()` is a 10-second fuse on the whole process**
   (`action_manager.js:50-61`): it sets `interrupt_code` every 300ms and, if `executing` is
   still true after 10s, calls
   `agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.')` →
   `process.exit` (`agent.js:986-995`). Generated code parked inside one pending await (or a
   loop the injection missed) can never see the flag — so it is uninterruptible by
   construction. And `stop()` is called not just by the 10-minute timeout but by **every mode
   interrupt and every new command** (`_executeAction` line 118). So uninterruptible generated
   code converts *any* interrupt — `mode:drowning` firing, the user typing `!stop`, the model's
   next command — into a process kill. This is the same failure class as "Mode `execute()` must
   pass a timeout": a run that cannot end pins `currentActionLabel`, and the only tool the
   manager has left is killing the process.
2. **A synchronous loop starves the event loop.** No timer fires (so neither the 10-minute
   timeout nor `stop()`'s fuse can even run), the socket goes unread, and the **server** drops
   the client — `lost connection: Timed out`, then the watchdog re-login. The door incident's
   observed shape (connection lost, re-login 25s later, no cleanKill line) matches this path.
   CLAUDE.md documents the identical mechanism in `followPlayer`'s microtask spin.

**Ownership hole** — `!newAction`'s perform is a bare async function, **not** wrapped in
`runAsAction`, so `perform.takesOverBot` is undefined and `takesOverBot('!newAction')`
(`commands/index.js:482-485`) returns false. The guard at `agent.js:628` therefore does **not**
refuse a model-emitted `!newAction` while a user-owned action is running — yet its `runAction`
call reaches `await this.stop()` (`action_manager.js:118`) and cancels the user's action.
Generated code is today the one takeover command exempt from "the model does not get to cancel
what a person asked for".

**No failure memory** — `LearnedSkills` (`src/agent/library/learned_skills.js`) stores only
code that ran clean; `recordFailure` (`learned_skills.js:78`) has **zero callers**. Within one
`generateCode` call, nothing stops attempt 4 from being byte-identical to attempt 2's failure;
across calls, nothing remembers that this intent already crashed this way.

---

## 2. Recommendation: (b) the harness first, then a minimal (a) grown from LearnedSkills

**Every recorded process death is a harness failure, not a routine-selection failure.** The
kill paths above — uninterruptible awaits meeting `stop()`'s fuse, event-loop starvation,
listener throws with no rejection handler — are all properties of *how* code runs, not *which*
code was chosen. Playbooks cannot fix them, because `docs/gaps/playbooks.md` itself (correctly)
concludes `!newAction` must survive as the escape hatch: as long as free-form code can run at
all, the container is the load-bearing part. Build it first.

**The playbook half is already half-built, and the cheap 80% is reuse, not YAML.**
`LearnedSkills` is a verified-code store keyed on intent with S/F tallies — that is a playbook
library minus the parameterisation. Consulting it *before* generating (offer the stored code
that worked for a matching intent) delivers playbooks' reuse benefit with zero new command
surface, zero new file format, and no new prompt tokens. The full declarative YAML engine in
`playbooks.md` (expression language, `verify:` blocks, record mode, promotion) is a large new
surface whose benefits only accrue *after the process stops dying* — defer it, keep the design
doc.

**Wrong-altitude selection (the door case) is a docs + validator problem.** `docs/OBEDIENCE.md`
measured that prohibitions on the *tempting* command flip the 9B — so `!newAction`'s
description gains "Do NOT use for walking, doors, or navigation - use !navTo / !goToPlayer",
and the static validator refuses `bot.pathfinder.goto` outright. Mechanism where it matters
(the validator), doc text where doc text is measured to work (steering a small model's
selection between commands it is allowed to use).

**What "sandbox" means here, honestly stated:**

- A pending await can be *abandoned* (deadline race) but not cancelled — after abandonment the
  harness clears control states and reports the zombie. That is bounded damage, same posture as
  `chest.js`'s `withTimeout`.
- Synchronous starvation **cannot be contained at runtime in-process**. The defense is static:
  refuse the loop shapes before evaluation. The watchdog restart remains the backstop.
- Crash isolation for listeners is achieved by **refusing listener registration** (statically
  and at the capability), not by a global rejection handler — a process-wide
  `unhandledRejection` handler would change behavior for the whole agent and mask real bugs.

---

## 3. Files and signatures

### New, PURE — `src/agent/library/code_guard.js` (the world_guard of code)

Parses with `espree` (already in node_modules as an ESLint dependency). Like
`world_guard.checkEdit`, every refusal names itself; like `openObstruction`, ambiguity
**fails open** — a guard that refuses legitimate code is worse than the status quo.

```js
/**
 * Static validation of generated code before it is evaluated. Pure: source text in,
 * verdict out. Unknown constructs PASS - only the named kill-shapes refuse.
 * @param {string} src            - the generated code (pre-template, as the model wrote it)
 * @returns {{ok: boolean, reason: string|null, violations: Array<{line: number, rule: string, detail: string}>}}
 */
export function validateGeneratedCode(src)

// Individual rules, exported for direct testing (mirrors isProtectedName/isTrappingBlock):
export function findUnboundedLoops(ast)      // while(true)/for(;;)/do-while(true) with no await in body
export function findForbiddenAccess(ast)     // bot._client, bot.pathfinder.goto/setGoal, bot.on/once/
                                             // addListener/prependListener, setInterval/setTimeout,
                                             // eval/Function, process, require, import()
export function findServerChat(ast)          // bot.chat / bot.whisper with a literal starting '/'
                                             // (dynamic strings are the runtime guard's job)

/**
 * "Have I already failed this exact way." Coordinates, ids and hex noise are stripped so
 * the same crash at different positions folds - same principle as memory_store's
 * proseTokens keeping digits, inverted: here the numbers are the noise.
 * @param {string} code  @param {string} errorString
 * @returns {string} stable signature
 */
export function failureSignature(code, errorString)

/**
 * @param {string} signature  @param {string[]} priorSignatures  @param {number} maxRepeats (default 1)
 * @returns {{retry: boolean, reason: string|null}}  - a NEW failure always retries
 */
export function shouldRetry(signature, priorSignatures, maxRepeats)

/**
 * Runtime chat check for the guardedBot proxy - pure so it is testable.
 * Plain speech and !commands pass; '/'-prefixed (after trim) refuses with the command named.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function chatAllowed(message)
```

### New, LIVE (thin) — `src/agent/library/code_harness.js`

```js
/**
 * Capability-restricted view of the bot for generated code. A Proxy: get() passes
 * everything through EXCEPT the deny-set (throws a named Error the retry loop can read);
 * chat/whisper are wrapped through chatAllowed(). The bot object itself is never mutated.
 */
export function guardedBot(bot)   // -> Proxy

/**
 * Deadline-raced execution. On timeout: ABANDONS the promise (cannot cancel it), calls
 * bot.clearControlStates() (guarded on !swim.inWater per the SwimAssist jump-key rule),
 * and returns {timedout:true, zombie:true} so the caller reports it. timeoutMs must be
 * well under the action timeout so containment fires before stop()'s 10s process fuse.
 * @returns {Promise<{ok: boolean, error: Error|null, timedout: boolean, zombie: boolean}>}
 */
export async function runContained(mainFn, bot, { timeoutMs })
```

### Modified — `src/agent/coder.js` (not on the shared-file list; the main wiring site)

- `_stageCode`: run `validateGeneratedCode` after `_lintCode`; a violation is pushed back to
  the model exactly like a lint error, with the rule named.
- `generateCode`: keep `priorSignatures` for the attempt loop; on catch, compute
  `failureSignature`, consult `shouldRetry` — a repeat refusal ends the loop with
  "same failure twice: <sig>" instead of burning attempts 4 and 5 on it. Call
  `this.learned.recordFailure(key)` when a *reused* learned skill throws.
- `generateCode`: execution becomes
  `await runContained(executionModule.main, guardedBot(this.agent.bot), { timeoutMs: settings.code_run_timeout_secs * 1000 })`.
- Reuse-before-generate: before the LLM loop, query `LearnedSkills` for a high-confidence
  intent match and offer that code as attempt 0 (through the same validator + harness).

### Modified — `src/agent/commands/actions.js` (shared; ONE additive line)

Mark the ownership: after the `!newAction` entry, `perform.takesOverBot = true` (or set the
property on the function expression). This makes `agent.js:628` refuse a model-emitted
`!newAction` during a user-owned action — no other change, no restructure.

### Modified — `settings.js` (additive key only)

`code_run_timeout_secs: 120` — the inner per-run deadline. Distinct from `code_timeout_mins`
(which bounds the whole generate-lint-run-retry action) and deliberately far under it.

---

## 4. PURE/LIVE split

| PURE (unit-tested, no bot) | LIVE (thin, bounded) |
|---|---|
| `validateGeneratedCode` + the three find* rules | `guardedBot` Proxy (delegates to `chatAllowed`) |
| `failureSignature`, `shouldRetry` | `runContained` deadline race |
| `chatAllowed` | coder.js wiring |
| learned-skill eligibility (`successes/failures` threshold, pure predicate in learned_skills.js) | reuse-before-generate query |

The Proxy and the race carry no decisions — every decision they enforce is a pure function
above them. Same shape as `checkEdit` (pure) vs `checkEditForBot` (live wrapper).

## 5. Test cases — `tests/code_guard.test.mjs` (world_guard.test.mjs pattern: `check()`, replay of the real incidents, refusals weighted toward must-NOT-fire)

**Must NOT fire (the guard refusing legitimate code is worse than the status quo):**
- typical real generated code: `await skills.collectBlocks(bot, 'oak_log', 10);` sequences — passes
- `for (let i=0;i<5;i++) { await skills.placeBlock(...) }` — bounded loop, passes
- `while (world.getNearestBlock(...)) { await skills.wait(bot, 500); }` — has await, passes
- `while (true) { ... await ... }` — unbounded but yielding, **passes** (starvation is the rule, not loop shape)
- the string `"while(true)"` inside a string literal or comment — passes (AST, not regex)
- `bot.chat("hello!")`, `bot.chat("!stats")` — passes; `chatAllowed('!inventory')` ok
- `bot.pathfinder.getPathTo(...)` — planning works here; only goto/setGoal refuse
- reads like `bot.entity.position`, `bot.inventory.items()` through the Proxy — pass through
- `shouldRetry`: first failure retries; a DIFFERENT failure after one failure retries
- `failureSignature`: same error at different coordinates → SAME signature (folds); genuinely
  different errors → different signatures (must not fold — the memory_store lesson)

**Must fire (each a replay of a recorded kill path):**
- `while (true) { bot.setControlState('forward', true); }` — no await → starvation → refused, rule named
- `for (;;) {}` — refused
- `bot._client.write(...)` — refused
- `bot.on('physicsTick', ...)` / `setInterval(...)` — the uncaught-listener-throw path — refused
- `bot.chat("/tp andy 0 64 0")`, `"/setblock"`, `" /fill"` (leading space) — refused statically
  (literal) and by `chatAllowed` at runtime (dynamic) — the world_guard/ALLOW_RESCUE_TP bypass
- `bot.pathfinder.goto(...)` / `setGoal(...)` — the door incident's altitude — refused
- `shouldRetry` with an identical signature already seen → `{retry:false}`
- `runContained` (fake bot, fake never-resolving mainFn): resolves `{timedout:true}` within
  deadline, control states cleared, **no cleanKill** — asserted by the fake agent surviving

**Ownership** (extend in the new test file, not `tests/action_owner.test.mjs`):
`takesOverBot('!newAction') === true`, and the fake-agent refusal path from action_owner's
pattern shows a model `!newAction` refused mid-user-action.

## 6. Integration points (partition constraint honoured)

- `skills.js`, `commands/index.js`, `modes.js`: **zero edits**.
- `commands/actions.js`: one additive line (`takesOverBot`), plus (optional, same edit) the
  OBEDIENCE-style sentence in `!newAction`'s description: "Do NOT use for walking, doors, or
  navigation - use !navTo or !goToPlayer."
- `coder.js`, `learned_skills.js`: main wiring; not shared with parallel workstreams.
- `settings.js`: one additive key.
- New files: `library/code_guard.js`, `library/code_harness.js`, `tests/code_guard.test.mjs`.

## 7. Ordered tasks

1. **`code_guard.js` + `tests/code_guard.test.mjs`** (pure, no bot).
   *Accept:* `bun tests/code_guard.test.mjs` green; every must-NOT-fire case above passes;
   every replay case refuses with its rule named.
2. **Wire validator + failure dedupe into `coder.js`.** Violations feed back like lint errors;
   repeated identical failure ends the attempt loop early; `recordFailure` finally has a caller.
   *Accept:* fake-prompter harness (fallback.test.mjs style): a model that always emits
   `for(;;){}` gets a named refusal each attempt and never reaches `compartment.evaluate`;
   a model that repeats one crashing program stops after 2 identical failures, not 5.
3. **`code_harness.js`: `guardedBot` + `runContained`; execution goes through both.**
   *Accept:* fake-bot tests — never-resolving main → `{timedout:true}` inside
   `code_run_timeout_secs` with no `cleanKill`; `bot.chat('/tp ...')` from run code throws a
   named error the retry loop surfaces; `bot.on` throws named error; `bot.entity.position`
   still readable.
4. **Ownership line in `actions.js`.**
   *Accept:* `takesOverBot('!newAction')` true; model-emitted `!newAction` refused while a
   user-owned action runs (fake-agent test).
5. **Reuse-before-generate** from `LearnedSkills` (validated + contained like fresh code), and
   S/F eligibility as a pure predicate.
   *Accept:* matching stored intent short-circuits the LLM loop in the fake harness; a stored
   skill that then throws has `failures` incremented on disk.
6. **Live verification (operator-run, NOT by this workstream; one bot, off-hours):** re-issue
   the door ask. Expected: either a real command is used (doc steering) or generated code runs
   and *ends* — worst case a named timeout, never a process exit. Then a deliberate
   `!newAction("loop forever")`: refused statically or contained at `code_run_timeout_secs`,
   process alive, `!stats` answers.
7. **Deferred:** the full YAML playbook engine of `playbooks.md` (promotion, `verify:`,
   record mode). Re-open only if, after 1-6 have soaked live, wrong-altitude codegen is still
   observed — measure first (the assists lesson: measure the assist, not the premise).
