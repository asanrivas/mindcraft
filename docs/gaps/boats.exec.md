# Boats — execution plan

**Status:** PLAN, re-verified 2026-08-31 against the checked-out `node_modules` (mineflayer
4.37.1, minecraft-data for 1.21.11). Supersedes [boats.md](boats.md) (2026-08-22) — that plan's
mineflayer/protocol research holds up almost entirely; its *framing* leaned on two premises
that CLAUDE.md has since overturned (broken `onGround`, protocol-775 translation layer), and
every place the reasoning depended on them is corrected below.

Nothing is implemented; `boat` appears nowhere in `src/agent`. Stage 0 gates everything.

---

## 1. Re-verified findings (file:line, current tree)

### 1a. A mounted bot is completely outside prismarine-physics — CONFIRMED

- `node_modules/mineflayer/lib/plugins/physics.js:477` — `bot.on('mount', () => { shouldUsePhysics = false })`. Verbatim.
- `physics.js:78-89` (`tickPhysics`) — with the flag down, **nothing** runs: no
  `simulatePlayer`, no `physicsTick` emit (`:81-85`), no serverbound `position` packets
  (`updatePosition` gated at `:86-88`).
- Physics resumes only in the clientbound `position` handler — `physics.js:372` (handler
  start), `:446` (`shouldUsePhysics = true`), then `bot.emit('forcedMove')` (`:451`). The old
  plan cited "~444/445" for the handler; the handler *starts* at 372 — 435/446 are the two
  `shouldUsePhysics = true` sites inside it (435 is the delayed post-respawn branch).
- `bot.waitForTicks` (`physics.js:455-473`) counts `physicsTick` events, so it **times out
  while mounted**. Any boat loop must be `sleep`-based, never tick-based. Confirmed.

**Dead premise, restated:** the old plan's headline was "the broken `onGround` land branch
cannot apply to boat travel". `onGround` is not broken here (CLAUDE.md, 2026-08-30 correction:
clean bot jumps a vanilla 1.252). The mount finding stands on its own merits — while seated,
the simulator is off and neither its virtues nor its faults apply — but it is no longer an
*argument for* boats. The argument for boats is speed: ~8 b/s vanilla cruise vs the measured
1.96 b/s swim, over oceans that start ~5000 blocks out.

### 1b. The API surface — CONFIRMED, with two additions

All in `node_modules/mineflayer/lib/plugins/entities.js`:

| Call | What it does | Line |
|---|---|---|
| `bot.mount(entity)` | `useEntity(target, 0)` — a `use_entity` interact, fire-and-forget. Completion is the `mount` event. | `:854-857` |
| `bot.moveVehicle(left, forward)` | On `newPlayerInputPacket` (a `common/features.json` range of `['1.21.3','latest']` — **active for 1.21.11**): serverbound `player_input` with `{forward, backward, left, right}` booleans. Sign convention per the in-source docs: `left: -1 means right, 1 means left`. | `:859-878` |
| `bot.dismount()` | `player_input {inputs:{jump:true}}`; errors if not mounted. Completion is the `dismount` event. | `:881-899` |
| `mount`/`dismount` events, `bot.vehicle` | Driven by clientbound `attach_entity` (`:747-771`) and `set_passengers` (`:773-799`). `entityGone` nulls `bot.vehicle` and emits `dismount` if the boat despawns (`:802-806`). | |

**Addition 1 — `player_input` is a full-state packet, and mineflayer writes partial states.**
The wire type is one `u8` bitflags `[forward, backward, left, right, jump, shift, sprint]`
(1.21.11 `protocol.json`, serverbound `0x2a`). `moveVehicle` writes only the four direction
flags; sneak writes only `{shift}` (`physics.js:261-268`); `dismount` writes only
`{jump:true}`. Every omitted flag rides as **false**, so each write clears the others
server-side. Consequences: (a) the "no sneak while mounted" invariant stands —
`physics.js:263` really does send the dismount-adjacent `shift` via `player_input` on this
version; (b) `dismount()` never sends a follow-up `jump:false` — the probe should confirm
that a single edge suffices; (c) in the input-driven branch, our own steer writes double as
the shift-clearing keep-alive.

