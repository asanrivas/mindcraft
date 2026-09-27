# Andy vs. a human player — capability gaps

What a competent human player does routinely that Andy cannot, ranked by how much survival
value each unlocks. Compiled 2026-08-22, after the swimming work made Andy mortal
([SWIMMING.md](../SWIMMING.md), [WORLD_TOOLS.md](../WORLD_TOOLS.md)).

**Ground rules for all plans** (the constraints that shaped everything else in this repo):
- `onGround` lies and mineflayer-pathfinder's executor cannot move the bot. Build on
  primitives that work: walking, raw jumping, block reads, mining, **water physics**.
  (Corrected 2026-08-23: the original "protocol 775 vs 774" explanation was WRONG — the
  server is natively 1.21.11 and there is no version skew; see CLAUDE.md "Movement". The
  constraint stands, the stated cause was stale. Older plan headers below may still cite it.)
- No cheat-code shortcuts: capabilities must work in survival without operator crutches.
- Measure before tuning — every "the bot can't X" claim in this codebase that got measured
  turned out wrong or differently-shaped than assumed.
- One owner per control state. Jump contention has caused three separate incidents.

## The gaps

| # | Gap | A human... | Andy today | Plan |
|---|-----|-----------|------------|------|
| 1 | **Food self-sufficiency** | hunts, farms, cooks, eats before starving | `mineflayer-auto-eat` eats from inventory, but nothing REFILLS the inventory; `tillAndSow` exists with no harvest loop; no hunting-for-food, no cooking pipeline | [food-survival.md](food-survival.md) |
| 2 | **Night safety** | sleeps in a bed, torches the area, shelters from mobs | `goToBed` exists untested; no torch-at-night habit; no shelter-building; `self_defense` is reactive melee only | [night-safety.md](night-safety.md) |
| 3 | **Boats** | crosses oceans at ~8 blocks/s in a boat | swims at 2 b/s; no vehicle code at all — `boat` appears nowhere in skills | [boats.md](boats.md) |
| 4 | **Ranged combat + shield** | kites with a bow, blocks with a shield | `!shoot` with bow AND crossbow shipped + live-verified; shield reflex and self_defense wiring still open (server is on peaceful — no hostiles to test against) | [ranged-combat.md](ranged-combat.md) |
| 5 | **Resource progression** | wood -> stone -> iron -> diamond autonomously | the pieces exist (`collectBlocks`, `craftRecipe`, `smeltItem`, `digDown`) but nothing sequences them; no ore-finding strategy; `getCraftingPlan` is informational only | [resource-progression.md](resource-progression.md) |
| 7 | **Safe autonomy for `!newAction`** | doesn't need one — a human knows the recipe | free-form codegen: crashed the bot process live while trying to walk through a door the navigator handles | [playbooks.md](playbooks.md) |
| 6 | **The Nether** | builds a portal, lights it, navigates hell terrain | zero portal/dimension logic; the navigator has never seen lava oceans or ceiling bedrock | [nether.md](nether.md) |

## Gaps found 2026-08-29 (see [../OBEDIENCE.md](../OBEDIENCE.md) "Not done" for detail)

| Gap | Andy today | Cost when it bites |
|---|---|---|
| **Descent executor stalls, model freelances** | `staircaseDown` returned `no descent progress` at Y=−45 (1 block dug in 4s, cause uninvestigated); the model then improvised `digDown`/`navTo` down INTO the bedrock layer and oscillated ~2h | a whole session burned; memory polluted with loop narration |
| **No "below target Y" awareness** | nothing in `$STATS` or the mine report tells the model it is UNDER the layer it wants; it kept digging down toward a Y above its head | the freelancing above never self-corrects |
| **`!buildStatus` blueprint paths unguessable** | model invents `"file.json"` — no query lists `blueprints/*.json` | command reliably called with a path that cannot exist |
| **Transient junk in memory Locations** | `current@`, `nav_failures@` stored as places (cap 12) | stale episode state steers future navigation |
| **Andy's memory store saturated** | 200/200 rows, 150 lessons, running on pre-fix code; evicting durable facts now | needs restart + `compact.mjs` pass (bob's is done) |
| **Obedience harness unwired** | `scratchpad/obedience_ab.mjs` exists and runs, but nothing invokes it on description changes | description drift silently un-fixes command selection |
| **llama-server has no wake/boot supervisor** | `run_llama.bat` restarts a crash, but a stopped task / sleeping box = silent failover to paid gemini | cloud spend, and nobody notices until `!stats` shows BACKUP |

## Gaps noted but NOT planned yet

Real gaps, deliberately deferred — either blocked by the ones above or lower value:

- **Fishing** — food gap covers eating first; fishing is one supply line within it.
- **Enchanting / brewing / anvils** — needs resource progression (XP, diamonds, obsidian) first.
- **Villager trading** — commands exist (`!showVillagerTrades`, `!tradeWithVillager`); what is
  missing is an economy strategy, not a mechanic.
- **Elytra** — mineflayer refuses `elytraFly` while `isInWater`; flight on broken physics is a
  research project, and end-game anyway.
- **Redstone** — vast, and nothing else depends on it.
- **Precision parkour / sprint-jump chains** — the physics mismatch makes this the single worst
  candidate to attempt; AutoJump's momentum trick is already at the edge of what works.
- **The End** — gated behind the Nether and heavy combat.

## Environment note discovered during testing

**The server runs peaceful difficulty.** Summoned zombies and creepers vanish instantly;
passive mobs appear fine. Every combat plan above should be read with that in mind — the
survival pressure that motivates gaps 2 and 4 is partially absent until difficulty changes,
and none of the combat paths can be live-tested against hostiles as things stand.

## How these plans were produced

Each linked plan was drafted by a planning subagent given this repo's constraints, then
reviewed. They are PLANS, not shipped work: nothing below this directory is implemented unless
its doc says so explicitly.
