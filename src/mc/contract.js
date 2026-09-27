/**
 * The BotClient contract - mineflayer's bot shape, frozen to the subset this
 * repo actually calls. Both backends (backends/mineflayer.js today,
 * backends/native.js eventually) must satisfy these exact names so that none
 * of the ~1000 `bot.*` call sites across src/ have to change.
 *
 * This is data, not code, so tests/contract.test.mjs can walk it mechanically
 * instead of the audit living only as a comment someone forgets to update.
 *
 * See docs/CLIENT_REPLACEMENT.md and the plan this shipped from for the full
 * per-call-site audit this was built from.
 */

// Methods that exist on the bot object itself once a plugin/session has
// injected them (mineflayer injects these after the protocol handshake
// completes - see node_modules/mineflayer/lib/loader.js). Checked with
// `typeof bot[name] === 'function'`.
export const METHODS = [
    // lifecycle
    'quit', 'loadPlugin', 'acceptResourcePack', 'waitForChunksToLoad',
    // events (EventEmitter surface)
    'on', 'once', 'removeListener', 'emit',
    // world / block reads
    'blockAt', 'findBlocks', 'blockAtCursor', 'nearestEntity',
    // physics / movement control
    'setControlState', 'clearControlStates', 'look', 'lookAt',
    // actions
    'chat', 'command', 'whisper', 'dig', 'stopDigging', 'placeBlock',
    'activateBlock', 'activateItem', 'deactivateItem', 'useOn', 'attack',
    'sleep', 'equip', 'unequip', 'recipesFor', 'craft', 'openContainer',
    'openFurnace', 'openVillager', 'trade', 'closeWindow', 'toss', 'consume',
    'setQuickBarSlot',
];

// Nested method groups, checked as `typeof bot[group][name] === 'function'`
// once bot[group] exists (some only populate after 'creative'/spawn).
export const NESTED_METHODS = {
    creative: ['setInventorySlot', 'startFlying', 'stopFlying', 'flyTo'],
    inventory: ['items', 'findInventoryItem'],
};

// Plain properties/namespaces expected to exist on the bot object. Some only
// populate after spawn (entity, game, players) - the offline contract test
// checks presence where a fake login can produce it and documents the rest
// for the live parity harness (M2/M6) to verify against a real server.
export const PROPERTIES = [
    'inventory', 'physics', 'entities', 'players', 'registry',
];

// Custom properties this repo bolts onto bot from outside mineflayer. A
// backend must be a plain EventEmitter (not a Proxy or sealed object) so
// arbitrary assignment like this keeps working.
export const CUSTOM_PROPERTIES = [
    'output', 'interrupt_code', 'modes', 'restrict_to_inventory',
    'swimAssist', 'lastDamageTime', 'lastDamageTaken', 'itemUseOwner',
    'last_verification',
];

// Physics fields that are READ AND WRITTEN mid-tick by swim_assist.js,
// swim_probe.js and blueprint_builder.js. A backend that makes these
// computed/read-only breaks swimming and creative flight silently - see the
// plan's "riskiest assumptions" section.
export const MUTABLE_PHYSICS_FIELDS = ['liquidAcceleration', 'gravity'];

// Events this repo subscribes to via bot.on/once/removeListener. Not
// mechanically checkable offline (they require a live session to fire) -
// listed here so the live shadow-diff harness (M2/M6) has the checklist, and
// so a native backend implementor knows the full set to emit.
export const EVENTS = [
    'error', 'login', 'spawn', 'end', 'kicked', 'death', 'respawn', 'health',
    'time', 'move', 'physicsTick', 'forcedMove', 'chat', 'whisper',
    'messagestr', 'playerJoined', 'playerLeft', 'playerCollect', 'entityDead',
    'resourcePack',
];

// Synthetic events mindcraft emits on the bot itself - not mineflayer's job,
// any backend gets these for free as long as it's a real EventEmitter.
export const SYNTHETIC_EVENTS = ['idle', 'sunrise', 'noon', 'sunset', 'midnight'];

/**
 * Walk the contract against a bot-shaped object. Returns { missing: string[] }.
 * `liveConnected` widens the check to PROPERTIES/NESTED_METHODS that only
 * populate post-spawn - pass true only when checking a fully spawned bot.
 */
export function checkContract(bot, { liveConnected = false } = {}) {
    const missing = [];

    if (typeof bot.on !== 'function' || typeof bot.emit !== 'function') {
        missing.push('<not an EventEmitter>');
        return { missing };
    }

    for (const name of METHODS) {
        if (typeof bot[name] !== 'function') missing.push(name);
    }

    for (const [group, names] of Object.entries(NESTED_METHODS)) {
        const obj = bot[group];
        if (!obj) {
            if (liveConnected) missing.push(`${group} (missing namespace)`);
            continue;
        }
        for (const name of names) {
            if (typeof obj[name] !== 'function') missing.push(`${group}.${name}`);
        }
    }

    for (const name of PROPERTIES) {
        if (!(name in bot)) missing.push(name);
    }

    if (liveConnected && bot.physics) {
        for (const name of MUTABLE_PHYSICS_FIELDS) {
            if (!(name in bot.physics)) missing.push(`physics.${name}`);
        }
    }

    return { missing };
}
