import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import { digWithTool, equipBestTool, isCanopy, isFallingBlockName, isTreeTrunk, isWaterName } from './tools.js';
import * as tools from './tools.js';
import * as swim from './swim.js';
import * as chest from './chest.js';
import * as nav from './nav.js';
import * as blockIO from './block_io.js';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { existsSync, readFileSync } from 'fs';
import * as farming from './farming.js';
import * as build_guard from './build_guard.js';
import * as progression from './progression.js';
import * as mining from './mining.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// ============= CONSTANTS =============
const CONSTANTS = {
    MAX_REACH_DISTANCE: 4.5,
    DEFAULT_SEARCH_RANGE: 32,
    MAX_SEARCH_RANGE: 512,
    STUCK_TIMEOUT_MS: 800,
    PATHFIND_TIMEOUT_MS: 1000,
    INTERACT_DISTANCE: 2,
    LOW_DURABILITY_THRESHOLD: 10,
    HUNGER_THRESHOLD: 14,
};

// Block type groups for flexible collection
const BLOCK_TYPES = {
    logs: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem'],
    planks: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks'],
    stone: ['stone', 'andesite', 'granite', 'diorite', 'deepslate', 'tuff', 'calcite', 'dripstone_block', 'cobblestone', 'cobbled_deepslate'],
    saplings: ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule'],
    wool: ['white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool'],
    glass: ['glass', 'white_stained_glass', 'orange_stained_glass', 'magenta_stained_glass', 'light_blue_stained_glass', 'yellow_stained_glass', 'lime_stained_glass', 'pink_stained_glass', 'gray_stained_glass', 'light_gray_stained_glass', 'cyan_stained_glass', 'purple_stained_glass', 'blue_stained_glass', 'brown_stained_glass', 'green_stained_glass', 'red_stained_glass', 'black_stained_glass'],
};

export function log(bot, message) {
    bot.output += message + '\n';
    // Mirror to the service log. `bot.output` is only read when the ACTION returns, so a skill
    // that runs for forty minutes reports nothing at all until it is over - which is exactly
    // when you need to know what it decided. Prefixed with the bot name because two agents
    // share one log.
    console.log(`[${bot.username ?? '?'}] ${message}`);
}

/**
 * Resolve a player name with fuzzy/case-insensitive matching
 * @param {Bot} bot - The minecraft bot
 * @param {string} username - The username to search for (can be partial/case-insensitive)
 * @returns {string|null} - The exact player name if found, null otherwise
 */
export function resolvePlayerName(bot, username) {
    if (!username) return null;
    
    // Direct exact match first
    if (bot.players[username]) {
        return username;
    }
    
    const searchName = username.toLowerCase();
    const playerNames = Object.keys(bot.players);
    
    // Try case-insensitive exact match
    let match = playerNames.find(name => name.toLowerCase() === searchName);
    if (match) return match;
    
    // Try matching without leading special characters (like dots)
    match = playerNames.find(name => {
        const cleanName = name.replace(/^[^a-zA-Z0-9]+/, '').toLowerCase();
        return cleanName === searchName;
    });
    if (match) return match;
    
    // Try partial match (input is contained in player name, case-insensitive)
    match = playerNames.find(name => name.toLowerCase().includes(searchName));
    if (match) return match;
    
    // Try partial match with cleaned name
    match = playerNames.find(name => {
        const cleanName = name.replace(/^[^a-zA-Z0-9]+/, '').toLowerCase();
        return cleanName.includes(searchName) || searchName.includes(cleanName);
    });
    if (match) return match;
    
    return null;
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    // Sort by attack damage descending (fixed comparison)
    weapons.sort((a, b) => (b.attackDamage || 0) - (a.attackDamage || 0));
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

/**
 * Check if a tool has low durability
 * @param {Object} item - the item to check
 * @param {number} threshold - durability threshold (default 10)
 * @returns {boolean} true if tool is about to break
 */
function isToolLowDurability(item, threshold = CONSTANTS.LOW_DURABILITY_THRESHOLD) {
    if (!item || item.durabilityUsed === undefined) return false;
    const maxDurability = item.maxDurability || 100;
    return (maxDurability - item.durabilityUsed) <= threshold;
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;
    
    // Check if bot already has enough of this item
    const currentCount = world.getInventoryCounts(bot)[itemName] || 0;
    if (currentCount >= num * 10) { // If we have 10x what we're trying to craft, probably don't need more
        log(bot, `You already have ${currentCount} ${itemName} in inventory. Do you really need to craft more?`);
    }

    const itemRecipes = mc.getItemCraftingRecipes(itemName);
    if (!itemRecipes || itemRecipes.length === 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe! You cannot craft ${itemName}.`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        // Build a helpful error message showing what's needed AND what the bot has
        const recipeReqs = mc.getItemCraftingRecipes(itemName)[0][0];
        const inventory = world.getInventoryCounts(bot);
        
        // Check for generic ingredient alternatives (e.g., any planks work for sticks)
        let reqStr = Object.entries(recipeReqs).map(([key, value]) => {
            const have = inventory[key] || 0;
            // Check for alternatives (planks can be any wood type)
            if (key.includes('_planks')) {
                const allPlanks = Object.entries(inventory)
                    .filter(([k, v]) => k.includes('_planks') && v > 0)
                    .map(([k, v]) => `${k}(${v})`);
                if (allPlanks.length > 0) {
                    return `${key}: ${value} (have ${have}, but you have: ${allPlanks.join(', ')})`;
                }
            }
            return `${key}: ${value} (have ${have})`;
        }).join(', ');
        
        log(bot, `Cannot craft ${itemName}. Requires: ${reqStr}`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    // Don't attempt to craft if we can't craft even once
    if (craftLimit.num <= 0) {
        log(bot, `Cannot craft ${itemName}: missing ${craftLimit.limitingResource}. You have: ${inventory[craftLimit.limitingResource] || 0}, need at least 1.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    try {
        const countBefore = world.getInventoryCounts(bot)[itemName] || 0;
        await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
        
        // Wait for inventory to sync from server (race condition fix)
        let newCount = world.getInventoryCounts(bot)[itemName] || 0;
        const expectedCount = countBefore + Math.min(craftLimit.num, num);
        
        // Retry up to 10 times (500ms total) waiting for inventory update
        for (let i = 0; i < 10 && newCount < expectedCount; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            newCount = world.getInventoryCounts(bot)[itemName] || 0;
        }
        
        // Check if this is a tool/weapon that should be equipped
        const isEquipable = itemName.includes('_sword') || itemName.includes('_pickaxe') || 
                           itemName.includes('_axe') || itemName.includes('_shovel') || 
                           itemName.includes('_hoe') || itemName.includes('bow') ||
                           itemName.includes('shield') || itemName.includes('fishing_rod');
        const equipHint = isEquipable ? ' Use !equip to use it.' : '';
        
        if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${newCount} ${itemName}.${equipHint}`);
        else log(bot, `Successfully crafted ${itemName}, you now have ${newCount} ${itemName}.${equipHint}`);
    } catch (err) {
        // Handle mineflayer craft errors gracefully
        const errMsg = err.message || String(err);
        if (errMsg.includes('missing ingredient')) {
            log(bot, `Crafting ${itemName} failed: ingredients changed during crafting. Try collecting more materials.`);
        } else {
            log(bot, `Crafting ${itemName} failed: ${errMsg}`);
        }
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    // Hunting a fish used to pause ALL of self_preservation - which also disabled falling-block
    // digging, fire response and low-health flight - purely so the bot could put its head under
    // water. Drowning is its own mode now, so nothing needs disabling here, and that mode stays
    // ON during the fight: the bot should still come up for air mid-hunt.
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

/**
 * Kill a mob from range with bow or crossbow.
 *
 * Stand-your-ground by design: strafing needs ground acceleration this server does not grant
 * (the onGround lie), so the winning play is to plant, aim and shoot - not to kite. Movement
 * happens only between engagements, via the custom navigator.
 *
 * @param {'bow'|'crossbow'|'auto'} weapon
 * @returns {Promise<string>} VERIFIED-style outcome line.
 */
export async function shootBow(bot, mobType, weapon = 'auto', maxShots = 12) {
    const bowLib = await import('./bow.js');
    const target0 = world.getNearbyEntities(bot, 32).find(e => e.name === mobType);
    if (!target0) return `No ${mobType} within 32 blocks to shoot.`;
    if (target0.type === 'player') return `Refusing to shoot a player.`;

    const before = bowLib.bowInfo(bot).arrows;
    let fired = 0, lastReason = '';
    const t0 = Date.now();

    // Confirm death by the ENTITY, never by absence from a radius query. A mob that takes one
    // arrow and wanders past the search radius - or blinks out of bot.entities during a chunk
    // update - would otherwise be reported as killed. In a codebase whose entire convention is
    // "VERIFIED means read back from world state", inferring a kill from a failed lookup is a
    // fabricated verification.
    const targetId = target0.id;
    let confirmedDead = false;
    const onDeath = (entity) => { if (entity?.id === targetId) confirmedDead = true; };
    bot.on('entityDead', onDeath);
    try {

    for (let shot = 0; shot < maxShots; shot++) {
        if (bot.interrupt_code) { lastReason = 'interrupted'; break; }
        // Re-find each round: the entity object goes invalid on death or despawn.
        if (confirmedDead) { lastReason = 'target_down'; break; }
        const target = bot.entities[targetId];
        if (!target || target.isValid === false) {
            // Gone from the entity table without a death event: it despawned, unloaded, or
            // simply walked away. Say which we do NOT know rather than claiming a kill.
            lastReason = confirmedDead ? 'target_down' : 'target_vanished';
            break;
        }
        if (target.position.distanceTo(bot.entity.position) > 40) { lastReason = 'out_of_range'; break; }

        const r = await bowLib.shootAt(bot, target, weapon);
        lastReason = r.reason;
        if (!r.fired) {
            if (r.reason === 'no_arrows' || r.reason.startsWith('no_')) break;
            if (r.reason === 'friendly_in_corridor') { await new Promise(s => setTimeout(s, 800)); continue; }
            break;
        }
        fired++;
        await new Promise(s => setTimeout(s, 600)); // arrow flight + server-side damage tick
    }

    } finally {
        bot.removeListener('entityDead', onDeath);
    }

    await pickupNearbyItems(bot); // recover arrows and drops
    const after = bowLib.bowInfo(bot).arrows;
    const downed = confirmedDead;
    // Returned, not log()ed: runAsAction concatenates bot.output with the return value, so
    // logging AND returning printed the line once and then a bare "true" after it.
    return `VERIFIED SHOOT: ${downed ? `killed ${mobType}` : `${mobType} NOT confirmed dead (${lastReason})`}, `
        + `${fired} shot(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s, arrows ${before}->${after}.`;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    let enemy = world.getNearestEntityWhere(bot, entity => {
        // Double-check hostile status and exclude friendly entities
        if (!mc.isHostile(entity)) return false;
        // Safety filter: never attack friendly entities
        if (mc.isFriendly(entity)) {
            console.log(`[DEFEND_SELF] Skipping ${entity.name} - marked as friendly`);
            return false;
        }
        return true;
    }, range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                // Closing on the enemy: an ordinary move, so the navigator handles it.
                await nav.navigateTo(bot, {
                    x: enemy.position.x, y: enemy.position.y, z: enemy.position.z,
                }, { arriveDist: 3.5, maxReplans: 2, waypointMs: 1500 });
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                // Too close - back off to swing range. Short budget: this runs inside the
                // attack loop and a long retreat would stop us fighting back.
                await fleeFrom(bot, enemy.position.clone(), 2, { timeoutMs: 1500 });
            } catch (err) {/* might error if entity dies, ignore */}
        }
        bot.pvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => {
            if (!mc.isHostile(entity)) return false;
            return !mc.isFriendly(entity);
        }, range);
        if (bot.interrupt_code) {
            bot.pvp.stop();
            return false;
        }
    }
    bot.pvp.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    
    // Check if inventory is full before starting
    const emptySlots = bot.inventory.emptySlotCount();
    if (emptySlots === 0) {
        const bulkItems = bot.inventory.items()
            .filter(i => i.count >= 10)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map(i => `${i.name}(${i.count})`);
        log(bot, `Inventory is FULL (0 empty slots). Cannot collect ${blockType}. Consider storing: ${bulkItems.join(', ')}`);
        return false;
    } else if (emptySlots < 3 && num > 5) {
        log(bot, `Warning: Only ${emptySlots} inventory slots free. May not collect all ${num} ${blockType}.`);
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    
    // Flexible block type matching - accept any variant when asking for a specific type
    if (BLOCK_TYPES.logs.includes(blockType)) {
        blocktypes = BLOCK_TYPES.logs;
    } else if (BLOCK_TYPES.planks.includes(blockType)) {
        blocktypes = BLOCK_TYPES.planks;
    } else if (BLOCK_TYPES.stone.includes(blockType)) {
        blocktypes = BLOCK_TYPES.stone;
    } else if (BLOCK_TYPES.saplings.includes(blockType)) {
        blocktypes = BLOCK_TYPES.saplings;
    } else if (BLOCK_TYPES.wool.includes(blockType)) {
        blocktypes = BLOCK_TYPES.wool;
    } else if (BLOCK_TYPES.glass.includes(blockType)) {
        blocktypes = BLOCK_TYPES.glass;
    }
    
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;
    let collectedTypes = new Set(); // Track what types were actually collected

    const movements = createSafeMovements(bot, { dontMineUnderFallingBlock: false, dontCreateFlow: true });

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await equipBestTool(bot, block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success) {
                collected++;
                collectedTypes.add(block.name); // Track the actual block type collected
            }
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    
    // Report what was actually collected
    if (collectedTypes.size > 1) {
        const typesStr = Array.from(collectedTypes).join(', ');
        log(bot, `Collected ${collected} logs (types: ${typesStr}).`);
    } else if (collectedTypes.size === 1 && !collectedTypes.has(blockType)) {
        log(bot, `Collected ${collected} ${Array.from(collectedTypes)[0]} (requested ${blockType}).`);
    } else {
        log(bot, `Collected ${collected} ${blockType}.`);
    }
    
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await equipBestTool(bot, block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}



export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail',
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close - try to move away, but don't fail if pathfinding has issues
        // "Step away from the cell I am about to fill" - ONE block, not a retreat. stepClear
        // is bounded to an adjacent cell; fleeFrom is the fallback for when no neighbour is
        // standable, and must not be the default (see stepClear's note on the 30-block drift).
        if (!await stepClear(bot, targetBlock.position)
            && !await fleeFrom(bot, targetBlock.position.clone(), 2, { timeoutMs: 3000 })) {
            log(bot, `Couldn't move away from target, trying to place anyway.`);
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far - try to get closer, but handle pathfinding failures gracefully
        try {
            let pos = targetBlock.position;
            // Generous but bounded: goToGoal spends up to ~2s on path planning before it
            // starts walking, so a tight budget starves the actual movement.
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4), 15000);
        } catch (pathErr) {
            // Pathfinding failed, check if we're close enough to place anyway
            if (bot.entity.position.distanceTo(targetBlock.position) > 6) {
                log(bot, `Cannot reach ${target_dest} to place block.`);
                return false;
            }
            log(bot, `Pathfinding partial, attempting placement from current position.`);
        }
    }

    // Re-check proximity AFTER moving closer. Walking to the target can leave the bot
    // standing in the very cell it needs to fill - which is the normal case for a floor at
    // foot level - and the earlier check ran before this move, so nothing caught it.
    if (!dont_move_for.includes(item_name)) {
        const now = bot.entity.position;
        const now_above = now.plus(Vec3(0, 1, 0));
        if (now.distanceTo(targetBlock.position) < 1.1 || now_above.distanceTo(targetBlock.position) < 1.1) {
            if (!await stepClear(bot, targetBlock.position)
                && !await fleeFrom(bot, targetBlock.position.clone(), 2, { timeoutMs: 3000 })) {
                log(bot, `Standing on ${target_dest} and could not step clear.`);
            }
        }
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            // Through block_io, not bot.placeBlock, for three reasons - all of which showed up
            // in one 13x13 floor bob laid on 2026-08-30:
            //   - bot.placeBlock ends in an ack wait the server does not always satisfy
            //     ("Event blockUpdate:(4718, 68, 4614) did not fire within timeout of 500ms"),
            //     which is a throw for a block that landed fine. _genericPlace skips it.
            //   - a FIXED 200ms settle then one read counts a block that arrives at 250ms as a
            //     failure; placeVerified polls to its deadline instead.
            //   - placing has an interaction RATE LIMIT and this path honoured none, so a fill
            //     ran itself into the server's throttle. placeVerified paces at
            //     MIN_PLACE_GAP_MS. (Same reason the terrain-clear loop sleeps 120ms.)
            // Its own check is "something solid appeared"; ours below is "the RIGHT block
            // appeared", so both still run.
            const placement = await blockIO.placeVerified(bot, buildOffBlock, faceVec, { expectName: blockType });
            // Confirm against world state rather than trusting the API call. bot.placeBlock
            // can resolve without the block landing, so reporting success here unverified
            // let bogus placement counts propagate up through fill().
            if (!verifyBlockPlaced(bot, target_dest, blockType)) {
                log(bot, `Tried to place ${blockType} at ${target_dest} but the block is not there (${placement.why}).`);
                return false;
            }
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            return true;
        }
    } catch (err) {
        // The API also throws *after* a successful placement, so re-read before believing
        // the error - otherwise fill() undercounts and retries blocks that already exist.
        await new Promise(resolve => setTimeout(resolve, 200));
        if (verifyBlockPlaced(bot, target_dest, blockType)) {
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            return true;
        }
        log(bot, `Failed to place ${blockType} at ${target_dest}: ${err.message}`);
        console.warn(`[placeBlock] ${blockType} at ${target_dest} failed:`, err.message,
            '| bot at', bot.entity.position.floored(), '| buildOff', buildOffBlock?.name, buildOffBlock?.position, '| face', faceVec);
        return false;
    }
}

/**
 * Check that the block at a position actually matches what was meant to be placed.
 * @param {MinecraftBot} bot
 * @param {Vec3} pos
 * @param {string} blockType
 * @returns {boolean}
 */
function verifyBlockPlaced(bot, pos, blockType) {
    const placed = bot.blockAt(pos);
    if (!placed) return false;
    if (placed.name === blockType) return true;
    // dirt placed on grass reports as grass_block; accept the known equivalence
    if (blockType === 'dirt' && placed.name === 'grass_block') return true;
    return false;
}

async function placeBlockWithTimeout(bot, blockType, x, y, z, placeOn, timeoutMs = 25000) {
    // fill() is excluded from the "unstuck" mode's rescue interrupt (it stands still on
    // purpose while placing nearby blocks), so a hung pathfinder.goto() inside placeBlock
    // would otherwise never be recovered from. Race it against a timeout instead.
    let timedOut = false;
    const timeout = new Promise((resolve) => {
        setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs);
    });
    const result = await Promise.race([
        placeBlock(bot, blockType, x, y, z, placeOn).catch(() => false),
        timeout
    ]);
    if (timedOut) {
        bot.pathfinder.stop();
        log(bot, `Timed out trying to place ${blockType} at (${x}, ${y}, ${z}), skipping.`);
        return false;
    }
    return result;
}

export async function fill(bot, blockType, x1, z1, x2, z2, y, height = 1) {
    /**
     * Fill a rectangular area with blocks using an efficient snake pattern.
     * Bot walks along rows, placing blocks while standing on previously placed blocks.
     * Builds from bottom to top for structural support. Resumable if interrupted.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place (e.g., "dirt", "cobblestone").
     * @param {number} x1, the x coordinate of the first corner.
     * @param {number} z1, the z coordinate of the first corner.
     * @param {number} x2, the x coordinate of the second corner.
     * @param {number} z2, the z coordinate of the second corner.
     * @param {number} y, the starting y coordinate (base height).
     * @param {number} height, how many levels to build (default 1).
     * @returns {Promise<number>} the number of blocks successfully placed.
     * @example
     * // Fill a 10x10 floor with dirt at height 64
     * await skills.fill(bot, "dirt", 0, 0, 10, 10, 64);
     * // Build a 5-block tall wall
     * await skills.fill(bot, "cobblestone", 0, 0, 10, 0, 64, 5);
     **/
    const minX = Math.min(Math.floor(x1), Math.floor(x2));
    const maxX = Math.max(Math.floor(x1), Math.floor(x2));
    const minZ = Math.min(Math.floor(z1), Math.floor(z2));
    const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
    const baseY = Math.floor(y);
    const buildHeight = Math.max(1, Math.floor(height));

    const emptyBlocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];

    const areaWidth = maxX - minX + 1;
    const areaDepth = maxZ - minZ + 1;
    const blocksPerLevel = areaWidth * areaDepth;
    const totalBlocks = blocksPerLevel * buildHeight;

    log(bot, `Filling area (${minX},${minZ}) to (${maxX},${maxZ}) from y=${baseY} to y=${baseY + buildHeight - 1} with ${blockType}. Total: ${totalBlocks} blocks.`);

    let totalPlaced = 0;
    let totalSkipped = 0;

    // Build level by level, bottom to top
    for (let level = 0; level < buildHeight; level++) {
        const currentY = baseY + level;

        if (buildHeight > 1) {
            log(bot, `Level ${level + 1}/${buildHeight} (y=${currentY}): starting...`);
        }

        let levelPlaced = 0;
        let levelSkipped = 0;

        // Snake pattern: alternate direction each row for efficient walking
        for (let x = minX; x <= maxX; x++) {
            const rowIndex = x - minX;
            const goingForward = rowIndex % 2 === 0;

            // Determine z iteration direction
            const zStart = goingForward ? minZ : maxZ;
            const zEnd = goingForward ? maxZ : minZ;
            const zStep = goingForward ? 1 : -1;

            for (let z = zStart; goingForward ? z <= zEnd : z >= zEnd; z += zStep) {
                if (bot.interrupt_code) {
                    const msg = `Fill INTERRUPTED at level ${level + 1}. Placed ${totalPlaced + levelPlaced}/${totalBlocks} so far - the area is NOT complete. Run the same command to resume.`;
                    log(bot, msg);
                    return msg;
                }

                // Check if block already exists
                const existingBlock = bot.blockAt(new Vec3(x, currentY, z));
                if (existingBlock && existingBlock.name === blockType) {
                    levelSkipped++;
                    continue;
                }
                if (existingBlock && !emptyBlocks.includes(existingBlock.name)) {
                    levelSkipped++; // Different solid block, skip
                    continue;
                }

                // Place the block
                const success = await placeBlockWithTimeout(bot, blockType, x, currentY, z, 'bottom');
                if (success) {
                    levelPlaced++;

                    if ((totalPlaced + levelPlaced) % 50 === 0) {
                        log(bot, `Progress: ${totalPlaced + levelPlaced}/${totalBlocks} blocks placed.`);
                    }
                }
            }
        }

        totalPlaced += levelPlaced;
        totalSkipped += levelSkipped;

        if (buildHeight > 1 && levelPlaced > 0) {
            log(bot, `Level ${level + 1}/${buildHeight} complete: ${levelPlaced} placed, ${levelSkipped} skipped.`);
        }
    }

    // Verify against world state before reporting. The placement counters above track what
    // the bot *believed* it did; this re-reads the region and reports what is actually there,
    // so a build that silently failed cannot be reported as complete.
    const check = verifyRegion(bot, minX, minZ, maxX, maxZ, baseY, buildHeight, blockType);
    log(bot, `Fill complete! Placed ${totalPlaced} ${blockType} blocks. (${totalSkipped} already existed)`);
    log(bot, check.summary);
    return check.summary;
}

/**
 * Re-read a region and compare it against the block type that was supposed to fill it.
 * This is the generic outcome check: it trusts the world, not the action's own bookkeeping.
 * @param {MinecraftBot} bot, reference to the minecraft bot.
 * @param {number} minX @param {number} minZ @param {number} maxX @param {number} maxZ
 * @param {number} baseY, lowest y level of the region.
 * @param {number} height, number of y levels.
 * @param {string} blockType, the block that should be present.
 * @returns {{total:number, correct:number, missing:number, pct:number, complete:boolean, summary:string, mismatches:Array}}
 */
export function verifyRegion(bot, minX, minZ, maxX, maxZ, baseY, height, blockType) {
    let total = 0, correct = 0;
    const mismatches = [];
    for (let level = 0; level < height; level++) {
        const y = baseY + level;
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                total++;
                const block = bot.blockAt(new Vec3(x, y, z));
                if (block && block.name === blockType) {
                    correct++;
                } else if (mismatches.length < 5) {
                    mismatches.push({ x, y, z, actual: block ? block.name : 'unloaded' });
                }
            }
        }
    }
    const missing = total - correct;
    const pct = total === 0 ? 100 : Math.round((correct / total) * 1000) / 10;
    const complete = missing === 0;
    // Record the latest outcome so !endGoal can refuse a completion claim that the world
    // does not support (see actions.js '!endGoal').
    bot.last_verification = { complete, correct, total, pct, blockType, at: Date.now() };
    let summary = `VERIFIED: ${correct}/${total} blocks are ${blockType} (${pct}%).`;
    if (!complete) {
        const examples = mismatches
            .map(m => `(${m.x},${m.y},${m.z})=${m.actual}`)
            .join(', ');
        summary += ` NOT COMPLETE - ${missing} block(s) wrong or missing, e.g. ${examples}.`
            + ` Do NOT report this as finished; fix the remaining blocks.`;
    }
    return { total, correct, missing, pct, complete, summary, mismatches };
}

