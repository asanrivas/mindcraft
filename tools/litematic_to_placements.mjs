#!/usr/bin/env bun
/**
 * Converts a .litematic (Litematica mod schematic) file into a flat JSON list of
 * block placements: [{x,y,z,name,properties,nbt}], in schematic-local coordinates
 * (min-corner of the region = origin 0,0,0). Skips air.
 *
 *   bun tools/litematic_to_placements.mjs <input.litematic> <output.json>
 *
 * Litematica stores per-region blocks as a bit-packed long array (LitematicaBitArray):
 * entries are `bitsPerEntry = max(2, ceil(log2(paletteSize)))` wide, packed contiguously
 * (may span a 64-bit boundary, unlike vanilla chunk section packing). Index order is
 * `index = y * (width*length) + z * width + x`, where width/length are abs(Size.x/z).
 * Region.Position + region-local min-corner offset (for negative Size axes) gives the
 * schematic-space coordinate of local (0,0,0).
 */
import fs from 'fs';
import nbt from 'prismarine-nbt';

/**
 * Blocks Mojang RENAMED between the version a schematic was authored in and the one we connect as.
 * A stale name is not a missing block, it is the same block under its old spelling - but nothing
 * downstream can tell the difference, and the symptom is far from the cause:
 * `mcData.itemsByName['chain']` is undefined on 1.21.11, so `new Item(undefined, 1)` yields an item
 * whose `.components` is undefined, and the builder reports
 * `equip chain failed: undefined is not an object (evaluating 'item.components.length')` followed
 * by `no item chain` for every one. Measured 2026-09-22: 31 in wizard_tower, 14 in survival_base,
 * plus 136 `grass` (now `short_grass`) that would have failed the same way.
 *
 * Renaming at IMPORT, not at placement time, is deliberate. A rename applied while placing would
 * put `iron_chain` in the world and then verify it against the blueprint's `chain` and score a
 * perfectly good placement as a failure - the builder compares block names, so the name has to be
 * right in the data.
 */
const RENAMES = {
    chain: 'iron_chain',        // 1.21.9: chain -> iron_chain (copper_chain variants added)
    grass: 'short_grass',       // 1.20.3: grass -> short_grass
    grass_path: 'dirt_path',    // 1.17
    snow_layer: 'snow',
    sign: 'oak_sign',
    wall_sign: 'oak_wall_sign',
};

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error('Usage: litematic_to_placements.mjs <input.litematic> <output.json>');
    process.exit(1);
}

function toUnsigned64(v) {
    return v < 0n ? v + (1n << 64n) : v;
}

/** Current name for a block, and a note when it had to be translated. */
const renamed = new Map();
function currentName(name) {
    const to = RENAMES[name];
    if (!to) return name;
    renamed.set(name, (renamed.get(name) || 0) + 1);
    return to;
}

function decodeRegion(region) {
    const width = Math.abs(region.Size.x);
    const height = Math.abs(region.Size.y);
    const length = Math.abs(region.Size.z);
    const minCorner = {
        x: region.Size.x >= 0 ? region.Position.x : region.Position.x + region.Size.x + 1,
        y: region.Size.y >= 0 ? region.Position.y : region.Position.y + region.Size.y + 1,
        z: region.Size.z >= 0 ? region.Position.z : region.Position.z + region.Size.z + 1,
    };

    const palette = region.BlockStatePalette;
    const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const mask = (1n << BigInt(bitsPerEntry)) - 1n;
    const longs = region.BlockStates.map(toUnsigned64);

    const numEntries = width * height * length;
    const getEntry = (index) => {
        const startOffset = index * bitsPerEntry;
        const startArrIndex = Math.floor(startOffset / 64);
        const endArrIndex = Math.floor(((index + 1) * bitsPerEntry - 1) / 64);
        const startBitOffset = BigInt(startOffset % 64);
        let value;
        if (startArrIndex === endArrIndex) {
            value = (longs[startArrIndex] >> startBitOffset) & mask;
        } else {
            const endOffset = 64n - startBitOffset;
            value = ((longs[startArrIndex] >> startBitOffset) | (longs[endArrIndex] << endOffset)) & mask;
        }
        return Number(value);
    };

    const tileEntityByPos = new Map();
    for (const te of region.TileEntities || []) {
        tileEntityByPos.set(`${te.x},${te.y},${te.z}`, te);
    }

    const placements = [];
    for (let y = 0; y < height; y++) {
        for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
                const index = y * (width * length) + z * width + x;
                const paletteIndex = getEntry(index);
                const entry = palette[paletteIndex];
                if (!entry || entry.Name === 'minecraft:air') continue;
                const sx = minCorner.x + x;
                const sy = minCorner.y + y;
                const sz = minCorner.z + z;
                const placement = {
                    x: sx, y: sy, z: sz,
                    name: currentName(entry.Name.replace('minecraft:', '')),
                    properties: entry.Properties || {},
                };
                const te = tileEntityByPos.get(`${sx},${sy},${sz}`);
                if (te) placement.nbt = te;
                placements.push(placement);
            }
        }
    }
    return { placements, width, height, length, minCorner, entities: region.Entities || [] };
}

const buf = fs.readFileSync(inPath);
const { parsed } = await nbt.parse(buf);
const root = nbt.simplify(parsed);

const regionNames = Object.keys(root.Regions);
if (regionNames.length !== 1) {
    console.error(`Expected exactly 1 region, found ${regionNames.length}: ${regionNames.join(', ')}. This script only merges a single region.`);
}

let allPlacements = [];
let bounds = { width: 0, height: 0, length: 0 };
let totalEntities = 0;
for (const rname of regionNames) {
    const { placements, width, height, length, entities } = decodeRegion(root.Regions[rname]);
    allPlacements = allPlacements.concat(placements);
    bounds.width = Math.max(bounds.width, width);
    bounds.height = Math.max(bounds.height, height);
    bounds.length = Math.max(bounds.length, length);
    totalEntities += entities.length;
}

const nameCounts = new Map();
for (const p of allPlacements) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
const topBlocks = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

const output = {
    meta: {
        name: root.Metadata?.Name,
        author: root.Metadata?.Author,
        description: root.Metadata?.Description,
        size: bounds,
        blockCount: allPlacements.length,
        expectedTotalBlocks: root.Metadata?.TotalBlocks,
        entityCount: totalEntities,
        tileEntityCount: allPlacements.filter(p => p.nbt).length,
    },
    placements: allPlacements,
};

fs.writeFileSync(outPath, JSON.stringify(output));
console.log(`Decoded ${allPlacements.length} blocks (expected ${root.Metadata?.TotalBlocks}), size ${bounds.width}x${bounds.height}x${bounds.length}`);
if (renamed.size) console.log(`Renamed to current 1.21.11 names: ${[...renamed].map(([n, c]) => `${n}->${RENAMES[n]} x${c}`).join(', ')}`);
console.log('Top blocks:', topBlocks.map(([n, c]) => `${n}:${c}`).join(', '));
console.log(`Wrote ${outPath}`);