**Addition 2 — `steer_boat` is also never sent.** `grep -rn steer_boat mineflayer/lib` → zero
hits (verified; so is `vehicle_move` — zero hits in either direction, confirming the old
plan). Serverbound `steer_boat 0x22 {leftPaddle, rightPaddle}` still exists at 1.21.11. A
vanilla boat driver sends *three* streams: `player_input`, `steer_boat`, and serverbound
`vehicle_move`. mineflayer sends only the first. The probe's Phase A must therefore try
`player_input` alone **and** `player_input + steer_boat` before concluding input-driving is
dead — paddle state is a plausible server-side movement input that costs one extra sub-phase.

### 1c. The packets — CONFIRMED byte-for-byte

From `node_modules/minecraft-data/minecraft-data/data/pc/1.21.11/protocol.json`, `play` state:

- serverbound `vehicle_move` **0x21**: `{x,y,z: f64, yaw,pitch: f32, onGround: bool}`
- clientbound `vehicle_move` **0x37**: `{x,y,z: f64, yaw,pitch: f32}` (no onGround)
- serverbound `player_input` **0x2a**: bitflags u8 as above
- serverbound `steer_boat` **0x22**: `{leftPaddle: bool, rightPaddle: bool}`

mineflayer has **no handler for clientbound `vehicle_move`** — a server correction of the
boat's position is silently dropped. Anything we build must raw-listen on
`bot._client.on('vehicle_move', ...)`.

### 1d. Position truth while mounted — CONFIRMED

Nothing updates `bot.entity.position` while mounted (physics is off, and the serverbound
position stream with it). The boat entity *is* updated by `rel_entity_move`
(`entities.js:301`), `entity_move_look` (`:320`), `entity_teleport` (`:333`),
`sync_entity_position` (`:348`) — so `bot.vehicle.position` is live **when the server is
moving the boat**. Caveat the old plan missed: in the client-authoritative regime (our Branch
B) the server does not echo the driver's own vehicle moves back to the driver, so
`bot.vehicle.position` may sit still while the boat genuinely moves. The probe's ground truth
must not depend on it — see §2.

### 1e. What the old plan got WRONG

- **"This server is 26.1 (protocol 775) reached through a 774 translation layer" — false.**
  The server is natively 1.21.11 = protocol 774 (CLAUDE.md, established 2026-08-23);
  ViaVersion advertises 775 in the ping and sits *outside* our packet path when we connect
  native. Every clause that leaned on it goes: "re-sending is cheap insurance across the
  translation layer" (Phase A re-send stays, but as plain robustness); "strategy B rejected
  wholesale by the translation layer" as an infeasibility mode (the realistic rejection risk
  is **Purpur/Paper vehicle-move validation and anti-cheat**, which is a known quantity here —
  `swim_assist.js` already carries a `forcedMove` valve because this server does correct us).
- **The onGround framing** (§1a above). Also: the old plan said we get to "choose what
  `onGround` to send" as if escaping a broken flag — restated: we choose it because *we* are
  the vehicle's physics authority in Branch B, and `false` is the honest value for a floating
  boat.
- **Stale line numbers in `src/`:** `travelDirection`'s water branch is now
  `skills.js:4928-4944` (was cited 4288-4311); `MAX_SWIM_LEG = 24` is `skills.js:5248` (was
  4590). The mineflayer citations were all correct or within a line or two.
- Everything else — the API table, `shouldUsePhysics` consequences, the missing
  `vehicle_move` handler, packet shapes and ids — re-verified correct.

---

## 2. STAGE 0 — `tools/boat_probe.mjs` (the decisive probe; DO NOT run from this session)

**The central unknown is server-side and undecidable from code:** does Purpur 1.21.11 move a
boat from `player_input` (± `steer_boat`) alone, or does it expect the driver to stream
serverbound `vehicle_move` (vanilla ≤1.21.x client-authoritative)? One script answers it.

**Style:** exactly `tools/place_probe.mjs` — a standalone mineflayer bot (no agent, no
assists), `createRequire` for mineflayer, `--host/--port` defaulting from `settings.js`,
version `1.21.11`, offline auth, raw `bot._client` listeners registered **at connect** (before
any write, to avoid racing the reply).

```
bun tools/boat_probe.mjs --username boatprobe --at <x,y,z>
```

