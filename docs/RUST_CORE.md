# A Rust/WASM core for the owned client

Status: **plan, not built.** No Rust toolchain is installed on this box yet (`cargo`, `rustc`,
`wasm-pack` all absent), so Milestone 0 needs a decision before anything else happens.

---

## Read this before agreeing: where Rust actually wins here

The instinct is to port the physics. **Do not start there.** Measured on this machine today, on
the owned client:

```
physics tick        0.39 - 0.43 ms      against a 50 ms budget   ->  0.8% utilised
chunk decode        557 columns, 0 errors, no measured cost problem
A* plan, 96 blocks  ~430 ms             against a 50 ms tick     ->  8.6 ticks of blocking
```

Porting the physics tick would optimise the one thing that is not slow. **The A\* planner is the
real target** — 430 ms of synchronous computation, re-run up to `maxReplans: 6` times per
`navigateTo` call, which is up to 2.6 seconds per navigation during which the bot is not steering
and not reading packets. That is a genuine, measured, user-visible cost, and it is exactly the
shape WASM is good at: a pure function over a block grid with no I/O.

So the honest case for Rust here is **two** things, and performance is only the second:

1. **A core we own.** Two years of mineflayer produced a stack where the failures were in someone
   else's semantics — awaits that never settle, `sequence: 0` hardcoded, a smooth `lookAt` inside
   a jump. None of those were performance. A Rust core with its own tests is not hostage to that.
2. **The planner, which is genuinely 20-50x too slow**, and collision queries at the volume A\*
   wants them.

### Where Rust would be a mistake

- **Protocol I/O, session, auth, encryption.** `minecraft-protocol` is not mineflayer and is not
  the problem. Keep it.
- **The agent, LLM plumbing, command layer.** Nothing CPU-bound, everything async.
- **The physics tick on its own.** 0.8% of budget. Port it only when it is already inside the
  core for A\* to share, never for speed.

---

## Architecture

```
   JS  (bun)                                  RUST -> WASM  (crates/mc-core)
   ─────────────────────────────────────      ──────────────────────────────────────
   minecraft-protocol   transport, codec
   src/mc/net/          packet policy, acks   world      palette-compressed sections
   src/mc/session/      login, keepalive      collision  AABB sweep against the store
   src/agent/           LLM, commands         planner    A* / JPS over the same store
   block_io, container_io, place_packet       physics    ported, verified against JS
                        │                             │
                        └──── flat typed arrays ──────┘
                              (chunk in, plan out)
```

**The single design constraint that decides whether this succeeds: never cross the boundary
per-block.** A 96-block A\* expands tens of thousands of cells; at ~100 ns per JS↔WASM call that
is the entire budget gone in overhead. Therefore:

- The world **lives in WASM linear memory.** JS writes a chunk section in once, on the
  `map_chunk` packet, as a single `Uint8Array` copy.
- Queries JS still needs (`blockAt` for skills) come back through a thin accessor, and the hot
  consumers (A\*, collision) never leave Rust at all.
- A plan comes back as **one** flat `Int32Array` of packed positions, not a call per waypoint.

If a milestone cannot hold that constraint, it is the wrong milestone.

---

## Milestones, each with a number and a differential test

Every stage is verified against the implementation it replaces, on the same input. This project
has learned the hard way that a measurement of our own code is not a measurement of the server —
so each milestone compares **new against old**, not new against expectation.

### M0 — toolchain, and a benchmark that can fail
Install `rustup` + `wasm-pack`. Create `crates/mc-core`. Ship one exported function and a bench
harness that times a JS↔WASM round trip, so the boundary cost is a number we own from day one
rather than an assumption.
**Gate:** boundary round trip measured and written down. If it is worse than ~1 µs, the whole
design above needs revisiting before any port.

### M1 — world store
Palette-compressed 16×16×16 sections in Rust, ingest from the `map_chunk` payload.
**Differential test:** `tools/observe.mjs` already decoded 24,389 blocks across 22 block types
with zero disagreements. Re-run that comparison with the Rust store as a third opinion; any
single disagreement fails the milestone.
**Gate:** 0 disagreements, and ingest cost per chunk below the current JS path.

