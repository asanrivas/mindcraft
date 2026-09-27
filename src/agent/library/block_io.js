/**
 * We own block placement. mineflayer's is unusable for anything time-critical.
 *
 * Same shape of decision as `container_io.js`, and for the same underlying reason: mineflayer
 * wraps a fire-and-forget packet in an await that this server does not reliably satisfy, and
 * then reports the missing confirmation as a failure of the action itself.
 *
 * THREE DEFECTS, each measured
 * ---------------------------
 * 1. **It burns the whole window waiting for an ack.** `bot.placeBlock` writes the packet and
 *    then blocks up to 500ms on a `blockUpdate:` event to confirm it
 *    (mineflayer/lib/plugins/place_block.js:13), throwing when none arrives. A jump lasts about
 *    900ms, so ONE failed attempt consumed the entire flight and there was never a second try.
 *    The packet had already gone; the throw described the confirmation, not the placement.
 *
 * 2. **It awaits a SMOOTH look before writing the packet.** `_genericPlace` calls
 *    `await bot.lookAt(face, options.forceLook)` with `forceLook` undefined
 *    (generic_place.js:36) - the multi-tick turn. On its own that outlasts a jump's apex.
 *
 * 3. **The body has to be out of the cell being filled.** Pillaring targets the cell the feet
 *    are standing in, and the bot is 1.8 blocks tall, so at +0.5 the hitbox still overlaps it
 *    and the server refuses. Measured: `place at (4710, 67, 4610) failed ... (held cobblestone,
 *    was air)`.
 *
 * These interact, which is why none of them was visible alone. A clean mineflayer bot placing at
 * +0.5 succeeds 4/4 on this server - but only by ACCIDENT: defect 2 delayed the packet long
 * enough for defect 3 to stop mattering. Fixing the look broke placement, and that is how the
 * real clearance requirement surfaced.
 *
 * WHAT WE DO INSTEAD
 * ------------------
 * - Call `_genericPlace`, which is the half that actually writes `block_place`, and never
 *   `placeBlock`, which is that plus the unsatisfiable await.
 * - Snap the look rather than turning smoothly.
 * - Wait for the body to clear the destination cell before asking.
 * - Confirm by READING THE WORLD. `blueprint_builder.js` reached the same conclusion from the
 *   other direction: "the API can throw after a successful placement - re-read before believing
 *   it".
 * - Pace the packets. Also from `blueprint_builder.js`: the server rate-limits interactions and
 *   silently drops the excess, so bursts time out en masse while slow stretches succeed.
 *
 * WE NOW HAND-WRITE THE PACKET (2026-08-30). This block used to say the opposite - that we stop
 * at `_genericPlace` because the packet's shape is version-dependent and 1.19+ adds a `sequence`
 * field, so a mistake would corrupt state silently. The reasoning was sound; the conclusion was
 * wrong, and `tools/place_probe.mjs` is what overturned it:
 *
 *     ours:       6/6 acknowledged, avg ack 50ms
 *     mineflayer: 212-914ms per placement
 *
 * That `sequence` field is not a hazard to avoid - it is the acknowledgement we were missing.
 * The server replies to every placement with `acknowledge_player_digging { sequenceId }` in
 * ~50ms; mineflayer sends `sequence: 0` hardcoded, never listens for the reply, and confirms
 * instead by awaiting a `blockUpdate` a correctly-predicting server never sends. Point 1 above
 * describes the symptom of exactly that.
 *
 * The version risk is now HANDLED rather than avoided: `place_packet.js` builds the body from
 * the NEGOTIATED protocol schema, and hand-writes nothing at all on a protocol with no
 * `sequence` to acknowledge - there, mineflayer's path is still what runs. See that file.
 */
import { Vec3 } from 'vec3';
import { placeFieldsFor, hasSequence, buildPlacePacket, faceToDirection, nextSequence, awaitPlaceAck } from './place_packet.js';

/** Vanilla player hitbox height. The reason a pillar step needs a full block of clearance. */
export const BODY_HEIGHT = 1.8;

