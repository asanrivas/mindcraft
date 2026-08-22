#!/bin/bash
# Regenerate Minecraft world map using MinedMap
# Usage: ./regenerate_map.sh [--watch]

MINEDMAP="/home/azureuser/MinedMap-2.7.0-x86_64-unknown-linux-gnu/minedmap"
WORLD="/home/azureuser/geyser/data/world"
OUTPUT="/home/azureuser/mindcraft/minedmap_output"

echo "Regenerating map from: $WORLD"
echo "Output to: $OUTPUT"

if [ "$1" == "--watch" ]; then
    echo "Starting in watch mode (will auto-update when world changes)..."
    $MINEDMAP -j 4 --watch "$WORLD" "$OUTPUT"
else
    $MINEDMAP -j 4 "$WORLD" "$OUTPUT"
    echo ""
    echo "Map regenerated! View at: http://localhost:8090/"
    echo "  - Castle area: region r.2.-2 (around x=1455, z=-928)"
    echo "  - Spawn: x=4736, z=4731"
fi
