/**
 * The owned world store.
 *
 * Chunk *decoding* is borrowed (prismarine-chunk/-block/-registry): the
 * section-palette format is intricate, data-driven, and already has a 26.1
 * mapping. What we own is the store around it - which packets mutate it,
 * when a column counts as loaded, and what observers get told.
 *
 * Two things this adds that mineflayer's equivalent does not:
 *
 *   - `generation`, a counter bumped on every mutation. nav.js currently
 *     invalidates its per-plan block cache on a timeout, which is both too
 *     eager (re-reads unchanged terrain) and too lazy (serves stale blocks
 *     after a dig). A monotonic counter lets it invalidate exactly when the
 *     world actually changed.
 *   - `waitForColumn(cx, cz)`, an awaitable chunk load. Polling for terrain
 *     to appear is a recurring source of flaky waits in skills.js.
 */
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import prismarineChunk from 'prismarine-chunk';
import prismarineBlock from 'prismarine-block';

export class World extends EventEmitter {
    /**
     * @param {object} registry - a prismarine-registry instance (version-keyed)
     * @param {{ minY?: number, height?: number }} dims - from the login packet
     */
    constructor(registry, dims = {}) {
        super();
        this.registry = registry;
        this.ChunkColumn = prismarineChunk(registry);
        this.Block = prismarineBlock(registry);
        this.minY = dims.minY ?? 0;
        this.height = dims.height ?? 384;

        /** @type {Map<string, object>} keyed by "cx,cz" */
        this.columns = new Map();
        /** Bumped on every mutation - see class doc. */
        this.generation = 0;
        /** @type {Map<string, Array<() => void>>} */
        this._columnWaiters = new Map();
    }

    static key(cx, cz) { return `${cx},${cz}`; }

    setDimensions({ minY, height }) {
        if (typeof minY === 'number') this.minY = minY;
        if (typeof height === 'number') this.height = height;
    }

    getColumn(cx, cz) {
        return this.columns.get(World.key(cx, cz)) ?? null;
    }

    /**
     * Install an already-decoded column. This is the single place a column
     * enters the store, so generation/columnLoad/waiter bookkeeping cannot
     * drift between code paths.
     */
    setColumn(cx, cz, column) {
        this.columns.set(World.key(cx, cz), column);
        this.generation++;
        this.emit('columnLoad', { cx, cz });
        this._resolveColumnWaiters(cx, cz);
    }

    /**
     * Decode and store a map_chunk payload.
     * @returns {boolean} whether the column was stored
     */
    loadColumn(packet) {
        const { x: cx, z: cz } = packet;

        // bitMap 0 with groundUp set is the server saying "this column is
        // empty" - treat it as an unload rather than decoding nothing into a
        // column that then reads as all-air (which a planner would happily
        // walk into).
        if (!packet.bitMap && packet.groundUp) {
            this.unloadColumn(cx, cz);
            return false;
        }

        let column = this.getColumn(cx, cz);
        if (!column) {
            column = new this.ChunkColumn({ minY: this.minY, worldHeight: this.height });
        }

        try {
            column.load(packet.chunkData, packet.bitMap, packet.skyLightSent, packet.groundUp);
            if (packet.biomes !== undefined) column.loadBiomes(packet.biomes);
            if (packet.skyLight !== undefined) {
                column.loadParsedLight(
                    packet.skyLight, packet.blockLight,
                    packet.skyLightMask, packet.blockLightMask,
                    packet.emptySkyLightMask, packet.emptyBlockLightMask,
                );
            }
        } catch (err) {
            // A decode failure must not take the observer down - record it
            // and leave the column absent, which reads as "unknown" rather
            // than as wrong terrain. Silently storing a half-decoded column
            // is the failure mode that makes a nav planner walk into walls.
            this.emit('columnError', { cx, cz, error: err });
            return false;
        }

        this.setColumn(cx, cz, column);
        return true;
    }

    unloadColumn(cx, cz) {
        const existed = this.columns.delete(World.key(cx, cz));
        if (existed) {
            this.generation++;
            this.emit('columnUnload', { cx, cz });
        }
    }

    /** @param {Vec3} pos absolute block position */
    blockAt(pos) {
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        const column = this.getColumn(cx, cz);
        if (!column) return null;
        if (pos.y < this.minY || pos.y >= this.minY + this.height) return null;

        // prismarine-chunk indexes within a column by positive-modulo local
        // coords; a plain % goes negative for negative world coords and
        // silently reads the wrong block.
        const local = new Vec3(
            ((pos.x % 16) + 16) % 16,
            pos.y,
            ((pos.z % 16) + 16) % 16,
        );
        const block = column.getBlock(local);
        if (block) block.position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
        return block;
    }

    /** @param {Vec3} pos absolute block position @param {number} stateId */
    setBlockStateId(pos, stateId) {
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        const column = this.getColumn(cx, cz);
        if (!column) return false;

        const local = new Vec3(
            ((pos.x % 16) + 16) % 16,
            pos.y,
            ((pos.z % 16) + 16) % 16,
        );
        column.setBlockStateId(local, stateId);
        this.generation++;
        this.emit('blockUpdate', { position: pos, stateId });
        return true;
    }

    /** Resolves once the column is loaded, or rejects on timeout. */
    waitForColumn(cx, cz, timeoutMs = 10000) {
        if (this.getColumn(cx, cz)) return Promise.resolve();
        const key = World.key(cx, cz);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const waiters = this._columnWaiters.get(key) ?? [];
                const idx = waiters.indexOf(onLoad);
                if (idx !== -1) waiters.splice(idx, 1);
                reject(new Error(`Timed out waiting for chunk column ${key}`));
            }, timeoutMs);
            const onLoad = () => { clearTimeout(timer); resolve(); };
            if (!this._columnWaiters.has(key)) this._columnWaiters.set(key, []);
            this._columnWaiters.get(key).push(onLoad);
        });
    }

    _resolveColumnWaiters(cx, cz) {
        const key = World.key(cx, cz);
        const waiters = this._columnWaiters.get(key);
        if (!waiters) return;
        this._columnWaiters.delete(key);
        for (const fn of waiters) fn();
    }

    get loadedColumnCount() { return this.columns.size; }
}