**Operator prep (by the engineer running it, not the script):** whitelist `boatprobe` first —
an unwhitelisted bot crash-loops (memory: mindcraft-server-gotchas). Pick open water ≥20
blocks across, away from both live bots and any base. `mc "summon minecraft:oak_boat x y z"`
one block from `--at`, and `mc "tp boatprobe x y z"` after login. The script itself sends no
RCON and touches no agent state.

**Procedure** (each phase logs per-sample lines, then one summary):

0. Connect; register raw listeners for clientbound `vehicle_move` (count + last payload) and
   log every `forcedMove`. Find the boat entity within 8 blocks; `bot.mount(entity)`; await
   the `mount` event (3s, one retry — the source has a crouch TODO at `entities.js:855`).
   Record `mountMs`. Snapshot start position from the boat entity.
1. **Phase A1 (input only):** face the open-water bearing with `bot.look(yaw, 0)`, then
   `player_input {forward:true}` re-sent every 1s for 5s. Sample `bot.vehicle.position` and
   the clientbound `vehicle_move` stream every 100ms.
2. **Phase A2 (input + paddles):** same, plus `steer_boat {leftPaddle:true, rightPaddle:true}`
   at 10Hz. (Kept even if A1 passes — it tells us whether paddles matter for speed.)
3. **Ground truth for A:** dismount (`bot.dismount()`), await `dismount` **and** the following
   `forcedMove`; read `bot.entity.position`. The server seats you at *its* boat position —
   this is the measurement that cannot lie.
