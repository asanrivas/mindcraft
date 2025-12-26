/**
 * Lightweight Mem0-inspired memory layer for Mindcraft
 * Uses Redis + local embeddings for fast semantic memory search
 * Compatible with Azure Foundry Claude
 */

import { createClient } from 'redis';
import { pipeline } from '@huggingface/transformers';
import { cosineSimilarity } from '../utils/math.js';
import crypto from 'crypto';
import { strictFormat } from '../utils/text.js';
import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { getKey } from '../utils/keys.js';

export class Mem0Local {
    static prefix = 'mem0';

    constructor(model_name, url, params) {
        this.model_name = model_name; // Azure Foundry model for generation
        this.url = url; // Azure Foundry URL
        this.params = params || {};
        this.agent_id = params.agent_name || 'andy';

        // Redis configuration
        this.redis = null;
        this.redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

        // Embedding configuration
        this.embeddingModel = params.embedding_model || 'Xenova/multilingual-e5-small';
        this.embedder = null;
        this.embeddingDim = 384;

        // Memory namespace
        this.memoryPrefix = `mem0:${this.agent_id}:`;

        // Azure Foundry client
        this.foundryClient = null;
        this.initFoundry(url);
    }

    /**
     * Initialize Azure Foundry client
     */
    initFoundry(url) {
        let config = {};

        // Extract resource name from URL
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
        if (config.resource) {
            console.log(`  resource: ${config.resource}`);
        }
        console.log(`  model: ${this.model_name}`);
    }

