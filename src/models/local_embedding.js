import { pipeline } from '@huggingface/transformers';
import { cosineSimilarity } from '../utils/math.js';

/**
 * Local embedding provider using Transformers.js
 * Runs entirely offline, no API calls needed
 */
export class LocalEmbedding {
    static prefix = 'local-embed';
    
    constructor(model_name, url, params) {
        this.model_name = model_name || 'Xenova/gte-small'; // Optimized for older CPUs
        this.embedder = null;
        this.initializing = false;
        this.initPromise = null;
        
        // LRU cache with max size (500 entries ~2MB for 384-dim embeddings)
        this.cache = new Map();
        this.maxCacheSize = 500;
        
        // Persistent cache path
        this.cachePath = null; // Will be set if needed
    }
    
    /**
     * Initialize the embedding model (singleton pattern)
     * Only loads once, reuses across all requests
     */
    async init() {
        if (this.embedder) return; // Already initialized
        
        if (this.initializing) {
            // Wait for ongoing initialization
            return this.initPromise;
        }
        
        this.initializing = true;
        this.initPromise = (async () => {
            try {
                console.log(`[LocalEmbedding] Loading model ${this.model_name} (first time takes 3-5s)...`);
                const startTime = Date.now();
                this.embedder = await pipeline('feature-extraction', this.model_name);
                const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[LocalEmbedding] Model loaded in ${loadTime}s`);
            } catch (error) {
                console.error('[LocalEmbedding] Failed to load model:', error);
                this.initializing = false;
                this.initPromise = null;
                throw error;
            }
            this.initializing = false;
        })();
        
        return this.initPromise;
    }
    
    /**
     * Generate embedding for text
     * @param {string} text - Text to embed
     * @returns {Promise<number[]>} Embedding vector
     */
    async embed(text) {
        await this.init();
        
        // Check cache first
        if (this.cache.has(text)) {
            return this.cache.get(text);
        }
        
        // Generate embedding
        const output = await this.embedder(text, { 
            pooling: 'mean',      // Average token embeddings
            normalize: true       // Normalize to unit length
        });
        
        // Convert to array
        const embedding = Array.from(output.data);
        
        // Add to cache with LRU eviction
        this._addToCache(text, embedding);
        
        return embedding;
    }
    
    /**
     * Batch embed multiple texts (more efficient)
     * @param {string[]} texts - Array of texts to embed
     * @returns {Promise<number[][]>} Array of embedding vectors
     */
    async embedBatch(texts) {
        await this.init();
        
        // Separate cached and uncached texts
        const uncached = [];
        const cached = [];
        const indices = [];
        
        texts.forEach((text, idx) => {
            if (this.cache.has(text)) {
                cached.push(this.cache.get(text));
                indices.push({ idx, cached: true });
            } else {
                uncached.push(text);
                indices.push({ idx, cached: false, textIdx: uncached.length - 1 });
            }
        });
        
        // Embed uncached texts
        const uncachedEmbeddings = uncached.length > 0 
            ? await Promise.all(uncached.map(text => this.embed(text)))
            : [];
        
        // Reconstruct in original order
        const results = [];
        let uncachedIdx = 0;
        for (const item of indices) {
            if (item.cached) {
                results.push(cached.shift());
            } else {
                results.push(uncachedEmbeddings[uncachedIdx++]);
            }
        }
        
        return results;
    }
    
    /**
     * Find most similar text in a collection
     * @param {string} query - Query text
     * @param {string[]} candidates - Candidate texts to search
     * @param {number} topK - Number of top results to return
     * @returns {Promise<Array<{text: string, similarity: number}>>}
     */
    async findSimilar(query, candidates, topK = 1) {
        if (candidates.length === 0) return [];
        
        const queryEmbedding = await this.embed(query);
        const candidateEmbeddings = await this.embedBatch(candidates);
        
        const similarities = candidates.map((text, idx) => ({
            text,
            similarity: cosineSimilarity(queryEmbedding, candidateEmbeddings[idx])
        }));
        
        // Sort by similarity descending
        similarities.sort((a, b) => b.similarity - a.similarity);
        
        return similarities.slice(0, topK);
    }
    
    /**
     * Add to cache with LRU eviction
     * @private
     */
    _addToCache(text, embedding) {
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxCacheSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(text, embedding);
    }
    
    /**
     * Clear the cache
     */
    clearCache() {
        this.cache.clear();
    }
    
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            memoryEstimate: this.cache.size * 384 * 4 // 384 dims * 4 bytes per float
        };
    }
}

