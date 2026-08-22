# Gap: The Nether

Status: **PLAN — nothing implemented**

## 0. Feasibility verdict — read this first, it gates everything

**Conditionally feasible — this is NOT the same hard blocker as the version bump. Verify with a
ten-minute, zero-code probe before writing any portal code.**

Reasoning, from source:

- We connect **as 1.21.11 / protocol 774** (`settings.js:2` pins it; the server accepts that).
  Every packet the client sees is therefore already in the 774 dialect — the proof is that
  overworld `map_chunk` packets parse and `bot.blockAt` works today.
- A dimension switch is not a new protocol surface. It is a `respawn` packet followed by a fresh
  `map_chunk` stream **in that same dialect**. mineflayer 4.37.1 handles all of it:
  - `node_modules/mineflayer/lib/plugins/blocks.js:553-570` — on `respawn` with a changed
    dimension, `switchWorld()` unloads every chunk column and rebinds `bot.world`.
  - `node_modules/mineflayer/lib/plugins/game.js:30-88, 118-122` — `handleRespawnPacketData`
    updates `bot.game.dimension` (from the registry, so it reads `the_nether`) and
    `bot.game.minY`/`height` from the dimension codec sent at login.
  - `node_modules/mineflayer/lib/plugins/health.js:6-8` — the client `respawn` packet emits bot
    `'respawn'` (note: **`'death'` does NOT fire** on portal traversal, so `agent.js:553`'s death
    handler stays quiet — correct).
  - `node_modules/mineflayer/lib/plugins/physics.js:424-482` — physics pauses until the server's
    post-respawn position packet.
- The `prismarine-chunk` "no 26.x implementation" blocker applied to **connecting at protocol
  775**. It does not apply here: the chunk parser is keyed off the *negotiated* client version
  (1.21.11 → the 1.18 column format in `prismarine-chunk/src/pc/`), which is exactly what parses
  overworld chunks today.

**If this is wrong, the failure looks like** (same class as the version-bump attempt,
`docs/PROTOCOL_ERROR_FIX.md`):

- `PartialReadError: Read error for undefined : Unexpected buffer end while reading VarInt` from
  protodef while parsing `respawn` or the first nether `map_chunk`; or
- **silent**: chunks never load — `bot.blockAt()` returns null everywhere, `full_state.js:95`'s
  "hacky fix when blocks are not loaded" fires, `nav.classify` reads everything UNKNOWN and the
  bot free-falls through unrendered terrain; or
- a `RangeError`/out-of-bounds inside `prismarine-chunk`'s ChunkColumn if `bot.game.minY/height`
  come out wrong for the dimension (`game.js:70-78`; nether defaults of 0/256 are luckily
  correct — **the return to the overworld is where a failed registry lookup bites**, because
  minY must go back to −64).

### Phase 0 probe (no code, operator RCON)

```
mc "execute in minecraft:the_nether run tp andy 0 80 0"
```

Then verify, in order:
1. Dashboard/`full_state.js:65` shows `dimension: the_nether` (already wired, used nowhere else).
2. `!surroundings` names real nether blocks (netherrack/soul_sand), not nulls.
3. `!navTo` a 20-block hop actually moves — physics resumed.
4. `grep PartialReadError logs/*.log` is clean.
5. `mc "execute in minecraft:overworld run tp andy <x> <y> <z>"` back, then **read a block below
   y=0** (`!scanArea` at a deepslate depth) to prove `minY` reverted to −64.
6. Run the round trip twice — the world-switch path caches `dimension`/`worldName` state
   (`blocks.js:501-511`) and the second switch exercises the cached branch.

GO → phases 2–4 below. NO-GO → record the exact error in this Status line, keep phases 1–2
(they are dimension-independent), and park the rest under the same rule as the version bump:
do not sink more time into it.

## 1. Portal construction

Geometry facts: frame is 4 wide × 5 tall obsidian with a 2×3 interior; the 4 corners are
optional → **10 obsidian minimum**. Lighting: flint_and_steel used on an interior face; success
is 6 `nether_portal` blocks appearing.

### Obsidian: casting beats mining — casting is the primary path

