import { LocalEmbedding } from '../models/local_embedding.js';
import { cosineSimilarity } from '../utils/math.js';
import settings from './settings.js';

/**
 * Local classifier for intent matching and simple request classification
 * Uses local embeddings to match natural language to commands without LLM calls
 */
export class LocalClassifier {
    constructor(embeddingModel) {
        this.embedder = embeddingModel || new LocalEmbedding();
        this.threshold = settings.local_intent_threshold || 0.75;
        this.initialized = false;
        this.initPromise = null;
        
        // Command intent mappings - natural language phrases that map to commands
        this.commandIntents = {
            '!collectBlocks': [
                'collect blocks', 'gather resources', 'mine blocks', 'collect wood', 'collect stone',
                'gather materials', 'pick up blocks', 'get blocks', 'harvest blocks', 'collect logs',
                'mine ore', 'gather items', 'collect cobblestone', 'get wood', 'get stone'
            ],
            '!craftRecipe': [
                'craft item', 'make item', 'create item', 'craft tool', 'build item', 'make tool',
                'craft weapon', 'make weapon', 'craft armor', 'make armor', 'craft recipe', 'create recipe'
            ],
            '!goToPlayer': [
                'go to player', 'follow player', 'come here', 'come to me', 'go to me', 'find player',
                'locate player', 'reach player', 'move to player'
            ],
            '!followPlayer': [
                'follow me', 'follow player', 'stay with me', 'come along', 'follow along', 'tag along',
                'follow', 'come with me', 'walk with me', 'stay close', 'keep up', 'follow you'
            ],
            '!equip': [
                'equip item', 'use item', 'hold item', 'wield item', 'put on item', 'wear item',
                'switch to item', 'select item', 'pick up item'
            ],
            '!consume': [
                'eat food', 'consume food', 'eat item', 'have food', 'eat something', 'feed yourself',
                'eat', 'consume', 'drink', 'heal yourself'
            ],
            '!putInChest': [
                'put in chest', 'store in chest', 'deposit in chest', 'place in chest', 'store items',
                'put away', 'store away', 'deposit items'
            ],
            '!takeFromChest': [
                'take from chest', 'get from chest', 'withdraw from chest', 'retrieve from chest',
                'grab from chest', 'get items from chest'
            ],
            '!depositAll': [
                'deposit all', 'store all', 'put away all', 'deposit everything', 'store everything',
                'empty inventory', 'clear inventory'
            ],
            '!discard': [
                'discard item', 'throw away', 'drop item', 'toss item', 'get rid of'
            ],
            '!viewChest': [
                'view chest', 'check chest', 'open chest', 'look in chest', 'what is in chest',
                'show chest contents', 'chest contents'
            ],
            '!givePlayer': [
                'give item', 'give me', 'hand over', 'pass item', 'give to player'
            ],
            '!stats': [
                'show stats', 'what is your status', 'how are you', 'check stats', 'show status',
                'what is your health', 'where are you', 'what is your position'
            ],
            '!inventory': [
                'show inventory', 'what do you have', 'check inventory', 'list inventory',
                'what items do you have', 'show items', 'what is in inventory'
            ],
            '!surroundings': [
                'what is around you', 'show surroundings', 'what do you see', 'check surroundings',
                'what blocks are nearby', 'look around', 'scan area'
            ],
            '!nearbyBlocks': [
                'nearby blocks', 'blocks nearby', 'what blocks are here', 'find blocks',
                'search for blocks', 'locate blocks'
            ],
            '!stop': [
                'stop', 'halt', 'cease', 'abort', 'cancel', 'stop everything', 'stop all actions'
            ],
            '!clearMemory': [
                'clear memory', 'forget everything', 'reset memory', 'wipe memory', 'clear all memory'
            ],
            '!goToBed': [
                'go to bed', 'sleep', 'rest', 'use bed', 'lie down', 'go sleep'
            ],
            '!attack': [
                'attack', 'fight', 'hit', 'strike', 'combat', 'engage enemy', 'attack enemy'
            ],
            '!smeltItem': [
                'smelt item', 'cook item', 'furnace item', 'smelt ore', 'cook food', 'process item'
            ],
            '!placeHere': [
                'place block', 'put block', 'set block', 'place here', 'build block', 'put down block',
                'build fence', 'place fence', 'put fence', 'build wall', 'place wall'
            ],
            '!searchForBlock': [
                'find block', 'search for block', 'locate block', 'find blocks', 'search blocks',
                'where is block', 'find resource'
            ],
            '!rememberHere': [
                'remember this place', 'save location', 'mark location', 'remember location',
                'save position', 'remember here'
            ],
            '!goToRememberedPlace': [
                'go to saved place', 'go to remembered place', 'return to place', 'go back to place',
                'visit saved location', 'go to location'
            ]
        };
        
        // Simple classification intents
        this.simpleIntents = {
            'yes': ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'affirmative', 'correct', 'right', 'true', 'yup', 'alright'],
            'no': ['no', 'nope', 'nah', 'negative', 'incorrect', 'wrong', 'false', 'dont', "don't", 'stop', 'cancel'],
            'help': ['help', 'what can you do', 'commands', 'what commands', 'show commands', 'list commands', 'help me'],
            'stop': ['stop', 'halt', 'cease', 'abort', 'cancel', 'quit', 'end']
        };
        
