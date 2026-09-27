#!/usr/bin/env python3
"""
Build Verification Tool - Generate ASCII/text maps from Minecraft world data
Usage: python3 verify_build.py <x1> <z1> <x2> <z2> [y] [--format ascii|json|counts]

Example: python3 verify_build.py 1445 -933 1465 -918 64
"""

import sys
import os
import json
import zlib
import struct
from pathlib import Path

# NBT parsing (simplified for block data)
WORLD_PATH = "/home/azureuser/geyser/data/world"

# Block to ASCII character mapping
BLOCK_CHARS = {
    'air': ' ',
    'cobblestone': '#',
    'stone': 'S',
    'dirt': 'd',
    'grass_block': 'g',
    'water': '~',
    'lava': 'L',
    'sand': '.',
    'gravel': ':',
    'oak_log': 'O',
    'spruce_log': 'T',
    'oak_planks': '=',
    'spruce_planks': '=',
    'torch': '*',
    'glass': 'G',
    'chest': 'C',
    'crafting_table': 'W',
    'furnace': 'F',
    'podzol': 'p',
    'fern': 'f',
    'short_grass': ',',
    'tall_grass': '|',
}

def get_block_char(block_name):
    """Get ASCII character for a block type"""
    if not block_name:
        return '?'
    # Remove minecraft: prefix if present
    block_name = block_name.replace('minecraft:', '')
    return BLOCK_CHARS.get(block_name, block_name[0].upper())

def read_region_file(region_x, region_z):
    """Read a region file and return raw data"""
    region_path = Path(WORLD_PATH) / "region" / f"r.{region_x}.{region_z}.mca"
    if not region_path.exists():
        return None
    with open(region_path, 'rb') as f:
        return f.read()

def parse_nbt_string(data, offset):
    """Parse NBT string from data"""
    if offset + 2 > len(data):
        return None, offset
    length = struct.unpack('>H', data[offset:offset+2])[0]
    offset += 2
    if offset + length > len(data):
        return None, offset
    string = data[offset:offset+length].decode('utf-8', errors='ignore')
    return string, offset + length

def find_block_states(chunk_data):
    """Find block_states palette in chunk NBT data (simplified parser)"""
    # This is a simplified approach - look for palette entries
    blocks = {}
    try:
        # Search for block state patterns in the decompressed data
        data = chunk_data
        i = 0
        while i < len(data) - 20:
            # Look for "Name" tag which precedes block names
            if data[i:i+4] == b'Name':
                # Try to read the string that follows
                try:
                    str_start = i + 4
                    if str_start + 2 <= len(data):
                        str_len = struct.unpack('>H', data[str_start:str_start+2])[0]
                        if str_len < 100 and str_start + 2 + str_len <= len(data):
                            block_name = data[str_start+2:str_start+2+str_len].decode('utf-8', errors='ignore')
                            if block_name.startswith('minecraft:'):
                                blocks[block_name] = blocks.get(block_name, 0) + 1
                except:
                    pass
            i += 1
    except Exception as e:
        pass
    return blocks

def get_chunk_data(region_data, chunk_x, chunk_z):
    """Extract chunk data from region file"""
    if not region_data:
        return None

    # Chunk location in region (0-31, 0-31)
    local_x = chunk_x % 32
    local_z = chunk_z % 32

    # Read location table entry
    offset_index = 4 * (local_x + local_z * 32)
    if offset_index + 4 > len(region_data):
        return None

    location = struct.unpack('>I', region_data[offset_index:offset_index+4])[0]
    if location == 0:
        return None

    sector_offset = (location >> 8) * 4096
    sector_count = location & 0xFF

    if sector_offset + 5 > len(region_data):
        return None

    # Read chunk header
    chunk_length = struct.unpack('>I', region_data[sector_offset:sector_offset+4])[0]
    compression_type = region_data[sector_offset+4]

    if sector_offset + 5 + chunk_length - 1 > len(region_data):
        return None

    compressed_data = region_data[sector_offset+5:sector_offset+4+chunk_length]

    try:
        if compression_type == 2:  # zlib
            return zlib.decompress(compressed_data)
        elif compression_type == 1:  # gzip
            import gzip
            return gzip.decompress(compressed_data)
    except:
        return None

    return None

