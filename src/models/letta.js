/**
 * Letta Client for Mindcraft
 * Connects to self-hosted Letta server with Azure Anthropic Claude
 * Supports local embeddings via Xenova/multilingual-e5-small (English + Malay)
 */

import { strictFormat } from "../utils/text.js";
import { pipeline } from "@huggingface/transformers";
import { cosineSimilarity } from "../utils/math.js";

export class Letta {
    static prefix = "letta";

    constructor(model_name, url, params) {
        this.model_name = model_name || "openai-proxy/claude-sonnet-4-5";
        this.url = url || process.env.LETTA_BASE_URL || "http://localhost:8283";
        this.params = params || {};
        this.agentId = null;
        this.agentName = null;

        // Local embedding configuration (multilingual support for English + Malay)
        this.embeddingModel = params?.embedding_model || "Xenova/multilingual-e5-small";
        this.embedder = null;
        this.embeddingInitializing = false;
        this.embeddingInitPromise = null;

        // Embedding cache (LRU) - 384-dim embeddings
        this.embeddingCache = new Map();
        this.maxCacheSize = 500;
    }

    // Create a new agent
    async createAgent(name) {
        const response = await fetch(`${this.url}/v1/agents/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name,
                model: this.model_name,
                embedding: "letta/letta-free",
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to create agent: ${error}`);
        }

