# Replacing mineflayer with an owned Minecraft client

Status: **M1 in progress** (started 2026-08-23). `src/mc/` exists with the mineflayer backend
wired through it and a passing contract test; the native backend is a stub.

## Why

The bot connects to a **Minecraft 26.1 server (protocol 775)**, but connects *as* 1.21.11.
`src/mindcraft/mcserver.js` used to regex-extract the version from the server's ping *name*
string (`"Purpur 1.21.11"`) and never read `response.version.protocol`. So the bot ran
one-version-stale collision data against a 26.x world.

The visible symptom: **`bot.entity.onGround` lies** — false for seconds while the bot is
provably standing (constant y, zero velocity), so prismarine-physics applies no ground
acceleration. Measured in [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md): 136 jump-ticks over
241 ticks moved 0.1 blocks; `mineflayer-pathfinder` won't plan a route over a 1-block step. An
entire replacement nav/swim stack exists to work around this (`nav.js`, `auto_jump.js`,
`swim_assist.js`, `swim_probe.js` — ~129 `bot.*` refs of pure compensation).

**Why a client rather than a version bump.** The bump looks tractable now (below), but the goal
is strategic: own the client, target 775 and whatever follows, and stop being gated on upstream
PrismarineJS release timing. The bump is a reprieve; ownership is the outcome.

**Deliverable:** a client we own, swapped in behind a config flag (`settings.mc_client`), proven
at parity against the live server, with mineflayer deletable once parity holds.

## A stale claim, corrected

`CLAUDE.md` used to assert `prismarine-chunk` "has no 26.x chunk implementation in any release."
**That was verifiably false for the installed packages** — a misread of a JS object literal
where unquoted keys sit beside quoted ones. Confirmed by loading each module at runtime
(2026-08-23):

| Package | Installed | 26.1 / protocol 775 |
|---|---|---|
| `prismarine-chunk` (root) | 1.41.0 | `26.1: require('./pc/1.18/chunk')` at `src/index.js:17` — instantiates |
| `minecraft-data` | 3.113.2 | full `pc/26.1/` incl. **`blockCollisionShapes.json`**; `{"version":775}` |
| `minecraft-protocol` | 1.67.0 | `26.1` in `supportedVersions` (and it is the `defaultVersion`) |
| `prismarine-registry` | 1.11.0 | `('26.1')` → 1168 blocks, 1506 items, protocol 775 |

The whole stack *below* mineflayer already speaks 775. The two remaining gates are policy, not
capability:

1. **mineflayer bundles `prismarine-chunk@1.39.0`** (no `26.1` key) shadowing the working root
   1.41.0 — addressable via the `overrides` block already in `package.json`.
2. **`testedVersions`** in `node_modules/mineflayer/lib/version.js` ends at `1.21.11`; the gate
   throws in `lib/loader.js`. A one-line patch-package append.

Stepping below mineflayer removes a *policy* gate. That is precisely the independence sought.

## Constraints

- The bot runs live as a systemd user service (`andy` on `mindcraft.service`, `bob` on his own
  `mindcraft-bob.service`). **No stage may break either.** Every increment ships behind a flag
  defaulting to `mineflayer`.
- `src/utils/mcdata.js` `initBot()` is the **only** `createBot`-equivalent call in `src/`;
  `src/agent/agent.js` its only consumer. This is the injection seam — see `src/mc/index.js`.
- Standalone bots to migrate or explicitly strand: `tasks/construction_tasks/get_blueprint.js`,
  `tasks/human_evaluation.js` (still construct mineflayer bots directly).
- **Keep `vec3`.** Used directly in 16+ files; every position is assumed to carry
  `.distanceTo/.floored/.offset/.clone/.plus/.scaled/.add/.set`. Tiny, standalone, and dropping
  it multiplies the migration surface for no gain.

**Scale:** ~1000 `bot.*` call sites across 32 files at the time this was written — `skills.js`
463, `agent.js` 66, `swim.js` 61, `actions.js` 42, `blueprint_builder.js` 41, `modes.js` 37,
`nav.js` 36. `bot.blockAt` alone is 89 calls; `bot.chat` 79; `bot.setControlState` 48.

## Architecture

### The seam: a duck-typed contract, not a façade

**The `BotClient` contract is mineflayer's bot shape, frozen to the subset actually used.**
Renaming anything forces a mass rewrite of the most battle-scarred code in the repo — exactly
how a live bot breaks. Both backends satisfy the same property/method names, so **zero call
sites change at M1**.

Two hard requirements on any backend's bot object:

