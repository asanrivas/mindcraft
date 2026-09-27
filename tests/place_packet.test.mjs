/**
 * The block_place packet we write ourselves, and the ack we wait on.
 *
 *   bun tests/place_packet.test.mjs
 *
 * `block_io.js` used to refuse to hand-write this packet, on the grounds that its shape is
 * version-dependent and a mistake would corrupt state silently rather than throw. These are the
 * tests that make that objection answerable: the body is built from the NEGOTIATED schema, an
 * unknown field is a loud throw, and a protocol with no `sequence` never reaches this path at
 * all. The real schemas below are copied from minecraft-data, not invented.
 */
import {
    placeFields, hasSequence, faceToDirection, buildPlacePacket,
    nextSequence, peekSequence, _resetSequence, awaitPlaceAck,
} from '../src/agent/library/place_packet.js';

let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { failures++; console.log(`FAIL ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
    else console.log(`ok   ${name}`);
}
function throws(name, fn) {
    try { fn(); failures++; console.log(`FAIL ${name}: expected a throw`); }
    catch { console.log(`ok   ${name}`); }
}

// --- the real 1.21.11 schema (float cursors, sequence, worldBorderHit) ---
const MODERN = ['container', [
    { name: 'hand', type: 'varint' }, { name: 'location', type: 'position' },
    { name: 'direction', type: 'varint' },
    { name: 'cursorX', type: 'f32' }, { name: 'cursorY', type: 'f32' }, { name: 'cursorZ', type: 'f32' },
    { name: 'insideBlock', type: 'bool' }, { name: 'worldBorderHit', type: 'bool' },
    { name: 'sequence', type: 'varint' },
]];
// --- an older schema: integer cursors in sixteenths, and NO sequence ---
const LEGACY = ['container', [
    { name: 'location', type: 'position' }, { name: 'direction', type: 'varint' },
    { name: 'hand', type: 'varint' },
    { name: 'cursorX', type: 'i8' }, { name: 'cursorY', type: 'i8' }, { name: 'cursorZ', type: 'i8' },
]];

const modern = placeFields(MODERN);
const legacy = placeFields(LEGACY);

check('schema parses to a field map', [...modern.keys()],
    ['hand', 'location', 'direction', 'cursorX', 'cursorY', 'cursorZ', 'insideBlock', 'worldBorderHit', 'sequence']);
check('a non-container schema is unusable', placeFields(['bitfield', []]), null);
check('garbage is unusable',                placeFields(null), null);

check('modern protocol has a sequence to ack', hasSequence(modern), true);
// This is the guard that bounds the whole feature: no sequence -> mineflayer's path runs.
check('legacy protocol has none',             hasSequence(legacy), false);
check('a null schema has none',               hasSequence(null), false);

// --- faces ---
check('face up',    faceToDirection({ x: 0, y: 1, z: 0 }), 1);
check('face down',  faceToDirection({ x: 0, y: -1, z: 0 }), 0);
check('face north', faceToDirection({ x: 0, y: 0, z: -1 }), 2);
check('face south', faceToDirection({ x: 0, y: 0, z: 1 }), 3);
check('face west',  faceToDirection({ x: -1, y: 0, z: 0 }), 4);
check('face east',  faceToDirection({ x: 1, y: 0, z: 0 }), 5);
// The zero vector is not a face. Returning a plausible 0 here would place against the wrong
// side silently, which is the exact class of failure the old comment feared.
check('the zero vector is not a face', faceToDirection({ x: 0, y: 0, z: 0 }), null);

// --- body construction ---
const loc = { x: 10, y: 64, z: -3 };
const top = { x: 0.5, y: 1.0, z: 0.5 };
check('modern body: exactly the declared fields, float cursors',
    buildPlacePacket(modern, { location: loc, direction: 1, cursor: top, sequence: 7 }),
    { hand: 0, location: loc, direction: 1, cursorX: 0.5, cursorY: 1.0, cursorZ: 0.5,
      insideBlock: false, worldBorderHit: false, sequence: 7 });

// A float cursor sent as sixteenths (or the reverse) is the silent-corruption case: the click
// lands on the wrong part of the face and the block orients wrongly with no error anywhere.
check('legacy body: cursors scaled to sixteenths, no sequence field emitted',
    buildPlacePacket(legacy, { location: loc, direction: 1, cursor: top, sequence: 7 }),
    { location: loc, direction: 1, hand: 0, cursorX: 8, cursorY: 16, cursorZ: 8 });

check('offhand is carried through',
    buildPlacePacket(modern, { location: loc, direction: 1, cursor: top, sequence: 2, hand: 1 }).hand, 1);

throws('an unhandled declared field throws rather than being skipped', () =>
    buildPlacePacket(placeFields(['container', [{ name: 'somethingNew', type: 'varint' }]]),
        { location: loc, direction: 1, cursor: top, sequence: 1 }));
throws('no schema throws', () => buildPlacePacket(null, { location: loc, direction: 1, cursor: top, sequence: 1 }));
throws('no direction throws', () => buildPlacePacket(modern, { location: loc, direction: null, cursor: top, sequence: 1 }));

// --- the counter ---
_resetSequence(1);
// 0 is left meaning "mineflayer wrote this", so a stray legacy packet is visible in a capture.
check('sequence starts at 1, not 0', nextSequence(), 1);
check('sequence increments',         nextSequence(), 2);
check('peek does not consume',       peekSequence(), 3);
check('peek really did not consume', nextSequence(), 3);

// --- the ack wait ---
function fakeBot() {
    const handlers = {};
    return {
        _client: {
            on: (e, h) => { (handlers[e] ??= []).push(h); },
            removeListener: (e, h) => { handlers[e] = (handlers[e] ?? []).filter((x) => x !== h); },
            emit: (e, p) => (handlers[e] ?? []).slice().forEach((h) => h(p)),
            count: (e) => (handlers[e] ?? []).length,
        },
    };
}

const b1 = fakeBot();
const p1 = awaitPlaceAck(b1, 5, 500);
b1._client.emit('acknowledge_player_digging', { sequenceId: 5 });
check('an exact ack resolves acked', (await p1).acked, true);
check('and the listener is removed', b1._client.count('acknowledge_player_digging'), 0);

// Acks are monotonic, so a LATER sequence proves ours was already processed. Insisting on
// equality would hang forever on one dropped ack.
const b2 = fakeBot();
const p2 = awaitPlaceAck(b2, 5, 500);
b2._client.emit('acknowledge_player_digging', { sequenceId: 9 });
check('a later ack also resolves acked', (await p2).acked, true);

const b3 = fakeBot();
const p3 = awaitPlaceAck(b3, 5, 500);
b3._client.emit('acknowledge_player_digging', { sequenceId: 4 });
let settled = false;
p3.then(() => { settled = true; });
await new Promise((r) => setTimeout(r, 20));
check('an EARLIER ack does not resolve it', settled, false);

// A missing ack is information, not an error: it must resolve false, never reject, or it would
// unwind a caller that still needs to go and read the world.
const b4 = fakeBot();
const r4 = await awaitPlaceAck(b4, 5, 60);
check('a timeout resolves acked=false rather than rejecting', r4.acked, false);
check('and cleans its listener up too', b4._client.count('acknowledge_player_digging'), 0);

console.log(failures === 0 ? 'place_packet: all checks passed' : `place_packet: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