// Keep coverArea as alias for backward compatibility
export async function coverArea(bot, blockType, x1, z1, x2, z2, y) {
    return fill(bot, blockType, x1, z1, x2, z2, y, 1);
}

export async function plantTreeGrid(bot, saplingType, x1, z1, x2, z2, spacing = 4) {
    /**
     * Plant saplings in a grid pattern with specified spacing.
     * Automatically detects ground level at each spot (no need for y coordinate).
     * Automatically skips spots with existing saplings or grown trees (resumable).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} saplingType, the type of sapling to plant (e.g., "oak_sapling", "birch_sapling").
     * @param {number} x1, the x coordinate of the first corner.
     * @param {number} z1, the z coordinate of the first corner.
     * @param {number} x2, the x coordinate of the second corner.
     * @param {number} z2, the z coordinate of the second corner.
     * @param {number} spacing, the gap between saplings (default 4 blocks).
     * @returns {Promise<number>} the number of saplings successfully planted.
     * @example
     * // Plant oak saplings in a 64x64 area with 4 block gaps
     * await skills.plantTreeGrid(bot, "oak_sapling", 0, 0, 64, 64, 4);
     **/
    const minX = Math.min(Math.floor(x1), Math.floor(x2));
    const maxX = Math.max(Math.floor(x1), Math.floor(x2));
    const minZ = Math.min(Math.floor(z1), Math.floor(z2));
    const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
    const gap = Math.max(1, Math.floor(spacing));
    const botY = Math.floor(bot.entity.position.y);

    // Normalize sapling name
    let sapling = saplingType;
    if (!sapling.endsWith('_sapling')) {
        sapling = sapling + '_sapling';
    }

    const plantableBlocks = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'moss_block', 'mud', 'muddy_mangrove_roots'];
    const airBlocks = ['air', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'snow'];

    // Helper function to find ground level at a given x,z
    function findGroundLevel(x, z) {
        // Search from bot's Y level, up to 20 blocks up or down
        for (let yOffset = 0; yOffset <= 20; yOffset++) {
            // Check above bot first
            for (const dir of [1, -1]) {
                const checkY = botY + (yOffset * dir);
                if (checkY < -64 || checkY > 320) continue;

                const blockAt = bot.blockAt(new Vec3(x, checkY, z));
                const blockBelow = bot.blockAt(new Vec3(x, checkY - 1, z));

                if (blockAt && blockBelow) {
                    // Found ground: air above plantable block
                    if (airBlocks.includes(blockAt.name) && plantableBlocks.includes(blockBelow.name)) {
                        return { y: checkY, ground: blockBelow.name };
                    }
                    // Found existing sapling
                    if (blockAt.name.includes('sapling')) {
                        return { y: checkY, existing: 'sapling' };
                    }
                    // Found tree trunk
                    if (blockAt.name.includes('_log')) {
                        return { y: checkY, existing: 'tree' };
                    }
                }
            }
        }
        return null;
    }

    // Scan the grid first
    let alreadyPlanted = 0;
    let grownTrees = 0;
    let needsPlanting = [];
    let unplantable = 0;

    log(bot, `Scanning grid from (${minX}, ${minZ}) to (${maxX}, ${maxZ}) with ${gap} block spacing...`);

    for (let x = minX; x <= maxX; x += gap + 1) {
        for (let z = minZ; z <= maxZ; z += gap + 1) {
            const ground = findGroundLevel(x, z);

            if (!ground) {
                unplantable++;
            } else if (ground.existing === 'sapling') {
                alreadyPlanted++;
            } else if (ground.existing === 'tree') {
                grownTrees++;
            } else {
                needsPlanting.push({ x, z, y: ground.y });
            }
        }
    }

    const totalSpots = alreadyPlanted + grownTrees + needsPlanting.length + unplantable;

    log(bot, `Scan complete: ${alreadyPlanted} saplings, ${grownTrees} grown trees, ${needsPlanting.length} plantable spots, ${unplantable} unplantable.`);

    if (needsPlanting.length === 0) {
        log(bot, `Tree grid from (${minX}, ${minZ}) to (${maxX}, ${maxZ}) is already fully planted/grown!`);
        return 0;
    }

    log(bot, `Planting ${sapling} at ${needsPlanting.length} spots...`);

    let plantedCount = 0;
    for (const pos of needsPlanting) {
        if (bot.interrupt_code) {
            log(bot, `Tree planting interrupted at (${pos.x}, ${pos.z}). Planted ${plantedCount}/${needsPlanting.length}. Run same command to resume.`);
            return plantedCount;
        }

        const success = await placeBlockWithTimeout(bot, sapling, pos.x, pos.y, pos.z, 'bottom');
        if (success) {
            plantedCount++;
        }

        // Progress update every 5 saplings
        if (plantedCount % 5 === 0 && plantedCount > 0) {
            log(bot, `Progress: ${plantedCount}/${needsPlanting.length} saplings planted.`);
        }
    }

    log(bot, `Finished planting. Placed ${plantedCount} ${sapling}. Total in grid: ${alreadyPlanted + grownTrees + plantedCount} trees/saplings.`);
    return plantedCount;
}

export function scanArea(bot, x1, z1, x2, z2, y = null) {
    /**
     * Scan a rectangular area and report what blocks are present.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x1, the x coordinate of the first corner.
     * @param {number} z1, the z coordinate of the first corner.
     * @param {number} x2, the x coordinate of the second corner.
     * @param {number} z2, the z coordinate of the second corner.
     * @param {number} y, optional y coordinate. If null, scans at bot's height.
     * @returns {object} summary of blocks found in the area.
     **/
    const minX = Math.min(Math.floor(x1), Math.floor(x2));
    const maxX = Math.max(Math.floor(x1), Math.floor(x2));
    const minZ = Math.min(Math.floor(z1), Math.floor(z2));
    const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
    const scanY = y !== null ? Math.floor(y) : Math.floor(bot.entity.position.y);

    const blockCounts = {};
    let totalBlocks = 0;

    for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
            const block = bot.blockAt(new Vec3(x, scanY, z));
            if (block) {
                blockCounts[block.name] = (blockCounts[block.name] || 0) + 1;
                totalBlocks++;
            }
        }
    }

    // Sort by count descending
    const sorted = Object.entries(blockCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10); // Top 10 blocks

    return {
        area: { minX, maxX, minZ, maxZ, y: scanY },
        size: { width: maxX - minX + 1, length: maxZ - minZ + 1 },
        totalBlocks,
        blockCounts: Object.fromEntries(sorted),
        topBlocks: sorted
    };
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

// ============= STORAGE CONTAINERS =============
//
// All container IO goes through library/chest.js. Nothing in this file may call
// bot.openContainer directly: that call has no timeout and has killed the process
// (see the header of chest.js for the three hangs it fixes). The functions here are
// policy - which container, which items, what to say - and chest.js is mechanism.

/** Nearest openable container, or null. Sorted by real distance. */
function getNearestStorageContainer(bot, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    const found = chest.findContainers(bot, range, 10);
    return found.length ? found[0].block : null;
}

/** Resolve the container a command should act on, or return {error} with a reason to print. */
function resolveContainer(bot, x, y, z, verb = 'use') {
    if (x !== null && y !== null && z !== null) {
        const hit = chest.containerAt(bot, x, y, z);
        if (!hit) {
            const b = bot.blockAt(new Vec3(x, y, z));
            return { error: `No storage container at (${x}, ${y}, ${z}) - there is ${b ? `a ${b.name}` : 'nothing loaded'} there.` };
        }
        if (hit.unopenable) {
            return { error: `A ${hit.unopenable} at (${x}, ${y}, ${z}) has no inventory screen; I cannot ${verb} it.` };
        }
        return { block: hit.block };
    }
    const near = getNearestStorageContainer(bot, CONSTANTS.DEFAULT_SEARCH_RANGE);
    if (!near) {
        return { error: `Could not find any storage container within ${CONSTANTS.DEFAULT_SEARCH_RANGE} blocks. Place a chest, barrel or shulker box nearby.` };
    }
    return { block: near };
}

export function listNearbyChests(bot, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    return chest.findContainers(bot, range, 50);
}

export async function putInChest(bot, itemName, num=-1, x=null, y=null, z=null) {
    /**
     * Put the given item in a storage container.
     * Reports what ACTUALLY moved, measured from the inventory, not what was requested.
     * @returns {Promise<boolean>} true if any item was deposited.
     **/
    const target = resolveContainer(bot, x, y, z, 'put items in');
    if (target.error) { log(bot, target.error); return false; }

    const held = bot.inventory.items().filter(i => i.name === itemName);
    if (held.length === 0) {
        const similar = bot.inventory.items().filter(i => i.name.includes(itemName.split('_')[0])).map(i => i.name);
        const summary = bot.inventory.items().sort((a, b) => b.count - a.count).slice(0, 10)
            .map(i => `${i.name}(${i.count})`).join(', ');
        let msg = `You do not have any ${itemName} in inventory.`;
        if (similar.length) msg += ` Similar: ${[...new Set(similar)].join(', ')}.`;
        if (summary) msg += ` You have: ${summary}`;
        log(bot, msg);
        return false;
    }

    const res = await chest.withContainer(bot, target.block, async (ctx) => {
        const r = await ctx.deposit(itemName, num);
        return { ...r, type: ctx.type, used: ctx.usedSlots(), total: ctx.totalSlots };
    }, { fallback: goToPosition });

    if (!res.ok) { log(bot, chest.explainFailure(res, `(${target.block.position.x}, ${target.block.position.y}, ${target.block.position.z})`)); return false; }

    const { moved, asked, reason, type, used, total } = res.value;
    if (moved === 0) {
        // Name the actual reason. "The chest is full" was printed for every zero, including
        // `none_held` - so asking the bot to store an item it was not carrying reported a
        // problem with the CHEST, and every later diagnosis started from the wrong end.
        const why = reason === 'none_held' ? `I am not carrying any ${itemName}`
            : reason === 'timeout'         ? `the ${type} is not responding`
            :                                `the ${type} is full`;
        log(bot, `Could not deposit any ${itemName}: ${why}.`);
        return false;
    }
    const left = bot.inventory.items().filter(i => i.name === itemName).reduce((s, i) => s + i.count, 0);
    if (moved < asked) {
        log(bot, `Deposited ${moved}/${asked} ${itemName} in ${type} (${used}/${total} slots). ${left} left in inventory.`);
    } else {
        log(bot, `Successfully put ${moved} ${itemName} in ${type}. (${used}/${total} slots used)`);
    }
    return true;
}

export async function takeFromChest(bot, itemName, num=-1, x=null, y=null, z=null) {
    /**
     * Take the given item from a storage container.
     * The count reported is measured from the inventory: the old version added up what it
     * asked for, so a full bag reported a successful withdrawal of nothing.
     **/
    const target = resolveContainer(bot, x, y, z, 'take items from');
    if (target.error) { log(bot, target.error); return false; }

    const res = await chest.withContainer(bot, target.block, async (ctx) => {
        const present = ctx.contents();
        if (!present.some(i => i.name === itemName)) {
            const available = [...new Set(present.map(i => i.name))];
            return { missing: true, available, type: ctx.type };
        }
        const r = await ctx.withdraw(itemName, num);
        return { ...r, type: ctx.type };
    }, { fallback: goToPosition });

    if (!res.ok) { log(bot, chest.explainFailure(res, `(${target.block.position.x}, ${target.block.position.y}, ${target.block.position.z})`)); return false; }

    const v = res.value;
    if (v.missing) {
        if (v.available.length === 0) log(bot, `The ${v.type} is empty.`);
        else log(bot, `Could not find ${itemName} in the ${v.type}. Available: ${v.available.slice(0, 5).join(', ')}${v.available.length > 5 ? '...' : ''}`);
        return false;
    }
    if (v.moved === 0) {
        log(bot, v.reason === 'inventory_full'
            ? `Could not take ${itemName}: my inventory is full.`
            : v.reason === 'timeout'
            ? `Could not take ${itemName}: the ${v.type} is not responding.`
            : `Could not take any ${itemName} from the ${v.type} (${v.reason}).`);
        return false;
    }
    if (v.moved < v.asked) {
        log(bot, `Took ${v.moved}/${v.asked} ${itemName} from the ${v.type} - inventory ran out of room.`);
    } else {
        log(bot, `Successfully took ${v.moved} ${itemName} from the ${v.type}.`);
    }
    return true;
}

export async function viewChest(bot, x=null, y=null, z=null) {
    /** View the contents of a storage container. */
    const target = resolveContainer(bot, x, y, z, 'look inside');
    if (target.error) { log(bot, target.error); return false; }

    const res = await chest.withContainer(bot, target.block, async (ctx) => ({
        items: ctx.contents().map(i => ({ name: i.name, count: i.count })),
        type: ctx.type, total: ctx.totalSlots,
    }), { fallback: goToPosition });

    if (!res.ok) { log(bot, chest.explainFailure(res, `(${target.block.position.x}, ${target.block.position.y}, ${target.block.position.z})`)); return false; }

    const { items, type, total } = res.value;
    if (items.length === 0) {
        log(bot, `The ${type} is empty. (0/${total} slots used)`);
    } else {
        log(bot, `The ${type} contains (${items.length}/${total} slots used, ${total - items.length} empty):`);
        for (const item of items) log(bot, `${item.count} ${item.name}`);
    }
    return true;
}

/** Items that stay in the bag no matter what. */
const ALWAYS_KEEP = ['netherite_pickaxe', 'netherite_sword', 'netherite_axe', 'netherite_shovel',
                     'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel'];
const isWornArmor = name => name.includes('helmet') || name.includes('chestplate')
                         || name.includes('leggings') || name.includes('boots');

/**
 * What may be deposited, AGGREGATED BY NAME - one entry per item type, not per slot.
 *
 * Per-slot is wrong and it costs a chest: 200 cobblestone occupies four slots, the first
 * deposit moves all four stacks, and the next three entries then find nothing left to deposit.
 * A deposit of zero is indistinguishable from a full container, so the loop declares the chest
 * full and walks to the next one with a bag that is already empty.
 */
function depositableItems(bot, keepItems) {
    const byName = new Map();
    for (const i of bot.inventory.items()) {
        if (keepItems.has(i.name) || isWornArmor(i.name)) continue;
        byName.set(i.name, (byName.get(i.name) ?? 0) + i.count);
    }
    return [...byName].map(([name, count]) => ({ name, count }));
}

export async function depositAllItems(bot, excludeItems = [], x=null, y=null, z=null) {
    /**
     * Deposit everything except tools and worn armour, spilling into further containers when
     * one fills up. A container that cannot be opened is SKIPPED with its reason logged, not
     * retried forever - that is the difference between "this chest is blocked" and a hung bot.
     **/
    const keepItems = new Set([...excludeItems, ...ALWAYS_KEEP]);
    const hasSpecificLocation = x !== null && y !== null && z !== null;
    const used = new Set();
    const failures = [];
    let totalDeposited = 0;
    const depositedTypes = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        if (bot.interrupt_code) break;
        if (depositableItems(bot, keepItems).length === 0) break;

        let block = null;
        if (attempt === 0 && hasSpecificLocation) {
            const target = resolveContainer(bot, x, y, z, 'deposit into');
            if (target.error) { log(bot, target.error); return false; }
            block = target.block;
            used.add(`${x},${y},${z}`);
        } else {
            for (const c of chest.findContainers(bot, CONSTANTS.DEFAULT_SEARCH_RANGE, 10)) {
                const key = `${c.position.x},${c.position.y},${c.position.z}`;
                if (used.has(key)) continue;
                block = c.block; used.add(key); break;
            }
        }
        if (!block) {
            if (attempt === 0) { log(bot, `Could not find any storage container nearby.`); return false; }
            break;
        }

        const pos = block.position;
        const res = await chest.withContainer(bot, block, async (ctx) => {
            // A double chest is one inventory behind two blocks; without this the second half
            // is visited as a "fresh" container and reported full all over again.
            if (ctx.isDouble) {
                for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                    const n = bot.blockAt(new Vec3(pos.x+dx, pos.y, pos.z+dz));
                    if (n && (n.name === 'chest' || n.name === 'trapped_chest')) {
                        used.add(`${pos.x+dx},${pos.y},${pos.z+dz}`); break;
                    }
                }
            }
            let moved = 0, full = false;
            for (const item of depositableItems(bot, keepItems)) {
                if (bot.interrupt_code) break;
                const r = await ctx.deposit(item.name, item.count);
                moved += r.moved;
                if (r.moved > 0) { depositedTypes.push(item.name); continue; }
                // Nothing held is not a full chest - it just means another entry already moved
                // it. Only a refusal by the container ends this chest's turn.
                if (r.reason === 'none_held') continue;
                full = true; break;
            }
            return { moved, full, type: ctx.type };
        }, { fallback: goToPosition });

        if (!res.ok) {
            failures.push(chest.explainFailure(res, `(${pos.x}, ${pos.y}, ${pos.z})`));
            continue; // try the next container rather than giving up
        }
        totalDeposited += res.value.moved;
        if (!res.value.full) break;
        log(bot, `${res.value.type} at (${pos.x}, ${pos.y}, ${pos.z}) is full, trying the next one...`);
    }

    for (const f of failures) log(bot, f);
    if (totalDeposited === 0) {
        log(bot, failures.length ? `Deposited nothing - no container I could open had room.`
                                 : `No items to deposit (or all items are in the keep list).`);
        return false;
    }
    log(bot, `Deposited ${totalDeposited} items (${new Set(depositedTypes).size} types) total.`);
    return true;
}

// ============= CHEST MASTER SYSTEM =============
//
// Names and persistence only. Every open below goes through chest.withContainer via the
// functions above, so a named chest that has been broken, buried or blocked reports that
// instead of hanging.

const namedChests = new Map();
let saveNamedChestsCallback = null;

export function setNamedChestsSaveCallback(callback) {
    saveNamedChestsCallback = callback;
}

export function getNamedChestsJson() {
    const result = {};
    for (const [key, value] of namedChests.entries()) result[key] = value;
    return result;
}

export function loadNamedChestsFromJson(json) {
    namedChests.clear();
    if (json && typeof json === 'object') {
        for (const [key, value] of Object.entries(json)) namedChests.set(key, value);
        console.log(`[ChestMaster] Loaded ${namedChests.size} named chests`);
    }
}

export function loadNamedChestsFromFile(filePath) {
    try {
        if (existsSync(filePath)) {
            const data = JSON.parse(readFileSync(filePath, 'utf8'));
            if (data.named_chests) loadNamedChestsFromJson(data.named_chests);
        }
    } catch (error) {
        console.log(`[ChestMaster] Could not load named chests: ${error.message}`);
    }
}

export function nameChest(bot, name, x, y, z) {
    const hit = chest.containerAt(bot, x, y, z);
    if (!hit) { log(bot, `No storage container found at (${x}, ${y}, ${z}). Cannot name it.`); return false; }
    if (hit.unopenable) { log(bot, `A ${hit.unopenable} cannot be used as a storage chest.`); return false; }
    const key = `chest:${name.toLowerCase()}`;
    namedChests.set(key, { x, y, z, type: hit.block.name });
    log(bot, `Named the ${hit.block.name} at (${x}, ${y}, ${z}) as "${name}".`);
    if (saveNamedChestsCallback) saveNamedChestsCallback();
    return true;
}

export function getNamedChest(name) {
    return namedChests.get(`chest:${name.toLowerCase()}`) || null;
}

export function listNamedChests(bot) {
    const chests = [];
    for (const [key, value] of namedChests.entries()) {
        if (key.startsWith('chest:')) chests.push({ name: key.substring(6), ...value });
    }
    if (chests.length === 0) {
        log(bot, `No named chests. Use !chestName to name a chest first.`);
    } else {
        log(bot, `Named chests (${chests.length}):`);
        for (const c of chests) log(bot, `  "${c.name}" - ${c.type} at (${c.x}, ${c.y}, ${c.z})`);
    }
    return chests;
}

export function forgetChest(bot, name) {
    const key = `chest:${name.toLowerCase()}`;
    if (namedChests.has(key)) {
        namedChests.delete(key);
        log(bot, `Forgot chest named "${name}".`);
        if (saveNamedChestsCallback) saveNamedChestsCallback();
        return true;
    }
    log(bot, `No chest named "${name}" to forget.`);
    return false;
}

// Item category definitions for auto-sorting
const ITEM_CATEGORIES = {
    ores: ['iron_ingot', 'gold_ingot', 'diamond', 'emerald', 'coal', 'copper_ingot', 'netherite_ingot',
           'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'coal_ore', 'copper_ore', 'lapis_lazuli',
           'redstone', 'quartz', 'raw_iron', 'raw_gold', 'raw_copper', 'ancient_debris', 'amethyst_shard'],
    building: ['cobblestone', 'stone', 'granite', 'diorite', 'andesite', 'dirt', 'sand', 'gravel',
               'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
               'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
               'stone_bricks', 'bricks', 'glass', 'glass_pane', 'terracotta', 'concrete', 'wool',
               'deepslate', 'calcite', 'tuff', 'smooth_stone', 'polished_granite', 'polished_diorite', 'polished_andesite'],
    food: ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit',
           'cooked_salmon', 'cooked_cod', 'bread', 'apple', 'golden_apple', 'enchanted_golden_apple',
           'carrot', 'golden_carrot', 'potato', 'baked_potato', 'beetroot', 'melon_slice',
           'pumpkin_pie', 'cookie', 'cake', 'sweet_berries', 'glow_berries', 'honey_bottle'],
    tools: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
            'wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe', 'netherite_axe',
            'wooden_shovel', 'stone_shovel', 'iron_shovel', 'golden_shovel', 'diamond_shovel', 'netherite_shovel',
            'wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe', 'netherite_hoe',
            'shears', 'flint_and_steel', 'fishing_rod', 'compass', 'clock', 'spyglass'],
    weapons: ['wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword',
              'bow', 'crossbow', 'trident', 'arrow', 'spectral_arrow', 'tipped_arrow', 'shield'],
    armor: ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
            'chainmail_helmet', 'chainmail_chestplate', 'chainmail_leggings', 'chainmail_boots',
            'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
            'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
            'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
            'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots', 'turtle_helmet', 'elytra']
};

function getItemCategory(itemName) {
    for (const [category, items] of Object.entries(ITEM_CATEGORIES)) {
        if (items.includes(itemName)) return category;
    }
    for (const [category, items] of Object.entries(ITEM_CATEGORIES)) {
        for (const item of items) {
            if (itemName.includes(item.split('_')[0]) || item.includes(itemName.split('_')[0])) return category;
        }
    }
    return 'misc';
}

export async function depositAllSorted(bot, excludeItems = []) {
    /** Auto-sort inventory into named chests by category. */
    const keepItems = new Set([...excludeItems, ...ALWAYS_KEEP]);

    const chestsByCategory = {};
    for (const [key, value] of namedChests.entries()) {
        if (key.startsWith('chest:')) chestsByCategory[key.substring(6)] = value;
    }
    if (Object.keys(chestsByCategory).length === 0) {
        log(bot, `No named chests configured. Use !chestName first (e.g. !chestName("ores", x, y, z)).`);
        return { success: false, deposits: [] };
    }

    const itemsByCategory = {};
    for (const item of depositableItems(bot, keepItems)) {
        const category = getItemCategory(item.name);
        (itemsByCategory[category] ??= []).push({ name: item.name, count: item.count });
    }

    let totalDeposited = 0;
    const depositedByCategory = {};
    const deposits = [];

    for (const [category, items] of Object.entries(itemsByCategory)) {
        if (bot.interrupt_code) break;
        const target = chestsByCategory[category]
            ?? chestsByCategory['misc'] ?? chestsByCategory['other'] ?? chestsByCategory['dump'];
        if (!target) continue;
        const label = chestsByCategory[category] ? category : 'misc';

        const hit = chest.containerAt(bot, target.x, target.y, target.z);
        if (!hit || hit.unopenable) {
            log(bot, `Chest "${label}" at (${target.x}, ${target.y}, ${target.z}) is not there any more.`);
            continue;
        }

        const res = await chest.withContainer(bot, hit.block, async (ctx) => {
            let moved = 0;
            const placed = [];
            for (const item of items) {
                if (bot.interrupt_code) break;
                const r = await ctx.deposit(item.name, item.count);
                moved += r.moved;
                if (r.moved > 0) { placed.push({ name: item.name, count: r.moved }); continue; }
                if (r.reason === 'none_held') continue;
                log(bot, `The ${label} chest is full.`);
                break;
            }
            return { moved, placed };
        }, { fallback: goToPosition });

        if (!res.ok) { log(bot, chest.explainFailure(res, `the "${label}" chest`)); continue; }
        if (res.value.moved === 0) continue;

        totalDeposited += res.value.moved;
        depositedByCategory[label] = (depositedByCategory[label] || 0) + res.value.moved;
        deposits.push({ chestName: label, location: { x: target.x, y: target.y, z: target.z }, items: res.value.placed });
    }

    if (totalDeposited === 0) {
        log(bot, `Sorted nothing - no items to sort, or no category chest could take them.`);
        return { success: false, deposits: [] };
    }
    log(bot, `Auto-sorted ${totalDeposited} items. ${Object.entries(depositedByCategory).map(([c, n]) => `${c}: ${n}`).join(', ')}`);
    return { success: true, deposits, totalDeposited };
}

