/**
 * Mem0 integration for Mindcraft using the official Node.js SDK
 * Uses Mem0 Platform (hosted) API - see https://docs.mem0.ai/cookbooks/companions/nodejs-companion
 */

import { MemoryClient } from 'mem0ai';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

/*
 * Minecraft-specific memory categories for auto-tagging
 * Configure these in Mem0 Dashboard > Project Settings > Custom Categories:
 *
 * building   - Construction tasks, structures, blocks to place, building projects
 * mining     - Mining resources, ores, caves, digging, collecting materials
 * crafting   - Crafting recipes, items to make, workbench tasks, smelting
 * combat     - Fighting mobs, PvP, weapons, armor, defense
 * farming    - Crops, animals, breeding, food production
 * exploration- Travel, coordinates, locations, biomes, bases, waypoints
 * trading    - Villager trades, emeralds, bartering
 * rules      - Player rules, restrictions, things NOT to do
 * goals      - Long-term objectives, missions, player requests
 * inventory  - Item storage, chest contents, resource management
 */

export class Mem0Local {
    static prefix = 'mem0';

    constructor(model_name, url, params) {
        this.model_name = model_name; // Azure Foundry model for generation
        this.url = url; // Azure Foundry URL
        this.params = params || {};
        this.agent_id = params.agent_name || 'andy';

        // Mem0 Platform Client Configuration
        const mem0Key = process.env.MEM0_API_KEY || (hasKey('MEM0_API_KEY') ? getKey('MEM0_API_KEY') : null);

        if (!mem0Key) {
            console.warn('[Mem0] Warning: MEM0_API_KEY not found. Memory features will be disabled.');
            this.memory = null;
        } else {
            console.log('[Mem0] Initializing Mem0 Platform client');
            this.memory = new MemoryClient({ apiKey: mem0Key });
        }

        // Azure Foundry client for LLM
        this.foundryClient = null;
        this.initFoundry(url);
    }

    /**
     * Initialize Azure Foundry client
     */
    initFoundry(url) {
        let config = {};

        if (url) {
            const match = url.match(/https:\/\/([^.]+)\.services\.ai\.azure\.com/);
            if (match) {
                config.resource = match[1];
            } else {
                config.baseURL = url;
            }
        }

        config.apiKey = getKey('AZURE_FOUNDRY_API_KEY');
        this.foundryClient = new AnthropicFoundry(config);
        console.log('[Mem0] Azure Foundry client initialized');
    }

