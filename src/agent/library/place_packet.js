/**
 * The `block_place` packet, and the acknowledgement mineflayer never asks for.
 *
 * WHY THIS EXISTS
 * ---------------
 * `block_io.js` used to say, in as many words, "we do not hand-write the packet": its shape is
 * version-dependent, and 1.19+ adds a `sequence` field, so getting it wrong fails silently
 * rather than throwing. That was the right call with the evidence available then. It is wrong
 * now, and the measurement that overturns it is `tools/place_probe.mjs`:
 *
 *     seq=1 ack=1  62ms  air -> cobblestone LANDED
 *     seq=3 ack=3  42ms  air -> air         MISSING   <- acknowledged, and REFUSED
 *     ours:       6/6 acknowledged, avg ack 50ms
 *     mineflayer: 212-914ms per placement
 *
 * Two things fall out of that, and both matter more than the risk the old note named.
 *
 * 1. **The server acknowledges every placement, by sequence, in ~50ms.** Since 1.19 the client
 *    stamps `block_place` with a monotonic `sequence` and the server replies
 *    `acknowledge_player_digging { sequenceId }` (minecraft-data kept the 1.18 name; this is
 *    "Acknowledge Block Change"). mineflayer writes `sequence: 0` HARDCODED
 *    (lib/plugins/generic_place.js) and never listens for the reply. It confirms instead by
 *    waiting on a `blockUpdate` event at the destination - which a server whose prediction
 *    MATCHED never sends, because 1.17+ clients predict placements locally and the server
 *    speaks up only when the prediction was wrong. That await is unsatisfiable on exactly the
 *    placements that worked, which is what `Event blockUpdate:(x, y, z) did not fire within
 *    timeout of 500ms` has always been in our build logs.
 *
 * 2. **An ack is not a success.** seq=3 above was acknowledged and the block is not there - the
 *    probe was standing in that cell, so the server refused it. The ack means "I have decided",
 *    not "I agreed". So the ack is a TIMING signal and the world is the truth, and with both
 *    there is no timeout guessing left anywhere in the placement path.
 *
 * THE VERSION RISK, HANDLED RATHER THAN ACCEPTED
 * ----------------------------------------------
 * We do not hardcode the field list. `placeFields` reads the NEGOTIATED protocol schema off the
 * client, so the packet we build is the packet this connection agreed to speak, and cursor
 * scaling follows the declared field type (float 0..1 on modern versions, sixteenths on the old
 * integer ones) instead of a version guess.
 *
 * And the whole path is opt-in on one condition: **if the schema has no `sequence` field there
 * is nothing to acknowledge, so we do not hand-write anything** - `placeVerified` falls back to
 * mineflayer. That bounds the blast radius to versions where the mechanism provably exists.
 */

/** Field name -> declared wire type, from a `packet_block_place` container schema. */
export function placeFields(schema) {
    // ["container", [ {name, type}, ... ]]
    if (!Array.isArray(schema) || schema[0] !== 'container' || !Array.isArray(schema[1])) return null;
    const out = new Map();
    for (const f of schema[1]) {
        if (f && typeof f.name === 'string') out.set(f.name, f.type);
    }
    return out.size ? out : null;
}

/** Does this protocol carry the sequence we can have acknowledged? */
export function hasSequence(fields) {
    return !!fields && fields.has('sequence');
}

/**
 * The face vector -> the wire's direction enum.
 * Same mapping as mineflayer's `vectorToDirection`; kept here so the packet layer is
 * self-contained and testable without loading a bot.
 */
export function faceToDirection(v) {
    if (v.y < 0) return 0;
    if (v.y > 0) return 1;
    if (v.z < 0) return 2;
    if (v.z > 0) return 3;
    if (v.x < 0) return 4;
    if (v.x > 0) return 5;
    return null;   // the zero vector is not a face; callers must not send it
}

/** Is this declared type a float? Cursors are 0..1 floats on modern versions, sixteenths before. */
function isFloat(type) {
    return type === 'f32' || type === 'f64' || type === 'float' || type === 'double';
}

/**
 * Build the packet body for exactly the fields this protocol declares.
 *
 * Unknown fields are never invented and declared fields are never omitted: a missing field is a
 * serializer throw (loud, findable), while an extra one is silently dropped (not). Both are
 * better than the third option, which is guessing from a version number.
 *
 * @param {Map<string,any>} fields  from placeFields()
 * @param {object} p
 * @param {{x:number,y:number,z:number}} p.location  the block whose face we click
 * @param {number} p.direction                      faceToDirection(faceVec)
 * @param {{x:number,y:number,z:number}} p.cursor    click point within the face, each 0..1
 * @param {number} [p.hand]                          0 main, 1 off
 * @param {number} p.sequence
 * @returns {object} the packet body
 */
export function buildPlacePacket(fields, p) {
    if (!fields) throw new Error('block_place schema unavailable');
    if (p.direction === null || p.direction === undefined) throw new Error('block_place needs a face direction');
    const scale = (v, name) => (isFloat(fields.get(name)) ? v : Math.floor(v * 16));
    const all = {
        hand: p.hand ?? 0,
        location: p.location,
        direction: p.direction,
        cursorX: scale(p.cursor.x, 'cursorX'),
        cursorY: scale(p.cursor.y, 'cursorY'),
        cursorZ: scale(p.cursor.z, 'cursorZ'),
        insideBlock: false,
        worldBorderHit: false,
        sequence: p.sequence,
    };
    const body = {};
    for (const name of fields.keys()) {
        if (!(name in all)) throw new Error(`block_place declares an unhandled field "${name}"`);
        body[name] = all[name];
    }
    return body;
}

/**
 * The client's own sequence counter.
 *
 * Vanilla starts at 0 and increments for every block_place AND block_dig, because the server
 * acknowledges both off the same counter - so digging must draw from here too, or a dig's ack
 * would satisfy a place's wait. Starting at 1 leaves 0 meaning "mineflayer wrote this", which
 * makes a stray legacy packet visible in a capture instead of colliding with ours.
 */
let sequence = 1;
export function nextSequence() { return sequence++; }
export function peekSequence() { return sequence; }
/** Test seam only. */
export function _resetSequence(v = 1) { sequence = v; }

/**
 * Read the negotiated `block_place` schema off a live client.
 * Returns null when it cannot be found, which sends callers down the mineflayer path.
 */
export function placeFieldsFor(bot) {
    const schema = bot?._client?.serializer?.protocol?.play?.toServer?.types?.packet_block_place
        ?? bot?.registry?.protocol?.play?.toServer?.types?.packet_block_place;
    return placeFields(schema);
}

/**
 * Resolve when the server acknowledges our sequence.
 *
 * `>=` rather than `===`: acks are monotonic, so a LATER sequence is proof the server has
 * already worked through ours. Requiring equality would hang forever on a dropped ack that a
 * subsequent one has already superseded.
 *
 * Resolves `{acked, ms}` and never rejects - a missing ack is information for the caller, not
 * an error to unwind, which is precisely the distinction mineflayer gets wrong.
 */
export function awaitPlaceAck(bot, seq, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const sentAt = Date.now();
        let done = false;
        const finish = (acked) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            bot._client.removeListener('acknowledge_player_digging', onAck);
            resolve({ acked, ms: Date.now() - sentAt });
        };
        const onAck = (packet) => { if (packet?.sequenceId >= seq) finish(true); };
        const timer = setTimeout(() => finish(false), timeoutMs);
        bot._client.on('acknowledge_player_digging', onAck);
    });
}
