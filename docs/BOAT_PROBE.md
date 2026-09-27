# Boat probe — Stage 0 result (2026-08-31)

**Verdict: INFEASIBLE.** Not because of the input-vs-`vehicle_move` question the plan set out
to answer — because **no boat mount initiated from the client ever succeeds on this server**,
so Phases A/B (which require riding a boat for 5s at a time) could never run. This is a
different, earlier failure than the plan anticipated, and it is measured, not assumed.

Ran per `docs/gaps/boats.exec.md` §2, branch `feature/llm-failover`. Probe account: `probe1`
(already whitelisted — reused from an earlier session, per the task's own note). Never touched
`andy` or `bob`; never restarted `mindcraft.service`. Rig built and torn down ~1300 blocks from
both live bots, on open ocean.

## The rig

- `tools/boat_probe.mjs` — the Stage-0 script itself, written to spec: standalone mineflayer
  bot (no agent), one persistent RCON connection (`tools/survey.mjs`'s pattern), raw
  `bot._client` listeners for clientbound `vehicle_move` registered at connect, phases
  A1/A2/B@2/B@4/B@8 each isolated by an RCON reset-and-remount, ground truth read after each
  phase. It runs end-to-end without throwing — the blocker below was found *by* running it and
  then chasing why every phase measured zero.
- Location: an artificial water channel at `x:3505-3585, z:6165-6178` (interior channel
  `z:6169-6173`), built over open ocean near `(3520, 63, 6171)` — 1300+ blocks from andy
  (3407, 62, 4890) and bob (4708, 70, 4612), and ~2000 from andy's `!marathon`/base activity.
  A solid stone floor (`y50-61`) was added first: the natural ocean floor here has an
  unrelated undersea cave, and an early attempt without the floor sent the probe into
  freefall through open air below the water column — a rig artifact, not a finding, and it is
  the reason the channel exists at all rather than raw ocean.
- Cleanup: boat entities killed, the channel's walls filled back to water/air (matching the
  surrounding ocean — the buried floor slab is left, indistinguishable from natural stone),
  forceload removed. `mc "list"` confirms only andy/bob online throughout and after.

## What actually blocked Stage 0

### 1. `bot.mount()` never attaches to the boat — confirmed, and found why

`mineflayer/lib/plugins/entities.js:901-918`'s `useEntity()` writes the serverbound
`use_entity` packet as `{target, mouse, sneaking}` for a plain interact (`mouse: 0`, which is
what `bot.mount()` sends). But 1.21.11's own schema
(`minecraft-data/.../1.21.11/protocol.json:10704-10769`) makes `hand` a **required** field for
`mouse: 0` (a switch on `mouse`, `{"0": "varint", "2": "varint"}` — only `mouse: 1`, attack,
gets away with omitting it). mineflayer never sends it. That is a real, reproducible mineflayer
bug for any entity interact on this protocol version, boats included.

Fixing it did not fix mounting. `tools/boat_probe.mjs`'s diagnostic sibling (kept only as
scratchpad output, not shipped) wrote the raw packet with `hand: 0` supplied, aimed via
`bot.lookAt` at the boat first, at 0.3-0.6 blocks of range — and waited **10 seconds** across
two attempts. Zero effect: no `attach_entity`, no `set_passengers`, no server-side warning, no
kick. Verified with a genuinely fresh, un-throttled RCON connection (see the two false starts
below) so this is not an artifact of stale state.

**So there is a second, undiagnosed reason client-driven interact-mounting fails here beyond
the missing field**, and Stage 0 does not have a code-level explanation for it. Purpur logs
nothing; the packet write does not throw; the server plugin list (`CountryBlock`, `floodgate`,
`Geyser-Spigot`, `MapModCompanion`, `SkinsRestorer`, `ViaBackwards`, `ViaVersion`) has nothing
that should intercept vehicle interacts.

### 2. A server-forced mount (`/ride <player> mount <boat>`) works, but self-ejects in ~2s regardless of input

To get *any* signal on the actual movement question, the probe also tried mounting via the
RCON `ride` command, which **does** attach the passenger — `mineflayer` correctly receives
`set_passengers` and fires `mount`. But every single trial, across four independent
combinations of what the client streams afterward, ejects the passenger **~2.0-2.2 seconds
later** with no warning and no correlation to the input:

| streamed after mount | time-to-eject |
|---|---|
| nothing | 1.91s |
| `player_input{forward}` every 250ms | 2.22s |
| static serverbound `vehicle_move` @ 20Hz | ~2s (RAW `set_passengers` seen at the 2s mark) |
| `vehicle_move` + `look` + `player_input`, all together @ 20Hz/20Hz/4Hz | ~2.2s (between the t=2s and t=3s samples) |