- A plain `EventEmitter` — **not** a Proxy or sealed object. `bot.output`, `bot.interrupt_code`,
  `bot.modes`, `bot.restrict_to_inventory`, `bot.swimAssist`, `bot.lastDamageTime`,
  `bot.lastDamageTaken`, `bot.itemUseOwner`, `bot.last_verification` are all bolted on from
  outside.
- **Mutable physics fields.** `bot.physics.liquidAcceleration` is read *and written* mid-tick by
  `swim_assist.js` and `swim_probe.js`; `bot.physics.gravity` written by `blueprint_builder.js`.
  These must stay writable and actually consulted by the tick loop.

```
src/mc/
  index.js              createClient(opts) -> BotClient; backend selection
  contract.js           the audited name list, as data, plus checkContract()
  backends/
    mineflayer.js        createBot + loadPlugin + both monkeypatches, moved verbatim from mcdata.js
    native.js             stub for the M2+ owned client
```

`initBot()` in `src/utils/mcdata.js` builds `options` from settings as before, then
`createClient(options, { backend: settings.mc_client, onVersionKnown })`. Selection is
`settings.mc_client`: `'mineflayer'` (default) or `'native'` (not implemented yet).

### The conformance test

`src/mc/contract.js` exports the audited API surface as data (`METHODS`, `NESTED_METHODS`,
`PROPERTIES`, `EVENTS`, ...) plus `checkContract(bot)`. `tests/contract.test.mjs` spins up an
in-process, loopback-only `minecraft-protocol` fake server (offline auth, random port — no real
network, no live server dependency) and walks the contract against the mineflayer backend. Run
with the rest of the suite: `bun run test`, or standalone: `bun tests/contract.test.mjs`.

This is what turns the audit from a document into an executable spec — it fails loudly if a name
the rest of `src/` depends on stops being injected, and it's the bar the native backend has to
clear before any call site can be pointed at it.

### `bot.chat()` vs `bot.command()`

`bot.chat()` was overloaded across ~79 sites — a large share are server commands (`/setblock`,
`/fill`, `/tp`, `/give`, `/summon`) whose output is scraped back through a transient
`messagestr` listener (`runServerCommand` in `src/agent/commands/actions.js`). `bot.command(cmd)`
is now part of the contract; on the mineflayer backend it's a straight alias to `chat()`.
Migrating call sites to it is an ongoing, independently-shippable cleanup — no rush, no
dependency on the native client. Later, a native backend can give `command()` a real
request/response channel instead of regex-scraping chat.

### Layer sequencing — borrow vs. build

Borrow where version-specific behavior is fully described by `minecraft-data`; build where it
isn't. A module that's just a `minecraft-data` interpreter carries no strategic risk — when 26.2
lands it follows for free. Hand-coded version behavior is where upstream owns you.

| Layer | Call | Where | Why |
|---|---|---|---|
| Transport / framing / compression / encryption / login | **BORROW** | `minecraft-protocol` | Already at 775. Zero strategic value in reimplementing AES-CFB8, zlib thresholds, session auth. |
| Packet codec | **BORROW** | `protodef` + `minecraft-data` `protocol.json` | Pure data interpretation — makes "775 and beyond" nearly free. |
| Packet routing / policy | **BUILD** | `src/mc/net/connection.js` | Where the 50ms position-throttle and PartialReadError-swallow monkeypatches (currently in `backends/mineflayer.js`, moved verbatim from `mcdata.js`) become first-class: a real rate-limiter queue and a per-packet-ID error policy. |
| Chunks / blocks | **BORROW** | `prismarine-chunk`, `-block`, `-registry` | The layer this doc's correction above concerns — section-palette decoding is intricate and data-driven. |
| World store | **BUILD** | `src/mc/world/` | `blockAt` is 89 sites — densest coupling. An owned store adds an awaitable `chunkLoaded(x,z)` and a generation counter `nav.js` can use to invalidate its block cache precisely. |
| Entities | **BUILD** | `src/mc/entities/` | A few hundred lines; no standalone module exists. Metadata index tables belong in one version-keyed `metadata.js`. |
| Physics | **BORROW → BUILD** | `prismarine-physics` → `src/mc/physics/` | The strategically important layer — the source of today's pain and the reason `nav.js`/`auto_jump.js` exist. Owning `simulatePlayer` is the change most likely to let us delete `auto_jump.js`. |
| Inventory / windows | **BUILD** | `src/mc/inventory/` | Fiddliest state machine in the protocol; ordering bugs corrupt inventory silently. Budget generously. |
| Crafting | **BORROW data, BUILD sequencing** | `minecraft-data` recipes | Keep the data, own the click sequence. |
| Chat | **BUILD** | `src/mc/chat/` | Small; `auth: "offline"` means signed-chat session keys aren't needed. |

