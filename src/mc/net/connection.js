/**
 * Packet routing and policy - the first layer we OWN rather than borrow.
 *
 * Transport, framing, compression, encryption and the codec stay borrowed
 * (minecraft-protocol + protodef + minecraft-data): those are pure data
 * interpretation, already speak protocol 775, and follow future versions for
 * free. See docs/CLIENT_REPLACEMENT.md "borrow vs build".
 *
 * What lives here is the two things mcdata.js used to achieve by
 * monkey-patching mineflayer's private `bot._client`:
 *
 *   1. An outbound rate limiter. Paper/Purpur enforce stricter packet rate
 *      limits than vanilla and drop the connection (ECONNRESET, or a
 *      "disconnect.spam" kick) when movement packets arrive faster than
 *      ~50ms apart. The old version kept a single pending timer per call
 *      site; this one is a real per-packet-name queue that always sends the
 *      LATEST state for a coalesced packet, never a stale one.
 *
 *   2. A per-packet error policy. The old version string-matched
 *      'PartialReadError' in an error message and swallowed it blind. This
 *      records WHICH packet failed to decode and how often, so a decode gap
 *      is diagnosable instead of invisible - that matters a lot more once we
 *      are the ones deciding what the packets mean.
 */
import { EventEmitter } from 'events';

/** Packets whose payload is pure current-state, so a newer one supersedes an older one. */
const COALESCED = new Set(['position', 'position_look', 'look', 'flying']);

const DEFAULT_MIN_INTERVAL_MS = 50;

export class Connection extends EventEmitter {
    /**
     * @param {import('minecraft-protocol').Client} client - a raw
     *   minecraft-protocol client. Connection takes over writing to it.
     * @param {{ minIntervalMs?: number, onDecodeError?: (info: object) => void }} [opts]
     */
    constructor(client, opts = {}) {
        super();
        this.client = client;
        this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

        /** @type {Map<string, {data: object, timer: NodeJS.Timeout|null}>} */
        this._pending = new Map();
        /** @type {Map<string, number>} */
        this._lastSent = new Map();
        /** Decode failures by packet name, so gaps are countable not invisible. */
        this.decodeErrors = new Map();
        this.closed = false;

        client.on('error', (err) => this._onClientError(err));
        client.on('end', (reason) => {
            this.closed = true;
            this._clearPending();
            this.emit('end', reason);
        });
    }

    /**
     * Rate-limited write. Coalesced packets (movement) are throttled and
     * always send the most recent payload; everything else goes straight out
     * so we never delay a dig, a chat line, or a keepalive.
     */
    write(name, data) {
        if (this.closed) return;
        if (!COALESCED.has(name)) {
            this.client.write(name, data);
            return;
        }

        const now = Date.now();
        const last = this._lastSent.get(name) ?? 0;
        const elapsed = now - last;

        if (elapsed >= this.minIntervalMs) {
            this._lastSent.set(name, now);
            this.client.write(name, data);
            return;
        }

        // Inside the window: keep only the newest payload and make sure a
        // timer exists to flush it. Overwriting `data` is the point - sending
        // a stale position after a fresh one is what makes a bot rubber-band.
        const entry = this._pending.get(name);
        if (entry) {
            entry.data = data;
            return;
        }
        const timer = setTimeout(() => {
            const pending = this._pending.get(name);
            this._pending.delete(name);
            if (this.closed || !pending) return;
            this._lastSent.set(name, Date.now());
            this.client.write(name, pending.data);
        }, this.minIntervalMs - elapsed);
        // Do not hold the event loop open just to flush a movement packet.
        if (typeof timer.unref === 'function') timer.unref();
        this._pending.set(name, { data, timer });
    }

    /**
     * Classify a client error. Decode failures are recorded and swallowed
     * (a malformed scoreboard or custom_payload must not kill the session);
     * anything else is re-emitted for the caller to deal with.
     */
    _onClientError(err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDecodeError = msg.includes('PartialReadError') ||
            msg.includes('Read error') ||
            msg.includes('Deserialization error');

        if (!isDecodeError) {
            this.emit('error', err);
            return;
        }

        const packetName = extractPacketName(msg) ?? 'unknown';
        const count = (this.decodeErrors.get(packetName) ?? 0) + 1;
        this.decodeErrors.set(packetName, count);
        // Log the first few per packet name, then go quiet - a persistently
        // undecodable packet should be visible once, not every tick.
        if (count <= 3) {
            console.warn(`[mc/net] decode error #${count} on packet "${packetName}": ${msg.slice(0, 160)}`);
        }
        this.emit('decodeError', { packetName, count, message: msg });
    }

    /** Snapshot of decode failures, for the parity harness and !stats-style reporting. */
    decodeErrorSummary() {
        return Object.fromEntries(this.decodeErrors);
    }

    _clearPending() {
        for (const { timer } of this._pending.values()) {
            if (timer) clearTimeout(timer);
        }
        this._pending.clear();
    }

    end(reason) {
        this.closed = true;
        this._clearPending();
        this.client.end(reason);
    }
}

/**
 * Pull a packet name out of a protodef error message. protodef formats these
 * as e.g. `Read error for packet_foo : ...` or includes a
 * `field: "play.toClient"` line; we take the best identifier available so the
 * counter is grouped by something meaningful.
 */
function extractPacketName(message) {
    const readFor = message.match(/Read error for ([\w.]+)/);
    if (readFor && readFor[1] !== 'undefined') return readFor[1];
    const field = message.match(/field:\s*"([^"]+)"/);
    if (field) return field[1];
    const packet = message.match(/(packet_[\w]+)/);
    if (packet) return packet[1];
    return null;
}
