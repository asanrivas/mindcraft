# Andy vs. a human player — capability gaps

What a competent human player does routinely that Andy cannot, ranked by how much survival
value each unlocks. Compiled 2026-08-22, after the swimming work made Andy mortal
([SWIMMING.md](../SWIMMING.md), [WORLD_TOOLS.md](../WORLD_TOOLS.md)).

**Ground rules for all plans** (the constraints that shaped everything else in this repo):
- Protocol 775 vs mineflayer's 774: `onGround` lies, mineflayer-pathfinder cannot move the bot.
  Build on primitives that work: walking, raw jumping, block reads, mining, **water physics**.
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
| 6 | **The Nether** | builds a portal, lights it, navigates hell terrain | zero portal/dimension logic; the navigator has never seen lava oceans or ceiling bedrock | [nether.md](nether.md) |

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
