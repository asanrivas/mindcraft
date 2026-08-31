# Backup Brain — failover when the local LLM is down

**Status:** shipped and running. Verified against a genuinely dead local server.
**Related:** [TESTING.md](TESTING.md) · [SERVICE_MANAGEMENT.md](SERVICE_MANAGEMENT.md)

---

## 1. Why this exists

Andy's primary model is a local llama-server reached over an SSH tunnel from a Windows box.
When that box sleeps, reboots, or the tunnel drops, every request fails at the socket and the
bot answers `"My brain disconnected, try again."` **forever** — it never recovers on its own and
never says why.

## 2. Configuration

```jsonc
// andy.json
"model": { "api": "llamacpp", "model": "qwen3.5-9b-uncensored", "url": "http://127.0.0.1:8000/v1" },

"backup_model": {
    "api": "fireworks",
    "model": "deepseek-v4-flash-0731",
    "params": { "max_tokens": 1024, "reasoning_effort": "low", "temperature": 0.7 }
},
"backup_cooldown_secs": 60
```

`backup_model` accepts **one profile or an ordered list**, tried left to right. Both agents
(andy, bob) run the same chain: **ox-alpha -> deepseek -> (last-resort) local**.

Measured on an identical Andy-shaped prompt, 5 runs each:

| model | min | median | max |
|---|---|---|---|
| `stealth/ox-alpha` (OpenRouter, free, 1M ctx) | 1.18 s | **1.40 s** | 10.5 s |
| `deepseek-v4-flash-0731` (Fireworks) | 2.39 s | 2.77 s | 18.3 s |

Median ~2x faster, and the 1M context should end the `context_length_exceeded` retries (78 in
one day). Both show occasional 10-18 s spikes, so the median is the number to trust, not the mean.

**ox-alpha is a stealth model**: prompts/completions are typically logged and shared with the
provider, and cloaked models can disappear without notice - which is exactly why it sits FIRST
in a chain rather than replacing anything.

Keys live in `keys.json` (gitignored). **A shell export is not enough**: the systemd --user
service does not inherit `~/.zshrc`, so a key exported there is invisible to the bot even though
`getKey` falls back to `process.env`.

## 3. Design

**`src/models/fallback.js` is the only place that decides "the model is down".** Providers just
throw; `FallbackModel` classifies the error, routes, and guarantees the caller's contract.

- **`sendRequest` always resolves to a string, never rejects.** `promptCoding` and
  `promptMemSaving` in `prompter.js` have **no try/catch**, so a rejection there propagates into
  the agent loop.
- **A circuit breaker with exponential backoff.** An *availability* error (ECONNREFUSED,
  timeout, 5xx, socket hangup) opens it, and the window doubles with each consecutive failure:
  60s → 120s → 240s → 480s → capped at 15 min.

  This is a response to measurement, not premature generality. The first version used a flat
  60 s cooldown, and a real **16-hour outage produced 178 trips and ZERO recoveries** — roughly
  950 re-dials of a dead socket, every one on the critical path of a user's turn. The same
  outage under backoff costs fewer than 80 attempts.
- **A background health probe takes recovery off the critical path.** While the breaker is
  open, `LlamaCpp.healthCheck()` does a bare `GET /v1/models` (2.5 s timeout, no generation)
  every 30 s; a success closes the breaker immediately. Previously the bot only learned the
  server was back when a real request happened to be routed at it after a cooldown, so the
  first turn after every recovery paid a full connect attempt. Verified live:
  `[fallback] primary chat model recovered after 5.5 min and 1 failed attempt(s).` — with no
  user request involved. Providers without a `healthCheck()` simply skip the probe.
- **Other errors fail over but do not open the breaker.** A 400 or an empty completion means the
  server is still reachable, so keep using it.
- **Last resort.** If every backup fails, the primary gets one more attempt before giving up.

Wrapping happens in `prompter.js` for both `chat_model` and `code_model`, **even when no backup
is configured**, so `FallbackModel` stays the single place that turns a thrown provider error
back into the string the agent loop expects.

## 4. Two provider changes this required

`llamacpp.js` and `fireworks.js` both **swallowed** errors and returned the "brain disconnected"
placeholder. A placeholder reads as **success** and stops the chain before a backup is ever
tried. Both now throw.

`llamacpp.js` also gained a **120 s timeout with `maxRetries: 0`**. Without one, a half-open SSH
tunnel hangs the request forever and the backup is never reached.

## 5. Visibility

`!stats` grows a line **only while failed over**, so the normal prompt costs nothing:

```
- Brain: BACKUP (deepseek-v4-flash-0731) - local model unreachable for 5 min, 1 failed attempt(s), next retry in 0s
```

The duration and retry cadence matter: without them a multi-hour outage reads as "the bot is
being weird today" rather than as an outage.

Without it, the only symptom of an outage is that Andy suddenly writes differently.

## 6. A bug worth remembering

The **anti-cheat-style valve pattern used here bites elsewhere too**: counting events without a
baseline. In this module the equivalent trap was simpler — the first version matched the reply
pattern too loosely and returned Andy's own chat echo as the server's answer. See
[WORLD_TOOLS.md](WORLD_TOOLS.md) §3 for the same class of bug in `runServerCommand`.

## 7. Verification

```bash
bun tests/fallback.test.mjs     # 20 cases, no network
```

Covers: error classification, happy path, breaker opens on availability errors, primary skipped
during cooldown, non-availability errors do *not* open the breaker, recovery after cooldown,
all-providers-down still returns a string, no-backup wrapper preserves old behaviour, and
ordered chains.

