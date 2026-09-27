/**
 * Idle Behavior System for Mindcraft
 * Handles automatic tasks when the bot is idle (not doing anything)
 */

import * as skills from './library/skills.js';
import * as chest from './library/chest.js';
import Vec3 from 'vec3';

export class IdleBehavior {
    constructor(agent) {
        this.agent = agent;
        this.idleTime = 0;
        this.lastScanTime = 0;
        this.isScanning = false;
        this.scannedChests = new Set(); // Track chests we've already scanned this session

        // Configuration
        this.IDLE_SCAN_DELAY = 30000;      // Wait 30 seconds of idle before scanning
        this.SCAN_COOLDOWN = 300000;       // 5 minutes between full scans
        this.SCAN_RANGE = 16;              // Search for chests within 16 blocks
        this.CONTAINER_TIMEOUT = 3000;     // 3 second timeout for opening containers (prevent keep-alive timeout)
        this.failedContainers = new Set(); // Permanently skip containers that fail (they might be protected)
    }

    /**
     * Called every update tick
     * @param {number} delta - Time since last update in ms
     */
    async update(delta) {
        // Skip if not truly idle
        if (!this.agent.isIdle() || this.isScanning) {
            this.idleTime = 0;
            return;
        }

        // Skip if self-prompting is active (bot is doing a task)
        if (this.agent.self_prompter.isActive()) {
            this.idleTime = 0;
            return;
        }

        this.idleTime += delta;

        // Distill queued conversation into memory while nothing else is happening. This is an
        // extra LLM call, so doing it here keeps it off the reply path where it would add
        // latency to every 30th message.
        if (this.idleTime >= 5000 && this.agent.history.pending_summary?.length > 0) {
            const did = await this.agent.history.consolidatePending();
            if (did) {
                console.log('[IdleBehavior] Consolidated pending memory while idle.');
                return; // give the bot a tick before considering a scan
            }
        }

        // Check if we should scan
        const now = Date.now();
        const timeSinceLastScan = now - this.lastScanTime;

        if (this.idleTime >= this.IDLE_SCAN_DELAY && timeSinceLastScan >= this.SCAN_COOLDOWN) {
            await this.performIdleScan();
        }
    }

    /**
     * Perform an idle scan of nearby area
     */
    async performIdleScan() {
        this.isScanning = true;
        this.lastScanTime = Date.now();

        try {
            console.log('[IdleBehavior] Starting idle scan...');

            // Scan for nearby chests and memorize contents
            await this.scanAndMemorizeChests();

            console.log('[IdleBehavior] Idle scan complete.');
        } catch (error) {
            console.warn(`[IdleBehavior] Scan error: ${error.message}`);
        } finally {
            this.isScanning = false;
            this.idleTime = 0;
        }
    }

    /**
     * Open a container for a read-only peek.
     *
     * Delegates to chest.openContainerSafe rather than racing bot.openContainer directly: the
     * race version leaked the window when it lost. `bot.openContainer` has no cancellation, so
     * a window that arrives after the deadline stays open as `bot.currentWindow` - and a stale
     * currentWindow makes the NEXT open never fire, which quietly broke every later deposit in
     * the session. chest.openContainerSafe closes whatever appeared, and refuses up front for
     * the reasons the server would silently drop (blocked chest, cat on top, out of reach,
     * a decorated_pot that has no screen at all).
     */
    async openContainerWithTimeout(bot, block, timeout) {
        const res = await chest.openContainerSafe(bot, block, { attempts: 1 });
        if (!res.ok) throw new Error(res.detail ?? res.reason);
        return res.window;
    }