    /**
     * Main LLM interface for Mindcraft - sendRequest
     */
    async sendRequest(turns, systemMessage) {
        // Extract user ID from message (format: "username: message")
        const lastUserMessage = turns.filter(t => t.role === 'user').pop();
        let userId = 'default';
        let userContent = lastUserMessage?.content || '';

        if (userContent) {
            const match = userContent.match(/^([^:]+):/);
            if (match) {
                userId = match[1].trim();
            }
        }

        // For full conversation context, format all turns
        const formattedTurns = strictFormat(turns).map(({ name, ...rest }) => rest);

        // Search memories based on recent context (if Mem0 is configured and query not empty)
        let memoriesStr = '';
        if (this.memory && userContent.trim()) {
            try {
                // Search user's memories AND shared system memories (for idle scans, etc.)
                const [userMemories, systemMemories] = await Promise.all([
                    this.memory.search(userContent, { user_id: userId }),
                    userId !== 'system' ? this.memory.search(userContent, { user_id: 'system' }) : Promise.resolve([])
                ]);

                const userResults = userMemories.results || userMemories || [];
                const systemResults = systemMemories.results || systemMemories || [];

                // Combine and deduplicate memories
                const allMemories = [...userResults, ...systemResults];
                const seenMemories = new Set();
                const memories = allMemories.filter(m => {
                    if (seenMemories.has(m.memory)) return false;
                    seenMemories.add(m.memory);
                    return true;
                });

                if (memories.length > 0) {
                    // Include category tags in memory context
                    memoriesStr = '\n\nUser Memories:\n' + memories.map(m => {
                        const category = m.categories?.[0] || 'general';
                        return `- [${category}] ${m.memory}`;
                    }).join('\n');
                    console.log(`[Mem0] Found ${memories.length} memories for ${userId} (including shared)`);
                }
            } catch (err) {
                console.warn(`[Mem0] Memory search failed: ${err.message}`);
            }
        }

        const augmentedSystem = systemMessage + memoriesStr;
        const startTime = Date.now();

        try {
            const requestParams = { ...this.params };
            delete requestParams.agent_name;
            delete requestParams.embedding_model;
            requestParams.max_tokens = requestParams.max_tokens || 4096;

            const resp = await this.foundryClient.messages.create({
                model: this.model_name,
                system: augmentedSystem,
                messages: formattedTurns,
                ...requestParams,
            });

            const assistantResponse = resp.content.find(c => c.type === 'text')?.text || '';
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[Mem0] Response received (${elapsed}s)`);

            // Store the conversation for memory extraction (if Mem0 is configured and content exists)
            if (this.memory && userContent.trim() && assistantResponse.trim()) {
                try {
                    const toStore = [
                        { role: 'user', content: userContent },
                        { role: 'assistant', content: assistantResponse }
                    ];
                    const result = await this.memory.add(toStore, { user_id: userId });

                    // Log stored memories with their auto-assigned categories
                    const stored = Array.isArray(result) ? result : (result?.results || []);
                    if (stored.length > 0) {
                        const categories = stored.map(m => m.categories?.[0] || 'general').join(', ');
                        console.log(`[Mem0] Stored ${stored.length} memory(s) for ${userId} [${categories}]`);
                    }
                } catch (err) {
                    console.warn(`[Mem0] Memory store failed: ${err.message}`);
                }
            }

            return assistantResponse;
        } catch (err) {
            console.error('[Mem0] Error:', err);
            return 'My brain disconnected, try again.';
        }
    }

    /**
     * Vision request with image
     */
    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    /**
     * Store an event memory (death, player join/leave, inventory changes, etc.)
     * @param {string} eventType - Type of event (death, player_join, player_leave, inventory, system)
     * @param {string} description - Human-readable description of the event
     * @param {Object} data - Additional event data (location, items, etc.)
     * @param {string} userId - User ID to associate with (default: 'system')
     */
    async storeEventMemory(eventType, description, data = {}, userId = 'system') {
        if (!this.memory) return;

        try {
            const timestamp = new Date().toISOString();
            const memoryContent = `[${eventType.toUpperCase()}] ${description}`;

            // Use 'user' role so Mem0 extracts the memory properly
            const toStore = [
                { role: 'user', content: memoryContent },
                { role: 'assistant', content: `Noted. I will remember this.` }
            ];

            const result = await this.memory.add(toStore, {
                user_id: userId,
                metadata: {
                    event_type: eventType,
                    timestamp: timestamp,
                    ...data
                }
            });

            const stored = Array.isArray(result) ? result : (result?.results || []);
            if (stored.length > 0) {
                console.log(`[Mem0] Event stored: ${eventType} - ${description}`);
            }
        } catch (err) {
            console.warn(`[Mem0] Event memory failed: ${err.message}`);
        }
    }

    /**
     * Convenience methods for common events
     */
    async recordDeath(location, cause = 'unknown') {
        const { x, y, z } = location;
        await this.storeEventMemory(
            'death',
            `Bot died at x:${Math.round(x)} y:${Math.round(y)} z:${Math.round(z)}. Cause: ${cause}`,
            { location: { x, y, z }, cause }
        );
    }

    async recordPlayerJoin(playerName) {
        await this.storeEventMemory(
            'player_join',
            `${playerName} joined the game`,
            { player: playerName },
            playerName
        );
    }

    async recordPlayerLeave(playerName) {
        await this.storeEventMemory(
            'player_leave',
            `${playerName} left the game`,
            { player: playerName },
            playerName
        );
    }

    async recordInventoryChange(action, items) {
        const itemStr = items.map(i => `${i.count}x ${i.name}`).join(', ');
        await this.storeEventMemory(
            'inventory',
            `${action}: ${itemStr}`,
            { action, items }
        );
    }

    async recordImportantLocation(name, location, description = '') {
        const { x, y, z } = location;
        await this.storeEventMemory(
            'location',
            `Important location "${name}" at x:${Math.round(x)} y:${Math.round(y)} z:${Math.round(z)}. ${description}`,
            { name, location: { x, y, z }, description }
        );
    }

    /**
     * Record items deposited into a chest for semantic recall
     * @param {string} chestName - Name of the chest (or "unnamed" if not named)
     * @param {Object} location - {x, y, z} coordinates
     * @param {Array} items - Array of {name, count} items deposited
     */
    async recordChestDeposit(chestName, location, items) {
        if (!this.memory || items.length === 0) return;

        const { x, y, z } = location;
        const itemStr = items.map(i => `${i.count}x ${i.name}`).join(', ');
        const chestDesc = chestName ? `"${chestName}" chest` : `chest at (${x}, ${y}, ${z})`;

        await this.storeEventMemory(
            'inventory',
            `Deposited into ${chestDesc} at x:${Math.round(x)} y:${Math.round(y)} z:${Math.round(z)}: ${itemStr}`,
            { chest_name: chestName, location: { x, y, z }, items }
        );
    }

    async close() {
        // Nothing to close
    }
}