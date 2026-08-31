# Block placement — we own it

Why `bot.placeBlock` is unusable for anything time-critical here, what `block_io.js` /
`place_packet.js` do instead, and the three defects that only fail in combination.

> **Provenance.** Everything below was in `CLAUDE.md` until the 2026-08-31 restructure.
> CLAUDE.md keeps the RULES; this file keeps the EVIDENCE — the measurements, the log
> excerpts and the incidents that produced each rule. Text is verbatim; heading levels
> are demoted by one so they nest under this file's title.

### Block placement - we own it

Full engine: **`src/agent/library/block_io.js`** (and `place_packet.js`). Same decision as
`container_io.js`, and the same underlying defect: mineflayer wraps a fire-and-forget packet in
an await this server does not satisfy, then reports the missing confirmation as a failed action.

**Never call `bot.placeBlock` for anything time-critical.** Three defects, and they only fail in
combination - which is why none was visible alone:

- **It burns the whole window on an ack.** It writes the packet, then blocks up to 500ms on a
  `blockUpdate:` event (`place_block.js:13`) and throws if none arrives. A jump is ~900ms, so one
  failed attempt consumed the flight and there was never a retry. The packet had already gone.
- **`_genericPlace` awaits a SMOOTH `lookAt`** before writing the packet (`generic_place.js:36`,
  `forceLook` undefined). That multi-tick turn alone outlasts a jump's apex.
- **The body must clear the cell being filled.** Pillaring targets the feet cell and the bot is
  1.8 tall, so at +0.5 the hitbox overlaps and the server refuses - as a missing confirmation,
  the hardest failure to read.

A clean bot placing at +0.5 nonetheless succeeds 4/4 here, **by accident**: the smooth look
delayed the packet until the body had risen clear. Forcing the look broke placement, and that is
how the real clearance requirement surfaced. Do not "optimise" one of these without the others.

What we do instead: write the packet, snap the look, wait for the hitbox to clear, confirm by
**reading the world**, and pace the packets - the server rate-limits interactions and silently
drops the excess (`blueprint_builder.js` found the same independently: *"the API can throw after
a successful placement - re-read before believing it"*).

Measured: `PILLAR TEST: +5.00 of 5` where the old path managed +0.00.

Pure parts are unit-tested in `tests/block_io.test.mjs` (`bodyClearsCell`, `placeGapRemaining`)
and `tests/place_packet.test.mjs`.