export async function findItemInChests(bot, itemName, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    /** Search every reachable container in range for an item. Unopenable ones are reported, not retried. */
    const containers = chest.findContainers(bot, range, 50);
    if (containers.length === 0) {
        log(bot, `No storage containers found within ${range} blocks.`);
        return [];
    }

    const results = [];
    const skipped = [];
    const startPos = bot.entity.position.clone();

    for (const c of containers) {
        if (bot.interrupt_code) break;
        const res = await chest.withContainer(bot, c.block, async (ctx) => {
            const matching = ctx.contents().filter(i => i.name === itemName || i.name.includes(itemName));
            return matching.reduce((s, i) => s + i.count, 0);
        }, { fallback: goToPosition });

        if (!res.ok) { skipped.push(`${c.type} at (${c.position.x}, ${c.position.y}, ${c.position.z}): ${res.detail}`); continue; }
        if (res.value > 0) results.push({ position: c.position, type: c.type, count: res.value, distance: c.distance });
    }

    if (!bot.interrupt_code) await goToPosition(bot, startPos.x, startPos.y, startPos.z, 1);

    if (results.length === 0) {
        log(bot, `Could not find "${itemName}" in any of the ${containers.length - skipped.length} containers I could open.`);
    } else {
        log(bot, `Found ${results.reduce((s, r) => s + r.count, 0)} "${itemName}" in ${results.length} container(s):`);
        for (const r of results) log(bot, `  ${r.count}x in ${r.type} at (${r.position.x}, ${r.position.y}, ${r.position.z})`);
    }
    if (skipped.length) log(bot, `Skipped ${skipped.length} container(s) I could not open: ${skipped.slice(0, 3).join('; ')}`);
    return results;
}

/**
 * Move items from one container to another.
 *
 * **The source is never emptied on spec.** The first version withdrew everything it could and
 * only then walked to the destination - so a transfer into a FULL chest left the source at 0/27,
 * 1728 items stranded in the bot's bag, and a cheerful "Transferred 0 items". Measured exactly
 * like that. Three things make that impossible now:
 *
 * - the destination's free space is measured FIRST, and the withdraw is bounded by it;
 * - whatever the destination would not take is PUT BACK in the source before returning;
 * - the round trip repeats while progress is being made, so `("all", -1)` really does move
 *   everything even when the bag can only carry part of it at a time.
 *
 * The cost is more container opens, which are bounded and cheap; the alternative is a bot that
 * strips a chest and wanders off holding the contents.
 */
export async function transferBetweenChests(bot, itemName, num, fromX, fromY, fromZ, toX, toY, toZ) {
    const src = resolveContainer(bot, fromX, fromY, fromZ, 'take items from');
    if (src.error) { log(bot, `Source: ${src.error}`); return false; }
    const dst = resolveContainer(bot, toX, toY, toZ, 'put items in');
    if (dst.error) { log(bot, `Destination: ${dst.error}`); return false; }

    const takeAll = String(itemName).toLowerCase() === 'all';
    const wants = (name) => takeAll || name === itemName || name.includes(itemName);
    const at = (p) => `(${p[0]}, ${p[1]}, ${p[2]})`;

    let budget = num === -1 || num == null ? Infinity : num;
    let movedTotal = 0, rounds = 0, stranded = [];
    let stopReason = null;

    // Bounded: each round must move something or we stop, so this is a progress guard rather
    // than a real iteration count. 8 rounds is 8 bagfuls, far more than any chest holds.
    while (rounds < 8 && budget > 0 && !bot.interrupt_code) {
        rounds++;

        // 1. How much will the destination actually take, and of what? Measured before anything
        //    leaves the source, because that is the whole point.
        const survey = await chest.withContainer(bot, dst.block, async (ctx) => ({
            room: (name, stackSize = 64) => chest.capacityFor({
                contents: ctx.contents(), totalSlots: ctx.totalSlots, itemName: name, stackSize,
            }).freeUnits,
            free: ctx.totalSlots - ctx.usedSlots(),
            type: ctx.type,
        }), { fallback: goToPosition });
        if (!survey.ok) { log(bot, `Destination: ${chest.explainFailure(survey, at([toX, toY, toZ]))}`); return false; }

        // 2. Take only what will fit, one item type at a time.
        const pickup = await chest.withContainer(bot, src.block, async (ctx) => {
            const names = [...new Set(ctx.contents().filter(i => wants(i.name)).map(i => i.name))];
            if (names.length === 0) return { taken: [], empty: true };
            const taken = [];
            for (const name of names) {
                if (budget <= 0 || bot.interrupt_code) break;
                const room = survey.value.room(name);
                if (room <= 0) continue;
                const want = Math.min(budget === Infinity ? room : budget, room);
                const r = await ctx.withdraw(name, want);
                if (r.moved > 0) { taken.push({ name, count: r.moved }); budget -= r.moved; }
                if (r.reason === 'inventory_full') break;
            }
            return { taken, empty: false };
        }, { fallback: goToPosition });
        if (!pickup.ok) { log(bot, `Source: ${chest.explainFailure(pickup, at([fromX, fromY, fromZ]))}`); return false; }

        if (pickup.value.empty) { stopReason = movedTotal ? null : 'source_empty'; break; }
        const taken = pickup.value.taken;
        if (taken.length === 0) { stopReason = movedTotal ? null : 'destination_full'; break; }

        // 3. Deposit, and find out what would not go in.
        const drop = await chest.withContainer(bot, dst.block, async (ctx) => {
            const left = [];
            let moved = 0;
            for (const t of taken) {
                if (bot.interrupt_code) break;
                const r = await ctx.deposit(t.name, t.count);
                moved += r.moved;
                if (r.moved < t.count) left.push({ name: t.name, count: t.count - r.moved });
            }
            return { moved, left };
        }, { fallback: goToPosition });
        if (!drop.ok) {
            // Carrying items with nowhere to put them: hand them back rather than wandering off
            // with a stripped chest behind us.
            stranded = taken;
            log(bot, `${chest.explainFailure(drop, at([toX, toY, toZ]))}`);
            break;
        }
        movedTotal += drop.value.moved;
        if (drop.value.left.length) { stranded = drop.value.left; stopReason = 'destination_full'; break; }
        if (drop.value.moved === 0) { stopReason = 'destination_full'; break; }
    }

    // 4. PUT BACK anything the destination refused. This is the invariant that makes every
    //    failure above harmless: items are either in a chest or in transit, never abandoned.
    let returned = 0;
    if (stranded.length) {
        const back = await chest.withContainer(bot, src.block, async (ctx) => {
            let n = 0;
            for (const t of stranded) n += (await ctx.deposit(t.name, t.count)).moved;
            return n;
        }, { fallback: goToPosition });
        returned = back.ok ? back.value : 0;
    }

    const tail = returned ? ` Put ${returned} back in the source.` : '';
    if (movedTotal === 0) {
        const why = stopReason === 'source_empty' ? `no ${takeAll ? 'items' : itemName} in the source container`
            : stopReason === 'destination_full' ? `the destination is full`
            : `nothing could be moved`;
        log(bot, `Transferred nothing from ${at([fromX, fromY, fromZ])} to ${at([toX, toY, toZ])}: ${why}.${tail}`);
        return false;
    }
    const short = stopReason === 'destination_full' ? ' The destination is now full.' : '';
    log(bot, `Transferred ${movedTotal} items from ${at([fromX, fromY, fromZ])} to ${at([toX, toY, toZ])}.${short}${tail}`);
    return true;
}

export async function putInNamedChest(bot, chestName, itemName, num = -1) {
    const c = getNamedChest(chestName);
    if (!c) { log(bot, `No chest named "${chestName}". Use !chestListNamed to see available chests.`); return false; }
    return await putInChest(bot, itemName, num, c.x, c.y, c.z);
}

export async function takeFromNamedChest(bot, chestName, itemName, num = -1) {
    const c = getNamedChest(chestName);
    if (!c) { log(bot, `No chest named "${chestName}". Use !chestListNamed to see available chests.`); return false; }
    return await takeFromChest(bot, itemName, num, c.x, c.y, c.z);
}

export async function viewNamedChest(bot, chestName) {
    const c = getNamedChest(chestName);
    if (!c) { log(bot, `No chest named "${chestName}". Use !chestListNamed to see available chests.`); return false; }
    return await viewChest(bot, c.x, c.y, c.z);
}

// ============= END CHEST MASTER SYSTEM =============

export async function eatIfHungry(bot, threshold = CONSTANTS.HUNGER_THRESHOLD) {
    /**
     * Eat food if hunger is below threshold.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} threshold, hunger level below which to eat (default 14 out of 20).
     * @returns {Promise<boolean>} true if food was consumed, false otherwise.
     * @example
     * await skills.eatIfHungry(bot);
     **/
    if (bot.food >= threshold) {
        return false; // Not hungry enough
    }
    
    // Food items sorted roughly by saturation/hunger restoration
    const goodFoods = ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop', 
                       'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'cooked_rabbit',
                       'cooked_cod', 'bread', 'baked_potato', 'mushroom_stew', 'beetroot_soup',
                       'rabbit_stew', 'pumpkin_pie', 'golden_carrot', 'apple', 'carrot',
                       'melon_slice', 'sweet_berries', 'glow_berries'];
    
    // Find best available food
    let foodToEat = null;
    for (const foodName of goodFoods) {
        const item = bot.inventory.findInventoryItem(foodName);
        if (item) {
            foodToEat = item;
            break;
        }
    }
    
    // Fallback: any food item
    if (!foodToEat) {
        foodToEat = bot.inventory.items().find(item => 
            item.name.includes('cooked') || item.name.includes('bread') || 
            item.name.includes('apple') || item.name.includes('carrot') ||
            item.name.includes('potato') || item.name.includes('stew') ||
            item.name.includes('pie') || item.name.includes('berries')
        );
    }
    
    if (!foodToEat) {
        log(bot, `Hungry (${bot.food}/20) but no food available in inventory.`);
        return false;
    }
    
    await bot.equip(foodToEat, 'hand');
    await bot.consume();
    log(bot, `Ate ${foodToEat.name}. Hunger now: ${bot.food}/20.`);
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    // Resolve player name with fuzzy matching
    const resolvedName = resolvePlayerName(bot, username);
    if (!resolvedName) {
        log(bot, `Could not find player "${username}". Nearby players: ${Object.keys(bot.players).filter(n => n !== bot.username).join(', ') || 'none'}`);
        return false;
    }
    username = resolvedName;
    
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

/**
 * Translate a mineflayer-pathfinder goal into a target our own navigator can steer at.
 *
 * THE POINT OF THIS SEAM. `settings.js` already blacklists `!goToCoordinates` with the note
 * "mineflayer-pathfinder ... cannot move this bot" - but the blacklist only hid the COMMANDS.
 * Every skill that walks somewhere still went through `goToGoal` -> `bot.pathfinder.goto`,
 * i.e. the same executor, reached by a different door. Measured with tools/pathfinder_probe.mjs:
 *
 *     plan:  status=success  nodes=3  in 6ms        <- planning is FINE
 *     goto:  timeout after 30.0s, moved 3.1 blocks  <- execution is not
 *
 * PLANNING is not the broken half, so `getPathTo` calls (world.isClearPath, the destructive /
 * non-destructive probe below) are left alone, and so are `stop()` / `setGoal(null)`, which
 * STAND pathfinder DOWN and are the cure rather than the disease.
 *
 * @returns {{x:number,y:number,z:number,dist:number,xzOnly:boolean}|null} null when the goal
 *   shape has no straightforward target - GoalInvert is "get AWAY from", not "go to".
 */
function navTargetFor(goal) {
    if (!goal) return null;
    const n = goal.constructor?.name;
    const range = goal.rangeSq != null ? Math.sqrt(goal.rangeSq) : 1;
    switch (n) {
        case 'GoalBlock':   return { x: goal.x, y: goal.y, z: goal.z, dist: 1, xzOnly: false };
        case 'GoalNear':    return { x: goal.x, y: goal.y, z: goal.z, dist: Math.max(1, range), xzOnly: false };
        case 'GoalXZ':      return { x: goal.x, y: 0, z: goal.z, dist: 1, xzOnly: true };
        case 'GoalNearXZ':  return { x: goal.x, y: 0, z: goal.z, dist: Math.max(1, range), xzOnly: true };
        case 'GoalFollow': {
            // Re-read the entity: a GoalFollow caches x/y/z at construction and the target moves.
            const e = goal.entity;
            const p = e?.position;
            if (!p) return null;
            return { x: p.x, y: p.y, z: p.z, dist: Math.max(1, range), xzOnly: false };
        }
        default: return null;   // GoalInvert and anything else: caller falls back
    }
}

/**
 * Walk to a pathfinder-shaped goal using OUR navigator.
 * Returns false when the goal shape is not expressible, so the caller can fall back.
 */
async function navToGoal(bot, goal, timeoutMs = 0, opts = {}) {
    const t = navTargetFor(goal);
    if (!t) return null;
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    const res = await nav.navigateTo(bot, { x: t.x, y: t.y, z: t.z }, {
        arriveDist: t.dist,
        goalXZOnly: t.xzOnly,
        ...opts,
    });
    if (Date.now() > deadline && !res.arrived) return false;
    return res.arrived;
}

export async function goToGoal(bot, goal, timeoutMs = 0) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {number} timeoutMs, optional cap on the walk itself (0 = unbounded).
     *   Callers on a per-block budget (e.g. placeBlock) should pass one, since goto()
     *   never resolves when no route exists.
     **/

    // OUR NAVIGATOR FIRST. Only goal shapes it cannot express (GoalInvert = "get away from")
    // fall through to the pathfinder path below, which is kept precisely for them.
    const doorCheckForNav = startDoorInterval(bot);
    try {
        const navResult = await navToGoal(bot, goal, timeoutMs);
        if (navResult !== null) return navResult;
    } finally {
        clearInterval(doorCheckForNav);
    }

    // NOTHING FALLS THROUGH HERE ANY MORE, so there is no pathfinder branch left to fall into.
    // What used to sit here built two `pf.Movements`, probed them with `getPathTo`, and then
    // executed with `bot.pathfinder.goto` - and that EXECUTOR cannot move this bot at all
    // (`onGround` reads false while the bot is provably standing, so it waits for a flag that
    // never arrives; measured: plan success in 6ms, goto timeout after 30s having moved 3.1
    // blocks). Every caller now constructs a `GoalFollow` or a `GoalNear`, both of which
    // `navTargetFor` translates, so the branch was dead weight that only made it look as though
    // there were still a working fallback.
    //
    // `GoalInvert` is the one shape the seam cannot express - it means "get AWAY from", so
    // there is no target to steer at - and `fleeFrom` supplies the missing heading instead.
    // Refuse in words rather than silently returning false: a bot that declines to move and
    // says nothing is indistinguishable from a bot that is stuck.
    log(bot, `I cannot walk to a ${goal?.constructor?.name ?? 'goal'} of that shape.`
        + ` "Get away from" is fleeFrom's job, not a walk target.`);
    return false;
}

let _doorInterval = null;

// `createSurfaceMovements` lived here: a pf.Movements tuned to keep long journeys out of caves
// (canDig off, maxDropDown 3, digCost 1000). Deleted with the executor it configured - the cost
// model that actually decides this now lives in nav.js DEFAULTS (digCost, dropCost, preferY /
// yBias), which is the one the A* planner reads.

function createSafeMovements(bot, options = {}) {
    /**
     * Create pathfinding movements that prioritize using doors over breaking blocks
     * @param {MinecraftBot} bot - reference to the minecraft bot
     * @param {Object} options - configuration options
     * @returns {pf.Movements} configured movements
     */
    const movements = new pf.Movements(bot);
    
    // High dig cost to discourage breaking blocks
    movements.digCost = options.digCost || 100;
    // High place cost to discourage building bridges over water
    movements.placeCost = options.placeCost || 50;
    
    // Don't break important blocks
    const dontBreakBlocks = [
        'door', 'oak_door', 'spruce_door', 'birch_door', 'jungle_door',
        'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door',
        'bamboo_door', 'crimson_door', 'warped_door', 'iron_door',
        ...BLOCK_TYPES.glass,  // All glass and stained glass variants
        'glass_pane', 'white_stained_glass_pane', 'orange_stained_glass_pane',
        'magenta_stained_glass_pane', 'light_blue_stained_glass_pane',
        'yellow_stained_glass_pane', 'lime_stained_glass_pane', 'pink_stained_glass_pane',
        'gray_stained_glass_pane', 'light_gray_stained_glass_pane', 'cyan_stained_glass_pane',
        'purple_stained_glass_pane', 'blue_stained_glass_pane', 'brown_stained_glass_pane',
        'green_stained_glass_pane', 'red_stained_glass_pane', 'black_stained_glass_pane',
        'stone_bricks', 'cobblestone',
        'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks', 'fence_gate', 'oak_fence_gate',
        'spruce_fence_gate', 'birch_fence_gate', 'jungle_fence_gate',
        'acacia_fence_gate', 'dark_oak_fence_gate', 'mangrove_fence_gate',
        'cherry_fence_gate', 'bamboo_fence_gate', 'crimson_fence_gate', 'warped_fence_gate',
        // All fence blocks - don't break player-built fences
        'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence',
        'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
        'bamboo_fence', 'crimson_fence', 'warped_fence', 'nether_brick_fence'
    ];
    
    for (let block of dontBreakBlocks) {
        const blockId = mc.getBlockId(block);
        if (blockId) movements.blocksCantBreak.add(blockId);
    }
    
    // Apply any custom options
    if (options.canDig === false) movements.canDig = false;
    if (options.canPlaceOn === false) movements.canPlaceOn = false;
    if (options.allow1by1towers === false) movements.allow1by1towers = false;
    if (options.dontMineUnderFallingBlock !== undefined) movements.dontMineUnderFallingBlock = options.dontMineUnderFallingBlock;
    if (options.dontCreateFlow !== undefined) movements.dontCreateFlow = options.dontCreateFlow;

    return movements;
}

/**
 * Find carpet blocks placed on top of fences nearby (within 4 blocks)
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @returns {Object|null} - {carpet: Block, fence: Block, jumpPos: Vec3} or null if not found
 */
function findCarpetOnFence(bot) {
    const searchRadius = 4;
    const botPos = bot.entity.position;

    // List of fence block names
    const fenceNames = [
        'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence',
        'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
        'bamboo_fence', 'crimson_fence', 'warped_fence', 'nether_brick_fence'
    ];

    // Search nearby blocks for fence + carpet combo
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        for (let dz = -searchRadius; dz <= searchRadius; dz++) {
            for (let dy = -1; dy <= 2; dy++) {
                const checkPos = botPos.offset(dx, dy, dz);
                const block = bot.blockAt(checkPos);

                if (block && fenceNames.includes(block.name)) {
                    // Found a fence, check if there's carpet on top
                    const abovePos = checkPos.offset(0, 1, 0);
                    const aboveBlock = bot.blockAt(abovePos);

                    if (aboveBlock && aboveBlock.name.includes('carpet')) {
                        // Found carpet on fence! Calculate approach position
                        const dist = botPos.distanceTo(checkPos);
                        if (dist < searchRadius) {
                            console.log(`[FENCE_HELPER] Found carpet (${aboveBlock.name}) on fence at ${checkPos}`);
                            return {
                                carpet: aboveBlock,
                                fence: block,
                                fencePos: checkPos,
                                carpetPos: abovePos
                            };
                        }
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Attempt to jump over a fence using carpet placed on top
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {Object} carpetInfo - {carpet, fence, fencePos, carpetPos} from findCarpetOnFence
 */
async function attemptCarpetFenceJump(bot, carpetInfo) {
    const { fencePos, carpetPos } = carpetInfo;
    const botPos = bot.entity.position;

    // Calculate direction to fence
    const dx = fencePos.x - botPos.x;
    const dz = fencePos.z - botPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > 3) {
        // Too far, need to get closer first - let pathfinder handle approach
        console.log(`[FENCE_HELPER] Carpet-fence too far (${dist.toFixed(1)} blocks), waiting for approach`);
        return;
    }

    console.log(`[FENCE_HELPER] Attempting carpet-fence jump at ${fencePos}`);

    // Look at the carpet position
    await bot.lookAt(carpetPos.offset(0.5, 0.5, 0.5));

    // Move towards the fence
    const dirX = dx / dist;
    const dirZ = dz / dist;

    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);

    // Wait a bit then jump
    setTimeout(() => {
        bot.setControlState('jump', true);
        console.log(`[FENCE_HELPER] Jumping onto carpet at ${carpetPos}`);

        // Release controls after jump
        setTimeout(() => {
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
        }, 400);
    }, 200);
}

function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 800) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            let foundGateOrDoor = false;
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor')))
                {
                    bot.activateBlock(block);
                    foundGateOrDoor = true;
                    break;
                }
            }

            // If no gate/door found, try carpet-on-fence jump as fallback
            if (!foundGateOrDoor) {
                const carpetOnFence = findCarpetOnFence(bot);
                if (carpetOnFence) {
                    attemptCarpetFenceJump(bot, carpetOnFence);
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

/**
 * Get surface Y coordinate at given X, Z position
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} x - x coordinate
 * @param {number} z - z coordinate
 * @returns {number} surface Y level
 */
function getSurfaceY(bot, x, z) {
    // Start from high and find first solid block
    for (let y = 100; y > 0; y--) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava' &&
            !block.name.includes('leaves') && !block.name.includes('log')) {
            return y + 1;
        }
    }
    return 64; // Default to sea level
}

/**
 * Check if bot is currently underground (in a cave)
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @returns {boolean} true if underground
 */
function isUnderground(bot) {
    const pos = bot.entity.position;
    // Check if there's solid blocks above the bot (cave ceiling)
    let solidAbove = 0;
    for (let y = Math.floor(pos.y) + 2; y < Math.floor(pos.y) + 10; y++) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (block && block.name !== 'air' && block.name !== 'water' && !block.name.includes('leaves')) {
            solidAbove++;
        }
    }
    // If more than 3 solid blocks above within 10 blocks, likely in a cave
    return solidAbove >= 3;
}