| | Mining path | In-place casting path |
|---|---|---|
| Hard requirement | `diamond_pickaxe` — **depends on the resource-progression gap (#5)** | 1–2 iron buckets + a lava pool + a water source |
| Tech-tree cost | iron pick → diamonds → diamond pick | 3 iron/bucket, 1 iron + 1 flint for flint_and_steel |
| Existing code | `digWithTool` (`tools.js:51`) — **has NO harvest-tier guard**: an iron pick "digs" obsidian for ~50 s, drops nothing, and returns true. Must add a tier guard (obsidian/crying_obsidian/ancient_debris ⇒ diamond+) before this path is enabled | `fillBucket(bot,'lava')` (`skills.js:3561`) works; `placeBlock(bot,'lava'|'water',x,y,z)` maps to the bucket item (`skills.js:917-922`) and routes buckets through `useToolOnBlock` (`skills.js:1036-1038`); `verifyBlockPlaced` (`skills.js:1047`) confirms results |

Casting procedure (mold of ~30 cobble): pour one lava bucket into each of the 10 frame cells,
convert each to obsidian with a reusable water bucket (place water adjacent-above, wait for the
cell to read `obsidian`, re-scoop with `fillBucket(bot,'water')`). **Order matters** — a cell
must have a closed bottom and back at pour time: bottom row first, then the side columns upward,
top row last. Water only converts *source* lava (flowing → cobblestone), so verify every cell
before moving on. Caveat: `placeBlock`'s internal approach moves use mineflayer-pathfinder
(`skills.js:991-1007`), the known-broken mover — pre-position with `nav.navigateTo` before each
pour so those internal moves are no-ops.

### New module `src/agent/library/portal.js`

```js
export function framePlan(anchor, axis)                    // pure: {frame:[10], interior:[6], corners:[4]} Vec3-likes
export function validateFrame(getName, anchor, axis)       // pure: {ok, missing:[], lit} — getName(x,y,z) callback
export function isNetherDimension(name)                    // pure: 'the_nether' + proxy names ('world_nether')
export async function buildPortalFrame(bot, anchor, axis, {method}) // 'place' | 'cast' | 'mine'
export async function lightPortal(bot, anchor, axis)       // useToolOnBlock(bot,'flint_and_steel', baseBlock) (skills.js:4034), then poll interior for 'nether_portal' ≤2 s
export async function enterPortal(bot, portalPos)          // §2
export async function awaitDimensionChange(bot, predicate, timeoutMs = 20000)
```

Lighting reuses `useToolOnBlock` — the `!useOn` command's skill (`skills.useToolOn`,
`skills.js:3972`) already does equip + look + `bot.activateBlock`, which is exactly the
flint-and-steel gesture.

## 2. Traversal and the return trip

- `enterPortal`: `nav.navigateTo` to within 2 of the base, then a **manual walk-in**
  (`setControlState('forward')` toward the interior cell — `nether_portal` has an empty bounding
  box, so `classify` reads it AIR and nothing blocks entry), then `clearControlStates()` and
  stand still. Survival transfer is server-side after ~4 s (80 ticks) standing in the portal.
- `awaitDimensionChange`: resolve when `predicate(bot.game.dimension)` is true AND chunks are
  live (`bot.blockAt(bot.entity.position)` non-null, plus one `chunkColumnLoad`). Timeout 20 s.
  Treat the `'respawn'` event as informational only; SwimAssist already resets on it
  (`swim_assist.js:62`) which correctly restores `liquidAcceleration`.
- **Arrival protocol before any step**: scan the surrounding ring with `classify` for
  lava/ledges; the pairing algorithm can place the arrival platform on a shelf over a lava
  ocean. Bridge with cobble if the ring is unsafe.
- Record both portal positions in `agent.memory_bank` (`portal_overworld`, `portal_nether`) and
  say the coordinates in chat so they survive into `$MEMORY`. (MemoryBank is RAM-only.)
- **Return trip = the same portal.** Step 2–3 blocks out of the arrival portal first (the server
  will not re-teleport until you leave and re-enter), do the nether business, navigate back to
  the recorded `portal_nether`, re-enter, `awaitDimensionChange(isOverworld)`. Never trust
  coordinate math (÷8 pairing links to *any* portal within 128 nether blocks) — trust the
  recorded position.
