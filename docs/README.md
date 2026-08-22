# Andy — documentation index

`CLAUDE.md` in the repo root is the always-loaded operational reference: quick commands,
architecture, and the short version of every rule. **These docs are the long version** — why a
thing is built the way it is, what was measured, and which bugs are still open.

> `docs/` is in `.gitignore`, so nothing here is committed. Move a file out of `docs/` if it
> needs to travel with the repo.

---

## Movement and the world

| Doc | What it covers |
|---|---|
| [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md) | Why mineflayer-pathfinder was replaced: the protocol-775 mismatch, the broken `onGround`, the A\* planner and lookahead executor, the cost model, 12 bugs, and the 1018-block verification journey |
| [SWIMMING.md](SWIMMING.md) | Swimming, diving, sprint-swimming and oxygen. Measured swim speeds, the `waterCost` correction, SwimAssist, the `drowning` mode, and one still-open failure mode |
| [WORLD_TOOLS.md](WORLD_TOOLS.md) | Seed lookup, `/locate biome`, operator teleport/gamemode/spawnpoint, block states, and placing blocks next to the bot |

**Read together:** the water cost model lives in NAVIGATION_REBUILD, the physics that justifies
it lives in SWIMMING.

## Model, memory and behaviour

| Doc | What it covers |
|---|---|
| [LLM_FAILOVER.md](LLM_FAILOVER.md) | The DeepSeek backup brain, the circuit breaker, and why providers must throw rather than return a placeholder |
| [LETTA.md](LETTA.md) · [LETTA_CLIENT.md](LETTA_CLIENT.md) | Letta integration |
| [MEM0_INTEGRATION.md](MEM0_INTEGRATION.md) · [MEM0_FINAL_STATUS.md](MEM0_FINAL_STATUS.md) · [MEM0_SUCCESS.md](MEM0_SUCCESS.md) | Mem0 cloud memory |

Steering (persistent user-authored directives) is documented in `CLAUDE.md` — it is short
enough not to need its own file.

## Operations

| Doc | What it covers |
|---|---|
| [CREATIVE_MODE.md](CREATIVE_MODE.md) | Native creative inventory, the web item picker, the `waitTimeout: 0` mineflayer bug, and how to check item ids against a newer server |
| [TESTING.md](TESTING.md) | Unit suites, driving the live bot over the MindServer socket, and the procedural traps that produce wrong readings |
| [SERVICE_MANAGEMENT.md](SERVICE_MANAGEMENT.md) | systemd service control |
| [DIAGNOSTIC_COMMANDS.sh](DIAGNOSTIC_COMMANDS.sh) · [verify_build.py](verify_build.py) | Diagnostic helpers |
| [regenerate_map.sh](regenerate_map.sh) · [scan_area.sh](scan_area.sh) | Map rendering and area scans |

## Historical / protocol

Older write-ups from the protocol-error era, kept for the reasoning rather than the steps:
[START_HERE_PROTOCOL_ERROR.txt](START_HERE_PROTOCOL_ERROR.txt),
[README_PROTOCOL_ERROR.md](README_PROTOCOL_ERROR.md),
[PROTOCOL_ERROR_FIX.md](PROTOCOL_ERROR_FIX.md),
[ERROR_FIX_SUMMARY.md](ERROR_FIX_SUMMARY.md),
[FIX_CHECKLIST.md](FIX_CHECKLIST.md),
[QUICK_FIX.txt](QUICK_FIX.txt),
[VILLAGER_ATTACK_FIX.md](VILLAGER_ATTACK_FIX.md),
[VISION_ENABLED_SUCCESS.md](VISION_ENABLED_SUCCESS.md),
[VISION_AND_PERFORMANCE_TEST.md](VISION_AND_PERFORMANCE_TEST.md),
[DELIVERABLES.md](DELIVERABLES.md).

---

## The recurring lessons

Every one of these was paid for twice — once in the navigation rebuild, once again in the
swimming work.

1. **Measure; do not infer from a comment.** `waterCost: 15` sat unchallenged behind "the bot
   barely moves while swimming". Swimming is ~4× faster than walking here.
2. **Trust measured progress over the block scan.** A map that says "clear" cannot tell you the
   bot's hitbox is caught on a lip. This killed both a travel leg and a rise.
3. **Never substring-match block names.** `sandstone`/`sand` froze the agent for 11 minutes;
   `water_cauldron` would have been a river.
4. **Never cache a control state you do not own.** SwimAssist believed it was holding jump while
   the bot sank.
5. **Always pass a timeout to mode `execute()`.** `-1` can pin the agent permanently.
6. **Two things doing the same job will fight.** `!surface` and `mode:drowning` traded
   interrupts while the bot drowned.
7. **Instrument before the third hypothesis.** Three numbers in `!stats` ended a diagnosis that
   had already consumed several wrong guesses.
