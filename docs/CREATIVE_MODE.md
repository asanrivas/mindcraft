# Creative mode — native inventory, and a UI for it

**Status:** shipped and verified live against the 26.1 server.
**Related:** [WORLD_TOOLS.md](WORLD_TOOLS.md) · [TESTING.md](TESTING.md)

---

## 1. Why this exists

Every "get the bot some blocks" path in this repo went through the server's `/give` over chat
(`!serverGive`): operator permission, one chat round-trip per stack, and verification only by
recounting the inventory afterwards. A real creative client does not do that — it writes the
slot directly with the `set_creative_slot` packet.

**mineflayer supports this out of the box.** `bot.creative` is a *core* plugin
(`lib/plugins/creative.js`), auto-loaded, no opt-in needed — unlike `mineflayer-tool`, which this
repo does not load. An earlier note in this project claimed the bot "has no creative inventory
UI, so creative mode only removes the cost of placing"; that was wrong.

## 2. Commands

| Command | Does |
|---|---|
| `!creativeGive(item, count)` | Put any item straight into the bag. Tops up existing stacks first, then fills empty slots. |
| `!creativeKit(kit)` | Stock `building`, `mining`, `survival`, or `all`. |
| `!creativeClear` | Empty every slot. |
| `!creativeStatus` | Report game mode and run the rejection probe. |
| `!creativeIdSweep` | Diagnostic: give one of each id-range sample for external verification (§4). |

**All of them refuse outside creative mode**, reporting the current mode rather than failing
oddly. That gating is deliberate: it keeps the survival work — mining, night safety, resource
progression — honest. Creative is a mode you switch into, not a back door that quietly opens.

## 3. The web UI

`src/mindcraft/public/js/creative-panel.js` + `css/creative-panel.css`. An **Items** button on
each agent card opens a searchable item picker with category groups, a count box, kit buttons,
a free-text "give by name" box, and a clear-inventory button.

**It needs no server-side change.** MindServer already relays arbitrary text to an agent
(`send-message`), and the agent already parses `!command(args)` out of it. So the panel is a
*composer*: clicks become the same commands you would type. No new socket event, no new trust
boundary.

Two things it must get right, both covered by the smoke test:

- **Command injection.** The panel builds a command string, so a crafted item name could close
  the quote and append another command. `sanitizeItemName` strips everything outside
  `[a-z0-9_]`. Verified: `Blaze Spawn Egg"); !stop(); //` → `blaze_spawn_egg_stop_`.
- **Count clamping.** Capped at 2304 (36 slots × 64), the most an inventory can physically hold.
  Verified: `99999` → `2304`.

The item list is **curated, not exhaustive** — shipping all 1505 items to a phone over Twingate
for a picker is wasteful. The free-text box covers everything else; an unknown name comes back
as a clean `unknown item "..."`.

Sized for a phone first (full-height sheet under 640px), since this UI is reached from a handset
as often as from the desktop.

## 4. The item-id question, and what can actually be checked

`set_creative_slot` carries a **numeric** item id from our minecraft-data tables. The server is
26.1 (protocol 775); minecraft-data caps at 1.21.11 (774). If 26.1 inserted an item anywhere in
the registry, every id above the insertion point shifts and the packet silently produces the
**wrong item** — the server accepts it, so nothing throws.

**In-process checks cannot detect this.** From 1.21.3 on, `noAckOnCreateSetSlotPacket` is set:
mineflayer applies the slot locally and the server sends no acknowledgement. If the server
stores the wrong item it has no reason to correct us, and our local echo resolves the id back
through *our* registry to the name we asked for. The two errors cancel and the check reads green.
`probeIdMapping` therefore detects **rejection only**, and its docstring says so.

Substitution can only be caught by resolving the item **name** server-side:

```bash
mc "msg andy !creativeIdSweep"           # gives one of each sample
mc "clear andy <item> 0"                 # "Found N matching item(s)" — resolves BY NAME
```

Samples deliberately span the whole id range: a shift moves everything *above* the insertion
point, so testing only common blocks (low, stable ids) would show green while every modern item
landed wrong.

**Result, measured 2026-08-23 — all 8 confirmed, no shift:**

| item | id | server |
|---|---|---|
| `stripped_birch_log` | 150 | ✅ |
| `mossy_stone_bricks` | 376 | ✅ |
| `light_blue_glazed_terracotta` | 601 | ✅ |
| `dark_oak_fence_gate` | 827 | ✅ |
| `black_bundle` | 1052 | ✅ |
| `blaze_spawn_egg` | 1203 | ✅ |
| `composter` | 1353 | ✅ |
| `howl_pottery_sherd` | 1458 | ✅ |