- Give the planner `portalCost: 40` for `nether_portal` cells so a route never shortcuts
  *through* a lit portal by accident; entry stays possible because the final approach is manual.

## 3. Nether navigator profile (`nav.js`)

Precedent: the `swimEnabled` gate in `DEFAULTS` (`nav.js:70`) — off by default, enabled only by
callers that know what they are doing. Add a `netherMode` flag the same way.

`DEFAULTS` additions (`nav.js:29-86`):

```
netherMode: false,
lavaMarginCost: 8,   // standing beside lava costs extra — keeps routes off shorelines
magmaCost: 4,        // netherMode only: magma is walkable-but-priced, not forbidden
portalCost: 40,
```

Nether override profile, exported as `navProfile(bot)` (returns `{}` unless
`isNetherDimension(bot.game.dimension)`), merged into opts by `travelDirection`
(`skills.js:4227`), `!navTo`, and `moveAway`:

```
netherMode: true,  swimEnabled: false,      // no water exists; drowning/escapeWater irrelevant
planRange: 48,     maxNodes: 12000,         // lava oceans + fully-3D caves eat node budget
maxDrop: 2,        dropCost: 8,             // falls end in lava
preferY: null,                              // "surface bias" is meaningless under bedrock ceiling
```

`classify` changes (`nav.js:131-153`), reviewed against the `tools.js` classifiers:

- **Bug found: `soul_fire` is missing.** The HAZARD list matches `'fire'` exactly; `soul_fire`
  falls through to the bounding-box branch (empty → AIR) and the planner will walk through it.
  Add it. (`fire`, `magma_block`, lava via `isLavaName`, `lava_cauldron`, bubble columns are
  already handled.)
- `magma_block`: HAZARD today. In the nether magma fields line every shore — as HAZARD they make
  whole regions unplannable and the frontier burns its budget skirting them. Under `netherMode`,
  reclassify to SOLID and charge `magmaCost` in the stand cost (keep HAZARD in the overworld).
- `soul_sand`/`soul_soil`: already SOLID via bounding box — correct; slowness is not worth a cost
  entry in v1.
- Lava margin: charge `lavaMarginCost` when any horizontal neighbour of the below-block is lava
  (4 extra memoised `classify` reads per cell). This both keeps routes away from the ghast-
  knockback kill zone and stops A* flooding its budget along an ocean edge. Extend the pure
  `swimCostFor` (`nav.js:198`) — or add a sibling `netherCostFor` — so it stays unit-testable.
- Measure `planPath` wall time in the nether against the 430 ms/96-block baseline before tuning
  further ("measure before tuning" — ground rules).

Gate on `isNetherDimension`: `travelDirection`'s climb-out-first logic (`skills.js:4200-4204`),
`goToSurface` (`skills.js:3953`), `climbToSurface` (`skills.js:4136`) — under a bedrock ceiling,
"climb to daylight" digs at bedrock forever.

## 4. Minimal survival policy (`modes.js`)

- **`self_preservation`'s water-bucket-on-fire branch (`modes.js:117-120`) must be
  dimension-gated** — in the nether the bucket flashes to steam, the fire remains, and the
  water is gone. Nether replacement: sprint out of the fire cell to the nearest non-hazard
  cell; if `swim.inLava(bot)`, hold jump (lava shares the water jump-impulse branch — the
  SWIMMING.md invariant) and steer to a new `nearestSolidGround(bot, radius)` (sibling of
  `nearestDryLand`, `nav.js:427`, accepting solid-non-hazard instead of dry-air-over-solid).
  Bounded `execute()` timeout as the existing branches do.
- **Ghasts — the top killer is knockback into lava.** v1 is distance and cover, not combat (bows
  belong to the ranged-combat gap): when a ghast is within 40 blocks and the bot is within the
  lava margin, move inland first; if health < 12, `placeNearby(bot, 'cobblestone')`
  (`skills.js:4553`) to wall the line of sight. One owner per control state; run via `execute()`
  with a timeout.
- No fire resistance exists (brewing is a deferred gap) — nothing to add beyond the above.
- `!enterNether` preflight warning (not a hard block): ≥64 cobblestone, a pickaxe, food; note
  that a water bucket is dead weight there.

