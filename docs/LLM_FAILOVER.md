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

`backup_model` accepts **one profile or an ordered list**, tried left to right.
Key: `FIREWORKS_API_KEY` in `keys.json`. Measured latency: **~1.4 s**.

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
