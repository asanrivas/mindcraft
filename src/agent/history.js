import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { LocalEmbedding } from '../models/local_embedding.js';
import { cosineSimilarity } from '../utils/math.js';
import { getNamedChestsJson } from './library/skills.js';
import { getBudget } from '../utils/context_budget.js';

/**
 * Clean up old log files, keeping only the most recent ones
 * @param {string} dirPath - Directory path to clean
 * @param {number} keepCount - Number of files to keep (default: 20)
 * @param {string} extension - File extension to filter (optional, e.g., '.json', '.txt')
 */
function cleanupOldLogs(dirPath, keepCount = 20, extension = null) {
    try {
        if (!existsSync(dirPath)) return;

        let files = readdirSync(dirPath)
            .filter(f => {
                const filePath = `${dirPath}/${f}`;
                // Only process files, not directories
                try {
                    return statSync(filePath).isFile() && (!extension || f.endsWith(extension));
                } catch {
                    return false;
                }
            })
            .map(f => ({
                name: f,
                path: `${dirPath}/${f}`,
                mtime: statSync(`${dirPath}/${f}`).mtime.getTime()
            }))
            .sort((a, b) => b.mtime - a.mtime); // Sort by modification time, newest first

        // Delete files beyond keepCount
        if (files.length > keepCount) {
            const toDelete = files.slice(keepCount);
            for (const file of toDelete) {
                try {
                    unlinkSync(file.path);
                    console.log(`[Cleanup] Deleted old log: ${file.name}`);
                } catch (err) {
                    console.warn(`[Cleanup] Failed to delete ${file.name}: ${err.message}`);
                }
            }
            console.log(`[Cleanup] Removed ${toDelete.length} old log file(s) from ${dirPath}`);
        }
    } catch (err) {
        console.warn(`[Cleanup] Error cleaning up logs in ${dirPath}: ${err.message}`);
    }
}


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory.
        // Scaled from the model's context window unless explicitly configured.
        const budget = getBudget();
        this.max_messages = (settings.max_messages === 'auto' || !settings.max_messages)
            ? budget.max_messages : settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = budget.summary_chunk_size;

        // Turns waiting to be distilled into memory. Consolidation is an extra LLM call, so
        // it is deferred to the idle loop instead of blocking a reply (see IdleBehavior).
        this.pending_summary = [];
        this.consolidating = false;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);
        this.memory = stripGroundedFacts(this.memory);

        const memory_cap = getBudget().memory_chars;
        if (this.memory.length > memory_cap) {
            this.memory = this.memory.slice(0, memory_cap);
            this.memory += '...(truncated, compress more next time)';
        }

        console.log("Memory updated to: ", this.memory);

        // Store embedding for semantic search
        if (this.embedder && this.memory.trim().length > 0) {
            try {
                const embedding = await this.embedder.embed(this.memory);
                this.memoryEmbeddings.push({
                    text: this.memory,
                    embedding: embedding,
                    timestamp: Date.now()
                });

                // Keep only last 50 memory embeddings to limit memory usage
                if (this.memoryEmbeddings.length > 50) {
                    this.memoryEmbeddings.shift();
                }
            } catch (error) {
                console.warn('[History] Failed to create memory embedding:', error.message);
            }
        }
    }

    /**
     * Distill any queued turns into memory. Safe to call repeatedly; no-ops when the queue is
     * empty or a consolidation is already running.
     * @returns {Promise<boolean>} whether work was done.
     */
    async consolidatePending() {
        if (this.consolidating || this.pending_summary.length === 0) return false;
        this.consolidating = true;
        const chunk = this.pending_summary;
        this.pending_summary = [];
        try {
            await this.summarizeMemories(chunk);
            await this.save();
            return true;
        } catch (err) {
            console.warn('[History] Consolidation failed:', err.message);
            return false;
        } finally {
            this.consolidating = false;
        }
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');

            // Cleanup old history files, keep only 20 most recent
            cleanupOldLogs(`./bots/${this.name}/histories`, 20, '.json');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            // Check if memory saving is disabled (e.g., when using Letta which has its own memory)
            const useMemorySaving = this.agent.prompter?.profile?.use_memory_saving !== false;
            if (useMemorySaving) {
                this.pending_summary.push(...chunk);
                // Safety valve: if the bot never goes idle, don't let the backlog grow
                // unbounded - fall back to consolidating inline.
                if (this.pending_summary.length >= this.summary_chunk_size * 4) {
                    await this.consolidatePending();
                }
            } else {
                console.log("[History] Memory saving disabled (external memory system in use)");
            }
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                saved_places: this.agent.memory_bank.getJson(),
                named_chests: getNamedChestsJson()
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            // Load saved places if available
            if (data.saved_places && this.agent.memory_bank) {
                this.agent.memory_bank.loadJson(data.saved_places);
                console.log('Loaded saved places:', Object.keys(data.saved_places).join(', ') || 'none');
            }
            // Named chests are now loaded in agent.js (they persist independently of load_memory setting)
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
        this.memoryEmbeddings = [];
    }

    /**
     * Search memories semantically using local embeddings
     * @param {string} query - Search query
     * @param {number} topK - Number of results to return (default: 3)
     * @param {number} minSimilarity - Minimum similarity threshold (default: 0.6)
     * @returns {Promise<Array<{text: string, similarity: number, timestamp: number}>>}
     */
    async searchMemory(query, topK = 3, minSimilarity = 0.6) {
        if (!this.embedder || this.memoryEmbeddings.length === 0) {
            return [];
        }

        try {
            const queryEmbedding = await this.embedder.embed(query);
            const results = [];

            for (const mem of this.memoryEmbeddings) {
                const similarity = cosineSimilarity(queryEmbedding, mem.embedding);
                if (similarity >= minSimilarity) {
                    results.push({
                        text: mem.text,
                        similarity: similarity,
                        timestamp: mem.timestamp
                    });
                }
            }

            // Sort by similarity descending
            results.sort((a, b) => b.similarity - a.similarity);

            return results.slice(0, topK);
        } catch (error) {
            console.warn('[History] Failed to search memory:', error.message);
            return [];
        }
    }

    /**
     * Get relevant memories for a query (formatted for prompt inclusion)
     * @param {string} query - Search query
     * @param {number} topK - Number of memories to retrieve
     * @returns {Promise<string>} Formatted memory string for prompts
     */
    async getRelevantMemories(query, topK = 3) {
        const results = await this.searchMemory(query, topK, 0.6);
        if (results.length === 0) {
            return '';
        }

        let formatted = 'Relevant memories:\n';
        for (let i = 0; i < results.length; i++) {
            formatted += `${i + 1}. ${results[i].text} (relevance: ${(results[i].similarity * 100).toFixed(0)}%)\n`;
        }
        return formatted;
    }
}

