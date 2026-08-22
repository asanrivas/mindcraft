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

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error('Usage: litematic_to_placements.mjs <input.litematic> <output.json>');
    process.exit(1);
}

function toUnsigned64(v) {
    return v < 0n ? v + (1n << 64n) : v;
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
                    name: entry.Name.replace('minecraft:', ''),
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
console.log('Top blocks:', topBlocks.map(([n, c]) => `${n}:${c}`).join(', '));
console.log(`Wrote ${outPath}`);