export async function goToPosition(bot, x, y, z, min_distance=2, sprint=false) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} min_distance, the distance to keep from the position. Defaults to 2.
     * @param {boolean} sprint, whether to sprint while moving. Defaults to false.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }

    // Calculate horizontal distance
    const botPos = bot.entity.position;
    const horizontalDistance = Math.sqrt(Math.pow(x - botPos.x, 2) + Math.pow(z - botPos.z, 2));
    const LONG_DISTANCE_THRESHOLD = 100;
    const WAYPOINT_INTERVAL = 50;

    // For long distances, use surface-aware waypoint navigation
    if (horizontalDistance > LONG_DISTANCE_THRESHOLD) {
        log(bot, `Long distance travel (${Math.round(horizontalDistance)} blocks), using surface navigation...`);

        // Calculate direction vector
        const dx = x - botPos.x;
        const dz = z - botPos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const dirX = dx / dist;
        const dirZ = dz / dist;

        // Create waypoints along the path
        const numWaypoints = Math.floor(horizontalDistance / WAYPOINT_INTERVAL);

        // Use surface movements for long distance

        for (let i = 1; i <= numWaypoints; i++) {
            if (bot.interrupt_code) {
                log(bot, `Navigation interrupted.`);
                return false;
            }

            const waypointX = Math.floor(botPos.x + dirX * WAYPOINT_INTERVAL * i);
            const waypointZ = Math.floor(botPos.z + dirZ * WAYPOINT_INTERVAL * i);

            // Check if we're getting close to destination
            const remainingDist = Math.sqrt(Math.pow(x - bot.entity.position.x, 2) + Math.pow(z - bot.entity.position.z, 2));
            if (remainingDist < WAYPOINT_INTERVAL) {
                break; // Close enough, do final approach
            }

            // Check if underground and try to get to surface
            if (isUnderground(bot)) {
                log(bot, `Detected underground, attempting to stay on surface...`);
                // Try to find a surface path instead
                const surfaceY = getSurfaceY(bot, bot.entity.position.x, bot.entity.position.z);
                if (surfaceY > bot.entity.position.y + 5) {
                    // Too deep underground, abort this waypoint and try next one
                    continue;
                }
            }

            try {
                await goToGoal(bot, new pf.goals.GoalNear(waypointX, bot.entity.position.y, waypointZ, 5));
                log(bot, `Waypoint ${i}/${numWaypoints} reached, ${Math.round(remainingDist)} blocks remaining...`);
            } catch (err) {
                // If surface path fails, try with normal movements
                log(bot, `Surface path blocked, trying alternate route...`);
            }
        }
    }

    // Enable sprinting if requested
    if (sprint) {
        bot.setControlState('sprint', true);
    }

    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools. Need appropriate tool.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
        // Check tool durability while pathfinding
        if (bot.heldItem && isToolLowDurability(bot.heldItem)) {
            log(bot, `Warning: ${bot.heldItem.name} is about to break!`);
        }
    };

    const progressInterval = setInterval(checkDigProgress, 1000);

    try {
        // Final approach to exact destination
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        if (sprint) {
            bot.setControlState('sprint', false);
        }
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        if (sprint) {
            bot.setControlState('sprint', false);
        }
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    if (range > CONSTANTS.MAX_SEARCH_RANGE) {
        log(bot, `Maximum search range capped at ${CONSTANTS.MAX_SEARCH_RANGE}.`);
        range = CONSTANTS.MAX_SEARCH_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    // Resolve player name with fuzzy matching
    const resolvedName = resolvePlayerName(bot, username);
    if (!resolvedName) {
        log(bot, `Could not find player "${username}". Nearby players: ${Object.keys(bot.players).filter(n => n !== bot.username).join(', ') || 'none'}`);
        return false;
    }
    username = resolvedName;
    
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    // REPORT WHAT HAPPENED, not what was attempted. This used to log "You have reached
    // <player>" unconditionally, discarding goToGoal's result - so a bot still sealed in a box
    // twelve blocks away announced that it had arrived. Measured: boxed in with no pickaxe, it
    // moved 0.0 blocks and said it had reached the player.
    // Re-read the entity before measuring. A long walk can outlast the object mineflayer handed
    // us at the top: it destroys and rebuilds a player's entity across render distance, and
    // judging arrival against a frozen position is how "You have reached <player>" gets said to
    // an empty field. Falls back to the original reference when they are out of sight, which is
    // still the best estimate we have.
    const livePlayer = bot.players[username]?.entity ?? player;
    const gap = bot.entity.position.distanceTo(livePlayer.position);
    if (gap <= Math.max(distance, 1) + 1.5) {
        log(bot, `You have reached ${username}.`);
        return true;
    }
    if (nav.enclosed(bot)) {
        // Name the real obstacle. The recovery ladder digs out of most enclosures, but bare
        // handed stone runs about 35 seconds a block, so "walled in with no pickaxe" looks
        // exactly like "ignoring you" for minutes at a time.
        const pick = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'));
        log(bot, `I am walled in ${gap.toFixed(0)} blocks from ${username}`
            + `${pick ? ' and still digging out' : ' with no pickaxe, so digging out is very slow'}.`);
        return false;
    }
    log(bot, `Could not reach ${username} - stopped ${gap.toFixed(1)} blocks away.`);
    return false;
}


/**
 * Is this entity in water? Read it from the WORLD, not from the entity: prismarine-physics
 * only simulates our own bot, so `entity.isInWater` is undefined for every other player.
 * Checks feet and head, so a player treading at the surface still counts.
 */
function entityInWater(bot, entity) {
    const p = entity.position;
    for (const dy of [0, 1]) {
        const b = bot.blockAt(p.offset(0, dy, 0));
        if (b && isWaterName(b.name)) return true;
    }
    return false;
}

/** Beyond this we assume you swam off rather than dived, and stop chasing into open water. */
const FOLLOW_SWIM_RANGE = 48;

/**
 * Break off a dive and breathe at this many bubbles. Must stay ABOVE mode:drowning's
 * threshold of 8, because the mode interrupts - and an interrupt sets bot.interrupt_code,
 * which is followPlayer's own loop condition. Letting drowning fire would not merely pause
 * the follow, it would END it, permanently, on the first deep dive. So we surface first and
 * the mode never needs to.
 */
const FOLLOW_AIR_FLOOR = 10;

/**
 * Poll period for the swim branch of `followPlayer`.
 *
 * Load-bearing, not a tuning knob: every path through that branch must yield a real macrotask
 * or the follow loop starves the event loop and the server times the client out. See the
 * comment at the `continue` for the failure it produced.
 */
const SWIM_POLL_MS = 100;

/**
 * How long to keep walking toward the last place we saw someone before admitting we lost them.
 * A teleport well beyond render distance is recoverable by WALKING - get close enough and the
 * server starts sending the entity again - so the bot must not give up the moment it blinks
 * out. But it must give up eventually, or it converges on an empty patch of ground and stands
 * there polling a position it has already reached.
 */
const FOLLOW_LOST_MS = 8000;
const FOLLOW_REACQUIRE_DIST = 6;

/**
 * Where each player was last actually SEEN, kept ACROSS calls to `followPlayer`.
 *
 * A follow does not run once - it is torn down and restarted from the top every time a mode
 * interrupts it, which is constantly (`hunting`, `item_collecting`, `torch_placing` and
 * `elbow_room` all list `action:followPlayer` as interruptible). The target can easily walk out
 * of entity range during the interruption, and a restarted call that only looks at
 * `bot.players[x].entity` then has no idea where they went - so it refuses, throwing away a
 * position it knew perfectly well a second earlier.
 *
 * That is exactly what happened on 2026-08-30: three `elbow_room` interrupts in 16 seconds, the
 * third resume found no entity, refused outright, and the follow was over - the bot stood on the
 * same block until it was restarted, while the player it was following walked away and logged off.
 */
const lastSeenPos = new Map();

/**
 * What should a follow loop do this iteration? Pure, so every branch is testable
 * (`tests/follow.test.mjs`) - a live run only ever exercises whichever one the world happens
 * to be in, and three of these four states need a player to teleport to produce at all.
 *
 * The distinction that matters is between "cannot see them" and "cannot reach them". They look
 * identical from chat and need opposite handling: one is fixed by WALKING, the other cannot be
 * fixed at all.
 *
 * @param {object} s
 * @param {boolean} s.hasEntity        - the entity object exists RIGHT NOW (re-read, never cached)
 * @param {boolean} s.online           - still in `bot.players`, i.e. on the server at all
 * @param {number}  s.lostMs           - how long we have been unable to see them
 * @param {number}  s.distToLastSeen   - how far we are from where we last saw them
 * @returns {{action: 'follow'|'seek'|'lost'|'gone', reason: string}}
 */
export function followVerdict({ hasEntity, online, lostMs = 0, distToLastSeen = Infinity,
                                lostMsLimit = FOLLOW_LOST_MS, reacquireDist = FOLLOW_REACQUIRE_DIST }) {
    // Checked FIRST: a player who quit is not out of render distance, and walking to their last
    // position would be a pointless journey ending in a timeout rather than an explanation.
    if (!online) return { action: 'gone', reason: 'left the game' };
    if (hasEntity) return { action: 'follow', reason: 'in sight' };
    // Out of render distance is RECOVERABLE BY WALKING - get close enough and the server starts
    // sending the entity again. Giving up the moment they blink out is what makes a long
    // teleport end the follow instead of starting a chase.
    if (lostMs > lostMsLimit && distToLastSeen < reacquireDist)
        return { action: 'lost', reason: 'arrived where they were, still not in sight' };
    return { action: 'seek', reason: 'walking to where I last saw them' };
}

export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    // Resolve player name with fuzzy matching
    const resolvedName = resolvePlayerName(bot, username);
    if (!resolvedName) {
        log(bot, `Could not find player "${username}". Nearby players: ${Object.keys(bot.players).filter(n => n !== bot.username).join(', ') || 'none'}`);
        return false;
    }
    username = resolvedName;
    
    // THE ENTITY OBJECT IS NOT STABLE, so it must never be captured for the life of the loop.
    // mineflayer DESTROYS a player's entity when they leave render distance and builds a NEW
    // one when they come back, so a reference taken once here points at an orphan whose
    // `position` is frozen wherever it was last seen. The bot then chases a ghost -
    // confidently, forever, with nothing in chat to say so. Exactly the shape of the
    // `GoalFollow` bug `navToGoal` already had to fix: it cached x/y/z at construction while
    // the target moved.
    const liveEntity = () => bot.players[username]?.entity ?? null;
    let player = liveEntity();
    /** Where we last actually SAW them - the only position worth walking toward once they blink out. */
    let lastSeen = player ? player.position.clone() : (lastSeenPos.get(username) ?? null);
    let lostSince = player ? null : Date.now();
    // Only refuse when we have BOTH no entity and no memory of one. "I cannot see you" and "I
    // have no idea where you went" are different problems, and only the second is hopeless.
    if (!player && !lastSeen) {
        log(bot, `I cannot see ${username} from here and I do not know where they went - come closer and ask again.`);
        return false;
    }

    let doorCheckInterval = startDoorInterval(bot);

    // LAND DRIVING IS OURS NOW. This used to be `bot.pathfinder.setGoal(GoalFollow, true)`,
    // which is the executor `settings.js` already blacklists `!goToCoordinates` over -
    // "mineflayer-pathfinder ... cannot move this bot". Follow was the last command still on
    // it, because GoalFollow had no equivalent here and so was never swapped out. Its executor
    // gates on `onGround` (false on this server while the bot is provably standing) and, at
    // mineflayer-pathfinder/index.js:629, clears the jump key UNCONDITIONALLY every tick -
    // and jump is the only propulsion this server actually gives us. Reported as "andy didn't
    // jump when I ask followme"; the truth is he was barely being driven at all.
    // Pathfinder must be fully stood down, not merely out-prioritised: it rewrites control
    // states every tick and silently cancels ours.
    bot.pathfinder.setGoal(null);
    bot.pathfinder.stop();
    log(bot, `You are now actively following player ${username}.`);

    // Follow has TWO drivers. mineflayer-pathfinder cannot follow anyone underwater - its
    // movement generator carries two literal `if (blockC.liquid) return // dont go underwater`
    // guards (mineflayer-pathfinder/lib/movements.js:541,561), so GoalFollow has no move that
    // descends into water and the bot floats on the surface watching you dive. When the player
    // is wet we stand pathfinder down and hand over to the swim stack instead.
    let swimming = false;

    // Consecutive failed water-exit attempts. Capped so a bot pressed against a bank it
    // genuinely cannot climb - a two-block face, a corner it is wedged into - stops retrying
    // the same eight-second climb forever and falls back to normal driving, which has a whole
    // dig/detour/bridge ladder behind it.
    let exitFails = 0;

    while (!bot.interrupt_code) {
        // RE-ACQUIRE EVERY ITERATION - see the note on `liveEntity` above.
        const live = liveEntity();
        if (live) {
            player = live;
            lastSeen = live.position.clone();
            lastSeenPos.set(username, lastSeen);   // survives the next mode interrupt
            lostSince = null;
        } else if (lostSince === null) lostSince = Date.now();

        const verdict = followVerdict({
            hasEntity: !!live,
            online: !!bot.players[username],
            lostMs: lostSince === null ? 0 : Date.now() - lostSince,
            distToLastSeen: bot.entity.position.distanceTo(lastSeen),
        });
        if (verdict.action === 'gone') {
            lastSeenPos.delete(username);   // a position from a past session is not a lead
            log(bot, `${username} left the game, so I stopped following.`);
            break;
        }
        if (verdict.action === 'lost') {
            // We arrived where they were and they are still invisible. Continuing to walk at a
            // position we have already reached IS the ghost behaviour.
            log(bot, `I got to where I last saw ${username}, but they are not in sight.`);
            break;
        }
        if (verdict.action === 'seek') {
            await nav.navigateTo(bot, { x: lastSeen.x, y: lastSeen.y, z: lastSeen.z },
                { arriveDist: Math.max(1.5, distance), maxReplans: 2, waypointMs: 1500 });
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
        }

        const distance_from_player = bot.entity.position.distanceTo(player.position);
        const botWet = swim.inWater(bot);
        if (!botWet) exitFails = 0;

        // GET OUT OF THE WATER FIRST - and do it REGARDLESS OF `distance`.
        //
        // The land leg below is gated on `distance_from_player > max(1.5, distance)`, so a bot
        // treading water three blocks off the bank the player is standing on has ALREADY
        // ARRIVED: it asks the navigator for nothing, and `followPath` - which carries the
        // per-tick water-exit branch - is only ever reached by way of a plan. Following works
        // perfectly; the bot just never comes ashore.
        //
        // Measured on gym lane 5 with the other player PINNED at 3.1 blocks (a live agent walks
        // off and hides this): with this branch disabled the bot took 15.6s to get out, with it
        // 1.0s. It is not a deadlock, and the 15.6s is the interesting part - what eventually
        // freed it was DRIFT. The bot sank to y=109, which pushed the 3D distance past 4 and
        // finally earned it a leg. That is not a recovery so much as a coincidence, and it
        // arrives in the worst possible state: the first climb from down there reported
        // "no reachable bank in the forward cone", because sinking had put the bank out of reach.
        //
        // Only when the player is DRY. A swimming player is a player to swim after, and the swim
        // branch below owns that case.
        //
        // Gated on a bank actually being within reach (pure block reads, ~free) rather than on
        // calling climbBank and letting it refuse: mid-lake there is nothing to climb, and
        // spinning on refusals here would stop the bot swimming toward the player at all.
        if (botWet && !entityInWater(bot, player) && exitFails < 3) {
            const [cx, cz] = nearestCompass(
                player.position.x - bot.entity.position.x,
                player.position.z - bot.entity.position.z);
            // climbBank aims itself at the cell it picks and searches a +-45 degree cone around
            // this heading, refusing anything it cannot actually swim to - so a heading pointing
            // at a two-block cliff still finds the one-block shore beside it.
            if (swim.bankTargetAhead(bot, cx, cz)) {
                const r = await swim.climbBank(bot, cx, cz);
                if (r.out) exitFails = 0; else exitFails++;
                await new Promise(resolve => setTimeout(resolve, SWIM_POLL_MS));
                continue;
            }
        }

        if (entityInWater(bot, player) && distance_from_player < FOLLOW_SWIM_RANGE) {
            if (!swimming) {
                // pathfinder rewrites control states every tick and silently cancels ours,
                // so it has to be fully stood down, not merely out-prioritised.
                bot.pathfinder.setGoal(null);
                bot.pathfinder.stop();
                swimming = true;
            }
            if (swim.oxygen(bot) <= FOLLOW_AIR_FLOOR && swim.isSubmerged(bot)) {
                await swim.surface(bot, { timeoutMs: 8000 });
                await new Promise(r => setTimeout(r, SWIM_POLL_MS));
                continue;   // re-evaluate: you may have surfaced too, or dived deeper
            }
            // Short legs, because swimTo is point-to-point and the target is moving. swimTo
            // refuses lava on itself and on the route, and its releaseControls hands the jump
            // key back to SwimAssist ('auto'), so a leg that ends deep leaves the bot buoyant.
            //
            // Only when there is actually a gap to close. swimTo returns 'arrived' on its
            // FIRST iteration when we are already inside `arrive`, and that path awaits
            // nothing but `bot.look(..., force)` - which resolves without a timer or any I/O
            // (mineflayer physics.js: the force branch returns before `lookingTask.promise`,
            // and a zero-delta look returns even earlier). See the poll note below.
            if (distance_from_player > Math.max(1.5, distance)) {
                await swim.swimTo(bot, player.position.clone(), {
                    timeoutMs: 1200,
                    arrive: Math.max(1.5, distance),
                });
            }
            // NEVER `continue` STRAIGHT BACK. This branch used to skip the 500ms poll on the
            // grounds that "a diver moves faster than that" - but every await on the fast
            // paths above is a microtask, not a macrotask, so the loop could spin without
            // ever yielding to the timer/IO phases. The socket then goes unread and unwritten
            // and the SERVER drops us: `andy lost connection: Timed out`, 70 seconds after a
            // follow began, which from the outside looks exactly like the bot drowning.
            // Trigger is ordinary: you stand in water within `follow_dist` of the bot.
            // 100ms keeps the dive responsive while bounding the loop at 10Hz.
            await new Promise(r => setTimeout(r, SWIM_POLL_MS));
            continue;
        }
        if (swimming) {
            swimming = false;   // land driving resumes below; nothing to re-arm
        }

        // Walk one short leg toward the player with OUR navigator, then re-evaluate. Legs are
        // short because the target moves; navigateTo replans internally anyway, and a long leg
        // would chase a stale position. `arriveDist` is the follow distance, so a bot already
        // close does nothing and simply polls.
        if (distance_from_player > Math.max(1.5, distance)) {
            await nav.navigateTo(bot, {
                x: player.position.x, y: player.position.y, z: player.position.z,
            }, { arriveDist: Math.max(1.5, distance), maxReplans: 2, waypointMs: 1500 });
        }

        // Always yield a real macrotask. Same trap as the swim branch above: navigateTo can
        // return through purely microtask paths (already inside arriveDist, or a plan of
        // length < 2), and a loop of microtasks never lets the event loop reach its timer/IO
        // phases - the socket goes unread and the SERVER drops us with `lost connection:
        // Timed out`, which from outside looks like the bot dying.
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


/**
 * Retreat from a point, using our navigator.
 *
 * `GoalInvert` is the one pathfinder goal shape the `navToGoal` seam cannot translate: it says
 * "get AWAY from", so there is no target to steer at. This supplies the missing half - a flee
 * HEADING - and then steers at a point along it like any other move.
 *
 * Fans out rather than committing to the single directly-opposite bearing: the straight-away
 * line is very often into the wall the bot has just been cornered against, and a flee that
 * fails because the one direction it tried was blocked is worse than no flee at all. Cardinal
 * offsets first (cheapest moves), widening to a full reversal.
 *
 * XZ-only on purpose - "away" is a compass direction; insisting on a Y as well makes a retreat
 * fail on any slope.
 *
 * @param {MinecraftBot} bot
 * @param {Vec3} from - the thing being fled
 * @param {number} distance - how far away is far enough
 * @param {object} opts - {timeoutMs}
 * @returns {Promise<boolean>} whether we ended up at least `distance` from `from`
 */
/**
 * Step just far enough clear of a cell to place into it - one block sideways, never a journey.
 *
 * placeBlock needs 1.1 blocks of separation from the cell it is about to fill, and nothing
 * more. It used to buy that with fleeFrom(target, 2), which is a NAVIGATOR call: it steers at
 * a point `distance + 2` away, fans through five bearings, and is allowed two replans. That is
 * the right shape for running from a creeper and the wrong shape for stepping off a floor tile.
 *
 * It matters because laying a floor puts the bot ON the next cell almost every time, so the
 * retreat fires once PER CELL, and each one pushes it away from wherever it happens to be
 * standing. Measured 2026-08-30, bob filling a 13x13 floor at (4710..4722, 4608..4620): he
 * drifted 4724 -> 4731 -> 4746 -> 4752, thirty blocks east of a region he had already left,
 * logging `pinned: nothing worked - recentring` the whole way, and came back with 60 ragged
 * blocks placed out of 169.
 *
 * So: pick an adjacent standable cell that is already far enough away, and take one short
 * step to it. Bounded by construction - the target is one block from where we stand, so a
 * failure costs a step, not a walkabout. fleeFrom remains the fallback for the case where no
 * neighbour is standable.
 *
 * @param {MinecraftBot} bot
 * @param {Vec3} target the cell we want to place into
 * @returns {Promise<boolean>} true if the bot is now >= 1.1 blocks clear of the cell
 */
export async function stepClear(bot, target) {
    const clearOf = (p) => p.distanceTo(target) >= 1.1 && p.offset(0, 1, 0).distanceTo(target) >= 1.1;
    if (clearOf(bot.entity.position)) return true;

    const feet = bot.entity.position.floored();
    // Straights before diagonals: a diagonal sweeps the bot's 0.6-block width past two block
    // corners, which is the same clipping that `bodyClear` exists for in the planner.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const t = feet.offset(dx, 0, dz);
        const centre = t.offset(0.5, 0, 0.5);
        if (!clearOf(centre)) continue;                  // still too close - no point going there
        const at = bot.blockAt(t), head = bot.blockAt(t.offset(0, 1, 0)), below = bot.blockAt(t.offset(0, -1, 0));
        if (at?.boundingBox !== 'empty' || head?.boundingBox !== 'empty' || below?.boundingBox !== 'block') continue;
        await nav.navigateTo(bot, { x: t.x, y: t.y, z: t.z },
            { arriveDist: 0.6, maxReplans: 1, planRange: 8 });
        if (clearOf(bot.entity.position)) return true;
    }
    return clearOf(bot.entity.position);
}

export async function fleeFrom(bot, from, distance = 16, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 6000;
    const deadline = Date.now() + timeoutMs;
    const start = bot.entity.position.clone();

    const far = () => bot.entity.position.distanceTo(from) >= distance;
    if (far()) return true;

    let ax = start.x - from.x, az = start.z - from.z;
    const len = Math.hypot(ax, az);
    // Standing exactly on top of it (a mob inside our own hitbox) gives no bearing at all;
    // pick one rather than dividing by zero and steering at NaN.
    if (len < 0.01) { ax = 1; az = 0; }
    else { ax /= len; az /= len; }

    for (const deg of [0, 45, -45, 90, -90]) {
        if (Date.now() > deadline || bot.interrupt_code) break;
        const r = deg * Math.PI / 180;
        const dx = ax * Math.cos(r) - az * Math.sin(r);
        const dz = ax * Math.sin(r) + az * Math.cos(r);
        const reach = distance + 2;   // overshoot, so arriving is genuinely outside the radius
        await nav.navigateTo(bot, {
            x: Math.floor(start.x + dx * reach),
            y: Math.floor(start.y),
            z: Math.floor(start.z + dz * reach),
        }, { arriveDist: 2, goalXZOnly: true, maxReplans: 2, planRange: 48 });
        if (far()) return true;
    }
    return far();
}

export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    // mineflayer-pathfinder cannot move this bot on this server, so goToGoal here never
    // returned - and because modes call this with no timeout, one trigger pinned the agent on
    // mode:self_preservation permanently. Use our own navigator and bound the whole thing.
    const nav = await import('./nav.js');
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    const deadline = Date.now() + 15000;
    for (const [dx, dz] of dirs) {
        if (Date.now() > deadline || bot.interrupt_code) break;
        const target = new Vec3(Math.floor(pos.x + dx * distance), Math.floor(pos.y),
                                Math.floor(pos.z + dz * distance));
        await nav.navigateTo(bot, target, {
            arriveDist: 2, maxReplans: 2, goalXZOnly: true, planRange: 32,
        });
        if (bot.entity.position.distanceTo(pos) >= distance * 0.6) break;
    }

    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    // Was GoalInvert(GoalFollow) on pathfinder's executor, which cannot move this bot.
    await fleeFrom(bot, entity.position.clone(), distance, { timeoutMs: 8000 });
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        // Short flee legs, then re-look: the enemy is chasing, so a long leg runs from where
        // it used to be. `distance+1` keeps the old "move a little further away" margin.
        await fleeFrom(bot, enemy.position.clone(), distance + 1, { timeoutMs: 2500 });
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    // Was `setGoal(GoalNear, 1)` followed by polling `pathfinder.isMoving()` - which on this
    // server never becomes true, because its executor gates on `onGround` and never starts
    // moving. The poll therefore fell through instantly and the bot reached for a door it was
    // still 16 blocks from. navigateTo is synchronous-until-arrival, so the wait IS the walk
    // and there is nothing to poll.
    await nav.navigateTo(bot, { x: door_pos.x, y: door_pos.y, z: door_pos.z },
                         { arriveDist: 1.5, maxReplans: 3 });

    // Verify rather than assume: a door we could not reach cannot be opened, and activating a
    // block out of range fails silently, which reads as "the door is stuck".
    const reach = bot.entity.position.distanceTo(door_pos.offset(0.5, 0.5, 0.5));
    if (reach > 4.5) {
        log(bot, `Could not reach the door at ${door_pos} - stopped ${reach.toFixed(1)} blocks away.`);
        return false;
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

/**
 * Sleep in the nearest bed.
 *
 * Repaired from a version with three separate faults, none of which had ever run successfully:
 *   1. `block.name.includes('bed')` also matched **bedrock**, so the bot walked to a stone
 *      floor and tried to sleep in it.
 *   2. It travelled with `goToPosition`, i.e. mineflayer-pathfinder, which cannot move this bot
 *      at all (protocol 775; see NAVIGATION_REBUILD.md).
 *   3. `bot.sleep()` was uncaught. Daytime, monsters-nearby and occupied-bed all throw, and the
 *      `while (bot.isSleeping)` wait was unbounded and ignored interrupts, while
 *      `pause('unstuck')` was never released on the throw path.
 *
 * @returns {Promise<{slept:boolean, reason:string, pos?:object}>}
 */
export async function goToBed(bot) {
    const nav = await import('./nav.js');
    const night = await import('./night.js');

    if (bot.game.dimension !== 'overworld') {
        log(bot, `Not sleeping in ${bot.game.dimension} - beds explode outside the overworld.`);
        return { slept: false, reason: 'wrong_dimension' };
    }

    const beds = bot.findBlocks({
        matching: (block) => night.isBedName(block.name),   // exact suffix, never 'bedrock'
        maxDistance: 48,
        count: 4,
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return { slept: false, reason: 'no_bed' };
    }

    for (const loc of beds) {
        if (bot.interrupt_code) return { slept: false, reason: 'interrupted' };

        const res = await nav.navigateTo(bot, new Vec3(loc.x, loc.y, loc.z), { arriveDist: 2 });
        if (!res.arrived) {
            log(bot, `Could not reach the bed at (${loc.x}, ${loc.y}, ${loc.z}).`);
            continue;
        }

        const bed = bot.blockAt(loc);
        if (!bed || !night.isBedName(bed.name)) continue;

        try {
            await bot.sleep(bed);
        } catch (err) {
            const msg = String(err.message || err);
            if (/monster|mob/i.test(msg)) {
                log(bot, `Cannot sleep: monsters nearby.`);
                return { slept: false, reason: 'monsters' };
            }
            if (/not sleeping|day|night|time/i.test(msg)) {
                log(bot, `Cannot sleep yet: it is not night.`);
                return { slept: false, reason: 'daytime' };
            }
            log(bot, `Could not sleep in that bed: ${msg}`);
            continue;   // occupied or out of reach - try the next one
        }

        bot.modes.pause('unstuck');
        try {
            const woke = await sleepUntilMorning(bot, 90000);
            const p = bot.entity.position;
            log(bot, `VERIFIED SLEEP: slept at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}), `
                + `${woke ? 'woke naturally' : 'still in bed'} at timeOfDay=${bot.time.timeOfDay}.`);
        } finally {
            bot.modes.unpause('unstuck');   // released even when the wait throws
        }
        return { slept: true, reason: 'slept', pos: loc };
    }
    return { slept: false, reason: 'unreachable' };
}

/**
 * Wait out the night in bed, but never hold the action open forever.
 *
 * If every player sleeps the server skips to dawn in seconds. If a human stays awake it does
 * not, and holding `currentActionLabel` for a seven-minute real-time night would block every
 * other action - the pin-forever failure this codebase has hit before. Give up holding, leave
 * the bot asleep, and let the mode's dawn path finish the job.
 */
async function sleepUntilMorning(bot, timeoutMs = 90000) {
    const t0 = Date.now();
    while (bot.isSleeping && Date.now() - t0 < timeoutMs) {
        if (bot.interrupt_code) break;
        await new Promise(r => setTimeout(r, 500));
    }
    return !bot.isSleeping;
}

/**
 * Dig in for the night when there is no bed: a 2-deep hole with a block pulled over the top.
 * Built only on primitives that work here - mining and placing.
 *
 * @returns {Promise<{sheltered:boolean, reason:string, seal?:object}>}
 */
/**
 * Wait for the bot to stop falling, then report its y.
 *
 * Two consecutive equal readings a tick apart; capped, so a bot wedged in a wall still returns.
 * `onGround` is unusable on this server (see CLAUDE.md), so stability of the measurement is the
 * only signal available.
 */
async function settleY(bot, maxMs = 1500) {
    const deadline = Date.now() + maxMs;
    let last = bot.entity.position.y;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        const now = bot.entity.position.y;
        if (Math.abs(now - last) < 0.01) return now;
        last = now;
    }
    return bot.entity.position.y;
}

/**
 * Can we actually finish a shelter here, BEFORE we break any ground?
 *
 * This check is the whole fix. The old routine dug first and asked later: it called
 * `digDown(bot, 2)`, **ignored its return value**, and went on to place a roof - so on bare
 * stone with no pickaxe it reported `Don't have right tools to break stone`, failed to descend,
 * and then tried to seal at `y+2`, which is the open air above the bot's own head with nothing
 * adjacent to place against. The result was the line `Dug in at y=111 but could not seal the
 * roof` every twenty seconds all night, each one interrupting whatever the bot was doing.
 *
 * A half-built shelter is worse than none: an open pit is somewhere to fall into and be cornered,
 * and it has cost the terrain as well.
 *
 * @returns {Promise<{ok:boolean, reason:string, material:string|null, harvest:Vec3|null}>}
 */
async function shelterFeasibility(bot) {
    const p = bot.entity.position.floored();

    // Can we get down at all? Not "is it diggable" - can we break it AND keep the drop.
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (!below || below.name === 'air' || below.name === 'cave_air')
        return { ok: false, reason: 'nothing_to_dig', material: null, harvest: null };
    if (!await tools.canBreak(bot, below))
        return { ok: false, reason: `no tool for ${below.name}`, material: null, harvest: null };

    // Something to roof it with: carried, or a wall we could mine one out of.
    if (hasBuildingBlocks(bot))
        return { ok: true, reason: 'carried', material: pickBuildMaterial(bot), harvest: null };

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const wall = bot.blockAt(p.offset(dx, -1, dz));
        if (!wall || wall.boundingBox !== 'block') continue;
        if (!STACKABLE.includes(wall.name)) continue;   // a drop we can actually place back
        if (!await tools.canBreak(bot, wall)) continue;
        return { ok: true, reason: 'harvest', material: null, harvest: wall.position };
    }
    return { ok: false, reason: 'nothing to seal with', material: null, harvest: null };
}

/**
 * Dig in for the night, or refuse - never anything in between.
 *
 * Sequence matters: prove it can be finished, dig, verify the dig HAPPENED, seal, verify the
 * seal. Any failure after ground has been broken climbs back out, so the bot is never left
 * standing in an open hole it dug for its own safety.
 */
export async function emergencyShelter(bot, modeState = null) {
    const night = await import('./night.js');
    const getName = (x, y, z) => {
        const b = bot.blockAt(new Vec3(x, y, z));
        return b ? b.name : null;
    };
    const origin = bot.entity.position.floored();
    const spot = night.pickShelterSpot(getName, origin, 2);
    if (!spot) {
        log(bot, `Nowhere safe to dig in around here.`);
        return { sheltered: false, reason: 'no_spot' };
    }

    if (spot.x !== origin.x || spot.z !== origin.z) {
        const nav = await import('./nav.js');
        await nav.navigateTo(bot, new Vec3(spot.x, spot.y, spot.z), { arriveDist: 1.5 });
    }

    const plan = await shelterFeasibility(bot);
    if (!plan.ok) {
        // Refusing BEFORE breaking ground is the point. Say why, so the log is diagnosable -
        // "could not seal the roof" was true of every distinct failure and told us nothing.
        log(bot, `Cannot dig in here: ${plan.reason}.`);
        return { sheltered: false, reason: plan.reason };
    }

    const startY = bot.entity.position.y;
    // THREE BLOCKS, NOT TWO - the old depth put the roof in mid-air on flat ground.
    //
    // With the top solid block at Y-1 and the bot's feet at Y, digging 2 breaks Y-1 and Y-2 and
    // leaves the bot at feet Y-2 / head Y-1. The seal then goes at Y - which is the open sky
    // above the surface, with four air neighbours and nothing to place against:
    // `Cannot place dirt at (4566, 111, 4706): nothing to place on`. Digging 3 puts the bot at
    // feet Y-3 / head Y-2 and the seal at Y-1, which is the old surface layer and therefore
    // surrounded by earth on every side. Works on a flat plain and in a hillside alike.
    //
    // It looked correct for a long time because in natural terrain the bot usually dug into a
    // slope, where the cell above the shaft happened to have solid neighbours anyway.
    // digDown already refuses to break into lava, water, or over a big drop - keep that.
    const dug = await digDown(bot, 3);
    // LET THE BOT LAND BEFORE MEASURING. `digDown` returns when the blocks are broken, not when
    // the body has fallen through them, so reading y straight away catches it mid-air: measured
    // `Dug down 2 blocks.` followed by `only got down 1.0 blocks` on a dig that worked perfectly.
    // Same class of mistake as counting a chest transfer the instant the deadline fires.
    const descended = startY - await settleY(bot);
    if (!dug || descended < 2.5) {
        // Did not actually get down. Sealing from here would place a block in mid-air above the
        // bot's head; that is the `nothing to place on` failure, and it is not worth retrying.
        if (descended > 0.5) await pillarUp(bot, Math.round(descended));
        log(bot, `Could not dig in: only got down ${descended.toFixed(1)} blocks.`);
        return { sheltered: false, reason: 'could_not_dig' };
    }

    let material = plan.material;
    if (!material) {
        await breakBlockAt(bot, plan.harvest.x, plan.harvest.y, plan.harvest.z);
        await pickupNearbyItems(bot);
        material = hasBuildingBlocks(bot) ? pickBuildMaterial(bot) : null;
    }
    if (!material) {
        await pillarUp(bot, Math.round(descended));
        log(bot, `Could not dig in: the wall block did not drop anything I can place.`);
        return { sheltered: false, reason: 'no_material' };
    }

    const p = bot.entity.position.floored();
    const sealPos = new Vec3(p.x, p.y + 2, p.z);
    await placeBlock(bot, material, sealPos.x, sealPos.y, sealPos.z, 'bottom');
    const sealed = bot.blockAt(sealPos);
    const ok = !!sealed && sealed.boundingBox === 'block';
    if (ok) {
        if (modeState) modeState.sheltered = sealPos;
        log(bot, `VERIFIED SHELTER: sealed at (${sealPos.x}, ${sealPos.y}, ${sealPos.z}) with ${sealed.name}.`);
        return { sheltered: true, reason: 'sealed', seal: sealPos };
    }
    // NEVER LEAVE AN OPEN PIT. A hole with no roof is strictly worse than the flat ground we
    // started on - the bot is cornered in it and the terrain is spent.
    await pillarUp(bot, Math.round(descended));
    log(bot, `Could not seal the roof at (${sealPos.x}, ${sealPos.y}, ${sealPos.z}); climbed back out.`);
    return { sheltered: false, reason: 'unsealed' };
}

/**
 * Break out of the overnight shelter at dawn.
 *
 * Climbs THREE, matching the shelter's depth: the bot sits at feet Y-3 with the seal at Y-1, so
 * one pillar leaves it still a block under the surface in a hole it cannot walk out of.
 */
export async function digOut(bot, sealPos) {
    if (!sealPos) return false;
    await breakBlockAt(bot, sealPos.x, sealPos.y, sealPos.z);
    await pillarUp(bot, 3);
    log(bot, `Dug out of the shelter at dawn.`);
    return true;
}

/**
 * The whole nightfall decision, in one place. Called by the night_safety mode.
 * @returns {Promise<string>} an outcome line
 */
export async function nightRoutine(bot, modeState = null) {
    const night = await import('./night.js');

    const bedNearby = bot.findBlocks({
        matching: (b) => night.isBedName(b.name), maxDistance: 48, count: 1,
    }).length > 0;

    const action = night.decideNightAction({
        timeOfDay: bot.time.timeOfDay,
        thundering: bot.thunderState > 0,
        inWater: swim.inWater(bot),
        hostileNear: false,          // the mode checks this before calling us
        bedNearby,
        bedInInv: !!night.bedInInventory(bot.inventory.items()),
        dimension: bot.game.dimension,
        isSleeping: bot.isSleeping,
    });

    if (action === 'none' || action === 'wait') return `Night routine: ${action}.`;

    if (action === 'sleep') {
        const r = await goToBed(bot);
        if (r.slept) return `Slept through the night.`;
        if (r.reason === 'monsters') return `Could not sleep: monsters nearby.`;
        // fall through to shelter - a bed we cannot reach is no use tonight
    }

    if (action === 'place_bed') {
        const bedItem = night.bedInInventory(bot.inventory.items());
        if (bedItem && await placeNearby(bot, bedItem.name)) {
            const r = await goToBed(bot);
            if (r.slept) return `Placed a bed and slept through the night.`;
        }
    }

    const s = await emergencyShelter(bot, modeState);
    return s.sheltered ? `Dug in for the night.` : `Could not shelter: ${s.reason}.`;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function fillBucket(bot, liquidType = 'water') {
    /**
     * Fill an empty bucket with water or lava from the nearest source.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} liquidType, the type of liquid to collect ('water' or 'lava'). Defaults to 'water'.
     * @returns {Promise<boolean>} true if the bucket was filled, false otherwise.
     * @example
     * await skills.fillBucket(bot, 'water');
     * await skills.fillBucket(bot, 'lava');
     **/
    // Validate liquid type
    if (liquidType !== 'water' && liquidType !== 'lava') {
        log(bot, `Invalid liquid type: ${liquidType}. Use 'water' or 'lava'.`);
        return false;
    }
    
    // Check for empty bucket
    const bucket = bot.inventory.findInventoryItem('bucket');
    if (!bucket) {
        log(bot, `You don't have an empty bucket to fill.`);
        return false;
    }
    
    // Find all liquid source blocks within range
    const liquidBlocks = bot.findBlocks({
        matching: block => block.name === liquidType && block.metadata === 0, // metadata 0 = source block
        maxDistance: 32,
        count: 100 // Get multiple candidates
    });
    
    if (!liquidBlocks || liquidBlocks.length === 0) {
        log(bot, `No ${liquidType} source found within 32 blocks.`);
        return false;
    }
    
    // Priority: closest Y level first, then horizontal distance
    const botY = bot.entity.position.y;
    const botPos = bot.entity.position;
    
    liquidBlocks.sort((a, b) => {
        const yDiffA = Math.abs(a.y - botY);
        const yDiffB = Math.abs(b.y - botY);
        
        // If Y difference is significantly different (more than 2 blocks), prioritize by Y
        if (Math.abs(yDiffA - yDiffB) > 2) {
            return yDiffA - yDiffB;
        }
        
        // Otherwise, sort by horizontal distance
        const horizDistA = Math.sqrt(Math.pow(a.x - botPos.x, 2) + Math.pow(a.z - botPos.z, 2));
        const horizDistB = Math.sqrt(Math.pow(b.x - botPos.x, 2) + Math.pow(b.z - botPos.z, 2));
        return horizDistA - horizDistB;
    });
    
    const liquidBlock = bot.blockAt(liquidBlocks[0]);
    
    if (!liquidBlock) {
        log(bot, `No ${liquidType} source found within 32 blocks.`);
        return false;
    }
    
    // Move closer if needed
    if (bot.entity.position.distanceTo(liquidBlock.position) > 4.5) {
        await goToGoal(bot, new pf.goals.GoalNear(liquidBlock.position.x, liquidBlock.position.y, liquidBlock.position.z, 3));
    }
    
    // Equip the bucket
    await equip(bot, 'bucket');
    
    // Use bucket on liquid
    try {
        await bot.activateBlock(liquidBlock);
        log(bot, `Filled bucket with ${liquidType}. You now have ${liquidType}_bucket.`);
        return true;
    } catch (err) {
        log(bot, `Failed to fill bucket: ${err.message}`);
        return false;
    }
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0); // this will probably work most of the time but a custom mining and towering up implementation could be added if needed
        log(bot, `Going to the surface at y=${y+1}.`);``
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

/**
 * Travel a long distance in a compass direction without relying on jumping.
 *
 * Why this exists: on this server (1.21.11) the bot's pathfinder jump does not carry any
 * horizontal momentum, so it can never mount a 1-block step - it bunny-hops in place against
 * the obstruction until the unstuck mode drags it backwards. Walking, descending, 0.5-high
 * step-ups (stepHeight 0.6) and mining all work normally, so this routine gets there using
 * only those: walk toward the next waypoint, and when something blocks the way, mine the two
 * blocks at head/feet height and step through.
 *
 * @param {MinecraftBot} bot
 * @param {number} dx unit direction on X (-1 west, +1 east, 0 none)
 * @param {number} dz unit direction on Z (-1 north, +1 south, 0 none)
 * @param {number} distance total blocks to cover
 * @param {number} step how far to attempt per leg
 * @returns {Promise<string>} verified travel summary
 */
/**
 * Cut a staircase upward until the bot is back at the surface.
 *
 * Falling into a cave used to end a journey: from underground every onward route is also
 * underground, so the bot just kept travelling in the dark and ended 30+ blocks below where it
 * started. Digging straight up does not help - that leaves a 1-wide shaft the bot cannot climb
 * without blocks to pillar on. A diagonal staircase needs nothing but the ability to mine.
 *
 * @returns {Promise<number>} how many blocks of height were gained.
 */
/**
 * Dig out the column of gravity blocks sitting on top of the bot.
 *
 * self_preservation used to answer sand-above by running away, which surrenders the position
 * and, mid-journey, undoes progress the bot just made. Breaking the column is a couple of
 * seconds with a shovel and leaves the bot where it wanted to be. Each removed block lets the
 * one above fall into its place, so re-read the same cell rather than walking up the column.
 *
 * @returns {Promise<number>} how many blocks were removed.
 */
export async function clearFallingBlocksAbove(bot, maxBlocks = 8) {
    let removed = 0;
    for (let i = 0; i < maxBlocks; i++) {
        if (bot.interrupt_code) break;
        const above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
        if (!above || !isFallingBlockName(above.name)) break;
        if (!(await digWithTool(bot, above))) break;
        removed++;
        await new Promise(r => setTimeout(r, 250)); // let the stack above settle down one
    }
    if (removed) log(bot, `Dug out ${removed} falling block(s) above me.`);
    return removed;
}

export async function climbToSurface(bot, maxSteps = 150, opts = {}) {
    const { preferDir = null, targetY = null } = opts;
    const nav = await import('./nav.js');
    const startY = bot.entity.position.y;
    // Cutting stairs in the direction we actually want to travel turns the climb into progress
    // rather than a detour; the other headings stay as fallbacks for when it dead-ends.
    const base = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const dirs = preferDir
        ? [preferDir, ...base.filter(d => d[0] !== preferDir[0] || d[1] !== preferDir[1])]
        : base;
    let dir = 0;

    // Stairing that buys no height, four headings running, is not going to start working on the
    // fifth. Count it, and hand over to the tower - which needs no horizontal room at all.
    let stalls = 0;
    // WHY THE CLIMB ENDED. This routine has six exits and reported none of them: a bot that
    // stopped one block under the surface, a bot that ran out of blocks, and a bot that decided
    // it had already arrived all printed the identical "Climbed N blocks" line. The null-surface
    // bug above sat behind that for as long as it did because of this.
    let stopped = 'step budget spent';
    let towered = 0;         // total height gained by towering, across ALL rungs (TOWER_BUDGET)

    for (let i = 0; i < maxSteps; i++) {
        if (bot.interrupt_code) { stopped = 'interrupted'; break; }
        const p = bot.entity.position.floored();
        let goalY = targetY;
        if (goalY === null) {
            // READ THE NEIGHBOURS TOO. `surfaceY` wants a cell that is standable WITH SOMETHING
            // SOLID UNDER IT, searching only above the bot - and after the bot has mined its own
            // column there is no such cell, because it removed every block a cell up there could
            // stand on. The scan then returns null, which the routine read as "no surface, stop"
            // and returned reporting success. Measured exiting at y=65, in a one-wide hole it
            // had just dug, with open sky two blocks overhead.
            goalY = nav.surfaceY(bot, p.x, p.z, 140, p.y + 1)
                ?? nav.surfaceY(bot, p.x + 1, p.z, 140, p.y + 1)
                ?? nav.surfaceY(bot, p.x - 1, p.z, 140, p.y + 1)
                ?? nav.surfaceY(bot, p.x, p.z + 1, 140, p.y + 1)
                ?? nav.surfaceY(bot, p.x, p.z - 1, 140, p.y + 1);
        }
        if (goalY === null) {
            // A NULL SURFACE READING MEANS TWO OPPOSITE THINGS, and they need opposite actions.
            //
            // In a hole the bot has mined out, no cell above has anything solid under it, so the
            // scan finds nothing - we are BELOW the surface and rising is right. Standing in open
            // sky on top of our own pillar reads EXACTLY the same, and there rising is a
            // disaster: each 4-block tower succeeds, the loop goes round, and it towers again.
            // Measured live, `climbOut: +54.0 to y=118.0` - a 54-block cobblestone spike into the
            // air, from a bot that was already standing on open ground. That regression is the
            // whole reason this branch is written out at length.
            //
            // The ceiling tells them apart. Something solid overhead means we are under
            // something and have somewhere to get out to; open sky means we are already out.
            const roofed = ceilingAbove((dy) => bot.blockAt(p.offset(0, dy, 0))) !== null;
            const sv = surfaceUnknownVerdict({ roofed, towered, budget: TOWER_BUDGET });
            if (!sv.tower) { stopped = sv.reason; break; }
            stopped = sv.reason;
            // THE ALLOWANCE, not a fixed 4. The budget has to be a hard cap, not a line the last
            // rung is free to step over - a pillar cannot be un-built.
            const lifted = await climbShaftUp(bot, null, Math.min(4, sv.allowance));
            if (lifted < 0.5) break;
            towered += lifted;
            continue;
        }
        // `surfaceY` already returns the STANDABLE cell - the one whose feet are on top of the
        // ground - so stopping a block below it was stopping a block short. On a slope that is
        // close enough to be invisible; at the top of a one-wide shaft it is the difference
        // between out and trapped, since the bot is then standing in a hole it cannot walk out
        // of. The tower rung is what makes demanding the last block safe: before it, the last
        // block was often unreachable and the tolerance was hiding that.
        if (p.y >= goalY) { stopped = `reached y=${p.y} (surface ${goalY})`; break; }

        const [dx, dz] = dirs[dir % dirs.length];
        const ahead = new Vec3(p.x + dx, p.y, p.z + dz);

        // The block we will step onto has to exist. After mining its way along, the bot is often
        // standing in an open chamber of its own making with no wall in any direction - stairs
        // are impossible there, so tower straight up instead of spinning on the spot.
        // ONE PLACE THAT GIVES UP ON STAIRS. Turning away used to be written three times with
        // three different bookkeeping rules, and only one of them counted a stall - so two of
        // the three ways this loop fails could never reach the tower.
        //
        // A staircase needs BOTH a solid neighbour to step onto and somewhere to travel through.
        // Sealed in a pocket it has the first and not the second, so it grinds sideways for the
        // whole budget: measured at 90s for +2 blocks against a plug only 3 thick. Towering has
        // no horizontal requirement, which is exactly why it is the right answer here.
        const turn = async (reason) => {
            dir++;
            if (++stalls < dirs.length) return false;
            stalls = 0;
            // ONE LEDGER ACROSS EVERY TOWER RUNG - the LOOP is what ran away, four blocks at a
            // time, and it does not care which rung supplied them. `roofed: true` because this
            // rung already has a goalY it can SEE: the open-sky question does not arise here,
            // only the ledger does.
            const sv = surfaceUnknownVerdict({ roofed: true, towered, budget: TOWER_BUDGET });
            if (!sv.tower) { stopped = sv.reason; return true; }
            const lifted = await climbShaftUp(bot, goalY, Math.min(8, sv.allowance));
            if (lifted < 0.5) { stopped = `${reason} and cannot tower`; return true; }
            towered += lifted;
            return false;
        };

        // The block we will step onto has to exist. After mining its way along, the bot is often
        // standing in an open chamber of its own making with no wall in any direction - stairs
        // are impossible there, so tower straight up instead of spinning on the spot.
        const stepBlock = bot.blockAt(ahead);
        if (!stepBlock || stepBlock.boundingBox !== 'block') {
            if (await turn('no wall to stair against')) break;
            continue;
        }

        for (const target of [ahead.offset(0, 1, 0), ahead.offset(0, 2, 0), new Vec3(p.x, p.y + 2, p.z)]) {
            await digWithTool(bot, bot.blockAt(target));
        }

        // ASK THE WORLD WHETHER THE STEP IS CLEAR, do not infer it from how many blocks we
        // mined. The old test turned away whenever `mined === 0` - which is also the GOOD case,
        // where the way was already open and nothing needed breaking. The bot then span through
        // all four headings without ever hopping, counted no stall, never reached the tower, and
        // burned its entire 150-step budget in milliseconds: `climbOut: +4.0 to y=66.0 - step
        // budget spent`, standing one block under the surface the whole time.
        const clear = (b) => !b || b.boundingBox !== 'block';
        const canStep = clear(bot.blockAt(ahead.offset(0, 1, 0)))
            && clear(bot.blockAt(ahead.offset(0, 2, 0)))
            && clear(bot.blockAt(new Vec3(p.x, p.y + 2, p.z)));
        if (!canStep) {
            if (await turn('cannot clear the way ahead')) break;
            continue;
        }

        const gained = await hopForward(bot, dx, dz, 1600);
        if (gained < 0.5) {
            if (await turn('stairs stalled')) break;
        } else stalls = 0;
    }

    const climbed = bot.entity.position.y - startY;
    console.log(`[${bot.username ?? '?'}] climbOut: +${climbed.toFixed(1)} to `
        + `y=${bot.entity.position.y.toFixed(1)} - ${stopped}`);
    log(bot, `Climbed ${climbed.toFixed(0)} blocks toward the surface (now y=${bot.entity.position.y.toFixed(0)}).`);
    return climbed;
}

/**
 * The eight integer headings. Every block-level helper in this file - `scanAhead`,
 * `clearWayAhead`, `bridgeWayAhead`, `hopForward`, `climbLedgeByPlacing` - indexes blocks as
 * `p + d * n`, so `d` HAS to be integral or those reads land on the wrong column. A marathon
 * leg points wherever it likes, so the heading used for STEERING (a real unit vector) is kept
 * separate from the one used for DIGGING (this, the nearest of eight).
 */
const COMPASS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Nearest of the eight integer headings to a free direction. Exported for the tests. */
export function nearestCompass(dx, dz) {
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    let best = COMPASS8[0], bestDot = -Infinity;
    for (const [cx, cz] of COMPASS8) {
        const cl = Math.hypot(cx, cz);
        const dot = (ux * cx + uz * cz) / cl;
        if (dot > bestDot) { bestDot = dot; best = [cx, cz]; }
    }
    return best;
}

/**
 * Travel overland to an XZ target, mining, bridging, swimming and climbing as needed.
 *
 * This is the engine `travelDirection` has always been; the only thing generalised is the
 * heading. It used to be one of four compass directions baked in for the whole journey, which
 * made every block-level helper's `p + d*n` arithmetic trivially correct but meant the bot
 * could only ever be told "go west". A checkpoint is at a bearing, not on an axis, so the
 * heading is now recomputed each leg from the vector to the target, and quantised to the
 * nearest of eight only where block arithmetic demands it.
 *
 * @returns {Promise<{arrived:boolean, covered:number, remaining:number, dug:number, legs:number, stalls:number}>}
 */
export async function travelToward(bot, targetX, targetZ, opts = {}) {
    const {
        step = 48,            // how far ahead each navigator leg aims
        arrive = 3,           // XZ distance that counts as arrival
        timeoutMs = 30 * 60 * 1000,
        announce = true,
        // Price water into the A* frontier, or keep it prohibitive.
        //
        // `travelDirection` keeps this ON: swimming was measured at 1.96 blocks/s against ~25
        // blocks/min overland, and a river crossing is unambiguously worth it - there is a far
        // bank, and the bot walks out on the other side.
        //
        // A checkpoint marathon turns it OFF, because a POND is not a river. Measured here over
        // twenty-five minutes at (4282, 62, 4935): this bot cannot climb out of water at all.
        // Holding jump in `climb` mode against an adjacent one-block bank produced
        // vel=(0.000, 0.000, 0.000) and gained 0.00 blocks, every time. Cheap water therefore
        // buys a route the bot can enter and cannot leave, and each attempt to mine its way out
        // widens the pond - the bot dug a canal east and the water followed it in.
        //
        // Water is only cheap if you can get out of it.
        swimEnabled = true,
        // Called after every navigator leg. Long journeys are otherwise completely opaque:
        // `log()` only appends to bot.output, which nothing reads until the whole action
        // returns - so a 40-minute run reports nothing at all until it is over.
        onLeg = null,
    } = opts;

    const startPos = bot.entity.position.clone();
    const startDist = Math.hypot(targetX - startPos.x, targetZ - startPos.z);
    if (announce)
        log(bot, `Travelling ${startDist.toFixed(0)} blocks to (${Math.round(targetX)}, ${Math.round(targetZ)}). This may take a while.`);

    let legs = 0, dug = 0, stalls = 0;
    const deadline = Date.now() + timeoutMs;

    // Surface travel only. If a previous leg ended in a cave, climb out before going further -
    // otherwise every route the planner can see from down there is also underground.
    const navMod = await import('./nav.js');
    let preferY = navMod.surfaceY(bot, startPos.x, startPos.z, 140, Math.floor(startPos.y) + 1);
    if (preferY !== null && preferY - startPos.y > 20) {
        log(bot, `Underground (${Math.round(preferY - startPos.y)} blocks below the surface); climbing out first.`);
        await climbToSurface(bot);
    }
    preferY = Math.floor(bot.entity.position.y);

    // Set only when the bot is wet and could not reach a bank: see the loop below.
    let strandedInWater = false;

    const result = () => {
        const p = bot.entity.position;
        const remaining = Math.hypot(targetX - p.x, targetZ - p.z);
        return {
            arrived: remaining <= arrive,
            covered: Math.max(0, startDist - remaining),
            remaining, dug, legs, stalls,
        };
    };

    while (Date.now() < deadline) {
        if (bot.interrupt_code) return result();

        // A land-only journey must not plan THROUGH water, but a bot that is ALREADY wet has to
        // be able to plan its way out, so water is priced normally while it is in some.
        //
        // This used to call `escapeWater` here on EVERY iteration instead. That was actively
        // harmful: `escapeWater` heads for the NEAREST dry land, which is frequently behind the
        // bot, so each iteration dragged it backwards and the following leg pulled it forwards
        // again. Measured on a bot standing in ONE block of water with open air on all four
        // sides - the easiest case there is - reporting `navMoved -1.2` then `-3.6` and "Still
        // in water" indefinitely, 34 blocks from its checkpoint.
        //
        // Genuine traps are the recovery ladder's job further down; it already calls
        // `escapeWater`, but only after a leg has actually stalled.
        strandedInWater = inWater(bot);

        const pos = bot.entity.position;
        const toX = targetX - pos.x, toZ = targetZ - pos.z;
        const dist = Math.hypot(toX, toZ);
        if (dist <= arrive) break;

        // Steering heading: a true unit vector toward the target.
        const ux = toX / dist, uz = toZ / dist;
        // Digging heading: the nearest of eight, so `p + d*n` stays on real block columns.
        const [dx, dz] = nearestCompass(ux, uz);

        const before = pos.clone();
        // Aim at the target itself once it is within one leg - overshooting a checkpoint by 48
        // blocks and walking back is how a fixed-stride traveller wastes an entire leg.
        const reach = Math.min(step, dist);
        const wx = Math.floor(pos.x + ux * reach);
        const wz = Math.floor(pos.z + uz * reach);

        try {
            // Use our own navigator (nav.js). mineflayer-pathfinder will not plan a route over
            // a 1-block step on this server, so it simply refuses to move; ours plans the step
            // and AutoJump executes it.
            const nav = await import('./nav.js');
            // Aim at a COLUMN, not a point: the surface height 48 blocks away is unknown, so a
            // y-aware goal would never match and the planner would waste its budget. goalXZOnly
            // plus the wide planRange is what lets it route around a dune instead of mining
            // through one - tunnelling measured ~12s per block, walking around costs seconds.
            await nav.navigateTo(bot, new Vec3(wx, Math.floor(pos.y), wz), {
                arriveDist: 3, maxReplans: 3, goalXZOnly: true, planRange: 96, horizon: 10,
                preferY,
                // Only once we are already stuck - the per-second line is noise on a leg that is
                // working, and the whole point of it is diagnosing a leg that is not.
                debug: stalls > 0,
                // See the `swimEnabled` note above. !navTo, moveAway and every mode-driven move
                // stay on the land-only model that has a 1018-block journey behind it: a cheaper
                // river changes which nodes win the whole A* frontier, not just the wet ones.
                //
                // `|| inWater(bot)` is not a hedge, it is the other half of the rule. "Don't go
                // in" and "do get out" need opposite prices, and a bot standing IN water with
                // water priced at 15 has no affordable first move at all - A* returns nothing,
                // `followPath` never runs, and the recovery ladder grinds against a pond it is
                // no longer allowed to plan through. That regressed a bot into a second freeze
                // within minutes of fixing the first one.
                swimEnabled: swimEnabled || strandedInWater,
            });
        } catch (err) {
            // fall through to the obstruction check
        }

        // Progress must be measured ALONG THE TRAVEL AXIS, not as total distance moved. When
        // the planner can only find a partial route it often heads the wrong way around an
        // obstacle; counting that as progress meant the "we are stuck, dig through" fallback
        // never fired and the bot wandered sideways for a quarter of an hour. The projection is
        // SIGNED, so retreating now counts against us - the old `|dx|*|Δx|` form scored a step
        // backwards exactly like a step forwards.
        const after = bot.entity.position;
        let moved = (after.x - before.x) * ux + (after.z - before.z) * uz;
        legs++;
        // Why did this leg stall, or not? `climbBank` never running turned out to be because
        // legs kept reporting progress - the bot was mining its way forward inside followPath,
        // so travelToward never saw a stall and its whole water ladder was unreachable.
        console.log(`[${bot.username ?? '?'}] leg ${legs}: moved=${moved.toFixed(2)} `
            + `stalls=${stalls} wet=${inWater(bot)} interrupt=${!!bot.interrupt_code} `
            + `pos=(${after.x.toFixed(1)}, ${after.y.toFixed(2)}, ${after.z.toFixed(1)}) `
            + `-> ${moved < 1.0 ? 'RECOVERY' : 'continue'}`);
        if (onLeg) onLeg({
            leg: legs, moved, dug, stalls,
            remaining: Math.hypot(targetX - after.x, targetZ - after.z),
            pos: after.clone(),
        });
        if (moved < 1.0) {
            // The pathfinder refuses to PLAN a route over a 1-block step on this server, so it
            // just stands still. Walking manually gets the bot moving, and AutoJump (see
            // auto_jump.js) then carries it over the step - measured: 9.4 blocks covered and a
            // step cleared where pathfinding moved 0.
            // NOT WHILE WET. walkForward exists for a land problem - the pathfinder refuses to
            // plan a 1-block step, and AutoJump carries the bot over once it is walking. AutoJump
            // early-returns in water, so in water this does nothing except hold `forward` into
            // the bank for 4 seconds - and being pressed flush against the bank is precisely the
            // state that makes the climb impossible (measured: 22s of zero movement at
            // x=4508.70 vs out in 0.8s from x=4508.40). It also delayed climbBank past the point
            // where the leg budget ran out. Go straight to the recovery ladder instead.
            const beforeWalk = bot.entity.position.clone();
            if (!inWater(bot)) await walkForward(bot, dx, dz, 4000);
            const afterWalk = bot.entity.position;
            const walkedOver = (afterWalk.x - beforeWalk.x) * ux + (afterWalk.z - beforeWalk.z) * uz;
            console.log(`[${bot.username ?? '?'}] postwalk: walkedOver=${walkedOver.toFixed(2)} `
                + `-> ${walkedOver > 1.0 ? 'RESTART LEG' : 'ladder'}`);
            if (walkedOver > 1.0) { stalls = 0; continue; }
        }
        if (moved < 1.0) {
            // An interrupted leg is not a stall, and the recovery ladder must not run on one.
            // Every step in it (climbBank, buildFootingBelow, escapeWater, the digs) begins by
            // checking `interrupt_code` and returns immediately, so the whole ladder silently
            // no-ops - `climbBank` reporting "still wet after 0ms, gained 0.00" is the
            // signature. That made four separate wiring fixes look like they did nothing.
            if (bot.interrupt_code) return result();
            stalls++;
            // Look 10 blocks ahead BEFORE touching the terrain. A ridge we can walk around is
            // far cheaper to walk around than to mine through, and mining a dune drops the sand
            // above straight onto the bot. Only fall through to digging if the detour fails.
            const nav = await import('./nav.js');

            // Never tunnel while underground. Mining forward at depth is exactly how the bot
            // ended up 31 blocks below the surface: once down there, every route the planner
            // can see is also underground, so it kept boring west in the dark. Climb out and
            // resume on the surface instead.
            const hereNow = bot.entity.position;
            const surfNow = nav.surfaceY(bot, Math.floor(hereNow.x), Math.floor(hereNow.z),
                                         140, Math.floor(hereNow.y) + 1);
            // 20, not 8: cutting through a ridge legitimately puts the bot "below the surface"
            // for a while, and a tighter threshold made this fight the tunnel it needed to dig.
            if (surfNow !== null && surfNow - hereNow.y > 20) {
                log(bot, `${Math.round(surfNow - hereNow.y)} blocks below the surface; climbing out rather than tunnelling.`);
                await climbToSurface(bot);
                preferY = Math.floor(bot.entity.position.y);
                stalls = 0;
                continue;
            }

            // Being in water used to be treated as a stall to escape from, on the belief that
            // the bot "barely moves while swimming". Measured: 1.96 blocks/s, about 4x its
            // overland speed through real terrain. So swim the crossing rather than retreating
            // to the bank - but only while the far side is close enough to be a crossing and not
            // an ocean. If the swim itself stalls, fall back to the old bank-first behaviour,
            // because none of the machinery below (dig, bridge, pillar) works while floating.
            // WADING is not AFLOAT, and this branch is only for afloat. A bot standing on solid
            // ground in one block of water, head in clear air, is on LAND as far as recovery
            // goes - it should walk, hop and dig like any other stall. Sending it through the
            // swim ladder instead had it surfacing, hunting banks and calling `escapeWater`,
            // which heads for the NEAREST dry land - often backwards. Measured: a bot in a
            // single block of water with open air on all four sides reporting navMoved -1.9,
            // -3.0, -0.8 and drifting away from its checkpoint indefinitely.
            //
            // Same distinction `nav.js` followPath and `auto_jump.js` already make.
            // Bias the feet cell UP slightly before flooring it. A bot floating at the surface
            // sits a hair above the block boundary (measured y=110.03 in 2-deep water), so any
            // momentary dip flips `floor(y)` down a block, makes the cell below read solid, and
            // the bot is misclassified as WADING. It then gets the land recovery - which mines -
            // and tunnels through the bank instead of climbing it. Measured in the gym: depths
            // 1 and 2 both ending east of the bank at y~110.05, having dug a channel.
            const feetCell = bot.entity.position.offset(0, 0.15, 0).floored();
            const headBlk = bot.blockAt(feetCell.offset(0, 1, 0));
            const belowBlk = bot.blockAt(feetCell.offset(0, -1, 0));
            const wading = inWater(bot)
                && !!belowBlk && belowBlk.boundingBox === 'block'
                && !(headBlk && isWaterName(headBlk.name));

            console.log(`[${bot.username ?? '?'}] recovery: wet=${inWater(bot)} wading=${wading} `
                + `submerged=${swim.isSubmerged(bot)} stalls=${stalls}`);

            // A one-block bank is the same problem whether the bot is wading or afloat, and
            // the answer is the same: hold jump continuously so the water impulse lifts it,
            // rather than AutoJump's three-tick pulse which is not enough here. This used to sit
            // behind `!wading`, so a bot standing in one block of water never got the climb at
            // all - it fell straight through to `clearWayAhead` and mined the bank instead.
            // That is the canal.
            if (inWater(bot)) {
                // RETRY. One attempt is not enough: climbBank bails after 2.5s without measured
                // progress (rightly - a genuinely jammed bot must not hold the leg forever), but
                // getting out of stand-deep water takes several impulses. Measured in isolation:
                // repeated attempts walked the bot from y=110.0 to y=111.0 over ~17s, while any
                // single attempt reported `gained 0.00`. Bounded so a hopeless spot still falls
                // through to the rest of the ladder.
                let climbed = false;
                for (let attempt = 0; attempt < 6 && !bot.interrupt_code; attempt++) {
                    const bankTry = await swim.climbBank(bot, dx, dz);
                    if (bankTry.out) {
                        log(bot, `Climbed out of the water onto the bank after ${attempt + 1} attempt(s).`);
                        climbed = true;
                        break;
                    }
                    if (!bankTry.target) break;   // nothing to climb here; stop wasting the leg
                }
                if (climbed) { stalls = 0; continue; }
            }

            if (inWater(bot) && !wading) {
                // SUBMERGED first, and before anything else in this branch. A bot under an
                // overhang - solid ceiling directly above, water at feet and head - cannot rise,
                // cannot climb a bank, and cannot walk out: buoyancy just presses it into the
                // ceiling. Observed at (4322, 61, 5034), in a two-block water pocket with stone
                // at y=63 and the only open faces to the east and south, while the checkpoint
                // lay west - so every steering decision drove it into the wall.
                //
                // `swim.surface` already owns exactly this ladder - rise, move to a neighbouring
                // open column, cut through a soft ceiling, unwedge - and the traveller simply
                // never called it. Nothing else here can make progress until the head is out.
                if (swim.isSubmerged(bot)) {
                    const up = await swim.surface(bot, { timeoutMs: 12000 });
                    log(bot, `Submerged and stalled; surfacing (${up.reason}, rose ${up.rose.toFixed(1)}).`);
                    if (up.surfaced) { stalls = 0; continue; }
                }

                // Shore first. When the land we want is the bank right in front of us, the move
                // is to climb ONTO it - not to look for a far bank to swim to, and certainly not
                // to mine it. Nothing else in this ladder can do it: swimming forward presses
                // the bot into the bank face, AutoJump refuses to fire in water, and digging and
                // placing do nothing while afloat. Four legs ground against a one-block bank at
                // (4264, 62, 4931) before this existed.
                const bank = await swim.climbBank(bot, dx, dz);
                if (bank.out) {
                    log(bot, `Climbed out of the water onto the bank (${bank.gained.toFixed(1)} blocks up).`);
                    stalls = 0;
                    continue;
                }

                // BUILD A FOOTING. The bank is right there and the bot cannot rise onto it: at
                // the water surface it gets no swim impulse and `onGround` is false, so there is
                // no jump either. Measured in the test gym at water depths 1-6, where it either
                // grinds against a one-block bank or mines a channel through it - while carrying
                // 320 cobblestone it never thought to use. Placing a block on the pool floor
                // under its feet makes the water shallow enough to STAND in, and the ordinary
                // step-up takes it from there.
                if (await buildFootingBelow(bot)) { stalls = 0; continue; }

                const far = swimCrossingTarget(bot, dx, dz, MAX_SWIM_LEG);
                if (far) {
                    log(bot, `In water; swimming ${far.distance.toFixed(0)} blocks to the far bank.`);
                    const r = await swim.swimTo(bot, far.pos, { timeoutMs: 25000, arrive: 1.5 });
                    if (r.arrived || r.reason === 'beached' || r.covered > 2) { stalls = 0; continue; }
                }
                log(bot, `In water and cannot cross; heading for the nearest bank.`);
                if (await escapeWater(bot)) { stalls = 0; continue; }
            }

            const ahead = nav.scanAhead(bot, dx, dz, 10);

            // Water ahead that is narrow enough to swim is a crossing, not an obstacle. Doing
            // this before the wall/cliff/bridge branches stops the bot filling in a river it
            // could have swum in a couple of seconds.
            if (ahead.water > 0 && ahead.water <= MAX_SWIM_LEG) {
                const far = swimCrossingTarget(bot, dx, dz, MAX_SWIM_LEG);
                if (far) {
                    log(bot, `Water ${ahead.water} blocks wide ahead; swimming across.`);
                    const r = await swim.swimTo(bot, far.pos, { timeoutMs: 25000, arrive: 1.5 });
                    if (r.arrived || r.reason === 'beached' || r.covered > 2) { stalls = 0; continue; }
                }
            }
            if (ahead.kind === 'wall' && stalls <= 2) {
                const side = (stalls % 2) ? 1 : -1;
                const here = bot.entity.position.floored();
                const sx = here.x + (-dz) * side * 10 + dx * 10;
                const sz = here.z + (dx) * side * 10 + dz * 10;
                log(bot, `Ridge ${ahead.distance} blocks ahead; trying to walk around it.`);
                const det = await nav.navigateTo(bot, new Vec3(sx, here.y, sz), {
                    arriveDist: 3, maxReplans: 2, goalXZOnly: true, planRange: 64,
                });
                if (det.covered > 2.0) { continue; }
            }

            // A cliff is far cheaper to climb than to tunnel through. Boring west through this
            // sandstone plateau ran at ~1.5 blocks/min; walking over the top runs at ~25. Only
            // worth it when the top is close enough to stair up to.
            if (ahead.kind === 'wall') {
                const here2 = bot.entity.position;
                const topY = nav.surfaceY(bot, Math.floor(here2.x) + dx * 4,
                                          Math.floor(here2.z) + dz * 4, 140, Math.floor(here2.y));
                const rise = topY === null ? null : topY - here2.y;
                if (rise !== null && rise >= 2 && rise <= 14) {
                    // Build first, dig second. Placing blocks leaves the terrain intact; cutting
                    // stairs into the cliff does not. Falls through to digging when there is
                    // nothing in the inventory to build with.
                    const built = await climbLedgeByPlacing(bot, dx, dz, rise);
                    if (built > 0.5) { stalls = 0; continue; }

                    log(bot, `Cliff ahead and nothing to build with; cutting stairs ${Math.round(rise)} blocks up.`);
                    const gained = await climbToSurface(bot, 40, { preferDir: [dx, dz], targetY: topY });
                    if (gained > 0.5) { stalls = 0; continue; }
                }
            }

            // `keepFloor` is deliberately NOT set here. It is the right idea only if the bot can
            // actually climb the one-block step it preserves - and measured on this server it
            // cannot: `climbBank` held jump against an adjacent one-block bank for 8s and gained
            // 0.00 blocks. Until that is fixed, mining the bank at water level and swimming into
            // the hole is the only escape that moves the bot at all, so do not take it away.
            let cleared = await clearWayAhead(bot, dx, dz, stalls > 3);
            // Bridging is for GAPS now. Water wide enough to reach here is water the swim
            // branch above already declined to cross, so filling it in is the right call; water
            // narrow enough to swim never gets this far.
            cleared += await bridgeWayAhead(bot, dx, dz);
            dug += cleared;
            if (cleared === 0 && stalls > 1 && lastClearHitBuild) {
                // Something we refuse to mine is in the way - a player build, or a tree we
                // would rather not fell. Step around it instead of grinding against it.
                log(bot, `Obstruction ahead I won't mine; stepping around it.`);
                const side = (stalls % 4 < 2) ? 1 : -1;   // alternate sides if the first fails
                const here3 = bot.entity.position.floored();
                // Step sideways AND forward, so going around still makes progress toward the
                // goal. Uses our navigator: goToGoal here relied on mineflayer-pathfinder,
                // which cannot move this bot at all.
                const sx = here3.x + (-dz) * side * 5 + dx * 3;
                const sz = here3.z + (dx) * side * 5 + dz * 3;
                try {
                    await nav.navigateTo(bot, new Vec3(sx, here3.y, sz), {
                        arriveDist: 2, maxReplans: 2, goalXZOnly: true, planRange: 48,
                    });
                } catch (err) { /* try the other side next time */ }
            } else if (cleared === 0 && stalls > 3) {
                // Nothing to mine and still not moving - sidestep to break the deadlock.
                await moveAway(bot, 4);
                stalls = 0;
            }
        } else {
            stalls = 0;
        }
    }
    return result();
}

export async function travelDirection(bot, dx, dz, distance, step = 48) {
    const startPos = bot.entity.position.clone();
    const targetX = Math.floor(startPos.x + dx * distance);
    const targetZ = Math.floor(startPos.z + dz * distance);
    const res = await travelToward(bot, targetX, targetZ, { step, arrive: 2 });
    return travelReport(bot, startPos, dx, dz, distance, res.dug);
}

function travelReport(bot, startPos, dx, dz, distance, dug) {
    const p = bot.entity.position;
    const covered = Math.abs(dx) * Math.abs(p.x - startPos.x) + Math.abs(dz) * Math.abs(p.z - startPos.z);
    const pct = Math.round((covered / distance) * 1000) / 10;
    return `VERIFIED TRAVEL: moved ${covered.toFixed(0)}/${distance} blocks (${pct}%). `
        + `Now at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}). Mined ${dug} block(s) to get through.`
        + (covered >= distance - 2 ? ' Arrived.' : ' NOT finished - run the same command again to continue.');
}

/**
 * Mine whatever is directly ahead at head and feet height so the bot can walk on.
 * Only removes what actually blocks the path, and refuses to touch player-made blocks.
 * @returns {Promise<number>} how many blocks were removed.
 */
async function clearWayAhead(bot, dx, dz, allowTrees = false, opts = {}) {
    const p = bot.entity.position.floored();
    let removed = 0;
    let blockedByBuild = false;
    // Cut an OPEN TRENCH, not a tunnel. Deserts are sand and gravel - gravity blocks - so
    // boring a 2-high hole through a dune drops everything above straight onto the bot and
    // buries it (observed: 32 minutes entombed at y=55 with sand on every side). Clearing
    // well above head height lets the column collapse once and then stay clear.
    //
    // `keepFloor` leaves the block at the bot's OWN feet level alone. That block is the thing
    // it is trying to step onto. In water this is the difference between cutting a two-block
    // bank down to a one-block step and simply making the pond bigger: the bot mined 15 blocks
    // of an east bank at (4280, 62, 4935), advanced two blocks in twenty minutes, and each dig
    // let the water follow it in.
    const heights = opts.keepFloor ? [1, 2, 3, 4] : [0, 1, 2, 3, 4];
    for (const ahead of [1, 2]) {
        for (const dy of heights) {
            const target = new Vec3(p.x + dx * ahead, p.y + dy, p.z + dz * ahead);
            const block = bot.blockAt(target);
            if (!block || block.name === 'air' || block.name === 'water') continue;
            if (isPlayerMade(block.name)) {
                log(bot, `Not mining ${block.name} at ${target} (looks player-made).`);
                blockedByBuild = true;
                continue;
            }
            // Walk around trees, do not fell them. A trunk is 1-2 blocks wide, so stepping
            // round it is trivial, whereas chopping is slower and destroys the landscape the
            // bot is only passing through. `allowTrees` releases this once we are properly
            // stuck, so a bot boxed in by a jungle cannot deadlock.
            if (!allowTrees && isTreeTrunk(block.name)) {
                blockedByBuild = true;
                continue;
            }
            try {
                if (await breakBlockAt(bot, target.x, target.y, target.z)) removed++;
            } catch (err) { /* keep going; the next leg will retry */ }
        }
    }
    if (removed) {
        log(bot, `Cleared ${removed} block(s) blocking the way.`);
        // Let gravity blocks finish falling before we try to walk through.
        await new Promise(r => setTimeout(r, 700));
    }
    lastClearHitBuild = blockedByBuild && removed === 0;
    return removed;
}

/**
 * Put a walkable surface across water or a gap directly ahead.
 * @returns {Promise<number>} blocks placed.
 */
async function bridgeWayAhead(bot, dx, dz) {
    const p = bot.entity.position.floored();
    const material = pickBuildMaterial(bot);
    let placed = 0;
    // Start 2 blocks out, never 1. placeBlock treats a target within 1.1 blocks as "too close"
    // and tries to walk AWAY first; that reposition pathfind repeatedly burned its full 12s
    // timeout, so bridging a block at the bot's feet cost ~12s per attempt and stalled travel.
    for (const ahead of [2, 3]) {
        const footing = new Vec3(p.x + dx * ahead, p.y - 1, p.z + dz * ahead);
        const stand = new Vec3(p.x + dx * ahead, p.y, p.z + dz * ahead);
        const below = bot.blockAt(footing);
        const at = bot.blockAt(stand);
        const needsFooting = below && (below.name === 'air' || isWaterName(below.name));
        const standBlocked = at && isWaterName(at.name);
        if (!needsFooting && !standBlocked) continue;
        try {
            if (standBlocked) await breakBlockAt(bot, stand.x, stand.y, stand.z);
            if (needsFooting && await placeBlock(bot, material, footing.x, footing.y, footing.z, 'top')) placed++;
        } catch (err) { /* next leg retries */ }
    }
    if (placed) log(bot, `Bridged ${placed} block(s) across water/gap.`);
    return placed;
}

/** Pick something sensible to bridge with from inventory, else a common block. */
export function pickBuildMaterial(bot) {
    const preferred = ['dirt', 'cobblestone', 'sandstone', 'sand', 'stone', 'netherrack', 'andesite'];
    const counts = world.getInventoryCounts(bot);
    for (const name of preferred) {
        if (counts[name] > 0) return name;
    }
    return 'sandstone'; // creative mode fills the hotbar on demand
}

/** Set when the last clear attempt was stopped solely by player-made blocks. */
let lastClearHitBuild = false;

/**
 * Decide whether a block looks player-placed and should be left alone while travelling.
 *
 * Matching is by exact name or block family, deliberately NOT by substring. A substring test
 * on "brick" also matches stone_bricks / mud_bricks / brick_stairs, which occur in ordinary
 * terrain and structures - that made the bot refuse to clear its own path and strand itself
 * (observed: 97 minutes stalled against a stone_bricks wall it was forbidden to mine).
 * @param {string} name
 * @returns {boolean}
 */
function isPlayerMade(name) {
    const exact = new Set([
        'chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
        'crafting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'beacon', 'conduit',
        'enchanting_table', 'brewing_stand', 'cauldron', 'lodestone', 'respawn_anchor',
        'jukebox', 'note_block', 'bookshelf', 'lectern', 'composter', 'loom', 'grindstone',
        'smithing_table', 'cartography_table', 'fletching_table', 'stonecutter', 'bell',
        'hopper', 'dispenser', 'dropper', 'observer', 'piston', 'sticky_piston', 'tnt',
        'torch', 'wall_torch', 'soul_torch', 'lantern', 'soul_lantern', 'campfire', 'ladder',
        'scaffolding', 'item_frame', 'painting', 'flower_pot', 'armor_stand',
    ]);
    if (exact.has(name)) return true;
    // Whole families that only exist because somebody placed them.
    const families = ['_bed', '_door', '_trapdoor', '_sign', '_banner', '_shulker_box',
        '_glazed_terracotta', '_wool', '_carpet', '_concrete', '_glass_pane', '_candle'];
    if (families.some(suffix => name.endsWith(suffix))) return true;
    // Bare glass and planks are strong build signals; stone/mud bricks are not.
    if (name === 'glass' || name.endsWith('_planks')) return true;
    return false;
}

/**
 * Walk forward under raw control for a while, letting AutoJump handle 1-block steps.
 * Used when the pathfinder declines to plan a route (it will not path over a step on this
 * server), which otherwise leaves the bot standing still indefinitely.
 * @returns {Promise<number>} blocks actually covered.
 */
/**
 * Get out of water by heading for the closest dry bank.
 *
 * Pillaring does not work here - the bot floats in the water cell, so there is nowhere to place
 * a block under itself. And steering at the distant travel goal just pushes it further into the
 * river. Aim at the nearest bank instead.
 *
 * Now swims properly rather than pulsing jump: `hopForward`'s jump pulse is buoyancy in water,
 * not propulsion, so it made the bot bob in place instead of crossing.
 * @returns {Promise<boolean>} true if the bot is out of the water.
 */
export async function escapeWater(bot, tries = 8) {
    const nav = await import('./nav.js');
    for (let i = 0; i < tries && inWater(bot); i++) {
        if (bot.interrupt_code) break;
        const land = nav.nearestDryLand(bot, 16);
        if (!land) break;
        const r = await swim.swimTo(bot, land, { timeoutMs: 8000, arrive: 1.2 });
        if (r.reason === 'lava' || r.reason === 'lava_on_route') break;
    }
    const out = !inWater(bot);
    log(bot, out ? `Out of the water at y=${bot.entity.position.y.toFixed(0)}.` : `Still in water.`);
    return out;
}

/**
 * Blocks that occupy TWO cells. Placing one needs a free neighbour as well as a free target, and
 * a half-placed bed is not a bed - it pops straight off and cannot set a respawn point.
 */
const TWO_CELL_BLOCKS = /(_bed$|_door$|^tall_grass$|^large_fern$|^sunflower$|^lilac$|^rose_bush$|^peony$)/;

/**
 * Place a block NEXT TO the bot rather than inside it.
 *
 * `!placeHere` used to pass the bot's own position straight to `placeBlock`, which cannot work:
 * the bot's body occupies that cell. It failed silently-ish behind mineflayer's 500ms
 * `blockUpdate` timeout, so the error read like the known timeout flake rather than "you asked
 * me to place a block inside myself". A bed made it obvious, needing two cells instead of one.
 *
 * @returns {Promise<boolean>} true if the block is verifiably there
 */
export async function placeNearby(bot, blockType, maxRadius = 3) {
    const needsPair = TWO_CELL_BLOCKS.test(blockType);
    const origin = bot.entity.position.floored();
    const free = (v) => {
        const at = bot.blockAt(v);
        const below = bot.blockAt(v.offset(0, -1, 0));
        if (!at || !below) return false;
        if (at.name !== 'air' && at.name !== 'cave_air') return false;
        return below.boundingBox === 'block';
    };

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let r = 1; r <= maxRadius; r++) {
        for (const [dx, dz] of dirs) {
            for (const dy of [0, -1, 1]) {
                const spot = origin.offset(dx * r, dy, dz * r);
                if (!free(spot)) continue;
                if (needsPair && !dirs.some(([nx, nz]) => free(spot.offset(nx, 0, nz)))) continue;
                if (await placeBlock(bot, blockType, spot.x, spot.y, spot.z)) return true;
            }
        }
    }
    log(bot, `No free space near me to place ${blockType}${needsPair ? ' (it needs two blocks of room)' : ''}.`);
    return false;
}

/** Is the bot's body in water? Canonical test lives in swim.js. */
function inWater(bot) {
    return swim.inWater(bot);
}

/**
 * How far a single swim leg may be. The guard against the ocean failure mode: beyond this the
 * bot heads for the nearest bank and the planner routes around instead. Without a ceiling, a
 * cheap-water cost model plus a goal on the far side of an ocean sends the bot out to sea, where
 * every recovery behaviour this codebase has (dig, bridge, pillar) is useless.
 */
const MAX_SWIM_LEG = 24;

/**
 * The first standable land straight ahead across the water, or null if there is none within
 * `maxLeg`. Returns a target for `swim.swimTo`, not just a distance, so the caller aims at dry
 * ground rather than at a point in open water.
 *
 * @returns {{pos:Vec3, distance:number, water:number}|null}
 */
function swimCrossingTarget(bot, dx, dz, maxLeg = MAX_SWIM_LEG) {
    const p = bot.entity.position.floored();
    let water = 0;
    for (let i = 1; i <= maxLeg + 4; i++) {
        const x = p.x + dx * i, z = p.z + dz * i;
        // Follow the water surface: the bank may be a block up or down from where we float.
        for (const dy of [0, 1, -1, 2]) {
            const y = p.y + dy;
            const feet = bot.blockAt(new Vec3(x, y, z));
            const head = bot.blockAt(new Vec3(x, y + 1, z));
            const below = bot.blockAt(new Vec3(x, y - 1, z));
            if (!feet || !head || !below) continue;
            const standable = (feet.name === 'air' || feet.name === 'cave_air')
                && (head.name === 'air' || head.name === 'cave_air')
                && below.boundingBox === 'block' && !isWaterName(below.name);
            if (standable && water > 0) {
                return { pos: new Vec3(x + 0.5, y, z + 0.5), distance: i, water };
            }
        }
        if (isWaterName(bot.blockAt(new Vec3(x, p.y, z))?.name)) water++;
        if (water > maxLeg) return null; // too wide to be a crossing
    }
    return null;
}

// Blocks worth spending to build with, cheapest-to-lose first. Deliberately excludes anything
// with value or gravity: sand would fall out from under the bot as it climbed.
const STACKABLE = [
    'dirt', 'cobblestone', 'stone', 'netherrack', 'red_terracotta', 'terracotta',
    'sandstone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'cut_sandstone',
];

/** Is there anything in the inventory we can build a climb out of? */
export function hasBuildingBlocks(bot) {
    return STACKABLE.some(n => bot.inventory.items().some(it => it.name === n));
}

/**
 * Climb a ledge the bot cannot jump, by PLACING blocks rather than mining.
 *
 * AutoJump clears exactly one block (`maxRise: 1`), so anything taller stops travel dead. The
 * alternative already in the code was to cut stairs *into* the cliff, which works but chews up
 * the landscape. Pillaring up and stepping across leaves the terrain intact.
 *
 * Pillar-then-step, not a forward ramp: the cell ahead at foot height IS the cliff face, so
 * there is nowhere in front to place a tread. The block has to go underneath the bot.
 *
 * @returns {Promise<number>} height actually gained.
 */
export async function climbLedgeByPlacing(bot, dx, dz, rise) {
    const startY = bot.entity.position.y;
    if (!hasBuildingBlocks(bot)) return 0;

    // Pillar in rounds rather than one shot: a single pass regularly gained less than asked
    // (jump height is inconsistent on this server), which left the bot stranded partway up a
    // wall it then could not step over.
    const want = Math.ceil(rise);
    for (let round = 0; round < 4; round++) {
        if (bot.entity.position.y - startY >= want - 0.1) break;
        const before = bot.entity.position.y;
        await pillarUp(bot, want - Math.round(bot.entity.position.y - startY));
        if (bot.entity.position.y - before < 0.5) break;   // made no headway this round
    }

    const lifted = bot.entity.position.y - startY;
    if (lifted < 0.5) return 0;

    // Now level with the top, step across onto it. Without this the bot is stranded on its
    // own tower and the next replan just walks it back off.
    await hopForward(bot, dx, dz, 1800);

    const gained = bot.entity.position.y - startY;
    if (gained >= 0.5) log(bot, `Placed blocks to climb ${gained.toFixed(0)} blocks up (no digging).`);
    return gained;
}

/**
 * Classic pillar jump: jump, and place a block underneath at the apex so the bot lands one
 * block higher. This is the only way up out of an open excavated chamber, where there is no
 * wall to cut a staircase into.
 * @returns {Promise<number>} height actually gained.
 */
/**
 * Build a footing under a bot that is AFLOAT, so it can stand up and step out.
 *
 * `pillarUp` cannot do this: it requires a solid block directly beneath the bot and jumps to
 * make clearance, and neither holds while floating. But "pillaring cannot work while floating"
 * (the note this file used to carry) is too strong - there is usually a POOL FLOOR a couple of
 * blocks down, and water is replaceable, so a block can be placed on that floor's top face to
 * fill the cell under the bot's feet. One or two of those turn deep-enough-to-float water into
 * water shallow enough to stand in, after which the ordinary step-up handles the bank.
 *
 * This is the move neither bot ever tried while carrying 320 cobblestone, and it is the one
 * that the test gym shows is needed: at depths 1-2 the bot can neither rise (no swim impulse at
 * the surface) nor jump (`onGround` is false), so it grinds against a one-block bank or mines
 * through it.
 *
 * Only useful in shallow water - beyond about 4 blocks the floor is out of reach, and at those
 * depths the bot can submerge and swim up under its own power anyway.
 *
 * @returns {Promise<number>} blocks placed
 */
export async function buildFootingBelow(bot, maxPlaces = 3) {
    const { Vec3 } = await import('vec3');
    let placed = 0;

    const why = (m) => console.log(`[${bot.username ?? '?'}] footing: ${m}`);

    for (let i = 0; i < maxPlaces; i++) {
        if (bot.interrupt_code) break;
        if (!inWater(bot)) { why('not in water'); break; }

        const feet = bot.entity.position.floored();
        const under = bot.blockAt(feet.offset(0, -1, 0));
        if (under && under.boundingBox === 'block') { why(`already standing on ${under.name}`); break; }

        // The reference has to be the highest solid in the column and within arm's reach.
        let ref = null;
        for (let dy = 2; dy <= 4; dy++) {
            const b = bot.blockAt(feet.offset(0, -dy, 0));
            if (b && b.boundingBox === 'block') { ref = b; break; }
        }
        if (!ref) { why(`no solid floor within reach under ${feet}`); break; }

        const mat = STACKABLE.map((n) => bot.inventory.items().find((it) => it.name === n)).find(Boolean);
        if (!mat) { why('nothing stackable in inventory'); break; }
        try { await bot.equip(mat, 'hand'); } catch (err) { why(`equip failed: ${err.message}`); break; }

        // Through block_io for the same reason pillarUp is: `bot.placeBlock` reports a late
        // confirmation as a failed placement, and this ran in water where the round trip is no
        // faster. The block either appears or it does not, and the world says which.
        const r = await blockIO.placeVerified(bot, ref, new Vec3(0, 1, 0));
        if (!r.ok) { why(`place failed on ${ref.position}: ${r.why}`); break; }
        placed++;
        why(`placed ${mat.name} on ${ref.position} (feet ${feet})`);
        await new Promise((r) => setTimeout(r, 250));
    }

    if (placed) log(bot, `Built a footing of ${placed} block(s) to stand on.`);
    return placed;
}

/** The engine's own jump impulse. `swim.climbBank` uses the same figure for the same reason. */
export const WET_LIFT_IMPULSE = 0.42;

/**
 * Should we (re)apply the lift impulse this tick, while wet?
 *
 * Pure, because the two ways of getting this wrong are opposite and both were live bugs. In
 * water prismarine-physics runs `if (isInWater) vel.y += 0.04` BEFORE it checks `onGround`
 * (index.js:723), so the asserted take-off is a no-op and the bot rises 0.04 - measured. One
 * hand-supplied 0.42 took that to 0.42 and no further, because water drag bleeds it away in a
 * few ticks. Rising a whole block while wet is therefore a DUTY CYCLE, not a single push.
 *
 * The guards are what keep it at vanilla parity: only while BELOW the clearance we need, and
 * only when not already rising - so it tops the bot up rather than compounding into a speed the
 * server would refuse. Same discipline as SwimAssist's boost.
 */
export function wetLiftVerdict(s) {
    if (!s || !s.inWater) return false;              // on land the engine's own jump works
    // LAVA SHARES THE WATER BRANCH. prismarine-physics computes `isInLava` independently
    // (index.js:713) and then handles both fluids in one branch (:472, :723), so both flags can
    // be true at a boundary. Every other wet entry point refuses there - SwimAssist `_tick`
    // restores and returns, `climbBank` breaks its loop - and this was the only one that did
    // not. An upward shove in lava is not itself lethal; being the one routine in the codebase
    // that keeps driving while burning is.
    if (s.inLava) return false;
    if (!(s.rise < (s.clearance ?? 1.0))) return false;   // already clear; stop pushing
    // A CADENCE - AND ITS ORIGINAL JUSTIFICATION WAS MEASURED AND DISPROVED. Read this before
    // citing it as an anti-cheat guard, and before deleting it.
    //
    // The mechanism is real and observed. When collision resolution zeroes vel.y every tick the
    // velocity gate is satisfied EVERY tick, so a 10ms sampler re-arms and asserts an impulse the
    // bot is not getting (2026-08-30 17:16:35, andy, wading at 4752.5/62.0/4614.3):
    //
    //   climbBank: t=0.0s vel=(0.000, 0.420, 0.000) pos=(4752.50, 62.00, 4614.30)
    //   climbBank: t=2.0s vel=(0.000, 0.420, 0.000) pos=(4752.50, 62.00, 4614.30)
    //
    // This gate was then claimed to be what keeps that inside vanilla parity. IT IS NOT. Measured
    // 2026-08-31 as a controlled gated-vs-ungated comparison in exactly that jammed state, three
    // runs each (docs/CADENCE_MEASUREMENT.md):
    //
    //   gated  (350ms):  171 lifts, 0 server corrections, 0 valve trips
    //   ungated  (0ms): 1525 lifts, 0 server corrections, 0 valve trips
    //
    // Nine times the re-arm rate, sustained over a minute of wet time, and the server did not
    // notice. The likely reason is structural: the protocol reports POSITION, not velocity, so a
    // vel.y write that collision cancels before the next position packet never reaches the wire
    // at all. Rate cannot matter for a quantity that is not transmitted.
    //
    // IT STAYS ANYWAY, but for ONE honest reason, not two. The measurement covered ONLY the
    // fully-jammed, zero-clearance case that the
    // old justification cited; a partial-rise bank, where re-arming produces REAL displacement,
    // is untested, and that is precisely where rate would become visible on the wire. Removing it
    // on this evidence would repeat the mistake the evidence just corrected: generalising from
    // the case that was measured to the case that was not.
    //
    // DO NOT WRITE "IT COSTS NOTHING" HERE. That was in an earlier draft and it is the same
    // over-generalisation in the other direction: "impulses land ~500ms apart so the gate rarely
    // binds" is measured only where NOTHING RISES. In a real partial rise each impulse produces
    // displacement, drag bleeds it within a few ticks, and 350ms is a third of a second of
    // sinking between pushes - so the gate could plausibly slow the very case it is kept for.
    // Unexplained supporting thread: three escapes of the identical wet pocket took 6.0s, 24.1s
    // and 44.2s, and the gate is one candidate among several for that spread.
    if ((s.sinceLastMs ?? Infinity) < (s.minGapMs ?? 350)) return false;
    return (s.velY ?? 0) <= (s.risingVelY ?? 0.05);  // already on the way up: leave it alone
}

/**
 * Total height `climbToSurface` may gain by TOWERING, across every rung, in one call.
 *
 * Measured runaways before any budget existed: `climbOut: +54.0 to y=118.0`, and `climbOut:
 * +27.0 to y=104.0` again from the other rung once only the first was bounded. 24 bounds both
 * and still covers the case the rung exists for - `travelDirection` calls `climbOut` when the
 * bot is >20 blocks below the surface, so a legitimate tower out of an open chamber fits.
 */
export const TOWER_BUDGET = 24;

/**
 * How far above the feet is the nearest ceiling? `null` means open sky.
 *
 * This is the observation `surfaceUnknownVerdict` decides on, split out so the SCAN is testable
 * too and not just the branch it feeds. dy starts at 2 because dy=1 is the bot's own head, and
 * stops at `maxDy` because this runs on every iteration of the climb loop.
 *
 * KNOWN AND DELIBERATE, verified against minecraft-data 1.21.11: leaves, glass, tinted glass and
 * ice all report `boundingBox === 'block'`, so a canopy or a greenhouse reads as ROOFED. That is
 * the safe way to be wrong. A false "roofed" costs a bounded tower and the next iteration re-reads
 * the world from higher up; a false "open sky" strands the bot underground behind a message that
 * says it succeeded, which is the failure nobody investigates. An unloaded or missing column
 * reads as open sky for the same reason `openObstruction` fails open - point missing data at the
 * cheap mistake, not the expensive one.
 *
 * @param {(dy:number)=>(string|null|undefined)} boundingBoxAt boundingBox dy blocks above the feet
 * @returns {number|null} dy of the lowest ceiling, or null for open sky
 */
export function ceilingAbove(blockAt, opts = {}) {
    const minDy = opts.minDy ?? 2;
    const maxDy = opts.maxDy ?? 40;
    for (let dy = minDy; dy <= maxDy; dy++) {
        // Accepts a block-ish object OR a bare boundingBox string, so an existing caller that
        // only has the box keeps working - but one that can supply the NAME gets the canopy test.
        const b = blockAt(dy);
        const box = typeof b === 'string' ? b : b?.boundingBox;
        if (box !== 'block') continue;
        // LEAVES ARE NOT A CEILING. minecraft-data gives oak_leaves boundingBox 'block'
        // (verified, 1.21.11), so a bot standing under a tree on OPEN GROUND reads as roofed -
        // and the null-surface branch then towers up through the canopy from ground it was
        // already standing on. That is the 54-block-spike false positive wearing a different
        // hat. Glass deliberately still counts: a greenhouse roof is a real roof.
        const name = typeof b === 'string' ? null : b?.name;
        if (name && isCanopy(name)) continue;
        return dy;
    }
    return null;
}

/**
 * `surfaceY` came back null for our column AND every neighbour. Rise, or stop?
 *
 * Pure, because null means two OPPOSITE things and picking wrong is destructive in one
 * direction. In a hole the bot has mined out, no cell above has anything solid under it, so the
 * scan finds nothing and rising is right. Standing in open sky on top of our own pillar reads
 * exactly the same - and there, rising builds a spike: measured `climbOut: +54.0 to y=118.0`,
 * four blocks at a time, from a bot already on open ground.
 *
 * A ceiling tells them apart. The budget is the second guard, because a pillar cannot be
 * un-built and bounding each tower CALL did not bound the LOOP that kept making them.
 *
 * IT RETURNS THE ALLOWANCE, NOT JUST A YES. A rung capped at 8 with 3 left in the ledger spends
 * 8, so a pre-spend `>=` test still overshoots by a whole rung - a third of the budget, and the
 * two call sites disagreed about even that (`>` after spending on one, `>=` before on the other).
 * `climbShaftUp`'s last argument is a MAXIMUM, so handing it the allowance is what turns the
 * budget from a threshold into a hard cap.
 */
export function surfaceUnknownVerdict(s) {
    const no = (reason) => ({ tower: false, allowance: 0, reason });
    if (!s) return no('no state');
    if (!s.roofed) return no('open sky above me - already at the surface');
    const allowance = (s.budget ?? TOWER_BUDGET) - (s.towered ?? 0);
    if (allowance < 1) return no(`tower budget spent (+${Math.round(s.towered ?? 0)})`);
    return { tower: true, allowance, reason: 'no surface reading in any neighbouring column' };
}

export async function pillarUp(bot, blocks = 1) {
    const { Vec3 } = await import('vec3');
    const stackable = STACKABLE;
    const startY = bot.entity.position.y;
    // NAME THE RUNG THAT FAILED. This loop has five ways to give up and reported none of them,
    // so every one of them surfaced to the caller as the single number 0 - indistinguishable
    // from "there was a ceiling". Chasing `pillar did not lift me` against open sky cost a whole
    // round of live testing that a one-line reason would have ended immediately.
    let why = 'done';

    for (let i = 0; i < blocks; i++) {
        if (bot.interrupt_code) { why = 'interrupted'; break; }
        const mat = stackable.map(n => bot.inventory.items().find(it => it.name === n)).find(Boolean);
        if (!mat) { why = 'nothing stackable in inventory'; break; }
        try { await bot.equip(mat, 'hand'); } catch (err) { why = `equip failed: ${err.message}`; break; }

        // SETTLE BEFORE MEASURING THE FLOOR. `onGround` is unusable here, so the only honest
        // test of "am I standing" is that y has stopped changing - and a pillar step is nearly
        // always entered straight out of a hop or a dig, with the body still falling. Measured
        // at y=65.17: seventeen hundredths above the block face, which reads as NOT standing on
        // it, so the floor check below failed and the jump was never even attempted.
        await settleY(bot, 600);
        const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') {
            why = `nothing solid under my feet (${below?.name ?? 'void'} at y=${bot.entity.position.y.toFixed(2)})`;
            break;
        }

        // Wait for actual clearance instead of guessing a delay. A fixed sleep placed the block
        // while the bot was still inside the target cell, which silently fails - measured as
        // "climbed 0 blocks" against a wall it should have cleared. Jump height also varies
        // here because the physics is running on stale collision data.
        const baseY = bot.entity.position.y;
        bot.setControlState('forward', false);   // drifting off the pillar loses the gain
        // ASSERTED TAKE-OFF, not a key press. Every jump in prismarine-physics is gated on
        // `entity.onGround`, which reads false for seconds at a time while the bot is provably
        // standing - so `setControlState('jump')` alone fires nothing, and this loop measured
        // `0 broken, 0 placed - pillar did not lift me` against OPEN SKY. JumpAssist asserts the
        // flag for the take-off tick and lets the engine apply its own 0.42 impulse. Heading
        // (0,0) because this is a vertical hop: the axial top-up then contributes exactly
        // nothing, where any other heading would shove the bot off its own pillar.
        //
        // `noteOutcome` is deliberately NOT called here. It latches jumping dead for the session
        // after three riseless flights, and a pillar can fail for reasons that say nothing about
        // the jump mechanism - a ceiling, a full inventory, a placement the server refused.
        // Only `jumpAcross`, which probes the terrain first, has earned the right to that verdict.
        const assisted = bot.jumpAssist?.begin(0, 0) === true;
        // IN WATER THE ENGINE'S JUMP BRANCH IS HIJACKED, so the asserted take-off is a no-op.
        // prismarine-physics checks `if (isInWater || isInLava) vel.y += 0.04` BEFORE it checks
        // `onGround` (index.js:723) - the branch that is dead on land is the live one here - so
        // asserting the ground flag buys nothing and the bot gets the swim nudge instead.
        // Measured live, wading against a 0.50-block bank: `apex 0.04, assisted=true`, over and
        // over, while climbBank was jammed and every other rung stood down for it.
        //
        // Supply the impulse directly, exactly as `swim.climbBank` does for this same reason -
        // and by the same means: `+=`, on a 350ms cadence, refusing lava.
        //
        // ADD, DO NOT ASSIGN, *HERE*. The two rules in CLAUDE.md are not in conflict; they
        // describe different velocity regimes. `scratchpad/sim/RESULTS.md` measures the land
        // case - "apex 0.87, not 1.25, because mechanism B used `vel.y += 0.42` from a velocity
        // the engine had already made NEGATIVE" - where gravity has taken vel.y to about -0.08
        // before the take-off tick, so `+=` really does cost a third. In water it never fires
        // from there: the gate is `velY <= 0.05` and the measured unaided sink rate is -0.025
        // b/t, so the two forms differ by at most 0.025, six per cent of the impulse.
        //
        // What the assignment DOES change is the one case that matters to a move check. Firing
        // from a fast fall, `= 0.42` is a delta-v of nearly a block per tick, where `+= 0.42` is
        // always exactly one engine impulse whatever it starts from. The server sees the delta,
        // not the endpoint, so `+=` is the only form that literally cannot exceed vanilla
        // parity - and it is the form `climbBank` has already been live-verified with.
        //
        // Canonical `swim.inWater`/`swim.inLava`, not the raw entity flags: both fall back to a
        // block scan of the feet and head cells, which is what every other consumer reads.
        let lastLift = 0;
        const wetLift = () => {
            const v = bot.entity.velocity;
            if (!v) return;
            if (!wetLiftVerdict({
                inWater: swim.inWater(bot), inLava: swim.inLava(bot),
                rise: bot.entity.position.y - baseY, velY: v.y,
                sinceLastMs: Date.now() - lastLift,
            })) return;
            lastLift = Date.now();
            v.y += WET_LIFT_IMPULSE;
        };
        wetLift();
        let apex = 0, placeErr = null;
        try {
            await bot.look(bot.entity.yaw, Math.PI / 2, true);   // face straight down
            if (!assisted) bot.setControlState('jump', true);
            // PLACE ON THE WAY UP, not at the apex. Waiting for a full block of clearance was
            // tried and is worse: the apex lasts about two ticks, and by the time the placement
            // packet is written the body is back in the cell. A clean mineflayer bot placing at
            // +0.5 on the way up succeeds 4/4 on this server, so 0.5 is the measured threshold,
            // not a guess. Retry within the flight rather than spending the whole jump on one
            // attempt - the window is several ticks wide and a single miss should not cost the
            // block.
            // `placeUnderfoot` owns the whole pillar placement: it waits for the body to leave
            // the cell it is filling, snaps the look instead of turning smoothly, never awaits
            // mineflayer's unsatisfiable ack, and retries inside the flight. See block_io.js -
            // all three of those are separate mineflayer defects that only fail in combination.
            // SUSTAIN THE IMPULSE IN WATER, do not just kick once. One 0.42 assignment took the
            // measured apex from 0.04 to 0.42 - real, and still not a full block, because water
            // drag bleeds it away within a few ticks. Rising a whole block while wet is a DUTY
            // CYCLE, which is exactly what `swim.climbBank` and SwimAssist's buoyancy already
            // are; a single push is the land model applied where it does not hold.
            //
            // Only while below the clearance and only when not already rising, so this cannot
            // compound into a speed the server would refuse.
            const apexWatch = setInterval(() => {
                apex = Math.max(apex, bot.entity.position.y - baseY);
                wetLift();
            }, 10);
            let res;
            try {
                // A LONGER WINDOW MUST NOT BUY A LONGER BURST. `placeUnderfoot` passes
                // `pace: false` on the stated premise that the window is shorter than the
                // interaction rate limit - and what it really relies on is that `bodyClearsCell`
                // is only true for the ~2 ticks a LAND apex lasts. In water that premise is
                // gone: the measured unaided sink is 0.025 b/t, so once the body is clear it
                // stays clear and every remaining attempt fires back to back.
                //
                // The logs say the burst is already real on land, where the clearance window is
                // supposed to be narrow: of 114 recorded pillar failures with attempts, 46 fired
                // six or more placement packets, 22 of them the full eight, acked at 33-41ms
                // each - eight interactions inside about 350ms against a documented
                // `MIN_PLACE_GAP_MS` of 250, and 90 lines of `refused by server`. Widening the
                // window to 2500ms is right (the wet rise is slow and 900ms genuinely is not
                // enough), but it must come with a tighter retry cap, or the extra time is spent
                // re-sending a placement the server has already refused.
                res = await blockIO.placeUnderfoot(bot, below, swim.inWater(bot)
                    ? { windowMs: 2500, maxAttempts: 3 }
                    : { windowMs: 900 });
            } finally {
                clearInterval(apexWatch);
            }
            if (!res.ok) placeErr = `${res.why} after ${res.attempts} attempt(s)`;
        } catch (err) {
            // look/jump failed; the next iteration retries
        } finally {
            // A leaked `active` flag mutes AutoJump permanently, which destroys the one-block
            // step the whole navigator is built on.
            if (assisted) bot.jumpAssist.end();
            bot.setControlState('jump', false);
        }
        await new Promise(r => setTimeout(r, 400));
        if (bot.entity.position.y - baseY < 0.5) {
            // APEX SEPARATES THE TWO FAILURES, and they need opposite fixes. An apex near zero
            // means the bot never left the ground - a take-off problem. An apex near 1.25 (the
            // engine's own jump) means it flew fine and the PLACEMENT is what failed, so the bot
            // simply fell back down the shaft it was trying to climb.
            why = `did not rise from y=${baseY.toFixed(2)} (apex ${apex.toFixed(2)}, `
                + `assisted=${assisted}, jumpAssist.disabled=${!!bot.jumpAssist?.disabled}`
                + (placeErr ? `, place failed: ${placeErr}` : '') + ')';
            break;
        }
    }
    const gained = bot.entity.position.y - startY;
    if (gained < 0.5) console.log(`[${bot.username ?? '?'}] pillarUp: +${gained.toFixed(2)} - ${why}`);
    return gained;
}

