# Gap: Boats

**Status:** PLAN — nothing implemented.
**Related:** [SWIMMING.md](../SWIMMING.md) · [NAVIGATION_REBUILD.md](../NAVIGATION_REBUILD.md) · [gaps/README.md](README.md)

A human crosses oceans at ~8 blocks/s in a boat. Andy swims at a measured 1.96 b/s. The word
`boat` appears nowhere in `src/agent`. This world's frozen oceans start ~5000 blocks out
(`frozen_ocean` at −2592, 5293) — boat travel is the difference between a 40-minute swim and a
10-minute cruise.

---

## 1. Feasibility — what the mineflayer source actually says

Read from `node_modules/mineflayer` 4.37.1 (`lib/plugins/entities.js`, `lib/plugins/physics.js`)
and `minecraft-data` for 1.21.11 (protocol 774, what this bot speaks).

**The headline: a mounted bot is completely outside prismarine-physics. The broken `onGround`
land branch cannot apply to boat travel.**

- `physics.js:477`: `bot.on('mount', () => { shouldUsePhysics = false })`. With that flag down,
  `tickPhysics` (physics.js:79–90) runs **nothing**: no `simulatePlayer`, no serverbound
  `position` packets, and — important later — **no `physicsTick` events**. Physics resumes only
  when the server sends a clientbound `position` packet (the handler at physics.js:~444 sets
  `shouldUsePhysics = true` and emits `forcedMove`), which is exactly what the server does when
  it seats you and when it dismounts you.
- So the question "does boat movement depend on prismarine-physics' broken land branch?" is
  answered **no, categorically** — the whole simulator is switched off while mounted.

**What the API offers** (all in `entities.js`):

| Call | What it sends (entities.js line) |
|---|---|
| `bot.mount(entity)` | `use_entity` interact packet (`useEntity(target, 0)`, :854). Fire-and-forget — completion is the `mount` event, driven by clientbound `attach_entity`/`set_passengers` (:746–800), which also sets `bot.vehicle`. |
| `bot.moveVehicle(left, forward)` | On 1.21.3+ (`newPlayerInputPacket` feature — active for us): serverbound `player_input` with `{forward, backward, left, right}` booleans (:859–872). Pre-1.21.3 it was `steer_vehicle`. |
| `bot.dismount()` | `player_input {inputs:{jump:true}}` (:881–899). Completion is the `dismount` event. |
| `bot.vehicle` / events `mount`, `dismount`, `entityAttach`, `entityDetach` | State + lifecycle. `entityGone` clears `bot.vehicle` if the boat entity despawns (:802–806). |

**What the API does NOT offer — the critical gap:** `vehicle_move` appears **nowhere** in
`mineflayer/lib` (grep: zero hits). In vanilla ≤1.21.x semantics, boat movement is
**client-simulated by the controlling passenger**: the real client runs boat physics and streams
serverbound `move_vehicle`; `player_input` only carries paddle inputs. mineflayer never sends
`vehicle_move` and has **no handler for the clientbound `vehicle_move` correction packet
either** — the server's authoritative boat position would be silently dropped.

Both packets exist at our protocol (verified in
`minecraft-data/.../pc/1.21.11/protocol.json`):

- serverbound `vehicle_move` 0x21: `{x,y,z: f64, yaw,pitch: f32, onGround: bool}`
- clientbound `vehicle_move` 0x37: `{x,y,z,yaw,pitch}`
- serverbound `player_input` 0x2a: bitflags u8 `[forward, backward, left, right, jump, shift, sprint]`

**The one genuine unknown, and it is server-side:** this server is 26.1 (protocol 775) reached
through a 774 translation layer. Whether *this* server moves a boat from `player_input` alone
(server-authoritative vehicle input, which Mojang has been moving toward) or still expects the
driver's client to stream `vehicle_move` (vanilla ≤1.21.x) cannot be determined from any source
in this repo. **Per this repo's rule — measure, don't argue — Stage 0 is a probe that tries both:**

- **Strategy A (input-driven):** mount, `bot.moveVehicle(0, 1)`, measure `bot.vehicle.position`
  over 100 ticks. If it moves, we are done and the implementation is trivial.
- **Strategy B (client-driven):** we *are* the driving client. Simulate trivial flat-water
  kinematics ourselves (yaw + speed ramp — no jumping, no `onGround` dependence; **we** choose
  what `onGround` to send) and write `bot._client.write('vehicle_move', {x,y,z,yaw,pitch,onGround:false})`
  at 20 Hz, exactly as a vanilla client does. The server validates vehicle moves with a generous
  "vehicle moved too quickly" threshold and corrects via clientbound `vehicle_move` — which we
  must listen for ourselves, since mineflayer ignores it.

