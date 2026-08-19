/**
 * GitHub Copilot + Claude + Mem0 integration for Mindcraft
 *
 * Uses GitHub Copilot API (OpenAI-compatible) with Mem0 cloud memory.
 * Reads the session token from openclaw's credential file (~/.openclaw/credentials/github-copilot.token.json)
 * and falls back to exchanging GITHUB_TOKEN PAT for a fresh session token when expired.
 *
 * Setup:
 *   1. Ensure openclaw is authenticated (token file exists) OR add GITHUB_TOKEN to keys.json
 *   2. Add MEM0_API_KEY to keys.json
 *   3. Profile config: {"api": "copilot-mem0", "model": "claude-sonnet-4.5"}
 *
 * Available models: claude-sonnet-4.5, claude-opus-4.5, claude-opus-4.6, claude-haiku-4.5,
 *                   gpt-5, gpt-5-mini, gpt-4o, gemini-3-flash-preview, gemini-3-pro-preview
 *
 * Tiered routing: set model to "tiered" to let haiku auto-select the right model per request.
 *   simple  → claude-haiku-4.5   (greetings, status, basic info, follow/stop)
 *   medium  → claude-sonnet-4.5  (crafting, mining, navigation, small builds)
 *   hard    → claude-opus-4.5    (large builds, multi-step planning, complex strategies)
 * Override tiers via params: tier_simple, tier_medium, tier_hard, tier_router
 */

import OpenAIApi from 'openai';
import { MemoryClient } from 'mem0ai';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

const OPENCLAW_TOKEN_FILE = `${homedir()}/.openclaw/credentials/github-copilot.token.json`;
const COPILOT_HEADERS = {
    'Editor-Version': 'vscode/1.95.0',
    'Editor-Plugin-Version': 'copilot-chat/0.22.4',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilotChat/0.22.4',
};

const TIER_DEFAULTS = {
    router: 'claude-haiku-4.5',
    simple: 'claude-haiku-4.5',
    medium: 'claude-sonnet-4.5',
    hard:   'claude-opus-4.5',
};

const ROUTER_SYSTEM = `You are a task complexity classifier for a Minecraft bot.
Classify the incoming task as ONE word only: simple, medium, or hard.

simple: greetings, status checks, basic questions, yes/no, follow me, stop, what are you doing
medium: crafting items, mining resources, navigation, small builds (<20 blocks), inventory management, farming
hard:   large structures (>20 blocks), multi-step plans, complex strategies, coding tasks, simultaneous goals

Reply with exactly one word: simple, medium, or hard`;



export class CopilotMem0 {
    static prefix = 'copilot-mem0';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'claude-sonnet-4.5';
        this.params = params || {};
        this.agent_id = params?.agent_name || 'andy';

        // Tiered routing config (only active when model_name === 'tiered')
        this.tiers = {
            router: params?.tier_router || TIER_DEFAULTS.router,
            simple: params?.tier_simple || TIER_DEFAULTS.simple,
            medium: params?.tier_medium || TIER_DEFAULTS.medium,
            hard:   params?.tier_hard   || TIER_DEFAULTS.hard,
        };

        // GitHub Copilot token cache
        this._copilotToken = null;
        this._tokenExpiry = null;

        // GitHub PAT fallback for token exchange (when openclaw token is expired)
        const githubToken = process.env.GITHUB_TOKEN || (hasKey('GITHUB_TOKEN') ? getKey('GITHUB_TOKEN') : null);
        this._githubToken = githubToken;
        this._baseUrl = url || 'https://api.githubcopilot.com';

        // Mem0 cloud memory
        const mem0Key = process.env.MEM0_API_KEY || (hasKey('MEM0_API_KEY') ? getKey('MEM0_API_KEY') : null);
        if (!mem0Key) {
            console.warn('[CopilotMem0] MEM0_API_KEY not found. Memory disabled.');
            this.memory = null;
        } else {
            this.memory = new MemoryClient({ apiKey: mem0Key });
            console.log('[CopilotMem0] Mem0 client initialized');
        }

