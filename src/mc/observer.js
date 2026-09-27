/**
 * The observer client - milestone M2 of docs/CLIENT_REPLACEMENT.md.
 *
 * A read-only Minecraft client: it connects, decodes chunks and tracks
 * entities, and does nothing else. No controls, no inventory, no actions, no
 * physics. That restriction is the point - it can run alongside the live
 * mineflayer bot with no possibility of interfering with it, while delivering
 * two things immediately:
 *
 *   1. A world view decoded against the server's ACTUAL protocol (775 / 26.1)
 *      rather than the 1.21.11 tables mineflayer is pinned to. That makes it
 *      a correct source of block/collision data months before the native
 *      client can drive a bot.
 *   2. The reference side of the parity harness - something to diff the
 *      mineflayer world view against, to find where the version skew
 *      actually bites.
 *
 * Deliberately NOT a BotClient: it does not satisfy src/mc/contract.js and
 * must never be handed to agent.js. `native.js` is where that eventually
 * happens, built on these same layers.
 */
import { EventEmitter } from 'events';
import mc from 'minecraft-protocol';
import prismarineRegistry from 'prismarine-registry';
import { Vec3 } from 'vec3';
import { Connection } from './net/connection.js';
import { World } from './world/world.js';
import { Entities } from './entities/entities.js';

export class Observer extends EventEmitter {
    /**
     * @param {{host: string, port: number, username: string, version: string,
     *          auth?: string, minIntervalMs?: number}} options
     */
    constructor(options) {
        super();
        this.options = options;
        this.version = options.version;
        this.registry = prismarineRegistry(this.version);
        this.world = new World(this.registry);
        this.entities = new Entities(this.registry, this.version);
        this.connection = null;
        this.client = null;

        this.game = { dimension: null, gameMode: null, minY: 0, height: 384 };
        /** Our own entity id, from the login packet. */
        this.entityId = null;
        /** Our own position, from `position` packets (server-authoritative). */
        this.position = null;
        this.spawned = false;
    }

    connect() {
        const { host, port, username, version, auth = 'offline' } = this.options;
        this.client = mc.createClient({
            host, port, username, version, auth,
            checkTimeoutInterval: 60000,
        });
        this.connection = new Connection(this.client, {
            minIntervalMs: this.options.minIntervalMs,
        });

        this.connection.on('error', (err) => this.emit('error', err));
        this.connection.on('decodeError', (info) => this.emit('decodeError', info));
        this.connection.on('end', (reason) => {
            this.spawned = false;
            this.emit('end', reason);
        });

        this._wireWorld();
        this._wireEntities();
        this._wireSelf();
        return this;
    }

    _wireSelf() {
        // 1.20.2+ sends the dimension codec in the configuration phase.
        this.client.on('registry_data', (packet) => {
            try {
                this.registry.loadDimensionCodec(packet.codec || packet);
            } catch (err) {
                this.emit('warning', `registry_data: ${err.message}`);
            }
        });

        this.client.on('login', (packet) => {
            this.entityId = packet.entityId;
            const spawn = packet.worldState ?? packet;
            const rawName = spawn.name ?? packet.worldName ?? '';
            this.game.dimension = String(rawName).replace('minecraft:', '');
            this.game.gameMode = spawn.gamemode ?? null;

            // Dimension height data lives in the registry codec on modern
            // versions; without it the ChunkColumn is allocated with the
            // wrong vertical extent and every block read is off by minY.
            const dimData = this.registry.dimensionsByName?.[this.game.dimension];
            if (dimData) {
                this.game.minY = dimData.minY;
                this.game.height = dimData.height;
            }
            this.world.setDimensions({ minY: this.game.minY, height: this.game.height });
            this.emit('login', { entityId: this.entityId, ...this.game });
        });

        this.client.on('position', (packet) => {
            this.position = new Vec3(packet.x, packet.y, packet.z);
            // The server expects the position to be acknowledged, or it will
            // keep resending it and eventually treat us as unresponsive.
            // This is the ONLY packet the observer writes - it is otherwise
            // strictly read-only.
            if (packet.teleportId !== undefined) {
                this.connection.write('teleport_confirm', { teleportId: packet.teleportId });
            }
            if (!this.spawned) {
                this.spawned = true;
                this.emit('spawn', this.position);
            }
        });

        this.client.on('kick_disconnect', (packet) => this.emit('kicked', packet));
    }

