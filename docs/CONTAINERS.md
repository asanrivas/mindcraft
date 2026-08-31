# Chests and containers — we own the protocol

`chest.js` (policy) and `container_io.js` (protocol). Nothing outside `chest.js` may call
`bot.openContainer`; nothing anywhere calls `win.deposit`, `win.withdraw` or `bot.transfer`.
This file is why.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

### Chests and containers

Full engine: **`src/agent/library/chest.js`**. `skills.js` holds only the policy (which
container, which items, what to say); **nothing outside `chest.js` may call `bot.openContainer`.**

#### We own the container protocol - mineflayer's is unusable here

`src/agent/library/container_io.js`. **Nothing in this project calls `win.deposit`,
`win.withdraw` or `bot.transfer` any more.** Three independent defects, each measured:

- **Every chest click waits forever.** `clickWindow` ends in `waitForWindowUpdate`, whose chest
  branch is a bare `await once(window, 'updateSlot:' + slot)` with **no deadline**
  (`mineflayer/lib/plugins/inventory.js:477-480`). On 1.17+ the client PREDICTS the click locally
  (`window.acceptClick`) and the server answers **only when the prediction is wrong** - so a
  click that works produces no packet and the await never settles. Seen as
  `withdraw timed out after 6000ms` on ordinary withdrawals: our deadline firing, not a slow
  server.
- **`transfer` is cursor-based and asserts.** It picks a stack onto the cursor and places it,
  recursing, with `assert.notStrictEqual` on the cursor. A desync throws
  `null is not an object (evaluating 'window.selectedItem.type')` and returns **with items still
  on the cursor** - which the server drops on the floor when the window closes. That is the
  item-loss path: source chest emptied, destination untouched, a cobblestone entity on the pad.
- **`bot.inventory` is FROZEN while a window is open.** mineflayer copies the player slots back
  only in `closeWindow` -> `copyInventory` (`inventory.js:412`). So `bot.inventory.items()`,
  `emptySlotCount()` and everything derived from them - including mineflayer's own
  "Unable to withdraw, Bot inventory is full" guard - report pre-transfer values for the whole
  session. Our counts read them, so **`moved` came out 0 however much actually moved**, and
  `transferBetweenChests` (which builds its carry list from `moved`) aborted with
  "my inventory is full" on a bag with 30 free slots.

What we do instead:

- **Shift-click (mode 1) is the workhorse.** One click moves a whole stack across the
  container/bag divide and never touches the cursor - nothing to strand, nothing to drop.
- **We never await the click.** By the time `clickWindow` reaches its unresolvable await it has
  already applied the local prediction and written the packet, which is all a click consists of.
  Fire it, swallow the pending promise, settle one tick.
- **Every number comes from `window.slots`**, which is live: locally predicted, server-corrected.
- **A partial count uses right-clicks**, one item at a time, and always puts the remainder back,
  so the cursor is empty by construction - the property mineflayer's version does not have.
- **`safeClose` empties the cursor first**, because closing while holding something is what
  scattered items on the ground.

Measured on the rig (`scratchpad/chest_rig.mjs`, `chest_full.mjs`, `chest_loss.mjs`): a full
27-slot chest into an empty double chest moves **1728 items, nothing on the floor, no timeouts**;
a part-stack `!chestTake("cobblestone", 10)` takes exactly 10. Pure arithmetic is unit-tested in
`tests/container_io.test.mjs`.

#### A transfer must never empty the source on spec

`!chestTransfer` used to withdraw everything it could and only *then* walk to the destination.
Into a full chest that left the source at **0/27**, 1728 items stranded in the bag, and the
message `Transferred 0 items`. Now:

- the destination's free space is **surveyed first**, and the withdraw is bounded by it;
- anything the destination refuses is **put back in the source** before returning;
- the round trip repeats while progress is made, so `("all", -1)` moves everything even when the
  bag can only carry part of it at a time.

The invariant is that items are either in a chest or in transit, never abandoned. More container
opens, all bounded; the alternative is a bot that strips a chest and wanders off with it.

#### A double chest is ONE container, not two