    /**
     * Scan nearby chests and store their contents in Mem0
     */
    async scanAndMemorizeChests() {
        const bot = this.agent.bot;
        const chatModel = this.agent.prompter?.chat_model;

        // Get all nearby containers within interaction range
        const containers = skills.listNearbyChests(bot, this.SCAN_RANGE);

        if (containers.length === 0) {
            console.log('[IdleBehavior] No containers found nearby.');
            return;
        }

        // Filter to only containers within direct interaction range (4 blocks)
        const reachableContainers = containers.filter(c => c.distance <= 4);

        if (reachableContainers.length === 0) {
            console.log(`[IdleBehavior] Found ${containers.length} container(s) but none within reach.`);
            return;
        }

        console.log(`[IdleBehavior] Found ${reachableContainers.length} reachable container(s) to scan.`);

        let scannedCount = 0;
        let failedCount = 0;
        const MAX_SCAN_PER_CYCLE = 2; // Very limited to prevent blocking
        const MAX_FAILURES = 2; // Stop if too many failures (likely server issue)

        for (const container of reachableContainers) {
            // Check if we've already scanned this chest recently
            const posKey = `${container.position.x},${container.position.y},${container.position.z}`;
            if (this.scannedChests.has(posKey) || this.failedContainers.has(posKey)) {
                continue;
            }

            if (scannedCount >= MAX_SCAN_PER_CYCLE) {
                console.log('[IdleBehavior] Reached scan limit for this cycle.');
                break;
            }

            // Stop early if we're getting too many failures (server might be lagging)
            if (failedCount >= MAX_FAILURES) {
                console.log('[IdleBehavior] Too many failures, stopping scan to prevent timeout.');
                break;
            }

            let openedContainer = null;
            try {
                // Open container with timeout (no walking - only scan what's in reach)
                openedContainer = await this.openContainerWithTimeout(
                    bot,
                    container.block,
                    this.CONTAINER_TIMEOUT
                );

                const items = openedContainer.containerItems();

                // Get the chest name if it has one
                const chestName = this.getChestName(container.position);

                // Store in Mem0 if we have items and Mem0 is available
                if (items.length > 0 && chatModel?.storeEventMemory) {
                    const itemSummary = this.summarizeItems(items);
                    const { x, y, z } = container.position;
                    const chestDesc = chestName ? `"${chestName}" chest` : `chest at (${x}, ${y}, ${z})`;

                    // Don't await Mem0 storage - do it in background to prevent blocking
                    chatModel.storeEventMemory(
                        'inventory',
                        `Scanned ${chestDesc}: contains ${itemSummary}`,
                        {
                            chest_name: chestName,
                            location: { x, y, z },
                            items: items.map(i => ({ name: i.name, count: i.count }))
                        }
                    ).catch(err => console.warn(`[IdleBehavior] Mem0 store failed: ${err.message}`));

                    console.log(`[IdleBehavior] Memorized contents of ${chestDesc}: ${itemSummary}`);
                }

                this.scannedChests.add(posKey);
                scannedCount++;
                failedCount = 0; // Reset failure count on success

            } catch (err) {
                console.warn(`[IdleBehavior] Could not scan container at ${posKey}: ${err.message}`);
                // Mark as permanently failed to avoid retrying (might be protected/locked)
                this.failedContainers.add(posKey);
                failedCount++;
            } finally {
                // Always try to close the container
                // safeClose tolerates an already-closed window and clears bot.currentWindow,
                // so a failed scan cannot poison the next one.
                await chest.safeClose(bot, openedContainer);
            }

            // Yield to event loop to let keep-alive packets through
            await new Promise(r => setImmediate(r));
        }

        console.log(`[IdleBehavior] Scanned ${scannedCount} new container(s).`);
    }

    /**
     * Get the named chest name for a position, if it exists
     */
    getChestName(position) {
        const namedChests = skills.getNamedChestsJson();
        for (const [key, value] of Object.entries(namedChests)) {
            if (value.x === position.x && value.y === position.y && value.z === position.z) {
                // Extract name from key (format: "chest:name")
                return key.replace('chest:', '');
            }
        }
        return null;
    }

    /**
     * Create a human-readable summary of items
     */
    summarizeItems(items) {
        // Group by item name and sum counts
        const grouped = {};
        for (const item of items) {
            if (grouped[item.name]) {
                grouped[item.name] += item.count;
            } else {
                grouped[item.name] = item.count;
            }
        }

        // Sort by count (most first) and take top items
        const sorted = Object.entries(grouped)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10); // Top 10 items

        const parts = sorted.map(([name, count]) => `${count}x ${name}`);

        if (Object.keys(grouped).length > 10) {
            parts.push(`and ${Object.keys(grouped).length - 10} more item types`);
        }

        return parts.join(', ');
    }

    /**
     * Clear the scanned chests cache (useful when moving to a new area)
     */
    clearCache() {
        this.scannedChests.clear();
        console.log('[IdleBehavior] Cleared scanned chests cache.');
    }

    /**
     * Force an immediate scan (ignores cooldowns)
     */
    async forceScan() {
        this.scannedChests.clear(); // Clear cache so we rescan everything
        this.lastScanTime = 0;
        await this.performIdleScan();
    }
}