Either way boats are feasible; the probe decides which branch ships.

**Consequences of `shouldUsePhysics = false` that shape everything below:**

1. **No `physicsTick` while mounted.** SwimAssist and AutoJump both hang off `physicsTick`, so
   they go silent automatically — no jump contention. But it also means `bot.waitForTicks`
   times out, the swim-probe machinery is dead, and any boat control loop must be
   `setInterval`/`sleep`-based, never tick-based.
2. **`bot.entity.position` goes stale while mounted.** Nothing updates it. The truth is
   `bot.vehicle.position`, kept current by `rel_entity_move`/`entity_teleport`/
   `sync_entity_position` handlers (entities.js:301–361). Anything reading the bot's position
   mid-cruise (`!stats`, the `unstuck` mode's stall detector) sees a frozen coordinate.
3. **`setControlState('sneak', true)` sends `player_input {shift}` even while mounted**
   (physics.js:245–263) — and shift is the dismount key. Control states are otherwise inert in
   a boat. New invariant: **nothing may touch sneak while `bot.vehicle` is set.**

---

## 2. Stage 0 — `!boatProbe` (measure first)

New file `src/agent/library/boat_probe.js`, mirroring `swim_probe.js`:

```js
export async function measureBoat(bot, opts = {})   // -> raw numbers
export function verdictForBoat(m)                    // pure: {strategy:'input'|'client-sim'|'infeasible', reason}
export function formatBoatProbe(m)                   // one VERIFIED BOAT PROBE line
```

Procedure (boat supplied by hand via `mc "give andy oak_boat 1"` for the probe only — the
craft path is Stage 1):

1. Place boat, mount (await `mount` event, 3 s timeout, one retry — the source has a TODO about
   crouch affecting mounting).
2. Install a raw listener `bot._client.on('vehicle_move', ...)` to capture server corrections
   (mineflayer drops them), and record `bot.vehicle.position` every 100 ms.
3. **Phase A:** `bot.moveVehicle(0, 1)` once, then re-send every second (real clients send
   `player_input` on change only, but re-sending is cheap insurance across the translation
   layer). 100 ticks. Measure b/s from `bot.vehicle.position` deltas.
4. **Phase B** (only if A reads ~0): stream serverbound `vehicle_move` at 20 Hz, advancing a
   simulated position along the current yaw at 2 b/s, then 4, then 8, 100 ticks each. Record:
   does `bot.vehicle.position` follow (server accepted), how many clientbound `vehicle_move`
   corrections arrive per phase, and the max speed held without correction.
5. Turn test: 90° heading change at cruise speed, both strategies.
6. Dismount; verify the clientbound `position` packet arrives (forcedMove) and physics resumes.

Output, in this project's style:

```
VERIFIED BOAT PROBE: inputDrive=0.00 b/s | clientSim@2=2.0 @4=4.0 @8=7.9 b/s |
corrections=0/0/3 | turn=ok | dismount=physics_resumed | VERDICT=client-sim (ship 6 b/s ceiling)
```

Command `!boatProbe` registered in `actions.js` via `runAsAction`, like `!swimProbe`
(actions.js:214). **Everything after this stage is provisional until these numbers exist.**

---

## 3. Stage 1 — boat lifecycle: craft or retrieve, place, mount, dismount, recover

New file `src/agent/library/boat.js`. Survival-legal throughout.

```js
export function isBoatEntity(entity)            // explicit name set (repo rule: never substring-match)
export function nearestBoat(bot, radius = 16)   // via world.getNearestEntityWhere
export async function ensureBoatItem(bot)       // -> item name | null
export async function placeBoat(bot, waterPos)  // -> {entity, reason}
export async function mountBoat(bot, entity)    // -> {mounted, ms, reason}
export async function dismountBoat(bot)         // -> {dismounted, physicsResumed, pos, reason}
export async function retrieveBoat(bot, entity) // break + pick up -> {retrieved, reason}
export function boatPosition(bot)               // bot.vehicle ? vehicle.position : bot.entity.position
```

- **`isBoatEntity`**: explicit set built from the 1.21.11 entity list — the 9 wood `*_boat`
  types, `bamboo_raft`, and their `*_chest_boat` / `bamboo_chest_raft` variants. A frozen
  `Set`, unit-tested, per the `isFallingBlockName` precedent.
- **`ensureBoatItem`**: inventory check for any boat item first; else craft — any `*_planks`
  ×5 plus a crafting table, through the existing `skills.craftRecipe` (skills.js:116) and its
  table-finding path. Returns null with a reason ("no planks") rather than throwing.
- **`placeBoat`**: boats are **entities placed via item use, not blocks**. Server-side,
  `BoatItem.use` raytraces from the player's eye along its look vector (fluids included), so the
  codebase's `fillBucket` pattern adapts: `equip(bot, boatName)` then `bot.lookAt(waterSurface)`
  at a water cell 2–3 blocks ahead, then `bot.activateItem()` (the equip + activateItem pattern
  at skills.js:3987–3991). Confirm success by awaiting an `entitySpawn` matching `isBoatEntity`
  within ~4 blocks of the aim point (2 s timeout, one retry). Do **not** use `activateBlock` —
  water is not a placeable face.
- **`mountBoat`**: `bot.mount(entity)`; await the `mount` event (3 s). After mounting:
  `bot.clearControlStates()` — safe now that SwimAssist asserts against real state (§5 of
  SWIMMING.md), and it prevents a latched `forward`/`jump` from firing the instant physics
  resumes at dismount. Set `bot.swimAssist.setMode('auto')`.
- **`dismountBoat`**: `bot.dismount()`; await the `dismount` event **and** the following
  `forcedMove` (that is the physics-resume handshake — until it arrives, `bot.entity.position`
  is garbage and no movement call may be issued). If wet on resume, SwimAssist's positive
  buoyancy takes over automatically on the next `physicsTick` — that is the existing invariant
  doing its job.
- **`retrieveBoat`**: `bot.attack(entity)` (boats break in 1–2 hits bare-handed), await
  `entityGone`, then `skills.pickupNearbyItems` (skills.js:735). Only attempt in water ≤2 deep
  or from land; a bot treading deep water breaking its own ride is how you strand yourself.

**Ownership contract (extends SWIMMING.md §4 invariant 2):**

| State | Jump key | Position source | Movement owner |
|---|---|---|---|
| dry land | AutoJump (pulses) | `bot.entity.position` | nav.js |
| wet | **SwimAssist** | `bot.entity.position` | swim.js |
| mounted | nobody (physicsTick stopped; controls inert) | **`bot.vehicle.position`** | boat.js steer loop |

Boarding: SwimAssist keeps jump until the `mount` event fires, then goes silent automatically.
Disembarking: SwimAssist re-acquires jump on the first `physicsTick` after `forcedMove` —
`boatTravel` must not touch jump at any point. New invariants: **no sneak while mounted**, and
**no tick-based waits while mounted**.

**Mode safety:** `modes.js` `unstuck` judges stallness from `bot.entity.position`, which freezes
while mounted — it would interrupt every cruise. Add an early `if (agent.bot.vehicle) return;`
guard to `unstuck` (and audit `self_preservation` the same way). `drowning` needs no change: a
seated bot's head is above water and, with `physicsTick` stopped, it could not fire anyway —
which is fine, because it is needed exactly when we are *out* of the boat, and that is when
physics is back.

---

## 4. Stage 2 — steering: `steerTo`

In `boat.js`:

```js
export async function steerTo(bot, targetXZ, opts = {})
// -> {arrived, covered, ms, bps, corrections, strategy, reason}
// reasons: arrived | land_ahead | stall | lost_vehicle | interrupted | timeout
```

A `sleep(50)`-loop (never `physicsTick`), strategy chosen by the probe verdict:

- **Strategy A (input):** aim with `bot.look(yaw, 0)` toward the target (yaw is how a real
  driver steers; pitch irrelevant — same lesson as swimming), hold `bot.moveVehicle(0, 1)`
  re-sent 1/s. Left/right inputs (`moveVehicle(±1, 1)`) only if the probe shows look-yaw alone
  does not turn the boat.
- **Strategy B (client-sim):** maintain our own boat state `{pos, yaw, speed}`; each 50 ms tick:
  turn yaw toward the bearing at a clamped rate, ramp speed toward the probe-verified ceiling,
  advance `pos`, write serverbound `vehicle_move`. Apply any clientbound `vehicle_move` as
  authoritative (snap our state to it) and count it. **Correction valve, copied from
  SwimAssist's `forcedMove` valve:** >3 corrections in 10 s → halve the speed ceiling; halve
  again rather than fight the server. The failure mode must be "slow boat", not "kicked".
- **Both:** every loop iteration, scan the water surface 8 blocks along the heading
  (`isWaterName` on the cell at boat Y, air above). Non-water ahead → ease off and finish with
  `land_ahead` at ~2 blocks clearance — that is the disembark trigger, not an error. Stall
  detector on `bot.vehicle.position` progress along the bearing (the travel-axis rule,
  NAVIGATION_REBUILD.md invariant 4). `bot.vehicle == null` mid-loop → `lost_vehicle`.

---

## 5. Stage 3 — `!boatTo(x, z)`

`skills.js`:

```js
export async function boatTravel(bot, x, z, opts = {}) // full pipeline, returns outcome string
```

Pipeline: `ensureBoatItem` (or `nearestBoat` already floating) → walk/swim to the water's edge
(`nav.navigateTo` / `swim.swimTo`) → `placeBoat` → `mountBoat` → `steerTo({x, z})` →
`dismountBoat` near the bank → `retrieveBoat` (default true; skip via `opts.keepBoat`) → final
`swimTo`/`navigateTo` onto dry land via `swimCrossingTarget` / `nav.nearestDryLand`
(nav.js:427). Never end the action with the bot floating in deep water: `drowning` mode and
positive buoyancy are the backstop, not the plan.

Command, in `actions.js` `actionsList` next to `!swimTo` (:144):

```js
{
    name: '!boatTo',
    description: 'Cross open water by boat: crafts/places/mounts a boat, cruises to (x,z), disembarks on the far bank and recovers the boat. Reports VERIFIED speed.',
    params: {
        'x': { type: 'int', description: 'Target x.' },
        'z': { type: 'int', description: 'Target z.' },
    },
    perform: runAsAction(async (agent, x, z) => skills.boatTravel(agent.bot, x, z)),
},
```

Outcome line (machine-checkable, measured, like `VERIFIED SWIM` at actions.js:157):

```
VERIFIED BOAT: arrived=true, covered 412/415 blocks in 61.3s (6.7 b/s, swim would be ~210s),
strategy=client-sim, corrections=1, boat=recovered
```

`!stats` (queries.js, beside the water line at :34) grows a line **only while mounted**:
`- In boat: oak_boat at (x, z), 6.5 b/s` — costs nothing in the normal prompt, and it is the
only visibility into a state where `bot.entity.position` lies.

---

## 6. Stage 4 — when `travelDirection` prefers the boat

The decision point already exists: skills.js:4288–4311. Today, water ahead wider than
`MAX_SWIM_LEG = 24` (skills.js:4590) means `escapeWater` and a detour — oceans are simply
untraversable. Change, inside the existing water branch:

1. New pure helper `openWaterRun(blockAt, x, z, y, dx, dz, maxLook = 96)` — how far the water
   extends along the heading (`scanAhead`'s water count caps at its 10-block range, too short).
2. If `swimCrossingTarget` finds a bank within `MAX_SWIM_LEG` → swim, unchanged.
3. Else if `openWaterRun ≥ MIN_BOAT_LEG` **and** (`ensureBoatItem` would succeed or a boat
   floats within 16 blocks) → `boatTravel` toward the heading, target = far bank or
   remaining-distance point, whichever is nearer.
4. Else → `escapeWater`, exactly as today. **`MAX_SWIM_LEG` stays at 24** — the boat is a new
   branch above the ceiling, not a raised ceiling.

`MIN_BOAT_LEG` from arithmetic, then re-derived from probe numbers: overhead (place + mount +
dismount + retrieve) ≈ 15 s; time saved ≈ (1/1.96 − 1/8) ≈ 0.39 s per block → break-even ≈ 40
blocks. Ship `MIN_BOAT_LEG = 40`. Between 24 and 40 blocks the answer remains: swim.

No cost-model change in `nav.js` in this iteration: the planner's 96-block `planRange` cannot
see across an ocean anyway; the boat decision lives at `travelDirection`'s scale, same as the
cliff/climb-out decisions. (Wiring water-with-boat pricing into A* is a later, separate change —
it moves the whole frontier; see the `swimEnabled` precedent.)

---

## 7. Pure, unit-testable pieces (`tests/boat.test.mjs`, run with the existing `bun run test` suite)

| Function | Property under test |
|---|---|
| `isBoatEntity` | `oak_boat` yes, `bamboo_raft` yes, `boat` no, `saddle` no — anchored like the `sandstone` cases |
| `boatKinematicsStep(state, bearing, dt, limits)` | Strategy B stepper: speed ramps and clamps, yaw turn-rate clamps, position advances along yaw; a correction snap resets cleanly |
| `shouldBoat({waterRun, haveBoat, canCraft, minLeg})` | the §6 decision table, all four branches |
| `openWaterRun(blockLookup, ...)` | injected fake block reader, same style as `swimCostFor` |
| `verdictForBoat(m)` | probe → strategy mapping incl. `infeasible` when both phases read ~0 |
| `formatBoatProbe` / VERIFIED formatting | exact-string regressions |

---

## 8. Risks

- **Boat desync / rubber-banding (strategy B).** The server corrects via clientbound
  `vehicle_move`, which mineflayer drops on the floor — without our raw listener the boat's real
  position silently diverges from our simulation. Mitigation: treat every correction as
  authoritative, count them, speed-halving valve (§4). Purpur's "vehicle moved too quickly" is a
  log-and-correct, not a kick, but the valve assumes hostility anyway — same posture as the
  sprint-swim boost.
- **Spurious physics re-enable while mounted.** Any clientbound `position` packet sets
  `shouldUsePhysics = true` (physics.js:~445) — mineflayer would resume sending *player*
  position packets while the server thinks we are seated: instant desync. This server emits
  position packets more freely than vanilla (swim-probe baseline finding). The steer loop must
  watch `forcedMove` while mounted and treat one as "seat lost — re-verify `bot.vehicle`, abort
  if gone".
- **Dismount into deep water.** Ordered backstops, all existing: SwimAssist positive buoyancy
  (crash-anywhere failure mode = floating), `drowning` mode first in `modes_list`, and
  `boatTravel` only dismounts after `land_ahead` (≤2 blocks to a bank). The dismount handshake
  (§3) guarantees physics is live before anything else runs.
- **Losing the boat entity.** `entityGone` fires on despawn/render-distance loss and nulls
  `bot.vehicle` — mid-cruise this returns `lost_vehicle`, and recovery is: probe position from
  the last known `bot.vehicle.position`, swim on or place a spare. Default-retrieve after every
  crossing is the real defence; boats left at sea are gone. Log the abandon position into
  `MemoryBank` when `keepBoat` is used.
- **Ice — the frozen oceans this is for.** Two distinct facts: (a) a frozen surface has no open
  water to *place* into — placement needs a hole (dig one ice block from the bank, or find a
  lead; `surface()`'s dig-ice machinery is adjacent art); (b) **boats on ice are FASTER than on
  water in vanilla** (ice ~40 b/s, blue ice ~70, vs ~8 on water) — on-ice driving is
  strategy B with `onGround: true` and a higher ceiling, and could beat everything else in this
  codebase by an order of magnitude. Ship water first; add an ice phase to `!boatProbe` before
  believing any of that. Also note SWIMMING.md §8: the under-ice crevice trap is exactly what
  boat travel *avoids* — the bot stays on top.
- **Chest boats** count as boats for retrieval/mounting but have inventory semantics — excluded
  from `ensureBoatItem` crafting, accepted by `nearestBoat`.
- **The probe can conclude "infeasible"** (strategy A reads 0 and strategy B is rejected
  wholesale by the translation layer). Then this plan stops at Stage 0 with a measured negative
  — which this repo treats as a result, not a failure — and the fallback remains swim legs +
  `escapeWater`.

---

## 9. Build order

| Stage | Deliverable | Gate |
|---|---|---|
| 0 | `boat_probe.js`, `!boatProbe`, raw `vehicle_move` listener | VERIFIED BOAT PROBE line decides strategy; **stop here if infeasible** |
| 1 | `boat.js` lifecycle + pure tests + `unstuck` vehicle guard | place→mount→dismount→retrieve round-trip on a pond, no stranding |
| 2 | `steerTo` (probe-selected strategy) | 100-block lake crossing, measured b/s in the VERIFIED line |
| 3 | `!boatTo`, `!stats` line | ocean leg vs measured swim baseline |
| 4 | `travelDirection` integration (`MIN_BOAT_LEG`) | `!travel` across water >24 wide boards a boat by itself |
| 5 (stretch) | ice placement + on-ice driving | probe ice phase first |

---

### Critical Files for Implementation

- /home/asanrivas/mindcraft/src/agent/library/skills.js — `boatTravel`, the `travelDirection` water branch (lines 4288–4311), `MAX_SWIM_LEG` (4590), the `equip`+`activateItem` placement pattern (3987–3991)
- /home/asanrivas/mindcraft/src/agent/commands/actions.js — `runAsAction` (43), `!swimTo`/`!swimProbe` registration pattern (144–220) for `!boatTo`/`!boatProbe`
- /home/asanrivas/mindcraft/src/agent/library/swim_assist.js — the ownership/valve patterns the mounted state must interoperate with
- /home/asanrivas/mindcraft/node_modules/mineflayer/lib/plugins/entities.js — `mount`/`dismount`/`moveVehicle` (854–899), vehicle lifecycle events (746–820)
- /home/asanrivas/mindcraft/node_modules/mineflayer/lib/plugins/physics.js — `shouldUsePhysics` gating (79–90, 477), the physics-resume handshake (~444)