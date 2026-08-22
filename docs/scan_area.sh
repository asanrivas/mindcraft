#!/bin/bash
# Scan a Minecraft area and output block grid
# Usage: ./scan_area.sh <x1> <z1> <x2> <z2> [y]
# Example: ./scan_area.sh 1450 -930 1460 -920 64

X1=${1:-1450}
Z1=${2:--930}
X2=${3:-1460}
Z2=${4:--920}
Y=${5:-64}

PASS="${MCRCON_PASS:-yBWoeDmcFIae4wfboq5d9f8C}"

echo "=== AREA SCAN ==="
echo "Area: ($X1, $Z1) to ($X2, $Z2) at y=$Y"
echo ""

# Block counters
declare -A BLOCKS

# Generate grid
echo "Grid (row=Z, col=X):"
echo -n "     "
for ((x=X1; x<=X2; x++)); do
    printf "%2d" $((x % 100))
done
echo ""

for ((z=Z1; z<=Z2; z++)); do
    printf "%4d " $z
    for ((x=X1; x<=X2; x++)); do
        # Get block at position
        RESULT=$(mcrcon -p "$PASS" "data get block $x $Y $z" 2>/dev/null)

        # Parse block type
        if [[ "$RESULT" == *"air"* ]] || [[ "$RESULT" == *"has no block"* ]]; then
            CHAR=" "
            BLOCK="air"
        elif [[ "$RESULT" == *"cobblestone"* ]]; then
            CHAR="#"
            BLOCK="cobblestone"
        elif [[ "$RESULT" == *"water"* ]]; then
            CHAR="~"
            BLOCK="water"
        elif [[ "$RESULT" == *"torch"* ]]; then
            CHAR="*"
            BLOCK="torch"
        elif [[ "$RESULT" == *"dirt"* ]]; then
            CHAR="d"
            BLOCK="dirt"
        elif [[ "$RESULT" == *"grass"* ]]; then
            CHAR="g"
            BLOCK="grass"
        elif [[ "$RESULT" == *"podzol"* ]]; then
            CHAR="p"
            BLOCK="podzol"
        elif [[ "$RESULT" == *"fern"* ]]; then
            CHAR="f"
            BLOCK="fern"
        elif [[ "$RESULT" == *"spruce_log"* ]]; then
            CHAR="T"
            BLOCK="spruce_log"
        elif [[ "$RESULT" == *"stone"* ]]; then
            CHAR="S"
            BLOCK="stone"
        else
            CHAR="?"
            BLOCK="unknown"
        fi

        printf "%s " "$CHAR"
        ((BLOCKS[$BLOCK]++))
    done
    echo ""
done

echo ""
echo "Block counts:"
for block in "${!BLOCKS[@]}"; do
    echo "  $block: ${BLOCKS[$block]}"
done | sort -t: -k2 -rn