/**
 * Is ONE tower-up step - break the ceiling, place under the feet - safe and possible here?
 *
 * Pure, so every refusal is unit-testable (`tests/shaft.test.mjs`). The refusals matter more
 * than the approvals: this routine mines the block directly over the bot's head, and the two
 * ways that goes wrong are irreversible. Breaking into lava kills the bot AND its inventory,
 * and breaking into water floods a sealed pocket the bot is standing at the bottom of.
 *
 * @param {object} ctx
 * @param {string} ctx.above      block name at feet+2 - the ceiling. 'air' when already open.
 * @param {boolean} ctx.hasBlocks something stackable is in the inventory
 * @param {boolean} ctx.afloat    the bot is floating, not standing on something solid
 * @returns {{ok: boolean, dig: boolean, falling: boolean, reason: string}}
 */
export function shaftUpVerdict(ctx) {
    const above = ctx?.above ?? 'air';
    const no = (reason) => ({ ok: false, dig: false, falling: false, reason });

    // Placing does not work while floating, for the same reason pillaring does not - there is
    // nothing under the feet to place against. Same invariant as the swim code.
    if (ctx?.afloat) return no('afloat - cannot place a block under myself');
    // Digging up without anything to stand on just makes a shaft the bot is still at the
    // bottom of. That is strictly worse than not starting: it spends the ceiling for nothing.
    if (!ctx?.hasBlocks) return no('nothing stackable to pillar with');
    if (tools.isLavaName(above)) return no('lava overhead');
    if (isWaterName(above)) return no('water overhead - breaking it would flood the shaft');
    if (above === 'bedrock') return no('bedrock overhead');

    const open = above === 'air' || above === 'cave_air' || above === 'void_air';
    return {
        ok: true,
        dig: !open,
        // Sand and gravel do not stay mined: the column above drops into the cell just cleared,
        // so the caller has to keep breaking the SAME cell instead of moving up into it.
        falling: !open && isFallingBlockName(above),
        reason: open ? 'already open' : `break ${above}`,
    };
}