        const agent = await response.json();
        this.agentId = agent.id;
        this.agentName = agent.name;
        return agent;
    }

    // Get or create agent by name
    async getOrCreateAgent(name) {
        const agents = await this.listAgents();
        const existing = agents.find((a) => a.name === name);

        if (existing) {
            this.agentId = existing.id;
            this.agentName = existing.name;
            console.log(
                `[Letta] Using existing agent: ${existing.name} (${existing.id})`,
            );
            return existing;
        }

        console.log(`[Letta] Creating new agent: ${name}`);
        return this.createAgent(name);
    }

    // List all agents
    async listAgents() {
        const response = await fetch(`${this.url}/v1/agents/`);
        return response.json();
    }

    // Main interface for mindcraft - sendRequest
    async sendRequest(turns, systemMessage) {
        // Ensure we have an agent
        if (!this.agentId) {
            const agentName =
                this.params.agent_name || `mindcraft-bot-${Date.now()}`;
            await this.getOrCreateAgent(agentName);
        }

        // Format turns using mindcraft's strictFormat
        const messages = strictFormat(turns);

        // Include system message as first user message if provided
        const lettaMessages = [];
        if (systemMessage && messages.length > 0) {
            // Prepend system context to first user message
            const firstMsg = messages[0];
            if (firstMsg.role === "user") {
                lettaMessages.push({
                    role: "user",
                    content: `[System Context]\n${systemMessage}\n\n[User Message]\n${firstMsg.content}`,
                });
                // Add remaining messages
                for (let i = 1; i < messages.length; i++) {
                    lettaMessages.push({
                        role: messages[i].role,
                        content: messages[i].content,
                    });
                }
            } else {
                lettaMessages.push(...messages);
            }
        } else {
            lettaMessages.push(...messages);
        }

        let res = null;
        try {
            console.log(`[Letta] Awaiting response from ${this.model_name}...`);

            const response = await fetch(
                `${this.url}/v1/agents/${this.agentId}/messages`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ messages: lettaMessages }),
                },
            );

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Letta API error: ${error}`);
            }

            const data = await response.json();

            // Extract assistant message
            const assistantMsg = data.messages?.find(
                (m) => m.message_type === "assistant_message",
            );
            res = assistantMsg?.content || "No response from Letta.";

            console.log("[Letta] Received response.");
        } catch (err) {
            console.error("[Letta] Error:", err);
            res = "My brain disconnected, try again.";
        }

        return res;
    }

    /**
     * Initialize the local embedding model (singleton pattern)
     * Skip if using Letta's server-side embeddings (letta/*)
     */
    async initEmbedding() {
        // Letta handles embeddings server-side for letta/* models
        if (this.embeddingModel.startsWith('letta/')) {
            console.log(`[Letta] Embeddings handled by Letta server: ${this.embeddingModel}`);
            this.embedder = 'letta-server';
            return;
        }

        if (this.embedder) return;

        if (this.embeddingInitializing) {
            return this.embeddingInitPromise;
        }

        this.embeddingInitializing = true;
        this.embeddingInitPromise = (async () => {
            try {
                console.log(`[Letta] Loading embedding model ${this.embeddingModel}...`);
                const startTime = Date.now();
                this.embedder = await pipeline("feature-extraction", this.embeddingModel);
                const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Letta] Embedding model loaded in ${loadTime}s`);
            } catch (error) {
                console.error("[Letta] Failed to load embedding model:", error);
                this.embeddingInitializing = false;
                this.embeddingInitPromise = null;
                throw error;
            }
            this.embeddingInitializing = false;
        })();

        return this.embeddingInitPromise;
    }

    /**
     * Generate embedding for text using local multilingual model
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} Embedding vector (384 dimensions)
     */
    async embed(text) {
        await this.initEmbedding();

        // Check cache first
        if (this.embeddingCache.has(text)) {
            return this.embeddingCache.get(text);
        }

        // For E5 models, prefix with "query: " for better retrieval
        const prefixedText = text.startsWith("query:") || text.startsWith("passage:")
            ? text
            : `query: ${text}`;

        // Generate embedding
        const output = await this.embedder(prefixedText, {
            pooling: "mean",
            normalize: true,
        });

        const embedding = Array.from(output.data);

        // Add to cache with LRU eviction
        if (this.embeddingCache.size >= this.maxCacheSize) {
            const firstKey = this.embeddingCache.keys().next().value;
            this.embeddingCache.delete(firstKey);
        }
        this.embeddingCache.set(text, embedding);

        return embedding;
    }

    /**
     * Find most similar text in a collection
     * @param {string} query - Query text
     * @param {string[]} candidates - Candidate texts to search
     * @param {number} topK - Number of top results
     * @returns {Promise<Array<{text: string, similarity: number}>>}
     */
    async findSimilar(query, candidates, topK = 1) {
        if (candidates.length === 0) return [];

        const queryEmbedding = await this.embed(query);
        const candidateEmbeddings = await Promise.all(
            candidates.map((c) => this.embed(`passage: ${c}`))
        );

        const similarities = candidates.map((text, idx) => ({
            text,
            similarity: cosineSimilarity(queryEmbedding, candidateEmbeddings[idx]),
        }));

        similarities.sort((a, b) => b.similarity - a.similarity);
        return similarities.slice(0, topK);
    }

    // Delete current agent
    async deleteAgent() {
        if (!this.agentId) return false;

        const response = await fetch(`${this.url}/v1/agents/${this.agentId}`, {
            method: "DELETE",
        });

        if (response.ok) {
            this.agentId = null;
            this.agentName = null;
        }

        return response.ok;
    }

    /**
     * Store an event memory in Letta's archival memory
     * @param {string} eventType - Type of event (death, player_join, player_leave, inventory, location)
     * @param {string} description - Human-readable description of the event
     * @param {Object} data - Additional event data
     * @param {string} userId - User ID to associate with (default: 'system')
     */
    async storeEventMemory(eventType, description, data = {}, userId = 'system') {
        if (!this.agentId) return;

        try {
            const timestamp = new Date().toISOString();
            const memoryContent = `[${eventType.toUpperCase()}] [${timestamp}] ${description}`;

            // Store in Letta's archival memory
            const response = await fetch(
                `${this.url}/v1/agents/${this.agentId}/archival`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        content: memoryContent,
                        metadata: {
                            event_type: eventType,
                            user_id: userId,
                            timestamp: timestamp,
                            ...data
                        }
                    }),
                }
            );

            if (response.ok) {
                console.log(`[Letta] Event stored: ${eventType} - ${description}`);
            } else {
                const error = await response.text();
                console.warn(`[Letta] Event memory failed: ${error}`);
            }
        } catch (err) {
            console.warn(`[Letta] Event memory failed: ${err.message}`);
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

    async close() {
        // Nothing to close
    }
}