4. **Phase B (client-driven; runs regardless, so we learn the server's posture either way):**
   remount. Maintain `{pos, yaw}`; at 20Hz advance `pos` along yaw at 2.0 b/s and write
   serverbound `vehicle_move {x,y,z,yaw,pitch:0,onGround:false}` for 5s. Then a 4.0 b/s run,
   then 8.0. Per run record: clientbound `vehicle_move` corrections received (count + max
   deviation from our sim), whether `bot.vehicle.position` follows, any kick.
5. **Ground truth for B:** dismount as in step 3; compare `bot.entity.position` against the
   simulated end position of the last run.
6. Report physics resumption (`forcedMove` arrived, a subsequent `physicsTick` fired) —
   confirms the seam closes cleanly.

**Numeric pass/fail (unambiguous):** over each 5s run, `disp` = XZ distance from the run's
start, measured at the post-dismount ground truth (steps 3/5); `simErr` = XZ distance between
ground truth and our simulated end (Phase B only).

- **INPUT-DRIVEN** iff Phase A1 or A2 `disp ≥ 4.0` blocks (≥0.8 b/s; real boat cruise is
  ≥2 b/s, and measured still-water drift is well under 0.5 blocks/5s — no overlap).
- **CLIENT-SIM** iff every Phase A `disp < 4.0` AND Phase B at 2 b/s has `disp ≥ 8.0` (of
  10.0 simulated) AND `simErr ≤ 2.0`. Corrections are reported, not gating: >0 corrections
  with `simErr ≤ 2.0` still passes (the valve handles them in the shipped code).
- **INFEASIBLE** iff neither — Phase A `disp < 4.0` and Phase B `disp < 8.0` (server discards
  or reverts our vehicle_move). Then this plan stops at Stage 0 with a measured negative and
  the fallback remains swim legs + `escapeWater`.

**Output**, one machine-checkable line:

```
VERIFIED BOAT PROBE: A1=0.2 A2=0.3 blocks/5s | B@2 disp=9.8 simErr=0.4 corr=1 | B@4 ... | B@8 ...
| dismount=physics_resumed | VERDICT=client-sim
```

---

## 3. Both branches (post-probe)

Shared lifecycle either way — new file `src/agent/library/boat.js`:
`isBoatEntity` (frozen name set: 9 wood `*_boat`, `bamboo_raft`, `*_chest_boat`,
`bamboo_chest_raft` — the `isFallingBlockName` precedent, never substring-match),
`nearestBoat`, `ensureBoatItem` (inventory, else `craftRecipe` from any `*_planks` ×5),
`placeBoat` (equip + `bot.lookAt(waterCell)` + `bot.activateItem()` — the `fillBucket`
pattern, `skills.js:758`; confirm by `entitySpawn` matching `isBoatEntity` within 4 blocks,
2s, one retry; never `activateBlock` — water is not a placeable face), `mountBoat` (mount
event, then `clearControlStates()` so no latched key fires when physics resumes),
`dismountBoat` (await `dismount` **and** the following `forcedMove` — until that handshake
completes, `bot.entity.position` is garbage and no movement call may be issued),
`retrieveBoat` (`bot.attack` → `entityGone` → `pickupNearbyItems`; only from land or water
≤2 deep), `boatPosition` (vehicle-aware position read for `!stats`).

### Branch A — input-driven (server moves the boat)

`steerTo(bot, {x,z})` in `boat.js`: a `sleep(50)` loop (never tick-based, §1a). Steer with
`bot.look(bearingYaw, 0)` — yaw is how a real driver steers — plus `bot.moveVehicle(0, 1)`
re-sent 1/s (also the shift-clearing keep-alive, §1b). Add `moveVehicle(±1, 1)` only if the
probe's turn data shows look-yaw alone does not turn the boat. Position truth:
`bot.vehicle.position` (live in this regime, §1d). Every iteration: scan 8 blocks of surface
along the heading; non-water → ease off, finish `land_ahead` at ~2 blocks — the disembark
trigger, not an error. **Lava at the surface anywhere in the scan → hard stop, reverse input,
`lava_ahead`.** Stall on progress along the travel axis (the NAVIGATION_REBUILD rule);
`bot.vehicle == null` mid-loop → `lost_vehicle`. A `forcedMove` while mounted means the server
unseated us or is fighting us — re-verify `bot.vehicle`, abort if gone (physics has resumed
and mineflayer is now streaming *player* positions from inside a boat: instant desync if
ignored).

### Branch B — we write `vehicle_move` (modeled on `place_packet.js`, explicitly)

New file `src/agent/library/boat_packet.js`, the third instance of "we own the packet"
(`place_packet.js`, `container_io.js` are the precedents; read both first):

- **Pure, schema-driven builders** — `vehicleMoveFields(schema)` reads the NEGOTIATED
  `packet_vehicle_move` container off `bot._client` exactly as `placeFields` does
  (`place_packet.js:47`); `buildVehicleMovePacket(fields, {x,y,z,yaw,pitch,onGround})` throws
  loudly on an unexpected field list. **Opt-in bound:** if the schema is not the 6-field shape
  we verified (§1c), refuse Branch B entirely — same blast-radius bound as `hasSequence`.
- **Pure kinematics stepper** — `boatStep(state, bearingYaw, dt, limits)` → next
  `{pos, yaw, speed}`: yaw turns at a clamped rate, speed ramps toward the probe-verified
  ceiling, position advances along yaw. A correction snap (`applyCorrection(state, pkt)`)
  resets speed and position cleanly. Fully unit-tested, no bot.
- **Raw clientbound listener** — corrections are authoritative: snap, count.
- **Correction valve, copied from SwimAssist** (`swim_assist.js:96-104`): only corrections
  that arrive *while we are streaming* count; >3 in 10s → halve the speed ceiling, halve
  again rather than fight. Failure mode must be "slow boat", never "kicked". Restore state on
  dismount/death (the `liquidAcceleration` leak lesson).
- **The live writer** — 20Hz `setInterval`: step, write, watch. `steerTo` has the same outer
  contract as Branch A (same scans, same reasons), only the propulsion differs.

Ship whichever branch the probe names; keep the other's pure parts (they cost nothing and the
stepper is the probe's own simulator).

---

## 4. Pure / live split

**Pure (unit-tested in `tests/boat.test.mjs`, no server — the `water_exit.test.mjs` /
`place_packet.test.mjs` pattern):**

| Function | Decides |
|---|---|
| `isBoatEntity(name)` | frozen-set membership |
| `shouldBoat({waterRun, landReachable, haveBoat, canCraft, distance, minLeg})` | boat vs swim vs walk vs escapeWater — the whole §6 decision table |
| `boardVerdict({entity, passengers, selfId, fluidBelow})` | may we mount THIS boat |
| `pickDismountPoint(blockAt, boatPos, bearing)` | which shore cell to disembark toward; refuses lava banks |
| `openWaterRun(blockAt, x, z, y, dx, dz, maxLook=96)` | how far the water extends (scanAhead caps at 10 — too short); injected fake reader like `swimCostFor` |
| `boatStep` / `applyCorrection` (Branch B) | kinematics |
| `vehicleMoveFields` / `buildVehicleMovePacket` (Branch B) | wire shape from real schemas copied out of minecraft-data |
| `verdictForBoat(measurements)` | probe → `input` / `client-sim` / `infeasible`, the §2 thresholds as code |
| `formatBoatOutcome(o)` | the VERIFIED line, exact-string regression |

**Live only:** mount/dismount handshake, `activateItem` placement, the steer loop itself, the
gym. Every live routine *consumes* a pure verdict rather than deciding inline.

---

## 5. `tests/boat.test.mjs` — cases (refusals carry more weight than acceptances)

- `isBoatEntity`: `oak_boat` yes, `bamboo_raft` yes, `oak_chest_boat` yes; `boat` no,
  `saddle` no, `boat_spawn_egg` no (anchored, the sandstone lesson).
- `boardVerdict` refusals: **passenger already seated** (`entity.passengers.length > 0` and
  none is us) → `occupied`; boat over lava → `lava`; entity not a boat → `not_a_boat`;
  already mounted in it → `already_mounted` (a no-op, not an error). Acceptance: empty boat
  on water.
- `shouldBoat` refusals: **destination reachable on land** (`landReachable=true`) → `walk`,
  whatever the water says; `waterRun < minLeg` → `swim` (24 < run < 40 stays swim —
  `MAX_SWIM_LEG` is untouched); no boat and no planks → `swim_or_escape`; route's first water
  cell is lava-adjacent → refuse. Acceptance: `waterRun ≥ 40`, boat available.
- `pickDismountPoint`: refuses a lava shore, refuses no-shore-in-reach (keep cruising),
  prefers the lowest dry cell in the forward cone (the `climbBank` cone lesson).
- **Never abandon the boat item:** `formatBoatOutcome` must throw unless the outcome carries
  `boat: retrieved | kept_at(x,z) | lost_reason` — an outcome that is silent about the boat
  fails the test. (`keepBoat` runs log the position to MemoryBank; that is `kept_at`.)
- `boatStep`: ramps, clamps, turn-rate limit, correction snap; speed ceiling halving after 4
  corrections in a fake 10s window (valve arithmetic, pure).
- `buildVehicleMovePacket`: correct body from the real 1.21.11 schema; **throws** on a
  mutated schema (extra field, missing `onGround`).
- `verdictForBoat`: all three verdicts, including the boundary values 4.0 / 8.0 / 2.0 exactly.

Plus one guard in `tests/command_docs.test.mjs`'s existing sweep: the new commands resolve,
are not one letter from anything destructive, and `!boatProbe` is hidden.

---

## 6. Integration points (shared files: MINIMAL, PURELY ADDITIVE)

| File | Change | Size |
|---|---|---|
| **new** `src/agent/library/boat.js` | lifecycle + steer + pure decisions | new file |
| **new** `src/agent/library/boat_packet.js` | Branch B only | new file |
| **new** `tools/boat_probe.mjs`, `tests/boat.test.mjs` | | new files |
| `src/agent/library/skills.js` | append `export async function boatTravel(bot, x, z, opts)` (pipeline: ensure→approach→place→mount→steer→dismount→retrieve→ashore). Stage 5 only: one added `else if` clause inside the existing water branch at `:4928-4944` calling `shouldBoat`. **No existing line modified; `MAX_SWIM_LEG` (`:5248`) untouched.** | ~1 function + 1 clause |
| `src/agent/commands/actions.js` | append `!boatTo`, `!boatProbe` entries to `actionsList` via the existing `runAsAction` (`:47`); append one imperative sentence to `!swimTo`'s description string (see §7 — required by the prohibitions-on-the-tempting-command rule; coordinate, it is a one-string edit) | 2 entries + 1 sentence |
| `src/agent/commands/queries.js` | one conditional `- In boat: ...` line in `!stats`, only while `bot.vehicle` — the only visibility into a state where `bot.entity.position` lies | ~3 lines |
| `src/agent/modes.js` | one early-return `if (agent.bot.vehicle) return;` at the top of `unstuck`'s update (its stall detector reads the frozen `bot.entity.position` and would interrupt every cruise); audit `self_preservation` for the same read | ~2 lines |
| `settings.js` | add `"!boatProbe"` to `hidden_actions` (`:144`) — measurement harness, chat-callable, hidden from the model | 1 token |

Nothing is restructured. `drowning` needs no change: seated head is above water, and with
`physicsTick` stopped it cannot fire — which is correct, because it is needed exactly when we
are out of the boat, and that is when physics is back.

**Ownership contract (extends the SWIMMING invariant table):** mounted → nobody holds the
jump key (physicsTick stopped, controls inert), position truth is the vehicle, movement owner
is `boat.js`. Two new invariants: **nothing touches sneak while `bot.vehicle` is set**
(`physics.js:261-268` — shift is the dismount-adjacent input and rides `player_input`), and
**no tick-based waits while mounted** (`waitForTicks` starves, §1a).

---

## 7. Command docs (compact-mode rules: first sentence ≤120ch; imperative follow-ups survive; param NAMES are the only param docs shown)

```js
{
    name: '!boatTo',
    description: 'Cross open water by boat to (x, z), landing on the far shore and picking the boat back up. '
        + 'Do NOT use for land travel or water under 40 blocks wide - use !travel or !swimTo. '
        + 'Refused when the destination is reachable on land. Takes about 15s of overhead to launch.',
    params: { 'x': {...}, 'z': {...} },   // bare x/z are self-explanatory; XZ only, like the marathon
},
{
    name: '!boatProbe',   // hidden_actions; description minimal, model never sees it
    description: 'Measure boat drive strategy on this server. Use only from chat.',
}
```

And on the **tempting** command, per the measured rule ("prohibitions go on the TEMPTING
command"): append to `!swimTo` — `'Do NOT use across open water wider than ~40 blocks - use
!boatTo.'` Cross-referencing both ways is what makes selection stable.

No new aliases. `!boatTo` shares no near-spelling with anything destructive.

---

## 8. Ordered tasks, acceptance-gated

| # | Task | Acceptance (all measured, none argued) |
|---|---|---|
| **0** | `tools/boat_probe.mjs` per §2. Engineer whitelists `boatprobe`, preps water + boat, runs it. | One `VERIFIED BOAT PROBE` line with a VERDICT hit by the §2 numeric thresholds. **INFEASIBLE stops the plan here — a measured negative is a result.** Everything below is provisional until this line exists. |
| 1 | Pure core: `boat.js` decision functions (+ `boat_packet.js` pure parts if verdict=client-sim) + `tests/boat.test.mjs`. | `bun tests/boat.test.mjs` green, all §5 refusal cases present. |
| 2 | Lifecycle live: place/mount/dismount/retrieve + the `unstuck` vehicle guard + `!stats` line. | Round trip on a pond: place → mount → dismount → retrieve, boat item back in inventory, log shows the `dismount`+`forcedMove` handshake and a subsequent `physicsTick`; `unstuck` fires 0 times while mounted. |
| 3 | `steerTo` for the probe-selected branch (Branch B includes the valve + raw correction listener). | 100-block lake crossing: `arrived`, measured b/s in the outcome, corrections counted, 0 kicks; `land_ahead` and `lava_ahead` each demonstrated once on purpose-built water. |
| 4 | `!boatTo` + command docs (incl. the `!swimTo` sentence) + `hidden_actions` entry. | Ocean leg reports `VERIFIED BOAT: ... b/s` beating the 1.96 b/s swim baseline; `tests/command_docs.test.mjs` green. |
| 5 | `travelDirection` integration: `MIN_BOAT_LEG = 40` (break-even arithmetic: ~15s overhead ÷ 0.39 s/block saved ≈ 40; re-derive from probe numbers). | `!travel` across water >40 wide boards a boat by itself; across 30-wide water it still swims; `MAX_SWIM_LEG` diff shows zero changes. |
| 6 | *(stretch)* Ice: placement needs a hole in the sheet; on-ice driving is Branch B with `onGround:true` and a far higher ceiling (~40 b/s vanilla). | An ice phase added to `!boatProbe` FIRST; believe nothing about ice until it prints. |
