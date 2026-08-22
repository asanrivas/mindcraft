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
- **A plain circuit breaker.** An *availability* error (ECONNREFUSED, timeout, 5xx, socket
  hangup) opens it, so the next 60 s of turns skip the dead primary instead of paying a connect
  timeout every turn. After the cooldown the primary is tried first again — recovery is
  automatic.
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
- Brain: BACKUP (deepseek-v4-flash-0731) - the local model is unreachable
```

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