/**
 * Tower straight up out of a sealed pocket: break the block above the head, place one under the
 * feet, repeat. What a player does when buried.
 *
 * `climbToSurface` cuts a diagonal STAIRCASE, which needs a solid neighbour to step onto and
 * horizontal room to travel through; `pillarUp` places under the feet but requires headroom it
 * cannot make for itself, so sealed under a ceiling it measures "not rising" on its first
 * iteration and returns 0. Neither one breaks upward, so between them the bot could not leave a
 * pocket whose only cheap exit was above it - the case that produced "Andy is stuck underground".
 *
 * Kept separate from `pillarUp` deliberately. `pillarUp`'s other callers are the night-shelter
 * paths (`emergencyShelter`, `digOut`), where a ceiling is the POINT - teaching it to break
 * through one would have the bot demolish the roof it just sealed itself under.
 *
 * @param {number|null} targetY stop once the feet reach this Y. Defaults to the surface.
 * @returns {Promise<number>} height gained.
 */
export async function climbShaftUp(bot, targetY = null, maxSteps = 64) {
    const startY = bot.entity.position.y;
    const why = (m) => console.log(`[${bot.username ?? '?'}] shaftUp: ${m}`);

    let target = targetY;
    if (target === null) {
        const p0 = bot.entity.position.floored();
        target = nav.surfaceY(bot, p0.x, p0.z, 160, p0.y + 1);
    }

    let dug = 0, placed = 0, stop = 'reached target';
    for (let i = 0; i < maxSteps; i++) {
        if (bot.interrupt_code) { stop = 'interrupted'; break; }
        const p = bot.entity.position.floored();
        if (target !== null && p.y >= target) break;

        const ceilPos = p.offset(0, 2, 0);
        const below = bot.blockAt(p.offset(0, -1, 0));
        const v = shaftUpVerdict({
            above: bot.blockAt(ceilPos)?.name ?? 'air',
            hasBlocks: hasBuildingBlocks(bot),
            afloat: swim.inWater(bot) && !(below && below.boundingBox === 'block'),
        });
        if (!v.ok) { stop = v.reason; break; }

        if (v.dig) {
            // A falling column has to be cleared until it STAYS clear. Reading the cell once
            // catches it in the moment between the block being broken and the sand above
            // landing in its place, and the bot then pillars into a cell that refills onto its
            // head. Two consecutive clear reads is the same "trust measured state" rule the
            // shelter descent and the chest counts already use.
            let cleared = false;
            for (let t = 0; t < (v.falling ? 24 : 3); t++) {
                const b = bot.blockAt(ceilPos);
                if (!b || b.boundingBox !== 'block') {
                    if (!v.falling) { cleared = true; break; }
                    await new Promise(r => setTimeout(r, 300));
                    const again = bot.blockAt(ceilPos);
                    if (!again || again.boundingBox !== 'block') { cleared = true; break; }
                    continue;
                }
                if (!(await digWithTool(bot, b))) break;
                dug++;
            }
            if (!cleared) { stop = `could not clear ${bot.blockAt(ceilPos)?.name} at ${ceilPos}`; break; }
        }

        const gained = await pillarUp(bot, 1);
        if (gained < 0.5) { stop = `pillar did not lift me (y=${bot.entity.position.y.toFixed(2)})`; break; }
        placed++;
    }

    const climbed = bot.entity.position.y - startY;
    why(`${climbed.toFixed(1)} blocks: ${dug} broken, ${placed} placed - ${stop}`);
    if (placed) log(bot, `Towered up ${climbed.toFixed(0)} blocks (broke ${dug}, placed ${placed}).`);
    return climbed;
}

