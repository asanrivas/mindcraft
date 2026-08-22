/**
 * The mineflayer-backed BotClient. This is today's initBot() body, moved
 * here verbatim from src/utils/mcdata.js so the construction seam
 * (src/mc/index.js createClient) can swap it for a native backend later
 * without touching any of the ~1000 bot.* call sites in src/.
 */
import minecraftData from 'minecraft-data';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import armorManagerPlugin from 'mineflayer-armor-manager';

/**
 * @param {object} options - mineflayer createBot options (username, host,
 *   port, auth, version, checkTimeoutInterval, ...), already resolved from
 *   settings by the caller.
 * @param {{ onVersionKnown?: (version: string) => void }} [hooks] - lets the
 *   caller (mcdata.js) capture bot.version once login completes, without
 *   this module needing to know about mcdata's module-level state.
 * @returns {import('mineflayer').Bot}
 */
export function createMineflayerBot(options, hooks = {}) {
    const bot = createBot(options);

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    let lastPositionUpdate = 0;
    let pendingPositionPacket = null;
    const POSITION_THROTTLE_MS = 50;
    const originalWrite = bot._client.write.bind(bot._client);
    bot._client.write = function (name, data) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Queue this packet so the last position update is never lost
                if (!pendingPositionPacket) {
                    pendingPositionPacket = setTimeout(() => {
                        pendingPositionPacket = null;
                        lastPositionUpdate = Date.now();
                        originalWrite(name, data);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket);
                pendingPositionPacket = null;
            }
        }
        return originalWrite(name, data);
    };

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function (event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mc/backends/mineflayer] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManagerPlugin); // auto equip armor

    // bot.chat() is overloaded across ~80 call sites: real speech, and
    // server slash-commands whose reply is scraped back off chat. command()
    // gives call sites an honest name for the latter; on this backend
    // there's no separate channel, so it's the same wire call as chat().
    bot.command = (cmd) => bot.chat(cmd);

    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        if (hooks.onVersionKnown) hooks.onVersionKnown(bot.version);
    });

    return bot;
}

// Re-exported so contract.js / tests can construct the same item/data
// modules the way mcdata.js does, without importing mineflayer internals.
export { minecraftData, prismarine_items };