**Live, with the local server actually down:**

```
[fallback] primary chat model (qwen3.5-9b-uncensored) is down: Connection error.
           Using backup for the next 60s.
Awaiting fireworks api response... (accounts/fireworks/models/deepseek-v4-flash-0731)
Generated response: Fun fact: In Minecraft, salmon can swim upstream...
```

Recovery verified with real sockets: down → backup; restored but inside cooldown → still backup;
after cooldown → primary.

---

## Moved here from CLAUDE.md (2026-08-31 restructure)

CLAUDE.md keeps the RULES; this file keeps the EVIDENCE. The text below is verbatim
from CLAUDE.md before it was compacted — the measurements, the incidents and the
reasoning behind the one-line rules that remain there. Heading levels are demoted by one.

### LLM Providers

18+ providers auto-discovered. Config: `{"api": "foundry", "model": "claude-sonnet-4-5", "url": "..."}`
Azure Foundry: URL ends with `/anthropic/`, key: `AZURE_FOUNDRY_API_KEY`

**copilot-mem0** (`src/models/copilot_mem0.js`): GitHub Copilot + Claude + Mem0 cloud memory
- Token priority: 1) `~/.openclaw/credentials/github-copilot.token.json`  2) exchange `GITHUB_TOKEN` PAT
- Calls `https://api.githubcopilot.com/chat/completions` (OpenAI-compatible, vscode-chat integration)
- Models: `claude-haiku-4.5`, `claude-sonnet-4.5`, `claude-opus-4.5/4.6`, `gpt-5`, `gpt-5-mini`, `gemini-3-flash-preview`
- **Tiered routing**: set `"model": "tiered"` — haiku classifies complexity, routes to haiku/sonnet/opus
  - `simple` → haiku  (greetings, status, follow/stop)
  - `medium` → sonnet (crafting, mining, navigation, small builds)
  - `hard`   → opus   (large builds >20 blocks, multi-step plans, complex strategies)
  - Override via params: `tier_router`, `tier_simple`, `tier_medium`, `tier_hard`
- Augments every request with Mem0 semantic memory; stores conversation + events (user + system pool)
- Event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) match `Mem0Local` interface
- Profile: `profiles/copilot.json` | Keys needed: `MEM0_API_KEY` (+ `GITHUB_TOKEN` if openclaw token expired)

#### Backup brain (failover when the local LLM is down)

Andy's primary model is a local llama-server reached over an SSH tunnel from a Windows box.
When that box sleeps or the tunnel drops, every request used to fail and Andy answered
`"My brain disconnected, try again."` forever. It now fails over to a cloud model.

```jsonc
// andy.json
"backup_model": { "api": "fireworks", "model": "deepseek-v4-flash-0731",
                  "params": { "max_tokens": 1024, "reasoning_effort": "low" } },
"backup_cooldown_secs": 60   // how long to stop dialling a primary that failed
```

`backup_model` takes one profile or an ordered list (tried left to right).
Key: `FIREWORKS_API_KEY`. Measured latency: **~1.4s**.

**`src/models/fallback.js` is the only place that decides "the model is down".** Providers
just throw; `FallbackModel` classifies the error, routes, and guarantees `sendRequest` always
resolves to a string - `promptCoding`/`promptMemSaving` in `prompter.js` have **no try/catch**,
so a rejection there propagates into the agent loop.

- A plain circuit breaker: an *availability* error (ECONNREFUSED, timeout, 5xx, socket hangup)
  opens it, so the next 60s of turns skip the dead primary instead of paying a connect timeout
  each turn. After the cooldown the primary is tried first again and recovery is automatic.
- Other errors (a 400, an empty completion) also fail over but do **not** open the breaker -
  the primary is still reachable, so keep using it.
- If every backup fails, the primary is retried once as a last resort before giving up.

Two provider changes this required: `llamacpp.js` and `fireworks.js` used to *swallow* errors
and return the "brain disconnected" placeholder. A placeholder reads as **success** and stops
the chain, so both now throw. `llamacpp.js` also gained a 120s timeout (`maxRetries: 0`) -
without one, a half-open tunnel hangs forever and the backup is never reached.

`!stats` grows a `- Brain: BACKUP (...)` line **only while failed over**, so the normal prompt
costs nothing. Without it the only symptom of an outage is that Andy suddenly writes differently.

Tests: `bun tests/fallback.test.mjs` (fakes, no network). Verified live against a genuinely
dead local server, and recovery verified with real sockets: down -> backup, back up but inside
cooldown -> still backup, after cooldown -> primary.

**Current chain (2026-08-29, both bots):** primary `llamacpp/qwen3.5-9b-uncensored` direct at
`http://amyasan:8000/v1` (tunnel disabled - `llama-tunnel.service` stopped; the server is a
`LlamaServer` scheduled task on the Windows box, `Start-ScheduledTask` over ssh restarts it),
backup `google/gemini-2.5-flash`. DigitalOcean is REMOVED: 402 on every model account-wide
while /models still answers - billing, not tier-lock (tier locks are 403). Two bugs fixed so
the local model can be primary at all: `applyContextBudget` must run BEFORE `new Prompter`
(providers copy params at construction, so a later `"auto"`->number mutation never reaches
them and llama-server 400s on the string), and it must resolve `max_tokens:"auto"` for the
whole backup chain, not just `profile.model`.