/**
 * Walk forward while pulsing jump, and report the HEIGHT gained.
 *
 * walkForward relies on AutoJump to clear a step, but AutoJump gates on `onGround`, which this
 * server reports as false for seconds at a time while the bot is provably standing. Driving the
 * jump directly is the only thing that reliably lifts the bot onto a stair tread here.
 */
async function hopForward(bot, dx, dz, ms = 1600) {
    const { Vec3 } = await import('vec3');
    const start = bot.entity.position.clone();
    try {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.stop();
    } catch (err) { /* plugin may be absent */ }
    await bot.lookAt(new Vec3(start.x + dx * 6, start.y, start.z + dz * 6), true);
    bot.setControlState('forward', true);
    const end = Date.now() + ms;
    try {
        while (Date.now() < end && !bot.interrupt_code) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 200));
            bot.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 200));
        }
    } finally {
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
    }
    await new Promise(r => setTimeout(r, 250));
    return bot.entity.position.y - start.y;
}

async function walkForward(bot, dx, dz, ms = 4000) {
    const { Vec3 } = await import('vec3');
    const start = bot.entity.position.clone();
    try {
        bot.pathfinder.setGoal(null);
        bot.pathfinder.stop();
        const look = start.offset(dx * 6, 0, dz * 6);
        await bot.lookAt(new Vec3(look.x, start.y, look.z), true);
        bot.setControlState('forward', true);
        await new Promise(r => setTimeout(r, ms));
    } catch (err) {
        // fall through and clean up
    } finally {
        bot.setControlState('forward', false);
    }
    await new Promise(r => setTimeout(r, 300));
    return bot.entity.position.distanceTo(start);
}

