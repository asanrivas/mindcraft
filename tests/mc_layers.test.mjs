/**
 * Unit tests for the owned client layers (src/mc/net, /world, /entities).
 * No server, no network:  bun tests/mc_layers.test.mjs
 *
 * These pin the behaviours that are easy to get subtly wrong and that fail
 * SILENTLY rather than loudly - which is the failure mode that cost this
 * repo the most time historically (see CLAUDE.md "recurring lessons").
 */
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import prismarineRegistry from 'prismarine-registry';
import { Connection } from '../src/mc/net/connection.js';
import { World } from '../src/mc/world/world.js';
import { Entities } from '../src/mc/entities/entities.js';
import { metadataIndices, readMetadata } from '../src/mc/entities/metadata.js';

let failures = 0;
const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); failures++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Connection: rate limiting -------------------------------------------------------------
{
    class FakeClient extends EventEmitter {
        constructor() { super(); this.written = []; }
        write(name, data) { this.written.push({ name, data }); }
        end() {}
    }

    const client = new FakeClient();
    const conn = new Connection(client, { minIntervalMs: 50 });

    // Non-coalesced packets must never be delayed - a throttled dig or chat
    // would be a regression, not a protection.
    conn.write('chat', { message: 'a' });
    conn.write('chat', { message: 'b' });
    check('non-coalesced packets pass straight through', client.written.length === 2);

    client.written.length = 0;
    conn.write('position', { x: 1 });
    check('first movement packet sends immediately', client.written.length === 1);

    conn.write('position', { x: 2 });
    conn.write('position', { x: 3 });
    check('movement packets inside the window are held', client.written.length === 1);

    await sleep(90);
    check('held movement packet is eventually flushed', client.written.length === 2);
    // The whole point of coalescing: send the NEWEST state, not the oldest.
    // Flushing x:2 after x:3 arrived is what makes a bot rubber-band.
    check('flushed packet carries the NEWEST payload, not a stale one',
        client.written[1].data.x === 3);
}

// --- Connection: decode-error policy -------------------------------------------------------
{
    class FakeClient extends EventEmitter {
        write() {} end() {}
    }
    const client = new FakeClient();
    const conn = new Connection(client);

    let rethrown = 0;
    conn.on('error', () => { rethrown++; });

    client.emit('error', new Error('PartialReadError: Read error for packet_foo : bad varint'));
    check('decode errors are swallowed, not re-emitted', rethrown === 0);
    check('decode error is attributed to its packet name',
        conn.decodeErrorSummary().packet_foo === 1);

    client.emit('error', new Error('PartialReadError: Read error for packet_foo : again'));
    check('repeat decode errors are counted', conn.decodeErrorSummary().packet_foo === 2);

    client.emit('error', new Error('ECONNRESET'));
    check('non-decode errors ARE re-emitted', rethrown === 1);
}

// --- World: negative-coordinate indexing ---------------------------------------------------
{
    const registry = prismarineRegistry('1.21.11');
    const world = new World(registry, { minY: -64, height: 384 });

    check('unloaded column reads as null, not as air',
        world.blockAt(new Vec3(5, 64, 5)) === null);

    // The bug this guards: `pos.x % 16` is NEGATIVE for negative world
    // coordinates, so a naive modulo silently reads the wrong block in the
    // entire x<0 or z<0 half of the world - which is most of this save.
    const column = new world.ChunkColumn({ minY: -64, worldHeight: 384 });
    world.columns.set(World.key(-1, -1), column);
    const stone = registry.blocksByName.stone.defaultState;
    world.setBlockStateId(new Vec3(-1, 64, -1), stone);
    const read = world.blockAt(new Vec3(-1, 64, -1));
    check('negative world coords index the correct block', read && read.name === 'stone');
    check('blockAt stamps absolute position back onto the block',
        read && read.position.x === -1 && read.position.z === -1);

    // A neighbouring cell in the same column must NOT have been written.
    const neighbour = world.blockAt(new Vec3(-2, 64, -1));
    check('negative-coord write did not smear into a neighbour',
        neighbour && neighbour.name === 'air');

    check('out-of-range y reads as null',
        world.blockAt(new Vec3(-1, 5000, -1)) === null);
}

// --- World: generation counter + awaitable columns -----------------------------------------
{
    const registry = prismarineRegistry('1.21.11');
    const world = new World(registry, { minY: -64, height: 384 });
    const column = new world.ChunkColumn({ minY: -64, worldHeight: 384 });
    world.columns.set(World.key(0, 0), column);

    const before = world.generation;
    world.setBlockStateId(new Vec3(1, 64, 1), registry.blocksByName.stone.defaultState);
    check('generation advances on mutation', world.generation > before);

    const steady = world.generation;
    world.blockAt(new Vec3(1, 64, 1));
    check('generation does NOT advance on a pure read', world.generation === steady);

    // waitForColumn is the point of the whole abstraction: no polling.
    let resolved = false;
    const pending = world.waitForColumn(9, 9, 1000).then(() => { resolved = true; });
    check('waitForColumn does not resolve before the column arrives', resolved === false);
    world.setColumn(9, 9, new world.ChunkColumn({ minY: -64, worldHeight: 384 }));
    await pending;
    check('waitForColumn resolves once the column loads', resolved === true);

    // An "empty column" map_chunk must unload, not install an all-air column
    // that a planner would treat as walkable void.
    world.setColumn(4, 4, new world.ChunkColumn({ minY: -64, worldHeight: 384 }));
    world.loadColumn({ x: 4, z: 4, bitMap: 0, groundUp: true });
    check('empty-column packet unloads rather than storing all-air',
        world.getColumn(4, 4) === null);

    await world.waitForColumn(0, 0, 50); // already loaded -> immediate
    check('waitForColumn on an already-loaded column resolves immediately', true);
}

// --- Entities: metadata merge + relative move ----------------------------------------------
{
    const registry = prismarineRegistry('1.21.11');
    const entities = new Entities(registry, '1.21.11');

    entities.spawn({ entityId: 7, type: 0, x: 10, y: 64, z: 10 });
    check('spawn registers the entity', entities.get(7) !== null);
    check('position is a real Vec3 (call sites need .offset/.distanceTo)',
        typeof entities.get(7).position.distanceTo === 'function');

    const idx = metadataIndices('1.21.11');
    entities.updateMetadata(7, [{ key: idx.isBaby, value: true }]);
    check('isBaby reads through the named index table', entities.isBaby(7) === true);

    // The merge bug: the wire only sends CHANGED keys, so replacing the list
    // instead of merging loses "is a baby" the first time health updates -
    // and isHuntable() would then start hunting babies with no error.
    entities.updateMetadata(7, [{ key: idx.health, value: 20 }]);
    check('metadata merges by key rather than replacing the list',
        entities.isBaby(7) === true);
    check('merged metadata keeps the new key too',
        readMetadata(entities.get(7).metadata, idx.health) === 20);

    // 1/4096-block deltas.
    entities.relativeMove(7, { dX: 4096, dY: 0, dZ: -4096 });
    const moved = entities.get(7).position;
    check('relative move applies the 1/4096 wire scale',
        Math.abs(moved.x - 11) < 1e-6 && Math.abs(moved.z - 9) < 1e-6);

    entities.teleport(7, { x: 0, y: 0, z: 0 });
    check('teleport sets absolute position', entities.get(7).position.x === 0);

    entities.destroy([7]);
    check('destroy removes the entity', entities.get(7) === null);
    check('count reflects removals', entities.count === 0);
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: mc client layers correct');