/**
 * Minimum gap between placement packets.
 *
 * Not a politeness knob: the server rate-limits interactions and DROPS what it will not serve,
 * so a burst fails wholesale while the same placements spread out all succeed. Observed in
 * `blueprint_builder.js` as mass timeouts under load, and once as a `disconnect.spam` kick.
 */
export const MIN_PLACE_GAP_MS = 250;

let lastPlaceAt = 0;

/**
 * How long to wait before the next placement packet may go out.
 * Pure, so the pacing is testable without a server.
 */
export function placeGapRemaining(lastAt, now, gap = MIN_PLACE_GAP_MS) {
    if (!lastAt) return 0;
    return Math.max(0, gap - (now - lastAt));
}

/**
 * Is the body clear of the cell we are about to fill?
 *
 * The bot occupies [feetY, feetY + BODY_HEIGHT); the destination cell occupies [destY, destY+1).
 * They must not overlap, or the server refuses the placement - and refuses it in the one way
 * that is hardest to read, as a missing confirmation.
 *
 * `slack` exists because the sampler is not the physics clock: at an apex of exactly 1.00 a
 * 10ms poll routinely reads 0.98, and the cell is free for every practical purpose by then.
 */
export function bodyClearsCell(s) {
    if (!s) return false;
    const height = s.height ?? BODY_HEIGHT;
    const slack = s.slack ?? 0.05;
    // Clear when the feet are at or above the cell's top face, or the whole body is below it.
    const above = s.feetY >= (s.destY + 1) - slack;
    const below = s.feetY + height <= s.destY + slack;
    return above || below;
}

/**
 * Snap the head to a point. `bot.look(..., true)` is instant; `bot.lookAt(p)` without force
 * turns smoothly over several ticks, which is fatal inside a jump.
 *
 * AND PUT IT ON THE WIRE HERE, rather than leaving it to the physics tick. `bot.look(y, p, true)`
 * only mutates `bot.entity.yaw/pitch` locally (mineflayer physics.js:348 - `force` sets
 * `lastSentYaw` and returns); the `look` packet goes out on the NEXT physics tick, up to 50ms
 * later. Every caller here writes its interaction packet immediately afterwards, so the
 * interaction overtakes the rotation on the wire and the SERVER still holds the old yaw - which is
 * how a blueprint's stairs, doors, gates, chests and barrels ended up facing whichever way the bot
 * happened to be looking on the PREVIOUS placement.
 *
 * Measured with `tools/facing_probe.mjs` at 4683,63,4571, all 4 cardinals x 7 look-steered
 * classes, every trial confirmed to have achieved its intended yaw first:
 *   as written, no delay      4/28 correct
 *   +1 physics tick (50ms)   25/26
 *   +3 physics ticks (150ms) 27/27
 * A delay works only because a hovering bot eventually emits a position update that carries the
 * new yaw; it is a race, not a fix. Writing the packet here is ordered by TCP and costs nothing.
 */
/**
 * How long to let a forced rotation settle on the SERVER before clicking.
 *
 * Writing the `look` packet ourselves (see snapLook) is ordered by TCP, so in principle the server
 * holds the new yaw before it reads the click. In practice it does not always, and this file already
 * has the measurement - `tools/facing_probe.mjs`, all four cardinals x 7 look-steered classes:
 *
 *     as written, no delay      4/28 correct
 *     +1 physics tick (50ms)   25/26
 *     +3 physics ticks (150ms) 27/27
 *
 * The packet write alone was read as making the delay unnecessary. It does not: it moves the odds,
 * it does not close the window. Live confirmation, 2026-09-24, repairing the wizard tower's facings
 * with the packet write and no delay: 306 re-placements, 26 landing a QUARTER TURN off - and the
 * errors ran both clockwise and anticlockwise, which is the signature of a race rather than of a
 * wrong constant, since a bad table is wrong the same way every time.
 *
 * 150ms, because 27/27 is worth three ticks when the whole cost is ~1200 oriented cells in a
 * blueprint - about three minutes across a build that runs for hours.
 *
 * ONLY on a forced rotation. Pillaring and bridging place blocks inside a jump, where the body has
 * to clear the target cell before the click; a delay there would break timing that is already
 * tight, and neither passes a yaw.
 */