/**
 * Work an inventory count toward `num` of `itemName`, one step at a time, by walking
 * `progression.resolveProgression`'s pure tech-tree resolver (docs/gaps/resource-progression.exec.md).
 *
 * The loop RE-PLANS every iteration rather than executing a stale plan - firstUnsatisfied is
 * judged against the CURRENT inventory, so a step consumed as an ingredient for a later step
 * (e.g. planks spent on sticks) is picked up correctly on the next pass. Bounded three ways:
 * a wall-clock deadline, three consecutive failures of the exact same step (kind+item), and
 * `bot.interrupt_code` checked every iteration so a user/mode interrupt is honoured promptly.
 *
 * Dispatch deliberately reuses existing, already-owned primitives rather than a second engine:
 *  - collect -> `collectBlock` (best-effort; ores never reach this branch - they resolve to a
 *    'mine' step instead, see below - but surface materials like oak_log do, and that path is
 *    documented elsewhere as unverified for logs specifically; a persistent failure here is
 *    caught by the same 3-strikes stall guard as everything else)
 *  - craft  -> `craftRecipe` (already routes through the navToGoal seam)
 *  - smelt  -> `smeltItem` (known furnace-window risk, same family as the chest defects this
 *    codebase owns elsewhere; not re-engineered here - a hang is still bounded by the
 *    command's own runAction timeout)
 *  - mine   -> `mining.branchMine`, targeted at the step's clamped `targetY`; progress is
 *    judged by an inventory diff on the step's OWN item name, not on branchMine's own report,
 *    since branchMine harvests every exposed ore it passes, not only the one asked for.
 */
export async function progressTo(bot, itemName, num = 1) {
    if (typeof itemName !== 'string' || itemName.length === 0) {
        log(bot, 'progressTo: no item name given.');
        return `progressTo failed: no item name given.`;
    }
    const need = Number.isFinite(num) && num > 0 ? Math.floor(num) : 1;
    const deadline = Date.now() + 55 * 60 * 1000; // stays under the command's 60-minute action timeout
    let lastStepKey = null;
    let stallCount = 0;

    while (Date.now() < deadline) {
        if (bot.interrupt_code) {
            log(bot, `progressTo(${itemName}) interrupted.`);
            return `progressTo(${itemName}) interrupted.`;
        }

        const inv = world.getInventoryCounts(bot);
        const plan = progression.resolveProgression(itemName, need, inv);
        if (plan.error) {
            log(bot, `progressTo: ${plan.error}`);
            return `progressTo failed: ${plan.error}`;
        }
        if (plan.satisfied) {
            const have = world.getInventoryCounts(bot)[itemName] || 0;
            const msg = `VERIFIED PROGRESSION: have ${have}x ${itemName} (wanted ${need}).`;
            log(bot, msg);
            return msg;
        }

        const step = progression.firstUnsatisfied(plan.steps, inv);
        if (!step) {
            // Resolver says unsatisfied but every planned step already reads met against the
            // current inventory - re-plan on the next pass rather than looping tight on nothing.
            await new Promise(r => setTimeout(r, 200));
            continue;
        }

        const key = `${step.kind}:${step.item}`;
        stallCount = key === lastStepKey ? stallCount + 1 : 0;
        lastStepKey = key;
        if (stallCount >= 3) {
            const msg = `progressTo(${itemName}) stalled on ${step.kind} ${step.item} `
                + `(x${step.count}) after 3 attempts - giving up.`;
            log(bot, msg);
            return msg;
        }

        let ok = false;
        try {
            switch (step.kind) {
                case 'craft':
                    ok = await craftRecipe(bot, step.item, 1);
                    break;
                case 'smelt':
                    ok = await smeltItem(bot, step.input, step.count);
                    break;
                case 'mine': {
                    const before = world.getInventoryCounts(bot)[step.item] || 0;
                    await mining.branchMine(bot, {
                        targetY: step.targetY,
                        deadlineMs: Math.min(6 * 60 * 1000, Math.max(0, deadline - Date.now())),
                    });
                    const after = world.getInventoryCounts(bot)[step.item] || 0;
                    ok = after > before;
                    break;
                }
                case 'collect':
                default:
                    ok = await collectBlock(bot, step.item, step.count);
                    break;
            }
        } catch (e) {
            log(bot, `progressTo: step ${step.kind} ${step.item} threw: ${e?.message || e}`);
            ok = false;
        }
        if (!ok) {
            // Brief pause so a persistently-failing step (3-strikes above) does not spin the
            // event loop tight while waiting to be recognised as a stall.
            await new Promise(r => setTimeout(r, 500));
        }
    }

    const have = world.getInventoryCounts(bot)[itemName] || 0;
    const msg = `PROGRESSION INCOMPLETE: have ${have}x ${itemName} (wanted ${need}) after 55 minutes.`;
    log(bot, msg);
    return msg;
}

/** Exact block-name check - never a substring test (CLAUDE.md). Used to keep huntForFood from
 *  chasing an animal into a lake: getting a bot OUT of water is this codebase's single largest
 *  source of stuck bots, and a swimming cow is not worth that risk. */
function isPositionInWater(bot, pos) {
    const block = bot.blockAt(pos.floored());
    return !!block && block.name === 'water';
}

/**
 * Hunt nearby passive animals for raw meat, confirming each kill instead of trusting "it left
 * range" (see `farming.killConfirmed`'s header for why that distinction matters).
 *
 * pvp/nav control-state contention (docs/gaps/food-survival.exec.md S11): `mineflayer-pvp` sets
 * its own pathfinder `GoalFollow` on `bot.pvp.attack`, which fights our navigator's control
 * states exactly the way raw mineflayer-pathfinder does everywhere else in this codebase. So
 * `bot.pvp.attack` is NEVER used here - pvp is stopped before every nav leg, and the actual
 * swing is our own `bot.attack` on a fixed cadence, the same alternation `defendSelf` already
 * uses successfully.
 *
 * Refuses up front while `swim.inWater(bot)`: SwimAssist owns the jump key while wet and
 * nothing else may touch it. `huntVerdict` also refuses per-target if the TARGET is in water -
 * chasing a swimming cow puts the bot in the lake, which is worse than the meal is worth.
 */
export async function huntForFood(bot, maxKills = 3, range = 48) {
    if (swim.inWater(bot)) {
        const msg = 'Cannot hunt while in water - SwimAssist owns the jump key, refusing.';
        log(bot, msg);
        return msg;
    }

    const targets = world.getNearbyEntities(bot, range)
        .filter(e => mc.isHuntable(e))
        .map(e => ({ name: e.name, distance: bot.entity.position.distanceTo(e.position), metadata: e.metadata, entity: e }));
    const ranked = farming.rankHuntTargets(targets);

    if (ranked.length === 0) {
        const msg = `No huntable animals within ${range} blocks.`;
        log(bot, msg);
        return msg;
    }

    const beforeInv = world.getInventoryCounts(bot);
    const deadIds = new Set();
    const onDead = (e) => { if (e && e.id != null) deadIds.add(e.id); };
    bot.on('entityDead', onDead);

    let kills = 0;
    let fled = 0;
    try {
        for (const target of ranked) {
            if (kills >= maxKills) break;
            if (bot.interrupt_code) break;
            const entity = target.entity;
            if (!entity || entity.isValid === false) { fled++; continue; }

            const startedAt = Date.now();
            const deadlineMs = 45000;
            let killedThis = false;
            while (true) {
                if (bot.interrupt_code) { bot.pvp.stop(); break; }
                if (swim.inWater(bot)) {
                    // The bot itself drifted/waded into water mid-chase - stand down entirely,
                    // do not merely skip this target (S11/SwimAssist ownership).
                    bot.pvp.stop();
                    log(bot, 'Hunt stopped: entered water mid-chase.');
                    return finishHunt();
                }
                const verdict = farming.huntVerdict({
                    targetValid: entity.isValid !== false,
                    dist: bot.entity.position.distanceTo(entity.position),
                    elapsedMs: Date.now() - startedAt,
                    deadlineMs,
                    botInWater: false, // checked directly above; kept false here so a target-in-water refusal is distinguishable
                    targetInWater: isPositionInWater(bot, entity.position),
                });

                if (verdict === 'refuse') { // target is swimming - not worth following into the lake
                    bot.pvp.stop();
                    fled++;
                    break;
                }
                if (verdict === 'give_up') {
                    bot.pvp.stop();
                    fled++;
                    break;
                }
                if (verdict === 'attack') {
                    bot.pvp.stop(); // never contest control states with pvp's own GoalFollow
                    await equipHighestAttack(bot);
                    await bot.lookAt(entity.position.offset(0, entity.height ?? 0.9, 0));
                    bot.attack(entity);
                    await new Promise(r => setTimeout(r, 600));
                    if (farming.killConfirmed(entity, { deathSeen: deadIds.has(entity.id) })) {
                        killedThis = true;
                        break;
                    }
                    continue;
                }
                // 'approach'
                bot.pvp.stop();
                try {
                    const p = entity.position; // fresh read every leg - entities are re-created across render distance
                    await nav.navigateTo(bot, { x: p.x, y: p.y, z: p.z },
                        { arriveDist: 2.5, maxReplans: 2, waypointMs: 1500 });
                } catch (e) { /* the animal may have moved or died mid-leg; the loop re-evaluates */ }
            }
            if (killedThis) {
                kills++;
                await pickupNearbyItems(bot);
            }
        }
    } finally {
        bot.removeListener('entityDead', onDead);
        bot.pvp.stop();
    }

    return finishHunt();

    function finishHunt() {
        const afterInv = world.getInventoryCounts(bot);
        const gained = {};
        for (const k of new Set([...Object.keys(beforeInv), ...Object.keys(afterInv)])) {
            const d = (afterInv[k] || 0) - (beforeInv[k] || 0);
            if (d > 0) gained[k] = d;
        }
        const gainedStr = Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
        const msg = `VERIFIED HUNT: killed ${kills}/${Math.min(maxKills, ranked.length)}`
            + (fled > 0 ? ` (${fled} fled)` : '') + `, gained ${gainedStr}.`;
        log(bot, msg);
        return msg;
    }
}

/**
 * Cook every raw-and-worth-eating item in the bag, chicken first (see `farming.COOK_ORDER` -
 * auto-eat refuses raw chicken outright, so until it is cooked it is dead weight).
 *
 * Deliberately thin: `smeltItem` (skills.js, above) already does the furnace work. This does
 * NOT restart the agent between items - that restart lives only in the `!smeltItem` COMMAND's
 * `perform` (actions.js), never in the `smeltItem` skill function itself, so calling the skill
 * directly here is restart-free by construction. Counts are read by inventory diff AFTER each
 * `smeltItem` call returns, never during - `bot.inventory` is frozen while a furnace window is
 * open (CLAUDE.md "Chests"), and `smeltItem`'s own await already covers the close.
 */
export async function cookFood(bot) {
    const plan = farming.cookPlan(world.getInventoryCounts(bot));
    if (plan.length === 0) {
        const msg = 'Nothing raw to cook.';
        log(bot, msg);
        return msg;
    }

    const cooked = [];
    let hardFailure = null;
    for (const { item, count } of plan) {
        if (bot.interrupt_code) break;
        const before = world.getInventoryCounts(bot)[item] || 0;
        let ok = false;
        try {
            ok = await smeltItem(bot, item, count);
        } catch (e) {
            log(bot, `cookFood: smelting ${item} threw: ${e?.message || e}`);
        }
        const after = world.getInventoryCounts(bot)[item] || 0;
        const consumed = Math.max(0, before - after);
        if (consumed > 0) cooked.push(`${consumed} ${item}`);
        if (!ok && consumed === 0) {
            // Hard failure - no furnace, no fuel, or an occupied furnace. smeltItem already
            // logged the specific reason; stop rather than retrying every remaining raw item
            // against the same missing furnace.
            hardFailure = item;
            break;
        }
    }

    const msg = cooked.length > 0
        ? `VERIFIED COOK: cooked ${cooked.join(', ')}.`
        : `Could not cook anything${hardFailure ? ` (stopped at ${hardFailure})` : ''}.`;
    log(bot, msg);
    return msg;
}

/**
 * Harvest mature crops within range and replant their seeds.
 *
 * Skips any crop inside an active blueprint's protected footprint (`build_guard`) - a farm must
 * not be harvested out from under the builder mid-build. Approaches through `breakBlockAt`/
 * `tillAndSow`, both of which already route through the `navToGoal` seam (S2/S3 in
 * docs/gaps/food-survival.exec.md - both were re-verified safe to reuse as-is).
 */
export async function harvestCrops(bot, range = 16, replant = true) {
    const crops = world.getNearestBlocksWhere(bot, (block) => {
        if (build_guard.isProtecting() && build_guard.isProtected(block.position.x, block.position.y, block.position.z)) {
            return false;
        }
        const props = typeof block.getProperties === 'function' ? block.getProperties() : undefined;
        return farming.isMatureCrop(block.name, props);
    }, range, 64);

    if (crops.length === 0) {
        const msg = `No mature crops within ${range} blocks.`;
        log(bot, msg);
        return msg;
    }

    const beforeInv = world.getInventoryCounts(bot);
    let harvested = 0;
    let replanted = 0;
    let processed = 0;

    for (const block of crops) {
        if (bot.interrupt_code) break;
        const { x, y, z } = block.position;
        const seed = farming.seedItemFor(block.name);
        const broke = await breakBlockAt(bot, x, y, z);
        if (broke) {
            harvested++;
            if (replant && seed) {
                try {
                    if (await tillAndSow(bot, x, y - 1, z, seed)) replanted++;
                } catch (e) { /* replanting is best-effort; the harvest itself already counted */ }
            }
        }
        processed++;
        if (processed % 4 === 0) await pickupNearbyItems(bot);
    }
    await pickupNearbyItems(bot);

    const afterInv = world.getInventoryCounts(bot);
    const gained = {};
    for (const k of new Set([...Object.keys(beforeInv), ...Object.keys(afterInv)])) {
        const d = (afterInv[k] || 0) - (beforeInv[k] || 0);
        if (d > 0) gained[k] = d;
    }
    const gainedStr = Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
    const msg = `VERIFIED HARVEST: broke ${harvested}/${crops.length}, replanted ${replanted}/${harvested}, gained ${gainedStr}.`;
    log(bot, msg);
    return msg;
}
