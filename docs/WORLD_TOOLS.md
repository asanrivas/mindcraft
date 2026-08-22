# World & Operator Tools

Seed lookup, biome location, teleport, gamemode, spawn point, block states.
**Related:** [SWIMMING.md](SWIMMING.md) · [TESTING.md](TESTING.md) · [NAVIGATION_REBUILD.md](NAVIGATION_REBUILD.md)

---

## 1. Finding places by seed

```
!worldSeed                        -> WORLD SEED: -5277008537596457581
!locateBiome("frozen_ocean")      -> BIOME minecraft:frozen_ocean at x=-2592 z=5293 (y=62), 5067 blocks away
```

Both ask the **server**, via `bot.chat('/seed')` and `/locate biome`. That uses the real world
generator, so the answer is exact for this seed — better than reproducing the biome maths against
a `minecraft-data` copy that does not understand 26.1. Both need operator permission.

### This world (seed `-5277008537596457581`)

| biome | x | z |
|---|---|---|
| ice_spikes | 2592 | 45 |
| frozen_river | 2560 | −51 |
| frozen_ocean | −2592 | 5293 |
| deep_frozen_ocean | −416 | −691 |

Note: **the frozen river is only 1 block deep** — the bot's head sits in the ice and it never
counts as submerged. For anything involving diving or drowning, use the frozen **ocean**.

## 2. Operator commands

| Command | Notes |
|---|---|
| `!serverTp(x, y, z)` | **Single use.** Refuses unless `bots/<name>/ALLOW_RESCUE_TP` exists, and deletes the marker on use. Arm by hand: `touch bots/andy/ALLOW_RESCUE_TP` |
| `!serverGamemode(mode)` | survival / creative / adventure / spectator |
| `!serverSpawnpoint` | Sets the respawn point to the bot's current position |
| `!serverSetblock(type, x, y, z, state)` | `state` is a **separate argument** — see §4 |
| `!serverFill(type, x1,y1,z1, x2,y2,z2)` | Vanilla 3D corner order, unlike `!fill` |

**These are deliberately narrow, not a generic `/`-passthrough.** The model can call every
command in the list; an unrestricted passthrough would hand it `/op`, `/ban` and `/kill`.

## 3. `runServerCommand` — and the trap in it

There is no request/response channel for slash commands: the answer arrives as an ordinary chat
line. `runServerCommand(bot, command, pattern, timeoutMs)` sends the command and waits on
`messagestr` for a matching line, with a timeout so a missing permission cannot hang.

**It must skip player chat.** The agent narrates every command it runs — `*asanrivas used
worldSeed*` — and that echo contains "Seed", so the first version matched its **own
announcement** and returned it as the server's response:

```
Server said: <andy> *asanrivas used worldSeed*
```

The reader now ignores lines starting `<name>` and lines containing the bot's own username.

## 4. Block states must be a separate argument

`!serverSetblock`'s `blockType` is validated as a `BlockOrItemName` against the registry, so
`red_bed[part=foot]` is rejected outright. The state therefore rides in its own parameter:

```
!serverSetblock("red_bed", -2580, 63, 5291, "facing=east,part=foot")
!serverSetblock("red_bed", -2579, 63, 5291, "facing=east,part=head")
```

**A bed with no state is half a bed** — it pops straight off and cannot set a respawn point.
Stairs and slabs need this too. Pass `"none"` for no state.

## 5. Placing blocks: `!placeHere` places *next to* the bot

`!placeHere` used to pass the bot's own position to `placeBlock`, which cannot work — the body
occupies that cell. The failure surfaced as mineflayer's generic 500 ms `blockUpdate` timeout,
which reads like the known flake rather than "you asked me to place a block inside myself".

`skills.placeNearby` now picks a free neighbouring cell, and requires a free **pair** for beds
and doors (`TWO_CELL_BLOCKS`). Verified in-world with a bed.

## 6. Setting up a recoverable bot before enabling survival

Death is impossible in creative, so oxygen never depletes and the drowning path cannot be
tested (see [SWIMMING.md](SWIMMING.md)). Order matters:

```
!placeHere("red_bed")        # a real, two-part bed
!serverSpawnpoint            # respawn point on SOLID ground beside it
!serverGamemode("survival")  # only now
```

Setting the spawn point while floating puts it in water; respawning submerged in a frozen ocean
is a slow drowning loop. Check the reported coordinates are on land.

`!goToBed` fails during the day (`bot is not sleeping`) — that is vanilla behaviour, and
`/spawnpoint` is the reliable mechanism regardless.
