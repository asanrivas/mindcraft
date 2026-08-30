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

    // Throttle position packets to avoid kicks on Paper/Spigot servers.
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET when
    // mineflayer sends position updates faster than 50ms apart.
    //
    // COALESCE TO THE LATEST PACKET, NOT THE FIRST. The original captured `name`/`data` in the
    // timer closure the moment the FIRST packet of a window was deferred, and every later packet
    // in that window hit `if (!pendingPositionPacket)` and was dropped on the floor - so the
    // comment "the last position update is never lost" described the opposite of the behaviour.
    // What the server received 50ms later was a STALE position, which is worse than a dropped
    // one: the server places blocks, and validates reach, against where it believes we are.
    //
    // That is not theoretical. `bot.placeBlock` sends its packet and then waits 500ms for a
    // `blockUpdate` to confirm it (mineflayer/lib/plugins/place_block.js:13), throwing when none
    // arrives. Inside the agent that throw was routine - `pillarUp` measured
    // `apex 1.00 ... place failed: Event blockUpdate did not fire within timeout of 500ms`, i.e.
    // the JUMP WORKED and the block never appeared - while a clean mineflayer bot on this same
    // server, with no throttle, pillared 4/4 with apex 1.25. The stale position is the difference.
    // RE-MEASURED 2026-08-30, and the premise did not survive. A clean bot with NO throttle,
    // moving and turning continuously against this server: 914 position packets over 45s, no
    // kick, connection intact. Driving `bot.look` at a target of 100/s and 250/s changed
    // nothing - the observed rate stayed 19.9/s, because mineflayer only writes a position
    // packet on its own physics tick. It CANNOT exceed 20/s through the normal APIs.
    //
    // 20/s is one packet every 50ms, which was exactly the old threshold - so the throttle was
    // firing on tick jitter alone, deferring packets it could never actually reduce the rate of.
    // That is not a safety valve, it is a coin flip on the packet the server uses to decide
    // where we are, and therefore what it will let us place and reach.
    //
    // Kept as a genuine burst guard rather than deleted: the original ECONNRESET was reported
    // by someone, and this now sits far enough above the natural rate that ordinary movement
    // never touches it, while a real runaway (some future code writing packets directly) is
    // still bounded. If a kick ever recurs, RAISE the evidence, not the threshold.
    let lastPositionUpdate = 0;
    let pendingTimer = null;
    let pendingName = null;
    let pendingData = null;
    const POSITION_THROTTLE_MS = 20;   // 50/s ceiling; mineflayer itself tops out at 20/s
    const originalWrite = bot._client.write.bind(bot._client);
    const flushPending = () => {
        pendingTimer = null;
        if (!pendingName) return;
        lastPositionUpdate = Date.now();
        const [n, d] = [pendingName, pendingData];
        pendingName = pendingData = null;
        originalWrite(n, d);
    };
    bot._client.write = function (name, data) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Always overwrite: the newest position is the only one worth sending.
                pendingName = name;
                pendingData = data;
                if (!pendingTimer) {
                    pendingTimer = setTimeout(flushPending,
                        POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            // A fresh packet supersedes anything queued; sending the stale one after it would
            // teleport the server's view of us backwards.
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            pendingName = pendingData = null;
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