### The plugin problem — mostly already solved

- **pathfinder** — `nav.js` already replaces it for movement. Only three goal shapes remain
  (near-a-point, follow-entity, invert-either) plus one reachability check in `world.js`. Plan:
  `src/agent/library/nav_goals.js`, independent of the native client, deletes the 13KB
  `patches/mineflayer-pathfinder+2.4.5.patch`.
- **pvp** — 5 call sites; `src/agent/library/melee.js`.
- **collectblock** — 1 call site, already fenced by `mustCollectManually()`.
- **armor-manager** — 1 call site, ~50 lines to replace.
- **auto-eat** — 1 config site, better owned so eating coordinates with `action_manager.js`.
- **prismarine-viewer** — do not reimplement. Feeds the whole vision pipeline via Puppeteer at
  `localhost:3000+`. Plan: shim it (it only needs `bot.world`/`bot.entity`/`bot.entities`/
  `bot.players`/`bot.version`), with a headless-mineflayer shadow viewer as the fallback.
- **mineflayer-tool** is already gone — `src/agent/library/tools.js` documents that it was never
  loaded. Precedent that plugin replacement works here.

## Milestone ladder

- **M1 — the seam.** Zero behavior change. *(current)* `src/mc/` skeleton, mineflayer backend
  absorbing both monkeypatches, `contract.js`, `tests/contract.test.mjs` green. `bot.command()`
  added. `mcserver.js` now reads `response.version.protocol` and logs the mismatch (still
  connects with the name-derived, mineflayer-safe version).
- **M2 — observer client.** Native: minecraft-protocol → chunk decode → entity table, no
  controls/inventory/actions. Ships a real 26.1 collision-data source usable by `nav.js` months
  before the switch, and the reference side of the parity harness.
- **M2.5 — plugin retirement.** Parallel track, no dependency on M2+.
- **M3 — motion.** Controls, physics tick, position packets. Success criterion: clears a 1-block
  step without `auto_jump.js`.
- **M4 — interaction.** dig/place/activate/attack, incl. a public `placeBlockWithOptions`.
- **M5 — inventory, windows, crafting.** The long one — budget double.
- **M6 — chat, commands, viewer shim.** Contract test green on the native backend.
- **M7 — split-fleet live.** `bob` (own service) flips to native; `andy` stays on mineflayer.
- **M8 — delete mineflayer.**

## Verification

- **Packet tape** (`tools/tape_record.mjs`, `tests/parity.test.mjs`, not yet built) — offline,
  deterministic, replays recorded server traffic into both world layers and diffs `blockAt`,
  entities, inventory. Build before M2 lands.
- **Live shadow diff** (`settings.mc_client = 'shadow'`, `tools/parity_run.mjs`, not yet built) —
  mineflayer drives the real bot, native observes on a second account, samples both at 1Hz,
  anchored on absolute world coordinates (not bot-relative, since the two accounts stand in
  different places).
- **Per-milestone gates:** M1 — contract test green, bot behavior unchanged after
  `systemctl --user restart mindcraft`. M2 — tape parity green. M3 — clears a 1-block step
  without `auto_jump.js`. M7 — `bob` runs a full day on native with no regression vs `andy`.

## Riskiest assumptions

1. **That the movement failure is a client-data problem at all.** Purpur/Paper server-side
   movement validation explains the symptoms equally well — anti-cheat correcting the client. If
   so, no client rewrite fixes it; the fix is server config. `swim_assist.js`'s `forcedMove`
   valve (disables its boost after 3 server corrections in 10s) is direct evidence the server
   *does* correct this client. A ~2-day check (patch `testedVersions`, connect as 26.1 on a
   spare account, watch whether a 1-block step plans) would settle it, independent of this plan.
2. **That the ecosystem's 26.1 data is production-quality, not a pre-release snapshot.**
   `prismarine-chunk` maps `26.1` → the *1.18* chunk implementation — plausible, but a
   biome-palette or lighting change would break it silently. The packet tape is the cheapest
   detector.
3. **That the ~1000-site audit is complete.** `tests/contract.test.mjs` converts this from hope
   to fact.
4. **That prismarine-viewer can be shimmed.** Riskiest plugin call, with a live user-facing
   dependency (`camera.js` → vision). Shadow-viewer bot is the hedge.
5. **Window/transaction state machines.** Highest defect density in every from-scratch MC
   client; failures are silent inventory corruption. Budget M5 at double.
6. **`liquidAcceleration` mid-tick mutation.** Any native physics layer that makes this field
   computed rather than mutable state silently breaks swimming — measured at ~4× walking speed
   here, so load-bearing for travel.
