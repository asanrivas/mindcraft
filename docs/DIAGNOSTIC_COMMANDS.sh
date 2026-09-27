#!/bin/bash

# Mindcraft Protocol Error Diagnostic Script
# Run this to collect info about your setup

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   Mindcraft Protocol Error - Diagnostic Tool                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# 1. Check Node.js, Bun and npm
echo "1️⃣  Runtime Versions"
echo "─────────────────────────────"
node --version
bun --version
npm --version
echo ""

# 2. Check installed packages
echo "2️⃣  Mineflayer Package Versions"
echo "─────────────────────────────"
npm list mineflayer minecraft-data 2>/dev/null | head -20
echo ""

# 3. Extract server details from settings.js
echo "3️⃣  Current Settings Configuration"
echo "─────────────────────────────"
grep -E '"minecraft_version"|"host"|"port"' settings.js | head -5
echo ""

# 4. Test connection to server
if command -v nc &> /dev/null; then
    echo "4️⃣  Server Connectivity Test"
    echo "─────────────────────────────"
    
    # Extract host and port from settings.js (basic parsing)
    HOST=$(grep '"host"' settings.js | sed 's/.*: *"\([^"]*\).*/\1/' | head -1)
    PORT=$(grep '"port"' settings.js | sed 's/.*: *\([0-9]*\).*/\1/' | head -1)
    
    if [ -n "$HOST" ] && [ -n "$PORT" ]; then
        echo "Testing connection to: $HOST:$PORT"
        timeout 3 nc -zv "$HOST" "$PORT" 2>&1 || echo "❌ Cannot connect to server"
    else
        echo "⚠️  Could not parse host/port from settings.js"
    fi
    echo ""
else
    echo "4️⃣  ⚠️  'nc' command not found, skipping connectivity test"
    echo ""
fi

# 5. Check if server is running locally
if [ -d "./server" ] || [ -f "server.jar" ]; then
    echo "5️⃣  Local Server Status"
    echo "─────────────────────────────"
    if pgrep -f "server.jar" > /dev/null; then
        echo "✅ Minecraft server is running locally"
        ps aux | grep "server.jar" | grep -v grep
    else
        echo "❌ No Minecraft server process found"
    fi
    echo ""
fi

# 6. Check disk space
echo "6️⃣  Disk Space"
echo "─────────────────────────────"
df -h | head -2
echo ""

# 7. Check for common issues
echo "7️⃣  Common Issue Checks"
echo "─────────────────────────────"

if grep -q '"minecraft_version": "auto"' settings.js; then
    echo "⚠️  ISSUE: minecraft_version is set to 'auto' (may cause version mismatch)"
    echo "   FIX: Change to specific version like '1.20.4'"
fi

if [ -d "node_modules" ]; then
    echo "✅ node_modules directory exists"
else
    echo "❌ node_modules directory NOT found - run: bun install"
fi

if grep -q '"localhost"' settings.js; then
    echo "✅ Using localhost for connection"
elif grep -q '"192.168' settings.js; then
    echo "✅ Using private IP address"
else
    echo "⚠️  Check host setting is correct"
fi

echo ""
echo "8️⃣  Recent Error Logs"
echo "─────────────────────────────"
if [ -d "bots/andy/logs" ]; then
    LATEST_LOG=$(ls -t bots/andy/logs/*.txt 2>/dev/null | head -1)
    if [ -n "$LATEST_LOG" ]; then
        echo "Latest log: $LATEST_LOG"
        echo "Last 10 lines:"
        tail -10 "$LATEST_LOG"
    fi
else
    echo "No logs directory found yet"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   Diagnostic Complete                                          ║"
echo "║   Review output above and check QUICK_FIX.txt for solutions    ║"
echo "╚════════════════════════════════════════════════════════════════╝"