### M2 — the planner (the actual prize)
Port `planPath` with its tuned cost model intact — `digCost 14`, `treeDigCost 60`, `dropCost 5`,
`waterCost 2` + `waterEntryCost 6`, `preferY`/`yBias`, octile heuristic, `heuristicWeight 1.25`.
Those constants have a 1018-block journey behind them; the port must reproduce them exactly,
not improve them.
**Differential test:** run both planners over recorded worlds and assert **identical paths**, not
merely equal-cost ones. Then relax to equal-cost only if a tie-break difference is understood.
**Gate:** identical output, and 96-block plan **under 20 ms** (from 430 ms). That is the number
that justifies the project.

### M3 — collision and physics
Only now, and only because A\* already needs collision in-core. Port `simulatePlayer`.
**Differential test:** the live baselines already exist — `onGround` 60/60 true and plain jump
apex **1.252** on this server, and the swim constants (forward 0.098 b/t, sink −0.025 b/t, rise
+0.151 b/t). Reproduce those or explain the divergence.
**Gate:** apex within 0.01 of 1.252, and the swim probe within measurement noise.

### M4 — wire it in
Behind the existing flag: `settings.mc_client = "native"`. `src/mc/contract.js` already freezes
the `bot.*` surface as data with a mechanical test, so no call site changes.
**Gate:** the full gym suite at parity — `updig_gym`, `gap_gym`, `boxed_gym`, `build_gym` — before
`native` becomes the default. Parity, not "looks fine".

---

## Techniques worth using, and why

- **Structure-of-arrays, not objects.** The planner touches one field of many cells; SoA keeps
  the cache line useful. This is where a port beats JS even before language overhead.
- **No allocation in the hot path.** Pre-sized open/closed sets, an index-based binary heap,
  arena-allocated nodes. Rust makes this checkable rather than aspirational.
- **JPS or bidirectional A\*** for open terrain, falling back to plain A\* where the cost model
  is non-uniform (dig/water/drop pricing breaks JPS's symmetry assumptions — this needs measuring,
  not assuming).
- **Deterministic replay.** Record chunk state + goal, replay offline. The existing
  `scratchpad/sim/` harness proved its worth and also proved its trap: it forces `onGround` false
  and its output was mistaken for a fact about the server. A replay harness must record the real
  world, not a hypothesis about it.
- **Property tests against the JS oracle.** While both exist, fuzz worlds and assert agreement.
  That is the strongest form of the differential test above and it is only available during the
  migration window — take it while it is there.
- **SIMD** (`core::simd` / `wide`) for the AABB sweep, last. It is the smallest win on the list
  and the easiest to get subtly wrong.

---

## Risks, stated plainly

- **The boundary tax could eat the win.** Mitigated by M0 gating on a measured round trip, and by
  the never-cross-per-block rule. If the world cannot live in WASM memory, stop.
- **Two implementations during the migration.** Real cost, and the reason every milestone is
  differential — the second implementation earns its place by disagreeing with the first in a way
  we can explain.
- **The tuned constants are the asset, not the code.** `nav.js` is 1801 lines and most of its
  value is in numbers paid for with live runs. Port the numbers with their comments attached.
- **Toolchain on this box.** `cargo`/`rustc`/`wasm-pack` are absent; installing them is a system
  change and needs an explicit yes.
- **bun's WASM support** is good but less exercised than Node's. Worth a spike in M0 rather than
  a discovery in M3.

---

## What this replaces, and what it does not

It does **not** replace `minecraft-protocol`, and it is not "writing a Minecraft client from
scratch". Today's measurements were unambiguous that the borrowed layers which are correct are
correct: transport, codec, chunk decode and physics all produce vanilla numbers on this server.
What we are buying out is the layer where the failures actually were — plus the planner, which is
ours already and is simply too slow.

The mineflayer exit is already most of the way done and was done this way: `container_io.js`
(261 lines), `block_io.js` (289), `place_packet.js` (170) each replaced one unusable API after it
was measured unusable. This is the same move at the next layer down.