def scan_area_from_world(x1, z1, x2, z2, y=64):
    """Scan an area and return block data"""
    min_x, max_x = min(x1, x2), max(x1, x2)
    min_z, max_z = min(z1, z2), max(z1, z2)

    # Determine which regions and chunks we need
    regions_needed = set()
    chunks_needed = set()

    for x in range(min_x, max_x + 1):
        for z in range(min_z, max_z + 1):
            chunk_x = x // 16
            chunk_z = z // 16
            region_x = chunk_x // 32
            region_z = chunk_z // 32
            regions_needed.add((region_x, region_z))
            chunks_needed.add((chunk_x, chunk_z))

    # Load region data
    region_cache = {}
    all_blocks = {}

    for region_x, region_z in regions_needed:
        region_data = read_region_file(region_x, region_z)
        if region_data:
            region_cache[(region_x, region_z)] = region_data

    # Scan chunks
    for chunk_x, chunk_z in chunks_needed:
        region_x = chunk_x // 32
        region_z = chunk_z // 32

        if (region_x, region_z) not in region_cache:
            continue

        chunk_data = get_chunk_data(region_cache[(region_x, region_z)], chunk_x, chunk_z)
        if chunk_data:
            blocks = find_block_states(chunk_data)
            for block, count in blocks.items():
                all_blocks[block] = all_blocks.get(block, 0) + count

    return all_blocks

def generate_ascii_map(x1, z1, x2, z2, y, blocks_data=None):
    """Generate ASCII representation of the area"""
    min_x, max_x = min(x1, x2), max(x1, x2)
    min_z, max_z = min(z1, z2), max(z1, z2)

    width = max_x - min_x + 1
    height = max_z - min_z + 1

    # Create header
    lines = []
    lines.append(f"=== BUILD VERIFICATION ===")
    lines.append(f"Area: ({min_x}, {min_z}) to ({max_x}, {max_z}) at y={y}")
    lines.append(f"Size: {width}x{height} blocks")
    lines.append("")

    # If we have block data, show counts
    if blocks_data:
        lines.append("Block composition:")
        sorted_blocks = sorted(blocks_data.items(), key=lambda x: -x[1])
        for block, count in sorted_blocks[:15]:
            block_name = block.replace('minecraft:', '')
            char = get_block_char(block_name)
            lines.append(f"  [{char}] {block_name}: {count}")
        lines.append("")

    # Legend
    lines.append("Legend: # = cobblestone, ~ = water, * = torch, T = spruce_log")
    lines.append("        g = grass, d = dirt, p = podzol, f = fern, ' ' = air")
    lines.append("")

    return "\n".join(lines)

def use_mcrcon_scan(x1, z1, x2, z2, y):
    """Use MCRCON to scan blocks (more accurate but slower)"""
    import subprocess

    min_x, max_x = min(x1, x2), max(x1, x2)
    min_z, max_z = min(z1, z2), max(z1, z2)

    blocks = {}
    grid = []

    password = os.environ.get('MCRCON_PASS', 'yBWoeDmcFIae4wfboq5d9f8C')

    for z in range(min_z, max_z + 1):
        row = []
        for x in range(min_x, max_x + 1):
            try:
                result = subprocess.run(
                    ['mcrcon', '-p', password, f'data get block {x} {y} {z}'],
                    capture_output=True, text=True, timeout=2
                )
                output = result.stdout.strip()
                # Parse block name from output like "Block data at [x, y, z]: {}"
                if 'has the following block data' in output or 'block data' in output.lower():
                    # Try to find block name
                    block = 'unknown'
                    for known in BLOCK_CHARS.keys():
                        if known in output.lower():
                            block = known
                            break
                else:
                    block = 'air'

                row.append(get_block_char(block))
                blocks[block] = blocks.get(block, 0) + 1
            except:
                row.append('?')
        grid.append(''.join(row))

    return blocks, grid

def main():
    if len(sys.argv) < 5:
        print(__doc__)
        print("\nQuick verification using !scanArea in bot:")
        print("  !scanArea(1445, -933, 1465, -918, 64)")
        sys.exit(1)

    x1 = int(sys.argv[1])
    z1 = int(sys.argv[2])
    x2 = int(sys.argv[3])
    z2 = int(sys.argv[4])
    y = int(sys.argv[5]) if len(sys.argv) > 5 else 64

    output_format = 'ascii'
    if '--format' in sys.argv:
        idx = sys.argv.index('--format')
        if idx + 1 < len(sys.argv):
            output_format = sys.argv[idx + 1]

    use_mcrcon = '--mcrcon' in sys.argv

    print(f"Scanning area: ({x1}, {z1}) to ({x2}, {z2}) at y={y}")
    print()

    if use_mcrcon:
        print("Using MCRCON for real-time block data...")
        blocks, grid = use_mcrcon_scan(x1, z1, x2, z2, y)

        if output_format == 'json':
            print(json.dumps({'blocks': blocks, 'grid': grid}, indent=2))
        else:
            print(generate_ascii_map(x1, z1, x2, z2, y, blocks))
            print("Grid view:")
            for row in grid:
                print(f"  {row}")
    else:
        # Use region file parsing
        blocks = scan_area_from_world(x1, z1, x2, z2, y)

        if output_format == 'json':
            print(json.dumps({'blocks': blocks}, indent=2))
        elif output_format == 'counts':
            for block, count in sorted(blocks.items(), key=lambda x: -x[1]):
                print(f"{block}: {count}")
        else:
            print(generate_ascii_map(x1, z1, x2, z2, y, blocks))

if __name__ == '__main__':
    main()
