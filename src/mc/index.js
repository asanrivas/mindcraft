/**
 * The construction seam. src/utils/mcdata.js initBot() calls createClient()
 * instead of mineflayer's createBot() directly, so the bot backend is a
 * config flag (settings.mc_client) rather than a hardcoded import.
 *
 * Both backends satisfy the same BotClient contract (see contract.js) - a
 * plain mineflayer-shaped EventEmitter - so none of the ~1000 bot.* call
 * sites elsewhere in src/ need to know which one is running.
 */
import { createMineflayerBot } from './backends/mineflayer.js';
import { createNativeBot } from './backends/native.js';

/**
 * @param {object} options - resolved createBot-style options (username,
 *   host, port, auth, version, ...)
 * @param {{ backend?: 'mineflayer'|'native', onVersionKnown?: (v: string) => void }} [config]
 * @returns {import('mineflayer').Bot} a BotClient-shaped EventEmitter
 */
export function createClient(options, config = {}) {
    const backend = config.backend || 'mineflayer';
    const hooks = { onVersionKnown: config.onVersionKnown };

    switch (backend) {
        case 'mineflayer':
            return createMineflayerBot(options, hooks);
        case 'native':
            return createNativeBot(options, hooks);
        default:
            throw new Error(`[mc] Unknown mc_client backend "${backend}". Expected "mineflayer" or "native".`);
    }
}

export { METHODS, NESTED_METHODS, PROPERTIES, CUSTOM_PROPERTIES, MUTABLE_PHYSICS_FIELDS, EVENTS, SYNTHETIC_EVENTS, checkContract } from './contract.js';