/**
 * Remove claims the model is not entitled to make in persistent memory.
 *
 * Command syntax is machine-derived from the command registry and injected every turn via
 * $COMMAND_DOCS. When the model also writes its *own* version of that syntax into memory,
 * the note is re-read and re-summarised each cycle, degrading a little each time - observed
 * live: the real signature !fill(blockType, x1, z1, x2, z2, y, height) decayed into
 * "!fill X1 Y1 Z1 X2 Y2 Z2 material" and then into "requires exactly 6 arguments", after
 * which the bot confidently acted on its own corrupted note.
 *
 * Dropping these lines makes that failure structurally impossible: the only syntax the model
 * ever sees is the generated one.
 * @param {string} memory
 * @returns {string}
 */
function stripGroundedFacts(memory) {
    if (!memory) return memory;
    const isSyntaxClaim = (line) => {
        const l = line.toLowerCase();
        const mentionsCallShape = /\b(arg|args|argument|parameter|param|syntax|format|signature)\w*\b/.test(l);
        if (!mentionsCallShape) return false;
        // Only strip when it is actually talking about how to CALL something: either it
        // names a command, or it quantifies the call shape ("uses 6 args", "requires 6-7").
        // Plain coordinates/counts elsewhere are left alone.
        return /!\w+/.test(line) || /\d/.test(l);
    };
    const kept = memory.split('\n').filter(line => !isSyntaxClaim(line));
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