const LOOK_SETTLE_MS = 150;

export async function snapLook(bot, point, yawOverride = null) {
    const p = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const dx = point.x - p.x, dy = point.y - p.y, dz = point.z - p.z;
    // A caller that KNOWS the horizontal angle it needs (a blueprint cell whose `facing` dictates
    // it) passes it here. The pitch still aims at the click point, so the ray stays vertically
    // honest and the cursor - which is what carries `half`, the hinge and the clicked face - is
    // untouched. Only the horizontal component, the one the server reads to derive `facing`,
    // is taken from the caller instead of from where the bot happens to be standing.
    const yaw = yawOverride !== null && yawOverride !== undefined ? yawOverride : Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    await bot.look(yaw, pitch, true);
    // Same packet and the same notchian conversions mineflayer's own sendPacketLook uses
    // (lib/physics.js:114, lib/conversions.js). A duplicate on the next tick is harmless; the
    // rotation arriving after the click is not.
    try {
        const onGround = bot.entity.onGround;
        bot._client?.write('look', {
            yaw: (180 / Math.PI) * (Math.PI - yaw),
            pitch: (180 / Math.PI) * -pitch,
            onGround,
            flags: { onGround, hasHorizontalCollision: undefined },   // 1.21.3+
        });
    } catch (e) { /* no client, or a schema without this packet: the physics tick still sends it */ }
}

/**
 * Place a block and confirm it from the world.
 *
 * @param {object} bot
 * @param {object} refBlock   the block whose face we click
 * @param {Vec3}   faceVector which face (e.g. (0,1,0) for its top)
 * @param {object} [opts]
 * @param {number} [opts.verifyMs] how long to watch for the block to appear
 * @param {boolean} [opts.pace]    honour the interaction rate limit (default true)
 * @param {string}  [opts.expectName] the exact block expected at dest; use for anything whose
 *                                    boundingBox is not 'block' (signs, trapdoors, fences...)
 * @param {number}  [opts.ackMs]   how long to wait for the server's sequence ack
 * @param {number}  [opts.graceMs] how long to let the block appear AFTER the ack before
 *                                 calling it a refusal (the ack does not barrier the block)
 * @param {object} [opts.placeOpts] extra options forwarded to _genericPlace
 * @returns {Promise<{ok: boolean, why: string}>}
 */
// Blocks that OPEN or TOGGLE when right-clicked. A player places against one by SNEAKING, which
// makes the click a placement instead of a use; without it the server uses the block and refuses
// the place packet. Measured 2026-09-27: a cathedral grille's only support anchor was the anvil
// below it - `support chain of 1 failed at link 1: refused by server (ack 38ms)`, every time.
// Whole names and whole suffixes only (see isFallingBlockName for why substrings are banned).
export const INTERACTIVE_REF = /^(anvil|chipped_anvil|damaged_anvil|chest|trapped_chest|ender_chest|barrel|furnace|blast_furnace|smoker|crafting_table|cartography_table|fletching_table|smithing_table|loom|stonecutter|grindstone|enchanting_table|brewing_stand|lectern|beacon|hopper|dropper|dispenser|crafter|jukebox|note_block|bell|cake|respawn_anchor|lever|comparator|repeater|daylight_detector|decorated_pot|chiseled_bookshelf|.*_shulker_box|shulker_box|.*_door|.*_trapdoor|.*_fence_gate|.*_bed|.*_button|.*_sign|.*_hanging_sign)$/;

/** Sneak for the click when the reference block would otherwise be USED rather than placed on. */
export async function placeVerified(bot, refBlock, faceVector, opts = {}) {
    if (!refBlock || !INTERACTIVE_REF.test(refBlock.name ?? '')) return placeVerifiedCore(bot, refBlock, faceVector, opts);
    bot.setControlState('sneak', true);
    await new Promise((r) => setTimeout(r, SNEAK_SETTLE_MS));   // the input packet must precede the click
    try {
        return await placeVerifiedCore(bot, refBlock, faceVector, opts);
    } finally {
        bot.setControlState('sneak', false);
    }
}
const SNEAK_SETTLE_MS = 100;

