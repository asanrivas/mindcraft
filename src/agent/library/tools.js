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

/**
 * Could we actually break this block, and keep what it drops?
 *
 * `bot.canDigBlock` is NOT this question - it only checks `diggable` and reach, and stone is
 * diggable bare-handed. It just drops nothing. That distinction is what made `emergencyShelter`
 * dig a pit it could not roof: it "mined a wall for a block", got no item, and then had nothing
 * to seal with.
 *
 * Equips the best tool we have first, because the answer depends on what ends up in hand.
 */
export async function canBreak(bot, block) {
    if (!block || block.boundingBox !== 'block') return false;
    if (block.name === 'bedrock' || isLavaName(block.name)) return false;
    if (bot.game?.gameMode === 'creative') return true;
    await equipBestTool(bot, block);
    const id = bot.heldItem ? bot.heldItem.type : null;
    return typeof block.canHarvest === 'function' ? !!block.canHarvest(id) : true;
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
        // Say why. A silent `false` here reads as "there was nothing to mine", which is the
        // opposite of the truth and sent a walled-in bot round the recovery ladder forever with
        // no indication that the dig itself was the thing failing.
        console.log(`[${bot.username ?? '?'}] dig ${block.name} at ${block.position}: ${err.message}`);
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

/**
 * Water and lava, matched EXACTLY.
 *
 * Same reasoning as isFallingBlockName: nav.js used to classify anything whose name CONTAINED
 * "water" as swimmable, which makes `water_cauldron` a river the planner will happily route a
 * path through. `lava_cauldron` is the mirror image - it is not a lava lake, but it is still
 * not something to walk into, so callers treat it as a hazard by other means.
 */
const WATER_BLOCKS = new Set(['water', 'flowing_water']);
const LAVA_BLOCKS = new Set(['lava', 'flowing_lava']);
// Plants that grow in water: the cell is still water, and the bot swims straight through them.
const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);

export function isWaterName(name) {
    return !!name && WATER_BLOCKS.has(name);
}

export function isLavaName(name) {
    return !!name && LAVA_BLOCKS.has(name);
}

/** Water, or a plant standing in it. Waterlogged blocks are NOT swimmable - they are solid. */
export function isSwimmable(name) {
    return isWaterName(name) || (!!name && WATER_PLANTS.has(name));
}

/**
 * Bubble columns drag an entity up (soul sand) or down (magma) regardless of what it holds.
 * They have no bounding box, so a naive check reads them as air and the planner routes through
 * a lift it cannot steer in.
 */
export function isBubbleColumn(name) {
    return name === 'bubble_column';
}


// Block placement lived here briefly as `placeBlockVerified`. It moved to `block_io.js`, which
// owns the whole problem rather than wrapping one symptom of it - the ack wait, the smooth look,
// the hitbox clearance and the interaction rate limit are four separate defects and a wrapper
// could only ever address the first.