    /**
     * Initialize Redis and embeddings
     */
    async init() {
        // Connect to Redis
        if (!this.redis) {
            console.log(`[Mem0] Connecting to Redis at ${this.redisUrl}...`);
            this.redis = createClient({ url: this.redisUrl });
            this.redis.on('error', (err) => console.error('[Mem0] Redis error:', err));
            await this.redis.connect();
            console.log('[Mem0] Redis connected');
        }

        // Initialize embeddings
        if (!this.embedder && this.embeddingModel !== 'disabled') {
            try {
                console.log(`[Mem0] Loading embedding model ${this.embeddingModel}...`);
                const startTime = Date.now();
                this.embedder = await pipeline('feature-extraction', this.embeddingModel, {
                    quantized: true,  // Use quantized model (int8) for lower memory
                    progress_callback: null,  // Disable progress logging
                    dtype: 'q8',  // 8-bit quantization
                });
                const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[Mem0] Embedding model loaded in ${loadTime}s (quantized)`);
            } catch (err) {
                console.warn(`[Mem0] Failed to load embeddings, disabling semantic search:`, err.message);
                this.embeddingModel = 'disabled';
                this.embedder = null;
            }
        }
    }

    /**
     * Generate embedding for text
     */
    async embed(text) {
        await this.init();

        if (!this.embedder || this.embeddingModel === 'disabled') {
            return null;  // No embeddings available
        }

        const prefixedText = text.startsWith('query:') || text.startsWith('passage:')
            ? text
            : `passage: ${text}`;

        const output = await this.embedder(prefixedText, {
            pooling: 'mean',
            normalize: true,
        });

        return Array.from(output.data);
    }

    /**
     * Add a memory
     * @param {string} content - Memory content
     * @param {Object} options - {user_id, category, metadata, ttl}
     * @returns {Promise<string>} Memory ID
     */
    async addMemory(content, options = {}) {
        await this.init();

        const memoryId = `mem_${crypto.randomBytes(8).toString('hex')}`;
        const timestamp = Date.now();

        // Generate embedding (if available)
        const embedding = await this.embed(content);

        const memory = {
            id: memoryId,
            agent_id: this.agent_id,
            user_id: options.user_id || 'default',
            content,
            embedding: embedding || [],  // Empty array if embeddings disabled
            category: options.category || 'general',
            metadata: options.metadata || {},
            timestamp,
        };

        // Store in Redis
        const key = this.memoryPrefix + memoryId;
        await this.redis.set(key, JSON.stringify(memory));

        // Set TTL if provided (in seconds)
        if (options.ttl) {
            await this.redis.expire(key, options.ttl);
        }

        // Add to user index
        await this.redis.sAdd(`${this.memoryPrefix}users:${memory.user_id}`, memoryId);

        console.log(`[Mem0] Added memory: ${memoryId} for user ${memory.user_id}`);
        return memoryId;
    }

    /**
     * Search memories by semantic similarity (or recent if embeddings disabled)
     * @param {string} query - Search query
     * @param {Object} options - {user_id, category, limit}
     * @returns {Promise<Array>} Matching memories with similarity scores
     */
    async searchMemories(query, options = {}) {
        await this.init();

        const limit = options.limit || 5;
        const userId = options.user_id || 'default';

        // Get all memory keys for user
        const memoryIds = await this.redis.sMembers(`${this.memoryPrefix}users:${userId}`);

        if (memoryIds.length === 0) {
            return [];
        }

        // Fetch all memories
        const memories = await Promise.all(
            memoryIds.map(async (id) => {
                const data = await this.redis.get(this.memoryPrefix + id);
                return data ? JSON.parse(data) : null;
            })
        );

        // Filter by category if specified
        let filteredMemories = memories.filter((m) => m !== null);
        if (options.category) {
            filteredMemories = filteredMemories.filter((m) => m.category === options.category);
        }

        // If embeddings disabled, return recent memories
        if (!this.embedder || this.embeddingModel === 'disabled') {
            console.log('[Mem0] Embeddings disabled, returning recent memories');
            filteredMemories.sort((a, b) => b.timestamp - a.timestamp);
            return filteredMemories.slice(0, limit).map((m) => ({
                ...m,
                similarity: 1.0,  // All equally "relevant" without semantic search
            }));
        }

        // Otherwise, calculate semantic similarities
        const queryEmbedding = await this.embed(`query: ${query}`);
        if (!queryEmbedding) {
            // Fallback if embedding fails
            filteredMemories.sort((a, b) => b.timestamp - a.timestamp);
            return filteredMemories.slice(0, limit).map((m) => ({
                ...m,
                similarity: 1.0,
            }));
        }

        const results = filteredMemories.map((memory) => ({
            ...memory,
            similarity: cosineSimilarity(queryEmbedding, memory.embedding),
        }));

        // Sort by similarity and limit
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
    }

    /**
     * List all memories for a user
     * @param {string} user_id - User ID
     * @param {Object} options - {category, limit}
     * @returns {Promise<Array>} Memories
     */
    async listMemories(user_id = 'default', options = {}) {
        await this.init();

        const memoryIds = await this.redis.sMembers(`${this.memoryPrefix}users:${user_id}`);

        if (memoryIds.length === 0) {
            return [];
        }

        const memories = await Promise.all(
            memoryIds.map(async (id) => {
                const data = await this.redis.get(this.memoryPrefix + id);
                return data ? JSON.parse(data) : null;
            })
        );

        let filteredMemories = memories.filter((m) => m !== null);

        if (options.category) {
            filteredMemories = filteredMemories.filter((m) => m.category === options.category);
        }

        // Sort by timestamp descending
        filteredMemories.sort((a, b) => b.timestamp - a.timestamp);

        if (options.limit) {
            return filteredMemories.slice(0, options.limit);
        }

        return filteredMemories;
    }

    /**
     * Update a memory
     * @param {string} memoryId - Memory ID
     * @param {Object} updates - {content, category, metadata}
     * @returns {Promise<boolean>} Success
     */
    async updateMemory(memoryId, updates) {
        await this.init();

        const key = this.memoryPrefix + memoryId;
        const data = await this.redis.get(key);

        if (!data) {
            console.warn(`[Mem0] Memory ${memoryId} not found`);
            return false;
        }

        const memory = JSON.parse(data);

        // Update content and re-embed if changed
        if (updates.content && updates.content !== memory.content) {
            memory.content = updates.content;
            memory.embedding = await this.embed(updates.content);
        }

        if (updates.category) memory.category = updates.category;
        if (updates.metadata) memory.metadata = { ...memory.metadata, ...updates.metadata };

        await this.redis.set(key, JSON.stringify(memory));
        console.log(`[Mem0] Updated memory: ${memoryId}`);
        return true;
    }

    /**
     * Delete a memory
     * @param {string} memoryId - Memory ID
     * @returns {Promise<boolean>} Success
     */
    async deleteMemory(memoryId) {
        await this.init();

        const key = this.memoryPrefix + memoryId;
        const data = await this.redis.get(key);

        if (!data) {
            return false;
        }

        const memory = JSON.parse(data);

        // Remove from Redis
        await this.redis.del(key);

        // Remove from user index
        await this.redis.sRem(`${this.memoryPrefix}users:${memory.user_id}`, memoryId);

        console.log(`[Mem0] Deleted memory: ${memoryId}`);
        return true;
    }

    /**
     * Clear all memories for a user
     * @param {string} user_id - User ID
     * @returns {Promise<number>} Number of memories deleted
     */
    async clearMemories(user_id = 'default') {
        await this.init();

        const memoryIds = await this.redis.sMembers(`${this.memoryPrefix}users:${user_id}`);

        for (const id of memoryIds) {
            await this.redis.del(this.memoryPrefix + id);
        }

        await this.redis.del(`${this.memoryPrefix}users:${user_id}`);

        console.log(`[Mem0] Cleared ${memoryIds.length} memories for user ${user_id}`);
        return memoryIds.length;
    }

    /**
     * Main LLM interface for Mindcraft - sendRequest
     * Includes memory context automatically
     */
    async sendRequest(turns, systemMessage) {
        await this.init();

        // Extract user context from turns
        const lastUserMessage = turns.filter((t) => t.role === 'user').pop();
        const userId = lastUserMessage?.name || 'default';

        // Search for relevant memories
        const query = lastUserMessage?.content || '';
        const relevantMemories = await this.searchMemories(query, {
            user_id: userId,
            limit: 3,
        });

        // Build memory context
        let memoryContext = '';
        if (relevantMemories.length > 0) {
            memoryContext = '\n\n[Relevant Memories]\n';
            relevantMemories.forEach((mem, idx) => {
                memoryContext += `${idx + 1}. ${mem.content} (${mem.category}, ${(mem.similarity * 100).toFixed(0)}% relevant)\n`;
            });
        }

        // Augment system message with memory
        const augmentedSystemMessage = systemMessage + memoryContext;

        // Format for Azure Foundry and strip 'name' field (not supported by Anthropic)
        const messages = strictFormat(turns).map((msg) => {
            const { name, ...rest } = msg;
            return rest;
        });

        // Call Azure Foundry
        console.log(`[Mem0] Calling Azure Foundry with ${relevantMemories.length} memories...`);

        try {
            // Set default max_tokens if not provided
            let max_tokens = this.params.max_tokens || 4096;

            // Filter out unwanted params
            const requestParams = { ...this.params };
            delete requestParams.agent_name;
            delete requestParams.embedding_model;
            requestParams.max_tokens = max_tokens;

            const resp = await this.foundryClient.messages.create({
                model: this.model_name,
                system: augmentedSystemMessage,
                messages: messages,
                ...requestParams,
            });

            console.log('[Mem0] Received response from Azure Foundry');

            const textContent = resp.content.find((content) => content.type === 'text');
            if (textContent) {
                return textContent.text;
            } else {
                console.warn('[Mem0] No text content found in response');
                return 'No response from Foundry.';
            }
        } catch (err) {
            console.error('[Mem0] Error:', err);
            return 'My brain disconnected, try again.';
        }
    }

    /**
     * Cleanup resources
     */
    async close() {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
    }
}