## 5. Commands (`src/agent/commands/actions.js`, append before line 1178)

- `!buildPortal(method?)` → `portal.buildPortalFrame` + `lightPortal`. Reports
  `VERIFIED PORTAL: frame 10/10 obsidian, interior 6/6 nether_portal at (x, y, z).`
- `!enterNether` → nearest `nether_portal` via `world.getNearestBlock(bot, 'nether_portal', 16)`
  (`world.js:296`), enter, await, record both sides. Reports
  `VERIFIED DIMENSION: overworld -> the_nether at (x, y, z). Chunks loaded in N ms.`
- `!returnOverworld` → navigate to remembered `portal_nether`, re-enter, await overworld,
  mirror VERIFIED line.
- `!stats` (`queries.js:18`): add `- Dimension: the_nether` **only when not overworld** — the
  same costs-nothing pattern as the In-water line (`queries.js:34`). `full_state.js:65` already
  reads `bot.game.dimension`; this is its first consumer.

## 6. Pure-testable pieces (`tests/portal.test.mjs`, bun, add to the chain in `package.json:58`)

- `framePlan`: 10 frame + 6 interior cells, both axes, corners excluded.
- `validateFrame` against a mock `getName`: complete / one-missing / lit / unlit.
- Casting-order invariant: every pour target has solid support below and behind at its
  scheduled step (simulated grid).
- `isNetherDimension`: `the_nether`, `world_nether`, `overworld`, junk.
- Cost model: `netherCostFor`/`classify` gates — magma SOLID-with-cost in netherMode, HAZARD
  otherwise; `soul_fire` HAZARD in both.

## 7. Risks

1. **Dimension-switch chunk reload** — gates everything; probe first; expected errors in §0.
2. **Overworld-return minY regression** — `game.js:73-78` registry lookup; probe step 5 covers it.
3. **Arrival portal over lava / on a ledge** — don't move on arrival; scan, bridge.
4. **Ghast knockback into lava** — margin cost + cover policy; accept some deaths in v1.
5. **`digWithTool` has no tier guard** — silent no-drop obsidian "mining"; fix before enabling
   the mining path.
6. **Lava-ocean node burn** — planRange 48 / maxNodes 12000 / margin cost; measure.
7. **Portal pairing surprises** — multiple portals within 128 nether blocks link unpredictably;
   always return via recorded coordinates.
8. **Modes interrupting the 4-second portal stand** — likely quiet (still, full health), but
   zombified-piglin proximity can fire `self_defense`; if observed, use the
   `excludeFromInterrupt` precedent (`modes.js:46`).
9. **`placeBlock`'s internal pathfinder moves** on rough netherrack — pre-position with `nav`.
10. **26.x nether blocks translated to the 774 dialect** — unknown names classify SOLID via
    bounding box (safe); verify `!surroundings` names during the probe.

## 8. Sequencing

- **Phase 0** — the probe (§0). GO/NO-GO.
- **Phase 1** (cheap, valuable even on NO-GO): `portal.js` pure geometry + tests; `classify`
  `soul_fire` fix + `netherMode` gates + tests; `!stats` dimension line.
- **Phase 2** (overworld-only, valuable even on NO-GO): `!buildPortal` — casting, lighting,
  frame verification. A lit portal is fully verifiable without ever traversing it.
- **Phase 3** (GO only): `!enterNether` / `awaitDimensionChange` / `!returnOverworld`.
- **Phase 4** (GO only): nether nav profile live tuning, survival policy; measure `planPath` ms
  and blocks/min in the nether.

Dependency: the diamond-pick mining path depends on the **resource-progression gap (#5)**. The
casting path does not — it needs iron for 1–2 buckets plus flint_and_steel, both reachable with
today's `!smeltItem`/`!craftRecipe`.

### Critical Files for Implementation
- /home/asanrivas/mindcraft/src/agent/library/nav.js
- /home/asanrivas/mindcraft/src/agent/library/skills.js
- /home/asanrivas/mindcraft/src/agent/library/portal.js (new)
- /home/asanrivas/mindcraft/src/agent/commands/actions.js
- /home/asanrivas/mindcraft/src/agent/modes.js