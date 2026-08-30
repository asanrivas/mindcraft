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
 * WHY WE DO NOT HAND-WRITE THE PACKET. We stop at `_genericPlace` deliberately, rather than
 * dropping to `bot._client.write('block_place', ...)`. That packet's shape is version-dependent
 * (`blockPlaceHasHeldItem` vs `blockPlaceHasHandAndIntCursor`) and 1.19+ adds a `sequence` field
 * the server uses to acknowledge and roll back predictions. Getting either wrong fails silently
 * and corrupts state rather than throwing, and there is nothing here that a lower layer buys us.
 */
import { Vec3 } from 'vec3';

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
 */
export async function snapLook(bot, point) {
    const p = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const dx = point.x - p.x, dy = point.y - p.y, dz = point.z - p.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    await bot.look(yaw, pitch, true);
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
 * @param {object} [opts.placeOpts] extra options forwarded to _genericPlace
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function placeVerified(bot, refBlock, faceVector, opts = {}) {
    if (!refBlock) return { ok: false, why: 'no reference block' };
    const verifyMs = opts.verifyMs ?? 400;
    const dest = refBlock.position.plus(faceVector);
    const before = bot.blockAt(dest);
    const landed = () => {
        const now = bot.blockAt(dest);
        return !!now && now.boundingBox === 'block' && now.type !== before?.type;
    };
    if (landed()) return { ok: true, why: 'already solid' };

    if (opts.pace !== false) {
        const wait = placeGapRemaining(lastPlaceAt, Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
    }

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