    _wireWorld() {
        this.client.on('map_chunk', (packet) => {
            this.world.loadColumn({
                x: packet.x,
                z: packet.z,
                bitMap: packet.bitMap,
                chunkData: packet.chunkData,
                groundUp: packet.groundUp,
                biomes: packet.biomes,
                skyLightSent: this.game.dimension === 'overworld',
                skyLightMask: packet.skyLightMask,
                blockLightMask: packet.blockLightMask,
                emptySkyLightMask: packet.emptySkyLightMask,
                emptyBlockLightMask: packet.emptyBlockLightMask,
                skyLight: packet.skyLight,
                blockLight: packet.blockLight,
            });
        });

        this.client.on('unload_chunk', (packet) => {
            this.world.unloadColumn(packet.chunkX, packet.chunkZ);
        });

        this.client.on('block_change', (packet) => {
            const loc = packet.location;
            this.world.setBlockStateId(new Vec3(loc.x, loc.y, loc.z), packet.type);
        });

        this.client.on('multi_block_change', (packet) => {
            // 1.16.2+ packs each record into a single long: the low 12 bits
            // are the position within the section, the rest is the state id.
            const base = packet.chunkCoordinates;
            for (const record of packet.records ?? []) {
                const value = BigInt(record);
                const stateId = Number(value >> 12n);
                const packed = Number(value & 0xfffn);
                const dz = (packed >> 4) & 0x0f;
                const dx = (packed >> 8) & 0x0f;
                const dy = packed & 0x0f;
                const pos = new Vec3(
                    base.x * 16 + dx,
                    base.y * 16 + dy,
                    base.z * 16 + dz,
                );
                this.world.setBlockStateId(pos, stateId);
            }
        });

        // Chunk batching: the server throttles chunk delivery based on how
        // fast we acknowledge. Never acknowledging stalls terrain streaming,
        // so this reply is required even for a read-only client.
        let batchStart = 0;
        this.client.on('chunk_batch_start', () => { batchStart = Date.now(); });
        this.client.on('chunk_batch_finished', (packet) => {
            const size = packet.batchSize || 1;
            const millisPerChunk = Math.max((Date.now() - batchStart) / size, 0.01);
            this.connection.write('chunk_batch_received', { chunksPerTick: 7 / millisPerChunk });
        });

        this.world.on('columnError', ({ cx, cz, error }) => {
            this.emit('warning', `chunk decode failed at ${cx},${cz}: ${error.message}`);
        });
    }

    _wireEntities() {
        this.client.on('spawn_entity', (packet) => this.entities.spawn(packet));
        this.client.on('named_entity_spawn', (packet) => this.entities.spawn({ ...packet, type: packet.type ?? -1 }));
        this.client.on('entity_destroy', (packet) => this.entities.destroy(packet.entityIds));
        this.client.on('entity_metadata', (packet) => this.entities.updateMetadata(packet.entityId, packet.metadata));
        this.client.on('entity_velocity', (packet) => this.entities.velocity(packet.entityId, packet));

        const rel = (packet) => this.entities.relativeMove(packet.entityId, packet);
        this.client.on('rel_entity_move', rel);
        this.client.on('entity_move_look', rel);
        this.client.on('entity_look', (packet) => this.entities.relativeMove(packet.entityId, { ...packet, dX: 0, dY: 0, dZ: 0 }));

        const abs = (packet) => this.entities.teleport(packet.entityId, packet);
        this.client.on('entity_teleport', abs);
        this.client.on('sync_entity_position', abs);

        this.client.on('player_info', (packet) => this.entities.upsertPlayers(packet.data));
        this.client.on('player_remove', (packet) => this.entities.removePlayers(packet.players));
    }

    /** A world-frame snapshot, for the parity harness to diff. */
    snapshot({ center = null, radius = 4 } = {}) {
        const origin = center ?? this.position;
        const blocks = {};
        if (origin) {
            const base = origin.floored();
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dz = -radius; dz <= radius; dz++) {
                        const pos = base.offset(dx, dy, dz);
                        const block = this.world.blockAt(pos);
                        blocks[`${pos.x},${pos.y},${pos.z}`] = block ? block.name : null;
                    }
                }
            }
        }
        return {
            dimension: this.game.dimension,
            loadedColumns: this.world.loadedColumnCount,
            generation: this.world.generation,
            entityCount: this.entities.count,
            entities: this.entities.values()
                .map((e) => ({
                    id: e.id,
                    name: e.name,
                    x: round2(e.position.x), y: round2(e.position.y), z: round2(e.position.z),
                }))
                .sort((a, b) => a.id - b.id),
            blocks,
            decodeErrors: this.connection?.decodeErrorSummary() ?? {},
        };
    }

    end(reason = 'observer done') {
        if (this.connection) this.connection.end(reason);
    }
}

function round2(n) { return Math.round(n * 100) / 100; }