The ejection is a real `set_passengers` packet from the server naming the boat with an empty
passenger list — not a mineflayer-side illusion. mineflayer's own `set_passengers` handler
(`entities.js:773-799`) only clears `bot.vehicle` / emits `dismount` when *our* id is in the
**new** list; on an ejection our id is (correctly) absent, so that branch never runs and
`bot.vehicle` is left stale forever after. That is a second real mineflayer gap (dismount
detection), independent of the interact bug above, and would need fixing regardless of what
this probe found — but it is not why the ride ends; the server ends it.

Ground truth (`data get entity probe1 Pos` over the same one persistent RCON connection)
confirms the boat's real behavior during this window: position drifted only slightly while
mounted (buoyancy settling, not our `vehicle_move` writes — the position never matched our
streamed coordinates), then jumped by exactly the kind of offset a vanilla "find a safe
dismount spot beside the vehicle" placement produces at the moment of ejection, then **stayed
frozen for the remaining 5+ seconds of the trial** — i.e., once ejected, our idle player simply
floats; nothing we streamed had any further effect.

Because every avenue mounts for at most ~2 seconds (RCON) or never mounts at all (client), the
probe cannot hold a boat for the plan's 5-second A/B windows, so the numeric thresholds
(`disp >= 4.0` for INPUT-DRIVEN, `disp >= 8.0 / simErr <= 2.0` at B@2 for CLIENT-SIM) are not
answerable from this rig. **A first full run of `tools/boat_probe.mjs` did report an apparent
quick mount and produced a formatted VERIFIED line — investigating why led to all of the above:
that run's `bot.vehicle` was almost certainly set by a stray, much-delayed `mount` event from
an earlier `bot.mount()` call landing on whatever `once` listener happened to be attached at
that moment (mineflayer's own retry loop never removes a losing listener), not a real
low-latency mount — and its ground-truth reads were reading a `bot.entity.position` that
mineflayer never updates while (nominally) mounted. That run's numbers are not trustworthy and
are not the basis for this verdict; they are why the diagnosis kept going instead of stopping
at a plausible-looking first result.**

## Two false starts worth recording (so they aren't repeated)

- Several intermediate diagnostic scripts used a *per-command* RCON helper (spawn
  `tools/rcon.mjs`, one new connection each call) instead of the required single persistent
  connection. CLAUDE.md already documents that this stalls the server after ~13 rapid cycles;
  it produced blank command output and an unmoved player mid-investigation and cost real time
  to notice. Every result quoted above comes from a re-run over one persistent connection
  (`tools/boat_probe.mjs`'s own pattern, copied for each diagnostic).
- The natural-terrain probe site free-fell the bot through the seabed (an unrelated undersea
  cave near the chosen ocean coordinates) before the artificial channel was built. Not a
  finding about boats — a reminder that "open ocean" from `/locate biome` is not "solid ocean
  floor," and any future water rig here should build its own floor rather than trust terrain.

## What this means for the boat work

Per `docs/gaps/boats.exec.md`'s own instruction: this is a clean negative, not a forced one.
**Recommend dropping boats** for now rather than proceeding to Branch A or Branch B:

- Branch A (input-driven) is moot — there is no sustained mount to drive.
- Branch B (`boat_packet.js`, streaming `vehicle_move` ourselves) is *also* moot for the same
  reason, independent of whether the server would have honored those packets — we could not
  keep a passenger seated long enough to find out, and the one window we did get showed no
  correlation between our streamed `vehicle_move` and the boat's real server-side position.
- If boats are revisited later, the prerequisite is no longer "which movement model does the
  server want" — it is **"why does no client-initiated mount attach on this server, and why
  does an operator-forced mount self-eject in ~2s regardless of input."** That is a different,
  harder, and currently unexplained question, most likely rooted in this specific
  Purpur/Paper/Geyser stack rather than in mineflayer or in anything `src/agent` controls. The
  missing `hand` field on `mouse: 0` interacts is a confirmed, fixable mineflayer bug
  independent of this verdict, but fixing it alone did not produce a mount, so it is necessary
  but not sufficient.
- The existing fallback — swim legs plus `escapeWater` — remains what ships. Nothing in
  `src/` or `tests/` was touched to reach this conclusion.

## Files

- `tools/boat_probe.mjs` — the Stage-0 script (kept; runs cleanly, is the artifact of record for
  *how* the phases were meant to be measured even though the mount blocker was found first).
- `docs/BOAT_PROBE.md` — this report.
- Diagnostic scratch scripts used to isolate the mount/eject behavior lived under
  `/tmp/.../scratchpad/boat_diag*.mjs` and `build_boat_channel.mjs` / `cleanup_boat_channel.mjs`
  for this session only — not checked in, and the rig they built has been reverted.
