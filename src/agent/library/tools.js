/**
 * Tool selection for digging.
 *
 * `mineflayer-tool` is not among the plugins loaded in mcdata.js, so `bot.tool.equipForBlock`
 * throws wherever it is called and every dig ran with whatever happened to be in hand - often
 * the terracotta the bot pillars with. This picks the right tool family for a block and the
 * best material tier available, then equips it.
 */

const AXE = /(_log|_wood|planks|fence|_door|chest|crafting_table|bookshelf|barrel|sign|ladder|bamboo)/;
// Anchored on purpose: "sandstone" is mined with a pickaxe, "sand" with a shovel. An unanchored
// substring test on "sand" is the same mistake that made self_preservation fire on sandstone.
const SHOVEL = /(^sand$|^red_sand$|^suspicious_sand$|gravel|^dirt$|coarse_dirt|rooted_dirt|dirt_path|clay|snow|grass_block|podzol|mycelium|mud|soul_sand|soul_soil|farmland|concrete_powder)/;
const HOE = /(leaves|hay_block|sponge|moss_block|nether_wart_block|shroomlight)/;

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/** Which tool family breaks this block fastest. */
export function toolFor(blockName) {
    if (!blockName) return 'pickaxe';
    if (AXE.test(blockName)) return 'axe';
    if (SHOVEL.test(blockName)) return 'shovel';
    if (HOE.test(blockName)) return 'hoe';
    return 'pickaxe';
}

/**
 * Equip the best available tool for `block`.
 * @returns {Promise<boolean>} true if a suitable tool is now in hand.
 */
export async function equipBestTool(bot, block) {
    if (!block || !block.name) return false;
    const kind = toolFor(block.name);

    for (const tier of TIERS) {
        const wanted = `${tier}_${kind}`;
        const item = bot.inventory.items().find(i => i.name === wanted);
        if (!item) continue;
        if (bot.heldItem && bot.heldItem.name === wanted) return true;
        try {
            await bot.equip(item, 'hand');
            return true;
        } catch (err) {
            return false; // inventory busy; digging bare-handed still works, just slower
        }
    }
    return false;
}

/** Equip the right tool, then break the block. */
export async function digWithTool(bot, block) {
    if (!block || block.boundingBox !== 'block') return false;
    if (block.name === 'bedrock' || block.name.includes('lava')) return false;
    await equipBestTool(bot, block);
    try {
        await bot.dig(block);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Blocks that actually fall under gravity, matched EXACTLY.
 *
 * Single source of truth on purpose. This started as a substring match on "sand" inside
 * modes.js, which also caught sandstone, red_sandstone, cut_sandstone and sandstone_stairs -
 * none of which fall. In a desert that made self_preservation fire continuously and interrupt
 * travel forever.
 */
export const FALLING_BLOCKS = [
    'sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'dragon_egg',
];

export function isFallingBlockName(name) {
    if (!name) return false;
    if (FALLING_BLOCKS.includes(name)) return true;
    return name.endsWith('_concrete_powder') || name.endsWith('anvil');
}

/**
 * Tree trunks: logs, stems, hyphae, mangrove roots, bamboo.
 *
 * Kept separate from `isPlayerMade` because trunks are natural, but they should still be walked
 * AROUND rather than chopped. A trunk is 1-2 blocks wide, so a detour costs a couple of blocks,
 * while felling it is slower and needlessly destroys the landscape the bot is travelling through.
 */
const TREE_TRUNK = /(_log$|_wood$|_stem$|_hyphae$|^mangrove_roots$|^bamboo)/;

export function isTreeTrunk(name) {
    return !!name && TREE_TRUNK.test(name);
}
