/**
 * The owned entity table.
 *
 * No standalone prismarine module covers this, so it is BUILD rather than
 * BORROW (docs/CLIENT_REPLACEMENT.md). It is deliberately small: track
 * identity, position, velocity and metadata for every entity the server tells
 * us about, and nothing else. Behavior belongs in the agent, not here.
 *
 * Positions are Vec3 throughout - 16+ files in this repo assume every
 * position carries .distanceTo/.floored/.offset/.plus/.scaled, so a plain
 * {x,y,z} here would break call sites the moment the native backend is used.
 */
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { metadataIndices, readMetadata } from './metadata.js';

// The wire sends relative moves as 1/4096ths of a block.
const DELTA_SCALE = 4096;

export class Entities extends EventEmitter {
    /**
     * @param {object} registry a prismarine-registry instance
     * @param {string} version
     */
    constructor(registry, version) {
        super();
        this.registry = registry;
        this.version = version;
        this.indices = metadataIndices(version);
        /** @type {Map<number, object>} entity id -> entity */
        this.map = new Map();
        /** @type {Map<string, object>} uuid -> player info */
        this.players = new Map();
    }

    get(id) { return this.map.get(id) ?? null; }
    get count() { return this.map.size; }
    values() { return [...this.map.values()]; }

    spawn(packet) {
        const typeInfo = this.registry.entitiesArray?.find((e) => e.id === packet.type)
            ?? this.registry.entities?.[packet.type];
        const entity = {
            id: packet.entityId,
            uuid: packet.objectUUID ?? packet.entityUUID ?? packet.playerUUID ?? null,
            type: typeInfo?.type ?? 'unknown',
            name: typeInfo?.name ?? null,
            displayName: typeInfo?.displayName ?? null,
            entityType: packet.type,
            position: new Vec3(packet.x, packet.y, packet.z),
            velocity: new Vec3(
                (packet.velocityX ?? 0) / 8000,
                (packet.velocityY ?? 0) / 8000,
                (packet.velocityZ ?? 0) / 8000,
            ),
            yaw: packet.yaw ?? 0,
            pitch: packet.pitch ?? 0,
            onGround: true,
            metadata: [],
            height: typeInfo?.height ?? 0,
            width: typeInfo?.width ?? 0,
        };
        this.map.set(entity.id, entity);
        this.emit('entitySpawn', entity);
        return entity;
    }

    /** Absolute teleport (entity_teleport / sync_entity_position). */
    teleport(id, { x, y, z, yaw, pitch, onGround }) {
        const entity = this.map.get(id);
        if (!entity) return null;
        entity.position = new Vec3(x, y, z);
        if (yaw !== undefined) entity.yaw = yaw;
        if (pitch !== undefined) entity.pitch = pitch;
        if (onGround !== undefined) entity.onGround = onGround;
        this.emit('entityMoved', entity);
        return entity;
    }

    /** Relative move (rel_entity_move / entity_move_look), in 1/4096 blocks. */
    relativeMove(id, { dX, dY, dZ, yaw, pitch, onGround }) {
        const entity = this.map.get(id);
        if (!entity) return null;
        entity.position = entity.position.offset(
            (dX ?? 0) / DELTA_SCALE,
            (dY ?? 0) / DELTA_SCALE,
            (dZ ?? 0) / DELTA_SCALE,
        );
        if (yaw !== undefined) entity.yaw = yaw;
        if (pitch !== undefined) entity.pitch = pitch;
        if (onGround !== undefined) entity.onGround = onGround;
        this.emit('entityMoved', entity);
        return entity;
    }

    velocity(id, { velocityX, velocityY, velocityZ }) {
        const entity = this.map.get(id);
        if (!entity) return null;
        entity.velocity = new Vec3(velocityX / 8000, velocityY / 8000, velocityZ / 8000);
        return entity;
    }

    /**
     * Merge a metadata update. The wire sends only changed keys, so this
     * must merge by key rather than replace the list - replacing it is how
     * you lose "is a baby" the first time the server updates health.
     */
    updateMetadata(id, metadataList) {
        const entity = this.map.get(id);
        if (!entity || !Array.isArray(metadataList)) return null;
        for (const item of metadataList) {
            if (!item || item.key === undefined) continue;
            const existing = entity.metadata.findIndex((m) => m.key === item.key);
            if (existing === -1) entity.metadata.push(item);
            else entity.metadata[existing] = item;
        }
        this.emit('entityMetadata', entity);
        return entity;
    }

    /** True when this entity is a baby, via the named index table. */
    isBaby(id) {
        const entity = this.map.get(id);
        if (!entity) return false;
        return readMetadata(entity.metadata, this.indices.isBaby) === true;
    }

    destroy(ids) {
        for (const id of ids ?? []) {
            const entity = this.map.get(id);
            if (!entity) continue;
            this.map.delete(id);
            this.emit('entityGone', entity);
        }
    }

    upsertPlayers(items) {
        for (const item of items ?? []) {
            const uuid = item.uuid ?? item.UUID;
            if (!uuid) continue;
            const existing = this.players.get(uuid) ?? {};
            this.players.set(uuid, {
                ...existing,
                uuid,
                name: item.player?.name ?? item.name ?? existing.name ?? null,
            });
        }
    }

    removePlayers(uuids) {
        for (const uuid of uuids ?? []) this.players.delete(uuid);
    }

    clear() {
        this.map.clear();
        this.players.clear();
    }
}