        console.log(`[CopilotMem0] Initialized with model: ${this.model_name}`);
    }

    /**
     * Get a valid Copilot session token.
     * Priority: 1) openclaw credential file  2) cached token  3) exchange GITHUB_TOKEN PAT
     */
    async _getToken() {
        const now = Date.now();

        // 1. Try openclaw's credential file first (refreshed by openclaw automatically)
        try {
            const raw = readFileSync(OPENCLAW_TOKEN_FILE, 'utf8');
            const cred = JSON.parse(raw);
            if (cred.token && cred.expiresAt && now < cred.expiresAt - 60_000) {
                return cred.token;
            }
        } catch (_) {
            // file not present — fall through
        }

        // 2. Return cached token if still valid
        if (this._copilotToken && this._tokenExpiry && now < this._tokenExpiry - 60_000) {
            return this._copilotToken;
        }

        // 3. Exchange GitHub PAT for a fresh session token
        if (!this._githubToken) throw new Error('No valid Copilot token: set GITHUB_TOKEN in keys.json or run openclaw auth');

        const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
            headers: {
                'Authorization': `token ${this._githubToken}`,
                'Accept': 'application/json',
                ...COPILOT_HEADERS,
            },
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Copilot token exchange failed (${resp.status}): ${body}`);
        }

        const data = await resp.json();
        this._copilotToken = data.token;
        this._tokenExpiry = (data.expires_at || (Date.now() / 1000 + 1800)) * 1000;
        console.log('[CopilotMem0] Copilot session token refreshed via PAT exchange');
        return this._copilotToken;
    }

    /**
     * Create an OpenAI client pointed at the Copilot endpoint with a fresh token.
     */
    async _getClient() {
        const token = await this._getToken();
        return new OpenAIApi({
            baseURL: this._baseUrl,
            apiKey: token,
            defaultHeaders: COPILOT_HEADERS,
        });
    }

    /**
     * Ask haiku to classify the task complexity.
     * Returns 'simple' | 'medium' | 'hard'
     */
    async _classifyTask(userContent) {
        try {
            const client = await this._getClient();
            const response = await client.chat.completions.create({
                model: this.tiers.router,
                messages: [
                    { role: 'system', content: ROUTER_SYSTEM },
                    { role: 'user',   content: userContent },
                ],
                max_tokens: 5,
                temperature: 0,
            });
            const tier = response.choices?.[0]?.message?.content?.trim().toLowerCase();
            if (tier === 'simple' || tier === 'medium' || tier === 'hard') return tier;
            return 'medium'; // safe fallback
        } catch (err) {
            console.warn(`[CopilotMem0] Router error: ${err.message} — falling back to medium`);
            return 'medium';
        }
    }

    async sendRequest(turns, systemMessage) {
        const lastUserMsg = turns.filter(t => t.role === 'user').pop();
        let userId = 'default';
        let userContent = lastUserMsg?.content || '';

        if (userContent) {
            const match = userContent.match(/^([^:]+):/);
            if (match) userId = match[1].trim();
        }

        const formattedTurns = strictFormat(turns).map(({ name, ...rest }) => rest);

        // Retrieve relevant Mem0 memories (user + shared system memories)
        let memoriesStr = '';
        if (this.memory && userContent.trim()) {
            try {
                const [userMems, sysMems] = await Promise.all([
                    this.memory.search(userContent, { user_id: userId }),
                    userId !== 'system'
                        ? this.memory.search(userContent, { user_id: 'system' })
                        : Promise.resolve([]),
                ]);

                const all = [
                    ...(userMems.results || userMems || []),
                    ...(sysMems.results  || sysMems  || []),
                ];
                const seen = new Set();
                const unique = all.filter(m => !seen.has(m.memory) && seen.add(m.memory));

                if (unique.length > 0) {
                    memoriesStr = '\n\nUser Memories:\n' + unique.map(m => {
                        const cat = m.categories?.[0] || 'general';
                        return `- [${cat}] ${m.memory}`;
                    }).join('\n');
                    console.log(`[CopilotMem0] Found ${unique.length} memories for ${userId}`);
                }
            } catch (err) {
                console.warn(`[CopilotMem0] Memory search failed: ${err.message}`);
            }
        }

        // Tier routing: classify task with haiku, then pick model
        let selectedModel = this.model_name;
        if (this.model_name === 'tiered') {
            if (userContent.trim()) {
                const tier = await this._classifyTask(userContent);
                selectedModel = this.tiers[tier];
                console.log(`[CopilotMem0] Tier: ${tier} → ${selectedModel}`);
            } else {
                selectedModel = this.tiers.simple; // system/empty messages are always simple
            }
        }

        const startTime = Date.now();
        let assistantResponse = '';

        try {
            const client = await this._getClient();

            const reqParams = { ...this.params };
            delete reqParams.agent_name;
            delete reqParams.embedding_model;
            delete reqParams.tier_router;
            delete reqParams.tier_simple;
            delete reqParams.tier_medium;
            delete reqParams.tier_hard;

            const messages = [
                { role: 'system', content: systemMessage + memoriesStr },
                ...formattedTurns,
            ];

            console.log(`[CopilotMem0] Awaiting ${selectedModel} response...`);
            const response = await client.chat.completions.create({
                model: selectedModel,
                messages,
                max_tokens: reqParams.max_tokens || 4096,
                ...reqParams,
            });

            assistantResponse = response.choices?.[0]?.message?.content || '';
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[CopilotMem0] Response received (${elapsed}s)`);

        } catch (err) {
            if (err.status === 401) {
                // Force token refresh on next call
                this._copilotToken = null;
                console.warn('[CopilotMem0] Auth error — token will refresh on next request');
            }
            console.error('[CopilotMem0] Error:', err.message);
            return 'My brain disconnected, try again.';
        }

        // Store conversation exchange in Mem0
        if (this.memory && userContent.trim() && assistantResponse.trim()) {
            try {
                const result = await this.memory.add([
                    { role: 'user',      content: userContent },
                    { role: 'assistant', content: assistantResponse },
                ], { user_id: userId });

                const stored = Array.isArray(result) ? result : (result?.results || []);
                if (stored.length > 0) {
                    const cats = stored.map(m => m.categories?.[0] || 'general').join(', ');
                    console.log(`[CopilotMem0] Stored ${stored.length} memory(s) for ${userId} [${cats}]`);
                }
            } catch (err) {
                console.warn(`[CopilotMem0] Memory store failed: ${err.message}`);
            }
        }

        return assistantResponse;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` },
                },
            ],
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    // ── Event memory methods (same interface as Mem0Local) ──────────────────

    async storeEventMemory(eventType, description, data = {}, userId = 'system') {
        if (!this.memory) return;
        try {
            const result = await this.memory.add([
                { role: 'user',      content: `[${eventType.toUpperCase()}] ${description}` },
                { role: 'assistant', content: 'Noted. I will remember this.' },
            ], {
                user_id: userId,
                metadata: { event_type: eventType, timestamp: new Date().toISOString(), ...data },
            });
            const stored = Array.isArray(result) ? result : (result?.results || []);
            if (stored.length > 0) console.log(`[CopilotMem0] Event stored: ${eventType} - ${description}`);
        } catch (err) {
            console.warn(`[CopilotMem0] Event memory failed: ${err.message}`);
        }
    }

    async recordDeath(location, cause = 'unknown') {
        const { x, y, z } = location;
        await this.storeEventMemory(
            'death',
            `Bot died at x:${Math.round(x)} y:${Math.round(y)} z:${Math.round(z)}. Cause: ${cause}`,
            { location: { x, y, z }, cause }
        );
    }

    async recordPlayerJoin(playerName) {
        await this.storeEventMemory('player_join', `${playerName} joined the game`, { player: playerName }, playerName);
    }

    async recordPlayerLeave(playerName) {
        await this.storeEventMemory('player_leave', `${playerName} left the game`, { player: playerName }, playerName);
    }

    async recordImportantLocation(name, location, description = '') {
        const { x, y, z } = location;
        await this.storeEventMemory(
            'location',
            `Important location "${name}" at x:${Math.round(x)} y:${Math.round(y)} z:${Math.round(z)}. ${description}`,
            { name, location: { x, y, z }, description }
        );
    }

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

    async close() {}
}