`findBlocks` returns both halves, so a pad with one single and one double chest reported
`Found 3 storage containers`, listing the same 54-slot window twice at neighbouring coordinates.
`chest.doublePartner` reads the block state - `type` is `single`/`left`/`right`, and only a
matching `facing` makes a pair, so two unrelated chests side by side stay two containers. It
checks all four horizontal neighbours rather than deriving the axis from `facing`: that mapping
is easy to get backwards and yields a listing wrong for half the orientations, which is worse
than one wrong always. Fails to "single" on missing data.

**When measuring a double chest from RCON, read BOTH halves.** `data get block` on one half
shows only that half's 27-slot `Items` list, so counting 54 slots at one coordinate silently
loses whatever landed in the other - and that reads exactly like the engine eating the items. It
cost a full round of false "128 items UNACCOUNTED FOR".

#### `bot.openContainer` has no timeout, and that killed the process

`mineflayer/lib/plugins/inventory.js:385` is `activateBlock()` + `await once(bot, 'windowOpen')`.
There is no deadline. **Every reason the server declines to send a window is an infinite hang**,
and an action that never returns pins `currentActionLabel` forever - after which no action can
ever start again. From the log:

```
ChestView at (4727,68,4764) caused code execution timeout and process kill
Chest viewing at (4557,68,4862) times out after 20s - pathfinding fails to reach it
```

Three separate causes, all fixed in `chest.js`, all previously the same symptom:

- **The approach was never verified.** Every old chest function called `goToPosition` - which
  drives **mineflayer-pathfinder, whose executor does not work on this server** (`onGround`
  reads false while standing; see Movement) - then called `openContainer` unconditionally,
  discarding the return value. A failed walk became a permanent hang instead of "I could not get
  to the chest". Approach now runs through `nav.js` and the distance is **measured** before a
  window is requested (`MAX_REACH = 3.5`). Same rule as everything else here: trust measured
  state over reported state.
- **Vanilla refuses to open some chests at all** - a solid cube directly above, or a cat sitting
  on it. Only chests obey that rule; barrels and shulker boxes do not, so checking them all
  would refuse containers that work.
- **`decorated_pot` and `chiseled_bookshelf` were in the old `STORAGE_CONTAINERS` list.** They
  store items but open **no window whatsoever**, so `!chestDepositAll` could pick one as "the
  nearest container" and wait forever for a `windowOpen` that does not exist.

`openObstruction()` is the pure predicate for the last two and **fails OPEN**: unknown block,
unloaded chunk or missing entity list all fall through to "try it, and let the timeout bound the
damage". A check that guessed *blocked* from missing data would disable the command in exactly
the situations we cannot diagnose. Everything else is bounded by `withTimeout`.

#### A leaked window poisons every later container op

`bot.openContainer` cannot be cancelled, so a window that arrives **after** we stopped waiting
stays open as `bot.currentWindow` - and a stale `currentWindow` makes the *next* open never
fire. That is one bad chest silently breaking every deposit for the rest of the session.
`withContainer` closes in a `finally`, `safeClose` tolerates every way a close can fail and
clears the field, and any leaked window is closed **pre-flight** before a new open.
`idle_behavior.js`'s chest scanner had exactly this leak (its own `Promise.race` dropped the
late window on the floor) and now goes through the same path.

#### Counts are measured, never requested

`takeFromChest` did `totalTaken += toTakeFromSlot` immediately after `withdraw`, with no check -
so a bot with a **full inventory** reported `Successfully took 64 diamond` having taken none.
`depositVerified`/`withdrawVerified` count the inventory before and after and report the
difference; a partial transfer says so, and `planWithdraw` bounds the request by real inventory
room up front. `transferBetweenChests` now carries only what it actually withdrew.

#### Deposit-all aggregates BY NAME, not by slot

200 cobblestone is four slots. The first deposit moves all four stacks and the next three
entries find nothing left - and **a deposit of zero is indistinguishable from a full
container**, so the loop declared the chest full and walked to the next one with an empty bag.
`depositableItems` returns one entry per item type; `none_held` is explicitly not `full`.

Tests: `bun tests/chest.test.mjs` (pure, no server). The cases that must **not** refuse matter
more than the ones that must.