async function placeVerifiedCore(bot, refBlock, faceVector, opts = {}) {
    if (!refBlock) return { ok: false, why: 'no reference block' };
    const verifyMs = opts.verifyMs ?? 400;
    const dest = refBlock.position.plus(faceVector);
    const before = bot.blockAt(dest);
    // "Did it land?" has two forms, and using the wrong one is how a working placement reads as
    // a failure. The default - "something solid that was not there before" - is right for the
    // pillar/bridge callers, which only care that the cell became standable. It is WRONG for a
    // blueprint, half of which is signs, trapdoors, fences and carpets whose boundingBox is
    // never 'block'. `expectName` is the precise form: place a spruce_trapdoor, get a
    // spruce_trapdoor.
    const expect = opts.expectName ?? null;
    const landed = () => {
        const now = bot.blockAt(dest);
        if (!now) return false;
        if (expect) return now.name === expect;
        return now.boundingBox === 'block' && now.type !== before?.type;
    };
    if (landed()) return { ok: true, why: 'already solid' };

    if (opts.pace !== false) {
        const wait = placeGapRemaining(lastPlaceAt, Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
    }

    const fields = placeFieldsFor(bot);
    const direction = faceToDirection(faceVector);

    if (hasSequence(fields) && direction !== null && bot._client?.write) {
        // ---- our path: real sequence, real acknowledgement ----
        // The click point on the clicked face, in face-local 0..1. `half` nudges it into the
        // upper or lower half of a side face, which is how a top-half slab or stair is asked
        // for - the same cursor trick _genericPlace uses.
        const half = opts.placeOpts?.half;
        const cursor = {
            x: 0.5 + faceVector.x * 0.5,
            y: 0.5 + faceVector.y * 0.5 + (faceVector.y === 0 && half === 'top' ? 0.25
                                         : faceVector.y === 0 && half === 'bottom' ? -0.25 : 0),
            z: 0.5 + faceVector.z * 0.5,
        };
        // Snap, never turn. A smooth `lookAt` outlasts a jump's apex, and the server validates
        // that the click is plausible from our eye - so the look has to land BEFORE the packet.
        const forcedYaw = opts.placeOpts?.yaw ?? null;
        await snapLook(bot, refBlock.position.offset(cursor.x, cursor.y, cursor.z), forcedYaw);
        // Let the rotation land before the click. See LOOK_SETTLE_MS: the packet write improves the
        // odds but does not close the window, and a click the server answers with the PREVIOUS yaw
        // is a block a quarter or a half turn out.
        if (forcedYaw !== null) await new Promise((r) => setTimeout(r, LOOK_SETTLE_MS));
        const seq = nextSequence();
        let packet;
        try {
            packet = buildPlacePacket(fields, { location: refBlock.position, direction, cursor, sequence: seq });
        } catch (err) {
            // A schema we cannot express is a reason to use mineflayer's path, not to fail.
            return placeViaMineflayer(bot, refBlock, faceVector, opts, dest, landed, verifyMs);
        }
        lastPlaceAt = Date.now();
        try { bot.swingArm('right'); } catch (e) { /* cosmetic */ }
        bot._client.write('block_place', packet);

        // The ack says the server has DECIDED, not that it agreed - a refusal is acknowledged
        // just the same (measured: an acked placement into the cell the bot was standing in
        // never appeared). So it is a timing signal; the world below is the truth.
        const ack = await awaitPlaceAck(bot, seq, opts.ackMs ?? 1000);
        if (landed()) return { ok: true, why: ack.acked ? `placed, ack ${ack.ms}ms` : 'placed, no ack' };
        // THE ACK IS NOT A BARRIER FOR THE BLOCK. It says the server has processed our sequence;
        // it does not say the resulting block_change has been applied to OUR world copy yet.
        // Sampling `landed()` once at ack time therefore reports a perfectly good placement as a
        // refusal whenever the two arrive in that order - caught 2026-08-31 placing scaffolding:
        //   clicking scaffolding top face: FAIL(refused by server (ack 19ms))
        //   after : scaffolding            <- it was there all along
        // So give the world a short grace window before calling it a refusal. This is bounded
        // and small: the ack has already told us the round trip is done, so we are waiting on
        // local application, not on the network.
        if (ack.acked) {
            const graceUntil = Date.now() + (opts.graceMs ?? 200);
            while (Date.now() < graceUntil) {
                if (landed()) return { ok: true, why: `placed, ack ${ack.ms}ms (late)` };
                await new Promise((r) => setTimeout(r, 10));
            }
            return { ok: false, why: `refused by server (ack ${ack.ms}ms)` };
        }
        // No ack: the packet or its reply was lost. Fall back to watching the world, which is
        // what we had before this path existed.
        const deadline = Date.now() + verifyMs;
        while (Date.now() < deadline) {
            if (landed()) return { ok: true, why: 'placed, ack lost' };
            await new Promise((r) => setTimeout(r, 20));
        }
        return { ok: false, why: `no ack and never appeared at ${dest}` };
    }

    return placeViaMineflayer(bot, refBlock, faceVector, opts, dest, landed, verifyMs);
}

/**
 * mineflayer's placement path, kept for protocols with no `sequence` to acknowledge and for
 * stubbed bots in tests. Everything it reports is still verified against the world, because its
 * throw describes the missing confirmation and not the placement.
 */
async function placeViaMineflayer(bot, refBlock, faceVector, opts, dest, landed, verifyMs) {
    try {
        lastPlaceAt = Date.now();
        if (typeof bot._genericPlace === 'function') {
            await bot._genericPlace(refBlock, faceVector, {
                swingArm: 'right', forceLook: true, ...(opts.placeOpts ?? {}),
            });
        } else {
            // No private API (a stubbed bot in tests, or a future mineflayer). Fall back to the
            // public one and accept its ack wait rather than inventing a packet.
            await bot.placeBlock(refBlock, faceVector);
            return { ok: true, why: 'placed via public API' };
        }
    } catch (err) {
        // The throw may describe a genuine refusal OR a late confirmation, and the two are not
        // distinguishable from the message. The world is, so ask it below rather than guessing.
        const deadline = Date.now() + verifyMs;
        while (Date.now() < deadline) {
            if (landed()) return { ok: true, why: 'placed despite error' };
            await new Promise((r) => setTimeout(r, 20));
        }
        return { ok: false, why: err?.message ?? String(err) };
    }

    const deadline = Date.now() + verifyMs;
    while (Date.now() < deadline) {
        if (landed()) return { ok: true, why: 'placed' };
        await new Promise((r) => setTimeout(r, 20));
    }
    return { ok: false, why: `never appeared at ${dest}` };
}

/**
 * Place the block the bot is currently jumping over, into the cell under its feet.
 *
 * The pillar step, as one call: it waits for the body to clear the cell and retries inside the
 * flight rather than spending the whole jump on a single attempt. `refBlock` is what the feet
 * were standing on before take-off.
 *
 * @returns {Promise<{ok: boolean, why: string, attempts: number}>}
 */
export async function placeUnderfoot(bot, refBlock, opts = {}) {
    const deadline = Date.now() + (opts.windowMs ?? 900);
    const maxAttempts = opts.maxAttempts ?? 8;
    const destY = refBlock.position.y + 1;
    let attempts = 0, why = 'never cleared the cell';

    while (Date.now() < deadline && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 10));
        if (!bodyClearsCell({ feetY: bot.entity.position.y, destY })) continue;
        attempts++;
        // No pacing inside a flight: the window is shorter than the rate limit, and a pillar is
        // one placement per jump, so the limiter is not what we are up against here.
        const r = await placeVerified(bot, refBlock, new Vec3(0, 1, 0),
            { verifyMs: opts.verifyMs ?? 60, pace: false });
        if (r.ok) return { ok: true, why: r.why, attempts };
        why = r.why;
    }
    return { ok: false, why, attempts };
}