Also confirmed independently: `!creativeGive("diamond_block", 100)` → `Found 100 matching
item(s) on player andy`.

Re-run the sweep after any server upgrade. It is cheap and it is the only check that works.

## 5. A mineflayer bug this hit — do not pass `waitTimeout: 0`

`bot.creative.setInventorySlot` marks a slot busy before writing and clears the flag **only on
the timeout path**:

```js
bot._setSlot(slot, item)
if (waitTimeout === 0) return          // <- returns WITHOUT clearing the flag
... setTimeout(() => { creativeSlotsUpdates[slot] = false }, waitTimeout)
```

So `waitTimeout: 0` leaks the busy flag and **every later write to that slot throws**
`Setting slot N cancelled due to calling bot.creative.setInventorySlot(N, ...) again` —
permanently, for the life of the process.

Found the hard way. `waitTimeout: 0` looked like a free optimisation (we do our own verify), and
`!creativeClear` with it bricked all 37 slots at once. Every subsequent give failed, and the
symptom — *"the sweep worked before the clear and fails after"* — pointed at the server rather
than at us. Only a restart cleared it.

`WRITE_ACK_MS = 60` in `creative.js` is the fix: large enough to reset the flag, small enough
that a 37-slot clear stays near two seconds. **It is a correctness constant, not a tuning knob.**

## 6. A verification trap worth remembering

The first live test looked like a failure: the bot said `inventory is full` while
`data get entity andy Inventory` over RCON showed only dirt and a bow.

**The bot was right and the measurement was wrong.** The RCON reply was truncated mid-NBT
(`... count...`) at ~120 characters; the bag genuinely held 36 distinct stacks. `!inventory`
showed the truth immediately.

Use `clear <player> <item> 0` for server-side checks — it returns one short line and cannot be
truncated. Same lesson as everywhere else in this project: **trust measured progress over a
scan**, and be sure the instrument is not the thing that is broken.

Related flake: RCON does not reliably echo `msg` back. Two whispers that returned an empty
string were both delivered. Check the *effect*, not the RCON return value.

## 7. Verification

```bash
bun tests/creative.test.mjs     # 60 cases, no server
```

Covers name resolution (`minecraft:` prefix, case, spaces), stack maths, slot ordering
(hotbar last, so a give never overwrites a pickaxe), top-up vs spill accounting, game-mode
gating, the full-inventory case, kit integrity, and the substitution case — which asserts a
server-side swap is reported as `ITEM ID MISMATCH` rather than success.

Browser smoke test (needs the server running):

```bash
bun scripts/creative_ui_smoke.mjs
```

Asserts the overlay opens, categories render, search filters, clicks compose the right command,
counts clamp, and item names are sanitised.

---

## Moved here from CLAUDE.md (2026-08-31 restructure)

CLAUDE.md keeps the RULES; this file keeps the EVIDENCE. The text below is verbatim
from CLAUDE.md before it was compacted — the measurements, the incidents and the
reasoning behind the one-line rules that remain there. Heading levels are demoted by one.

### Creative mode

Full story: **[docs/CREATIVE_MODE.md](docs/CREATIVE_MODE.md)**.

`!creativeGive(item, count)`, `!creativeKit(building|mining|survival|all)`, `!creativeClear`,
`!creativeStatus`, `!creativeIdSweep`. A web item picker lives behind the **Items** button on
each agent card (`public/js/creative-panel.js`) and composes those same commands.

- **mineflayer DOES support creative inventory.** `bot.creative` is a core auto-loaded plugin.
  No `/give`, no operator permission, no chat round-trip.
- **Every creative command refuses outside creative mode**, so the survival work stays honest.
- **Never pass `waitTimeout: 0` to `setInventorySlot`.** mineflayer leaks its per-slot busy flag
  on that path and every later write to that slot throws for the life of the process. It bricked
  all 37 slots once. `WRITE_ACK_MS = 60` is a correctness constant, not a tuning knob.
- **Item ids ride the wire as numbers**, resolved from 1.21.11 tables against a 26.1 server. A
  registry shift would silently produce the wrong item and **no in-process check can see it** —
  the server sends no ack, so our own echo confirms itself. Verify server-side by NAME:
  `!creativeIdSweep` then `mc "clear andy <item> 0"`. Swept 2026-08-23, ids 150–1458, all correct.
- **RCON truncates long NBT.** `data get entity andy Inventory` cut off at ~120 chars and made a
  full bag look empty, which read as a bug in working code. Use `clear <player> <item> 0`.