        // Pre-computed embeddings (populated during init)
        this.commandEmbeddings = new Map();
        this.simpleEmbeddings = new Map();
    }
    
    /**
     * Initialize classifier by pre-computing embeddings for all intents
     */
    async init() {
        if (this.initialized) return;
        
        if (this.initPromise) {
            return this.initPromise;
        }
        
        this.initPromise = (async () => {
            console.log('[LocalClassifier] Initializing intent embeddings...');
            const startTime = Date.now();
            
            // Pre-compute command intent embeddings
            for (const [command, phrases] of Object.entries(this.commandIntents)) {
                const embeddings = await this.embedder.embedBatch(phrases);
                this.commandEmbeddings.set(command, embeddings);
            }
            
            // Pre-compute simple intent embeddings
            for (const [intent, phrases] of Object.entries(this.simpleIntents)) {
                const embeddings = await this.embedder.embedBatch(phrases);
                this.simpleEmbeddings.set(intent, embeddings);
            }
            
            const initTime = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[LocalClassifier] Initialized in ${initTime}s (${this.commandEmbeddings.size} commands, ${this.simpleEmbeddings.size} simple intents)`);
            this.initialized = true;
        })();
        
        return this.initPromise;
    }
    
    /**
     * Match natural language to a command
     * @param {string} message - User message
     * @returns {Promise<{command: string, confidence: number} | null>}
     */
    async matchCommand(message) {
        if (!settings.use_local_embeddings) return null;
        
        await this.init();
        
        const messageEmbedding = await this.embedder.embed(message.toLowerCase());
        let bestMatch = null;
        let bestScore = 0;
        
        // Check each command
        for (const [command, embeddings] of this.commandEmbeddings.entries()) {
            // Find best matching phrase for this command
            for (const phraseEmbedding of embeddings) {
                const similarity = cosineSimilarity(messageEmbedding, phraseEmbedding);
                if (similarity > bestScore) {
                    bestScore = similarity;
                    bestMatch = command;
                }
            }
        }
        
        if (bestScore >= this.threshold) {
            return {
                command: bestMatch,
                confidence: bestScore
            };
        }
        
        return null;
    }
    
    /**
     * Classify simple intents (yes/no/help/stop)
     * @param {string} message - User message
     * @returns {Promise<{intent: string, confidence: number} | null>}
     */
    async classifySimple(message) {
        if (!settings.enable_simple_classifier) return null;
        
        await this.init();
        
        const messageEmbedding = await this.embedder.embed(message.toLowerCase());
        let bestMatch = null;
        let bestScore = 0;
        
        // Check each simple intent
        for (const [intent, embeddings] of this.simpleEmbeddings.entries()) {
            for (const phraseEmbedding of embeddings) {
                const similarity = cosineSimilarity(messageEmbedding, phraseEmbedding);
                if (similarity > bestScore) {
                    bestScore = similarity;
                    bestMatch = intent;
                }
            }
        }
        
        // Use slightly lower threshold for simple intents (they're more common)
        const simpleThreshold = this.threshold * 0.9;
        if (bestScore >= simpleThreshold) {
            return {
                intent: bestMatch,
                confidence: bestScore
            };
        }
        
        return null;
    }
    
    /**
     * Try to extract command arguments from message
     * Command-aware argument extraction
     * @param {string} message - User message
     * @param {string} command - Matched command
     * @param {string} senderName - Name of the message sender (for commands like followPlayer)
     * @returns {string[]} Extracted arguments
     */
    extractArgs(message, command, senderName = null) {
        const args = [];
        const lowerMessage = message.toLowerCase();
        
        // Helper function to normalize item/block names
        const normalizeName = (name) => {
            if (!name) return null;
            let normalized = name.trim().replace(/\s+/g, '_').toLowerCase();
            // Remove trailing 's' unless it's part of the name (like "glass")
            if (normalized.endsWith('s') && !normalized.endsWith('ss') && 
                !normalized.endsWith('_s') && normalized.length > 3) {
                normalized = normalized.slice(0, -1);
            }
            return normalized;
        };
        
        // Helper to extract number from message
        const extractNumber = (msg, defaultVal = '1') => {
            const numMatch = msg.match(/(\d+)/);
            return numMatch ? numMatch[1] : defaultVal;
        };
        
        // ===== PLAYER COMMANDS =====
        if (command === '!followPlayer' || command === '!goToPlayer') {
            // Extract player name: "follow me" -> sender name, "follow <name>" -> name
            if (lowerMessage.includes(' me') || lowerMessage === 'follow me' || 
                lowerMessage.includes('come here') || lowerMessage.includes('come to me')) {
                args.push(senderName || 'player');
            } else {
                const playerMatch = message.match(/(?:follow|go to|goto|come to)\s+([a-zA-Z0-9_]+)/i);
                if (playerMatch && playerMatch[1] && playerMatch[1].toLowerCase() !== 'me') {
                    args.push(playerMatch[1]);
                } else {
                    args.push(senderName || 'player');
                }
            }
            // Add distance/closeness parameter
            if (command === '!followPlayer') {
                args.push('3'); // default follow distance
            } else {
                args.push('3'); // default closeness for goToPlayer
            }
        }
        
        // ===== GIVE PLAYER =====
        else if (command === '!givePlayer') {
            // Pattern: "give me X", "give X to player", "give player X"
            if (lowerMessage.includes(' me ') || lowerMessage.includes('give me')) {
                // "give me diamond" pattern
                const itemMatch = message.match(/(?:give|hand|pass)\s+me\s+(?:a|an|the|some|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i);
                if (itemMatch && senderName) {
                    args.push(senderName);
                    args.push(normalizeName(itemMatch[1]));
                    args.push(extractNumber(message));
                }
            } else {
                // "give player diamond" or "give diamond to player"
                const giveMatch = message.match(/(?:give|hand|pass)\s+([a-zA-Z0-9_]+)\s+(?:a|an|the|some|\d+)?\s*([a-z_]+)/i);
                if (giveMatch) {
                    args.push(giveMatch[1]);
                    args.push(normalizeName(giveMatch[2]));
                    args.push(extractNumber(message));
                }
            }
        }
        
        // ===== COLLECT BLOCKS =====
        else if (command === '!collectBlocks') {
            const collectPatterns = [
                /(?:collect|get|gather|mine|harvest)\s+(?:some|a|an|the|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i,
                /(?:get|grab|pick up)\s+(?:some|a|an|the|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of collectPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    let blockName = normalizeName(match[1]);
                    // Handle common variations
                    if (blockName === 'wood' || blockName === 'log') blockName = 'oak_log';
                    if (blockName === 'stone') blockName = 'cobblestone';
                    if (blockName === 'dirt') blockName = 'dirt';
                    args.push(blockName);
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== CRAFT RECIPE =====
        else if (command === '!craftRecipe') {
            const craftPatterns = [
                /(?:craft|make|create|build)\s+(?:a|an|the|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of craftPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== EQUIP =====
        else if (command === '!equip') {
            const equipPatterns = [
                /(?:equip|use|hold|wield|switch to|select)\s+(?:a|an|the|my)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of equipPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    break;
                }
            }
        }
        
        // ===== CONSUME (eat/drink) =====
        else if (command === '!consume') {
            const consumePatterns = [
                /(?:eat|drink|consume|use)\s+(?:a|an|the|some|my)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of consumePatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    let itemName = normalizeName(match[1]);
                    // Handle food aliases
                    if (itemName === 'food') itemName = 'cooked_beef';
                    if (itemName === 'meat') itemName = 'cooked_beef';
                    if (itemName === 'bread') itemName = 'bread';
                    args.push(itemName);
                    break;
                }
            }
        }
        
        // ===== PUT IN CHEST =====
        else if (command === '!putInChest') {
            const putPatterns = [
                /(?:put|store|deposit|place)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)\s+(?:in|into)/i,
                /(?:store|deposit)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of putPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== TAKE FROM CHEST =====
        else if (command === '!takeFromChest') {
            const takePatterns = [
                /(?:take|get|grab|withdraw|retrieve)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)\s+(?:from|out)/i,
                /(?:take|get|grab)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of takePatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== DEPOSIT ALL =====
        else if (command === '!depositAll') {
            // Optional "except" parameter
            const exceptMatch = message.match(/(?:except|keep|but not|excluding)\s+([a-z_,\s]+)/i);
            if (exceptMatch) {
                args.push(exceptMatch[1].trim());
            } else {
                args.push(''); // empty except list
            }
        }
        
        // ===== DISCARD =====
        else if (command === '!discard') {
            const discardPatterns = [
                /(?:discard|throw away|drop|toss)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of discardPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== SMELT ITEM =====
        else if (command === '!smeltItem') {
            const smeltPatterns = [
                /(?:smelt|cook|process|furnace)\s+(?:the|my|a|an|\d+)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of smeltPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push(extractNumber(message, '1'));
                    break;
                }
            }
        }
        
        // ===== ATTACK =====
        else if (command === '!attack') {
            const attackPatterns = [
                /(?:attack|fight|kill|hit|strike)\s+(?:the|a|an)?\s*([a-z_]+)/i
            ];
            for (const pattern of attackPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    let mobName = normalizeName(match[1]);
                    // Handle common mob aliases
                    if (mobName === 'mob' || mobName === 'monster' || mobName === 'enemy') mobName = 'zombie';
                    args.push(mobName);
                    break;
                }
            }
        }
        
        // ===== SEARCH FOR BLOCK =====
        else if (command === '!searchForBlock') {
            const searchPatterns = [
                /(?:find|search|locate|look for)\s+(?:the|a|an|some)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            for (const pattern of searchPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(normalizeName(match[1]));
                    args.push('64'); // default search range
                    break;
                }
            }
        }
        
        // ===== REMEMBER HERE =====
        else if (command === '!rememberHere') {
            const rememberPatterns = [
                /(?:remember|save|mark)\s+(?:this|here|location|place|spot)\s+(?:as\s+)?["']?([a-zA-Z0-9_\s]+)["']?/i,
                /(?:call|name)\s+(?:this|here|it)\s+["']?([a-zA-Z0-9_\s]+)["']?/i
            ];
            for (const pattern of rememberPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(match[1].trim().replace(/\s+/g, '_'));
                    break;
                }
            }
            // If no name found, use generic name
            if (args.length === 0) {
                args.push('location_' + Date.now() % 10000);
            }
        }
        
        // ===== GO TO REMEMBERED PLACE =====
        else if (command === '!goToRememberedPlace') {
            const gotoPatterns = [
                /(?:go to|goto|return to|visit)\s+(?:saved\s+)?(?:place|location|spot)?\s*["']?([a-zA-Z0-9_\s]+)["']?/i,
                /(?:go back to|return to)\s+["']?([a-zA-Z0-9_\s]+)["']?/i
            ];
            for (const pattern of gotoPatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    args.push(match[1].trim().replace(/\s+/g, '_'));
                    break;
                }
            }
        }
        
        // ===== PLACE HERE =====
        else if (command === '!placeHere') {
            // Note: Complex structures (like "build 4x4 fence") should go to LLM
            if (/\d+x\d+/.test(message)) {
                return []; // Let LLM handle complex structure requests
            }
            
            const placePatterns = [
                /(?:place|put|set)\s+(?:a|an|the)?\s*([a-z_]+(?:\s+[a-z_]+)?)\s+(?:here|down|block)/i,
                /(?:place|put|set)\s+(?:a|an|the)?\s*([a-z_]+(?:\s+[a-z_]+)?)/i
            ];
            
            for (const pattern of placePatterns) {
                const match = message.match(pattern);
                if (match && match[1]) {
                    let blockName = normalizeName(match[1]);
                    // Handle common block defaults
                    if (blockName === 'fence') blockName = 'oak_fence';
                    if (blockName === 'wall') blockName = 'cobblestone_wall';
                    if (blockName === 'stairs') blockName = 'oak_stairs';
                    if (blockName === 'slab') blockName = 'oak_slab';
                    if (blockName === 'torch') blockName = 'torch';
                    if (blockName === 'block') return []; // Too generic, let LLM handle
                    args.push(blockName);
                    break;
                }
            }
        }
        
        // ===== NO-ARG COMMANDS (safety check) =====
        // !stats, !inventory, !surroundings, !nearbyBlocks, !stop, !clearMemory, 
        // !goToBed, !viewChest, !clearFurnace
        // These don't need args, return empty array
        
        return args;
    }
    
    /**
     * Main classification method - tries both command matching and simple classification
     * @param {string} message - User message
     * @param {string} senderName - Name of the message sender (for argument extraction)
     * @returns {Promise<{type: 'command'|'simple', command?: string, intent?: string, confidence: number, args?: string[]} | null>}
     */
    async classify(message, senderName = null) {
        // Check commands FIRST (more specific, should take priority)
        const commandResult = await this.matchCommand(message);
        if (commandResult) {
            const args = this.extractArgs(message, commandResult.command, senderName);
            return {
                type: 'command',
                command: commandResult.command,
                confidence: commandResult.confidence,
                args: args
            };
        }
        
        // Then try simple classification (only if no command matched)
        const simpleResult = await this.classifySimple(message);
        if (simpleResult) {
            return {
                type: 'simple',
                intent: simpleResult.intent,
                confidence: simpleResult.confidence
            };
        }
        
        return null;
    }
}

