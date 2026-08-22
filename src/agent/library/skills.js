import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import { digWithTool, equipBestTool, isFallingBlockName, isTreeTrunk, isWaterName } from './tools.js';
import * as swim from './swim.js';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { existsSync, readFileSync } from 'fs';

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

    for (let shot = 0; shot < maxShots; shot++) {
        if (bot.interrupt_code) { lastReason = 'interrupted'; break; }
        // Re-find each round: the entity object goes invalid on death or despawn.
        const target = Object.values(bot.entities).find(e =>
            e?.name === mobType && e.isValid !== false
            && e.position.distanceTo(bot.entity.position) <= 40);
        if (!target) { lastReason = fired > 0 ? 'target_down' : 'target_lost'; break; }

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

    await pickupNearbyItems(bot); // recover arrows and drops
    const after = bowLib.bowInfo(bot).arrows;
    const downed = lastReason === 'target_down';
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
                bot.pathfinder.setMovements(new pf.Movements(bot));
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new pf.Movements(bot));
                let inverted_goal = new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
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
        let movements = createSafeMovements(bot, { canDig: false });
        bot.pathfinder.setMovements(movements);
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
            let movements = createSafeMovements(bot, { canPlaceOn: false, allow1by1towers: false });
            bot.pathfinder.setMovements(movements);
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


async function gotoWithTimeout(bot, goal, label, timeoutMs = 15000) {
    /**
     * Run a pathfinder goto bounded by a timeout. mineflayer-pathfinder's goto() never
     * resolves when no route exists (e.g. the bot would need to step/jump up terrain it
     * won't path over), which would otherwise hang block placement indefinitely.
     * @returns {Promise<boolean>} true if the goal was reached, false on timeout/failure.
     */
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
        const result = await Promise.race([
            bot.pathfinder.goto(goal).then(() => 'ok', (e) => e),
            timeout
        ]);
        if (result === 'timeout') {
            bot.pathfinder.stop();
            console.warn(`[placeBlock] pathfinder goto timed out after ${timeoutMs}ms (${label})`);
            return false;
        }
        if (result !== 'ok') {
            console.warn(`[placeBlock] pathfinder goto failed (${label}): ${result?.message || result}`);
            return false;
        }
        return true;
    } finally {
        clearTimeout(timer);
    }
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
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        if (!await gotoWithTimeout(bot, inverted_goal, 'move away from target')) {
            // Pathfinding failed, but we can still try to place from current position
            log(bot, `Couldn't move away from target, trying to place anyway.`);
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far - try to get closer, but handle pathfinding failures gracefully
        try {
            let pos = targetBlock.position;
            let movements = createSafeMovements(bot);
            bot.pathfinder.setMovements(movements);
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
            const stand_clear = new pf.goals.GoalInvert(
                new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2));
            bot.pathfinder.setMovements(new pf.Movements(bot));
            if (!await gotoWithTimeout(bot, stand_clear, 'step off target cell')) {
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
            await bot.placeBlock(buildOffBlock, faceVec);
            await new Promise(resolve => setTimeout(resolve, 200));
            // Confirm against world state rather than trusting the API call. bot.placeBlock
            // can resolve without the block landing, so reporting success here unverified
            // let bogus placement counts propagate up through fill().
            if (!verifyBlockPlaced(bot, target_dest, blockType)) {
                log(bot, `Tried to place ${blockType} at ${target_dest} but the block is not there.`);
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

// All storage container types in Minecraft (comprehensive list)
const STORAGE_CONTAINERS = [
    // Standard chests
    'chest', 'trapped_chest', 'ender_chest', 'barrel',
    // Shulker boxes (all 17 variants - default + 16 colors)
    'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
    'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box',
    'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box',
    'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
    // Utility containers (can store items)
    'hopper', 'dispenser', 'dropper',
    // 1.20+ containers
    'decorated_pot', 'chiseled_bookshelf',
    // 1.21+ containers
    'crafter'
];

// Create a Set for O(1) lookup
const STORAGE_CONTAINERS_SET = new Set(STORAGE_CONTAINERS);

/**
 * Find the nearest storage container (chest, ender chest, shulker box, barrel, etc.)
 * Optimized to use a single search with filter function
 */
function getNearestStorageContainer(bot, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    // Use findBlock with a filter for better performance
    const containerPositions = bot.findBlocks({
        matching: (block) => STORAGE_CONTAINERS_SET.has(block.name),
        maxDistance: range,
        count: 10 // Get multiple candidates
    });

    if (containerPositions.length === 0) return null;

    // Find the closest one
    let nearestContainer = null;
    let nearestDistance = range + 1;

    for (const pos of containerPositions) {
        const block = bot.blockAt(pos);
        if (block) {
            const distance = bot.entity.position.distanceTo(pos);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestContainer = block;
            }
        }
    }
    return nearestContainer;
}

/**
 * Get a storage container at specific coordinates
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} x - x coordinate
 * @param {number} y - y coordinate
 * @param {number} z - z coordinate
 * @returns {Block|null} - the container block or null if not a valid container
 */
function getStorageContainerAt(bot, x, y, z) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (block && STORAGE_CONTAINERS_SET.has(block.name)) {
        return block;
    }
    return null;
}

/**
 * List all storage containers within range, sorted by distance
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} range - search radius (default 32)
 * @returns {Array} - array of {block, distance, position} objects
 */
export function listNearbyChests(bot, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    const containerPositions = bot.findBlocks({
        matching: (block) => STORAGE_CONTAINERS_SET.has(block.name),
        maxDistance: range,
        count: 50
    });

    const containers = [];
    for (const pos of containerPositions) {
        const block = bot.blockAt(pos);
        if (block) {
            const distance = bot.entity.position.distanceTo(pos);
            containers.push({
                block,
                distance: Math.round(distance * 10) / 10,
                position: { x: pos.x, y: pos.y, z: pos.z },
                type: block.name
            });
        }
    }

    // Sort by distance
    containers.sort((a, b) => a.distance - b.distance);
    return containers;
}

export async function putInChest(bot, itemName, num=-1, x=null, y=null, z=null) {
    /**
     * Put the given item in a storage container (chest, ender chest, shulker box, barrel, etc.).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the container.
     * @param {number} num, the number of items to put. Defaults to -1, which puts all items.
     * @param {number} x, optional x coordinate of the chest. If null, uses nearest chest.
     * @param {number} y, optional y coordinate of the chest.
     * @param {number} z, optional z coordinate of the chest.
     * @returns {Promise<boolean>} true if the item was put in the container, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     * await skills.putInChest(bot, "cobblestone", 64, 100, 65, 200); // Put in chest at specific location
     **/
    let container;
    if (x !== null && y !== null && z !== null) {
        container = getStorageContainerAt(bot, x, y, z);
        if (!container) {
            log(bot, `No storage container found at (${x}, ${y}, ${z}). Check the coordinates.`);
            return false;
        }
    } else {
        container = getNearestStorageContainer(bot, CONSTANTS.DEFAULT_SEARCH_RANGE);
        if (!container) {
            log(bot, `Could not find any storage container within ${CONSTANTS.DEFAULT_SEARCH_RANGE} blocks. Place a chest, barrel, or shulker box nearby.`);
            return false;
        }
    }

    // Get ALL matching items in inventory (may be spread across multiple slots)
    const matchingItems = bot.inventory.items().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        const similarItems = bot.inventory.items().filter(i => i.name.includes(itemName.split('_')[0])).map(i => i.name);
        const inventorySummary = bot.inventory.items()
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map(i => `${i.name}(${i.count})`)
            .join(', ');

        let errorMsg = `You do not have any ${itemName} in inventory.`;
        if (similarItems.length > 0) {
            errorMsg += ` Similar: ${similarItems.join(', ')}.`;
        }
        if (inventorySummary) {
            errorMsg += ` You have: ${inventorySummary}`;
        }
        log(bot, errorMsg);
        return false;
    }

    // Calculate total items across all slots
    const totalInInventory = matchingItems.reduce((sum, item) => sum + item.count, 0);
    const to_put = num === -1 ? totalInInventory : Math.min(num, totalInInventory);

    await goToPosition(bot, container.position.x, container.position.y, container.position.z, CONSTANTS.INTERACT_DISTANCE);
    const openedContainer = await bot.openContainer(container);

    // Check container capacity before deposit
    const totalSlots = openedContainer.slots.length - 36; // Subtract player inventory slots
    const isDoubleChest = totalSlots === 54;
    const chestType = isDoubleChest ? 'double chest' : container.name;

    // Pre-check: does the chest have room for this item?
    // If not, skip the deposit() call entirely — avoids 20s updateSlot timeout on full chests
    const chestContents = openedContainer.containerItems();
    const occupiedSlots = chestContents.length;
    const emptySlots = totalSlots - occupiedSlots;
    const existingStacks = chestContents.filter(i => i.name === itemName);
    const hasPartialStack = existingStacks.some(i => i.count < i.stackSize);
    if (emptySlots === 0 && !hasPartialStack) {
        await openedContainer.close();
        log(bot, `Could not deposit any ${itemName}. The ${chestType} is full.`);
        return false;
    }

    // Count items BEFORE deposit
    const countBefore = matchingItems.reduce((sum, item) => sum + item.count, 0);
    const itemType = matchingItems[0].type;

    try {
        // Deposit all at once - mineflayer waits for slot updates on chest windows
        await openedContainer.deposit(itemType, null, to_put);
    } catch (err) {
        // "destination full" = chest filled mid-deposit, some items may have been deposited already
        console.log(`[putInChest] Deposit threw: ${err.message}`);
    }

    // Count items AFTER deposit - this tells us what ACTUALLY moved regardless of errors
    const countAfter = bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const actualDeposited = countBefore - countAfter;

    // Get current slot usage
    const slotsUsedAfter = openedContainer.containerItems().length;
    await openedContainer.close();

    if (actualDeposited === 0) {
        log(bot, `Could not deposit any ${itemName}. The ${chestType} is full.`);
        return false;
    } else if (actualDeposited < to_put) {
        log(bot, `Deposited ${actualDeposited}/${to_put} ${itemName} in ${chestType} (${slotsUsedAfter}/${totalSlots} slots). ${countAfter} left in inventory.`);
    } else {
        log(bot, `Successfully put ${actualDeposited} ${itemName} in ${chestType}. (${slotsUsedAfter}/${totalSlots} slots used)`);
    }
    return true;
}

export async function takeFromChest(bot, itemName, num=-1, x=null, y=null, z=null) {
    /**
     * Take the given item from a storage container, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the container.
     * @param {number} num, the number of items to take. Defaults to -1, which takes all items.
     * @param {number} x, optional x coordinate of the chest. If null, uses nearest chest.
     * @param {number} y, optional y coordinate of the chest.
     * @param {number} z, optional z coordinate of the chest.
     * @returns {Promise<boolean>} true if the item was taken, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * await skills.takeFromChest(bot, "diamond", 10, 100, 65, 200); // Take from chest at specific location
     **/
    let container;
    if (x !== null && y !== null && z !== null) {
        container = getStorageContainerAt(bot, x, y, z);
        if (!container) {
            log(bot, `No storage container found at (${x}, ${y}, ${z}). Check the coordinates.`);
            return false;
        }
    } else {
        container = getNearestStorageContainer(bot, CONSTANTS.DEFAULT_SEARCH_RANGE);
        if (!container) {
            log(bot, `Could not find any storage container within ${CONSTANTS.DEFAULT_SEARCH_RANGE} blocks.`);
            return false;
        }
    }
    await goToPosition(bot, container.position.x, container.position.y, container.position.z, CONSTANTS.INTERACT_DISTANCE);
    const openedContainer = await bot.openContainer(container);
    
    // Find all matching items in the container
    let matchingItems = openedContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        // List available items as suggestion
        const availableItems = [...new Set(openedContainer.containerItems().map(i => i.name))];
        if (availableItems.length > 0) {
            log(bot, `Could not find ${itemName} in ${container.name}. Available: ${availableItems.slice(0, 5).join(', ')}${availableItems.length > 5 ? '...' : ''}`);
        } else {
            log(bot, `The ${container.name} is empty.`);
        }
        await openedContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await openedContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await openedContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the ${container.name}.`);
    return totalTaken > 0;
}

export async function viewChest(bot, x=null, y=null, z=null) {
    /**
     * View the contents of a storage container (chest, ender chest, shulker box, barrel, etc.).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, optional x coordinate of the chest. If null, uses nearest chest.
     * @param {number} y, optional y coordinate of the chest.
     * @param {number} z, optional z coordinate of the chest.
     * @returns {Promise<boolean>} true if the container was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * await skills.viewChest(bot, 100, 65, 200); // View chest at specific location
     **/
    let container;
    if (x !== null && y !== null && z !== null) {
        container = getStorageContainerAt(bot, x, y, z);
        if (!container) {
            log(bot, `No storage container found at (${x}, ${y}, ${z}). Check the coordinates.`);
            return false;
        }
    } else {
        container = getNearestStorageContainer(bot, CONSTANTS.DEFAULT_SEARCH_RANGE);
        if (!container) {
            log(bot, `Could not find any storage container nearby (chest, ender chest, shulker box, barrel).`);
            return false;
        }
    }
    await goToPosition(bot, container.position.x, container.position.y, container.position.z, CONSTANTS.INTERACT_DISTANCE);
    const openedContainer = await bot.openContainer(container);

    // Determine container type and capacity
    const totalSlots = openedContainer.slots.length - 36; // Subtract player inventory slots
    const isDoubleChest = totalSlots === 54;
    const chestType = isDoubleChest ? 'double chest' : container.name;

    let items = openedContainer.containerItems();
    const usedSlots = items.length;
    const emptySlots = totalSlots - usedSlots;

    if (items.length === 0) {
        log(bot, `The ${chestType} is empty. (0/${totalSlots} slots used)`);
    }
    else {
        log(bot, `The ${chestType} contains (${usedSlots}/${totalSlots} slots used, ${emptySlots} empty):`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await openedContainer.close();
    return true;
}

export async function depositAllItems(bot, excludeItems = [], x=null, y=null, z=null) {
    /**
     * Deposit all items from inventory to a storage container.
     * Will try multiple chests if the first one is full (unless specific location given).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string[]} excludeItems, items to keep in inventory (e.g., tools, weapons, food).
     * @param {number} x, optional x coordinate of the chest. If null, uses nearest chest.
     * @param {number} y, optional y coordinate of the chest.
     * @param {number} z, optional z coordinate of the chest.
     * @returns {Promise<boolean>} true if items were deposited, false otherwise.
     * @example
     * await skills.depositAllItems(bot, ["diamond_pickaxe", "diamond_sword", "cooked_beef"]);
     * await skills.depositAllItems(bot, [], 100, 65, 200); // Deposit to chest at specific location
     **/

    // Default items to always keep
    const defaultKeep = ['netherite_pickaxe', 'netherite_sword', 'netherite_axe', 'netherite_shovel',
                         'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel'];
    const keepItems = new Set([...excludeItems, ...defaultKeep]);

    let totalDeposited = 0;
    let allDepositedTypes = [];
    const usedContainers = new Set();
    const maxChests = 5; // Try up to 5 chests
    const hasSpecificLocation = x !== null && y !== null && z !== null;

    for (let chestAttempt = 0; chestAttempt < maxChests; chestAttempt++) {
        // Check if we still have items to deposit
        const itemsToDeposit = bot.inventory.items().filter(item => {
            if (keepItems.has(item.name)) return false;
            if (item.name.includes('helmet') || item.name.includes('chestplate') ||
                item.name.includes('leggings') || item.name.includes('boots')) return false;
            return true;
        });

        if (itemsToDeposit.length === 0) {
            break; // Nothing left to deposit
        }

        // Find container to use
        let container = null;

        // On first attempt, if specific location provided, use that chest
        if (chestAttempt === 0 && hasSpecificLocation) {
            container = getStorageContainerAt(bot, x, y, z);
            if (!container) {
                log(bot, `No storage container found at (${x}, ${y}, ${z}). Check the coordinates.`);
                return false;
            }
            usedContainers.add(`${x},${y},${z}`);
        } else {
            // Find nearest container we haven't used yet
            const nearbyContainers = world.getNearestBlocks(bot, STORAGE_CONTAINERS, CONSTANTS.DEFAULT_SEARCH_RANGE, 10);
            for (const c of nearbyContainers) {
                const posKey = `${c.position.x},${c.position.y},${c.position.z}`;
                if (!usedContainers.has(posKey)) {
                    container = c;
                    usedContainers.add(posKey);
                    break;
                }
            }
        }

        if (!container) {
            if (chestAttempt === 0) {
                log(bot, `Could not find any storage container nearby.`);
                return false;
            }
            break; // No more unused chests
        }

        await goToPosition(bot, container.position.x, container.position.y, container.position.z, CONSTANTS.INTERACT_DISTANCE);
        const openedContainer = await bot.openContainer(container);

        // Determine container type
        const totalSlots = openedContainer.slots.length - 36;
        const isDoubleChest = totalSlots === 54;
        const chestType = isDoubleChest ? 'double chest' : container.name;

        // If double chest, mark the partner half as used too so we don't revisit it
        if (isDoubleChest) {
            const pos = container.position;
            for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const neighbor = bot.blockAt({x: pos.x+dx, y: pos.y, z: pos.z+dz});
                if (neighbor && neighbor.name === 'chest') {
                    usedContainers.add(`${pos.x+dx},${pos.y},${pos.z+dz}`);
                    break;
                }
            }
        }

        let deposited = 0;
        let chestFull = false;

        for (const item of bot.inventory.items()) {
            // Skip items we want to keep
            if (keepItems.has(item.name)) continue;
            // Skip equipped armor
            if (item.name.includes('helmet') || item.name.includes('chestplate') ||
                item.name.includes('leggings') || item.name.includes('boots')) continue;

            // Pre-check capacity to avoid 20s updateSlot timeout on full chests
            const chestContents = openedContainer.containerItems();
            const emptySlots = totalSlots - chestContents.length;
            const hasPartialStack = chestContents.some(i => i.name === item.name && i.count < i.stackSize);
            if (emptySlots === 0 && !hasPartialStack) {
                log(bot, `${chestType} at (${container.position.x}, ${container.position.y}, ${container.position.z}) is full, trying next chest...`);
                chestFull = true;
                break;
            }

            try {
                await openedContainer.deposit(item.type, null, item.count);
                deposited += item.count;
                allDepositedTypes.push(item.name);
            } catch (e) {
                log(bot, `${chestType} at (${container.position.x}, ${container.position.y}, ${container.position.z}) is full, trying next chest...`);
                chestFull = true;
                break;
            }
        }

        await openedContainer.close();
        totalDeposited += deposited;

        if (!chestFull) {
            break; // Successfully deposited everything
        }
    }

    if (totalDeposited === 0) {
        log(bot, `No items to deposit (or all items are in the keep list).`);
        return false;
    }

    const uniqueTypes = [...new Set(allDepositedTypes)];
    log(bot, `Deposited ${totalDeposited} items (${uniqueTypes.length} types) total.`);
    return true;
}

// ============= CHEST MASTER SYSTEM =============

// In-memory storage for named chests (persisted to memory.json)
const namedChests = new Map();

// Callback to trigger save when named chests change
let saveNamedChestsCallback = null;

/**
 * Set the callback function to trigger when named chests change
 * @param {Function} callback - function to call when chests are modified
 */
export function setNamedChestsSaveCallback(callback) {
    saveNamedChestsCallback = callback;
}

/**
 * Get named chests as JSON for persistence
 * @returns {Object} - named chests data
 */
export function getNamedChestsJson() {
    const result = {};
    for (const [key, value] of namedChests.entries()) {
        result[key] = value;
    }
    return result;
}

/**
 * Load named chests from JSON (called on agent startup)
 * @param {Object} json - named chests data from saved file
 */
export function loadNamedChestsFromJson(json) {
    namedChests.clear();
    if (json && typeof json === 'object') {
        for (const [key, value] of Object.entries(json)) {
            namedChests.set(key, value);
        }
        console.log(`[ChestMaster] Loaded ${namedChests.size} named chests`);
    }
}

/**
 * Load named chests from a memory.json file
 * @param {string} filePath - path to memory.json file
 */
export function loadNamedChestsFromFile(filePath) {
    try {
        if (existsSync(filePath)) {
            const data = JSON.parse(readFileSync(filePath, 'utf8'));
            if (data.named_chests) {
                loadNamedChestsFromJson(data.named_chests);
            }
        }
    } catch (error) {
        console.log(`[ChestMaster] Could not load named chests: ${error.message}`);
    }
}

/**
 * Remember a chest with a custom name for easy access later
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} name - friendly name for the chest (e.g., "ores", "food", "building")
 * @param {number} x - x coordinate
 * @param {number} y - y coordinate
 * @param {number} z - z coordinate
 */
export function nameChest(bot, name, x, y, z) {
    const container = getStorageContainerAt(bot, x, y, z);
    if (!container) {
        log(bot, `No storage container found at (${x}, ${y}, ${z}). Cannot name it.`);
        return false;
    }
    const key = `chest:${name.toLowerCase()}`;
    namedChests.set(key, { x, y, z, type: container.name });
    log(bot, `Named the ${container.name} at (${x}, ${y}, ${z}) as "${name}".`);
    // Trigger save to persist the change
    if (saveNamedChestsCallback) {
        saveNamedChestsCallback();
    }
    return true;
}

/**
 * Get a named chest's location
 * @param {string} name - the name of the chest
 * @returns {Object|null} - {x, y, z, type} or null if not found
 */
export function getNamedChest(name) {
    const key = `chest:${name.toLowerCase()}`;
    return namedChests.get(key) || null;
}

/**
 * List all named chests
 * @returns {Array} - array of {name, x, y, z, type}
 */
export function listNamedChests(bot) {
    const chests = [];
    for (const [key, value] of namedChests.entries()) {
        if (key.startsWith('chest:')) {
            chests.push({
                name: key.substring(6),
                ...value
            });
        }
    }
    if (chests.length === 0) {
        log(bot, `No named chests. Use !nameChest to name a chest first.`);
    } else {
        log(bot, `Named chests (${chests.length}):`);
        for (const c of chests) {
            log(bot, `  "${c.name}" - ${c.type} at (${c.x}, ${c.y}, ${c.z})`);
        }
    }
    return chests;
}

/**
 * Remove a named chest
 * @param {string} name - the name of the chest to forget
 */
export function forgetChest(bot, name) {
    const key = `chest:${name.toLowerCase()}`;
    if (namedChests.has(key)) {
        namedChests.delete(key);
        log(bot, `Forgot chest named "${name}".`);
        // Trigger save to persist the change
        if (saveNamedChestsCallback) {
            saveNamedChestsCallback();
        }
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

/**
 * Get the category of an item
 * @param {string} itemName - name of the item
 * @returns {string} - category name or 'misc' if not categorized
 */
function getItemCategory(itemName) {
    for (const [category, items] of Object.entries(ITEM_CATEGORIES)) {
        if (items.includes(itemName)) {
            return category;
        }
    }
    // Try partial matching for variants
    for (const [category, items] of Object.entries(ITEM_CATEGORIES)) {
        for (const item of items) {
            if (itemName.includes(item.split('_')[0]) || item.includes(itemName.split('_')[0])) {
                return category;
            }
        }
    }
    return 'misc';
}

/**
 * Auto-sort inventory items into named chests by category
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string[]} excludeItems - items to keep in inventory
 */
export async function depositAllSorted(bot, excludeItems = []) {
    const defaultKeep = ['netherite_pickaxe', 'netherite_sword', 'netherite_axe', 'netherite_shovel',
                         'diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel'];
    const keepItems = new Set([...excludeItems, ...defaultKeep]);

    // Get all named chests
    const chestsByCategory = {};
    for (const [key, value] of namedChests.entries()) {
        if (key.startsWith('chest:')) {
            const name = key.substring(6);
            chestsByCategory[name] = value;
        }
    }

    if (Object.keys(chestsByCategory).length === 0) {
        log(bot, `No named chests configured. Use !nameChest first to set up category chests (e.g., !nameChest("ores", x, y, z)).`);
        return false;
    }

    let totalDeposited = 0;
    const depositedByCategory = {};

    // Group items by category
    const itemsByCategory = {};
    for (const item of bot.inventory.items()) {
        if (keepItems.has(item.name)) continue;
        if (item.name.includes('helmet') || item.name.includes('chestplate') ||
            item.name.includes('leggings') || item.name.includes('boots')) continue;

        const category = getItemCategory(item.name);
        if (!itemsByCategory[category]) {
            itemsByCategory[category] = [];
        }
        itemsByCategory[category].push(item);
    }

    // Deposit items to their respective category chests
    for (const [category, items] of Object.entries(itemsByCategory)) {
        const chest = chestsByCategory[category];
        if (!chest) {
            // Try to find a 'misc' or 'other' or 'dump' chest
            const fallbackChest = chestsByCategory['misc'] || chestsByCategory['other'] || chestsByCategory['dump'];
            if (!fallbackChest) continue;

            // Use fallback chest
            await goToPosition(bot, fallbackChest.x, fallbackChest.y, fallbackChest.z, CONSTANTS.INTERACT_DISTANCE);
            const container = getStorageContainerAt(bot, fallbackChest.x, fallbackChest.y, fallbackChest.z);
            if (!container) continue;

            const openedContainer = await bot.openContainer(container);
            for (const item of items) {
                try {
                    await openedContainer.deposit(item.type, null, item.count);
                    totalDeposited += item.count;
                    depositedByCategory['misc'] = (depositedByCategory['misc'] || 0) + item.count;
                } catch (e) {
                    break; // Chest full
                }
            }
            await openedContainer.close();
            continue;
        }

        await goToPosition(bot, chest.x, chest.y, chest.z, CONSTANTS.INTERACT_DISTANCE);
        const container = getStorageContainerAt(bot, chest.x, chest.y, chest.z);
        if (!container) {
            log(bot, `Chest "${category}" at (${chest.x}, ${chest.y}, ${chest.z}) no longer exists.`);
            continue;
        }

        const openedContainer = await bot.openContainer(container);
        for (const item of items) {
            try {
                await openedContainer.deposit(item.type, null, item.count);
                totalDeposited += item.count;
                depositedByCategory[category] = (depositedByCategory[category] || 0) + item.count;
            } catch (e) {
                log(bot, `${category} chest is full.`);
                break;
            }
        }
        await openedContainer.close();
    }

    if (totalDeposited === 0) {
        log(bot, `No items to sort (or all items are kept).`);
        return { success: false, deposits: [] };
    }

    const summary = Object.entries(depositedByCategory)
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(', ');
    log(bot, `Auto-sorted ${totalDeposited} items. ${summary}`);

    // Return detailed info for Mem0 storage
    const deposits = [];
    for (const [category, items] of Object.entries(itemsByCategory)) {
        const chest = chestsByCategory[category] || chestsByCategory['misc'] || chestsByCategory['other'] || chestsByCategory['dump'];
        if (chest) {
            deposits.push({
                chestName: category,
                location: { x: chest.x, y: chest.y, z: chest.z },
                items: items.map(i => ({ name: i.name, count: i.count }))
            });
        }
    }
    return { success: true, deposits, totalDeposited };
}

/**
 * Search for an item across all nearby chests
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} itemName - name of the item to find
 * @param {number} range - search range (default 32)
 */
export async function findItemInChests(bot, itemName, range = CONSTANTS.DEFAULT_SEARCH_RANGE) {
    const containers = listNearbyChests(bot, range);
    if (containers.length === 0) {
        log(bot, `No storage containers found within ${range} blocks.`);
        return [];
    }

    const results = [];
    const startPos = bot.entity.position.clone();

    for (const c of containers) {
        await goToPosition(bot, c.position.x, c.position.y, c.position.z, CONSTANTS.INTERACT_DISTANCE);

        try {
            const openedContainer = await bot.openContainer(c.block);
            const matchingItems = openedContainer.containerItems().filter(item =>
                item.name === itemName || item.name.includes(itemName)
            );

            if (matchingItems.length > 0) {
                const totalCount = matchingItems.reduce((sum, item) => sum + item.count, 0);
                results.push({
                    position: c.position,
                    type: c.type,
                    count: totalCount,
                    distance: c.distance
                });
            }
            await openedContainer.close();
        } catch (e) {
            // Skip this container if we can't open it
            continue;
        }
    }

    // Return to start position
    await goToPosition(bot, startPos.x, startPos.y, startPos.z, 1);

    if (results.length === 0) {
        log(bot, `Could not find "${itemName}" in any of the ${containers.length} containers searched.`);
    } else {
        const totalFound = results.reduce((sum, r) => sum + r.count, 0);
        log(bot, `Found ${totalFound} "${itemName}" in ${results.length} container(s):`);
        for (const r of results) {
            log(bot, `  ${r.count}x in ${r.type} at (${r.position.x}, ${r.position.y}, ${r.position.z})`);
        }
    }

    return results;
}

/**
 * Transfer items from one chest to another
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} itemName - name of the item to transfer (or "all" for everything)
 * @param {number} num - number of items to transfer (-1 for all)
 * @param {number} fromX - source chest x
 * @param {number} fromY - source chest y
 * @param {number} fromZ - source chest z
 * @param {number} toX - destination chest x
 * @param {number} toY - destination chest y
 * @param {number} toZ - destination chest z
 */
export async function transferBetweenChests(bot, itemName, num, fromX, fromY, fromZ, toX, toY, toZ) {
    // Verify both containers exist
    const fromContainer = getStorageContainerAt(bot, fromX, fromY, fromZ);
    const toContainer = getStorageContainerAt(bot, toX, toY, toZ);

    if (!fromContainer) {
        log(bot, `No storage container found at source (${fromX}, ${fromY}, ${fromZ}).`);
        return false;
    }
    if (!toContainer) {
        log(bot, `No storage container found at destination (${toX}, ${toY}, ${toZ}).`);
        return false;
    }

    // Go to source chest and take items
    await goToPosition(bot, fromX, fromY, fromZ, CONSTANTS.INTERACT_DISTANCE);
    const openedFrom = await bot.openContainer(fromContainer);

    let itemsToTransfer = [];
    if (itemName.toLowerCase() === 'all') {
        itemsToTransfer = openedFrom.containerItems();
    } else {
        itemsToTransfer = openedFrom.containerItems().filter(item =>
            item.name === itemName || item.name.includes(itemName)
        );
    }

    if (itemsToTransfer.length === 0) {
        log(bot, `No ${itemName === 'all' ? 'items' : itemName} found in source chest.`);
        await openedFrom.close();
        return false;
    }

    // Calculate how many to take
    let remaining = num === -1 ? Infinity : num;
    let totalTaken = 0;
    const takenItems = [];

    for (const item of itemsToTransfer) {
        if (remaining <= 0) break;
        const toTake = Math.min(remaining, item.count);
        try {
            await openedFrom.withdraw(item.type, null, toTake);
            totalTaken += toTake;
            remaining -= toTake;
            takenItems.push({ name: item.name, count: toTake, type: item.type });
        } catch (e) {
            break; // Inventory full
        }
    }
    await openedFrom.close();

    if (totalTaken === 0) {
        log(bot, `Could not take any items from source chest.`);
        return false;
    }

    // Go to destination chest and deposit items
    await goToPosition(bot, toX, toY, toZ, CONSTANTS.INTERACT_DISTANCE);
    const openedTo = await bot.openContainer(toContainer);

    let totalDeposited = 0;
    for (const item of takenItems) {
        const invItem = bot.inventory.findInventoryItem(item.name);
        if (invItem) {
            try {
                await openedTo.deposit(invItem.type, null, item.count);
                totalDeposited += item.count;
            } catch (e) {
                log(bot, `Destination chest is full. ${item.count} ${item.name} left in inventory.`);
                break;
            }
        }
    }
    await openedTo.close();

    log(bot, `Transferred ${totalDeposited} items from (${fromX}, ${fromY}, ${fromZ}) to (${toX}, ${toY}, ${toZ}).`);
    return true;
}

/**
 * Put items into a named chest
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} chestName - the name of the chest
 * @param {string} itemName - the item to put
 * @param {number} num - number of items (-1 for all)
 */
export async function putInNamedChest(bot, chestName, itemName, num = -1) {
    const chest = getNamedChest(chestName);
    if (!chest) {
        log(bot, `No chest named "${chestName}". Use !listNamedChests to see available chests.`);
        return false;
    }
    return await putInChest(bot, itemName, num, chest.x, chest.y, chest.z);
}

/**
 * Take items from a named chest
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} chestName - the name of the chest
 * @param {string} itemName - the item to take
 * @param {number} num - number of items (-1 for all)
 */
export async function takeFromNamedChest(bot, chestName, itemName, num = -1) {
    const chest = getNamedChest(chestName);
    if (!chest) {
        log(bot, `No chest named "${chestName}". Use !listNamedChests to see available chests.`);
        return false;
    }
    return await takeFromChest(bot, itemName, num, chest.x, chest.y, chest.z);
}

/**
 * View contents of a named chest
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {string} chestName - the name of the chest
 */
export async function viewNamedChest(bot, chestName) {
    const chest = getNamedChest(chestName);
    if (!chest) {
        log(bot, `No chest named "${chestName}". Use !listNamedChests to see available chests.`);
        return false;
    }
    return await viewChest(bot, chest.x, chest.y, chest.z);
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

export async function goToGoal(bot, goal, timeoutMs = 0) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {number} timeoutMs, optional cap on the walk itself (0 = unbounded).
     *   Callers on a per-block budget (e.g. placeBlock) should pass one, since goto()
     *   never resolves when no route exists.
     **/

    const nonDestructiveMovements = new pf.Movements(bot);
    const dontBreakBlocks = [
        'glass', 'glass_pane', 'door', 'oak_door', 'spruce_door', 'birch_door', 'jungle_door',
        'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'bamboo_door',
        'crimson_door', 'warped_door', 'iron_door',
        // Fence gates - can be opened/closed
        'fence_gate', 'oak_fence_gate', 'spruce_fence_gate', 'birch_fence_gate',
        'jungle_fence_gate', 'acacia_fence_gate', 'dark_oak_fence_gate',
        'mangrove_fence_gate', 'cherry_fence_gate', 'bamboo_fence_gate',
        'crimson_fence_gate', 'warped_fence_gate',
        // Fence blocks - don't break
        'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence',
        'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
        'bamboo_fence', 'crimson_fence', 'warped_fence', 'nether_brick_fence'
    ];
    for (let block of dontBreakBlocks) {
        const blockId = mc.getBlockId(block);
        if (blockId) nonDestructiveMovements.blocksCantBreak.add(blockId);
    }
    nonDestructiveMovements.placeCost = 50;
    nonDestructiveMovements.digCost = 100;

    const destructiveMovements = new pf.Movements(bot);
    destructiveMovements.placeCost = 50;

    let final_movements = destructiveMovements;

    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }

    const doorCheckInterval = startDoorInterval(bot);


    bot.pathfinder.setMovements(final_movements);
    try {
        if (timeoutMs > 0) {
            return await gotoWithTimeout(bot, goal, 'goToGoal', timeoutMs);
        }
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    } finally {
        clearInterval(doorCheckInterval);
    }
}

let _doorInterval = null;

/**
 * Create surface-only movements for long distance travel to avoid caves
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @returns {pf.Movements} configured movements that prefer surface travel
 */
function createSurfaceMovements(bot) {
    const movements = new pf.Movements(bot);

    // Disable digging to stay on surface
    movements.canDig = false;

    // Limit vertical drops to avoid falling into caves
    movements.maxDropDown = 3;

    // Don't build towers (stay on natural terrain)
    movements.allow1by1towers = false;

    // High cost for going down to discourage cave entry
    movements.digCost = 1000;

    // High place cost to discourage building bridges over water
    movements.placeCost = 100;

    // Avoid water/lava
    movements.canOpenDoors = true;

    return movements;
}

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
        const surfaceMovements = createSurfaceMovements(bot);

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
                bot.pathfinder.setMovements(surfaceMovements);
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

    log(bot, `You have reached ${username}.`);
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
    
    let playerObj = bot.players[username];
    if (!playerObj || !playerObj.entity) {
        console.log(`Player ${username} not found or has no entity`);
        return false;
    }
    let player = playerObj.entity;

    const move = createSafeMovements(bot);
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

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
    bot.pathfinder.setMovements(new pf.Movements(bot));

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
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
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
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
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

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
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
        bot.pathfinder.setMovements(new pf.Movements(bot));
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
        bot.pathfinder.setMovements(new pf.Movements(bot));
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
        bot.pathfinder.setMovements(new pf.Movements(bot));
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

    for (let i = 0; i < maxSteps; i++) {
        if (bot.interrupt_code) break;
        const p = bot.entity.position.floored();
        if (targetY !== null) {
            if (p.y >= targetY - 1) break;
        } else {
            const surf = nav.surfaceY(bot, p.x, p.z, 140, p.y + 1);
            if (surf === null || p.y >= surf - 1) break;
        }

        const [dx, dz] = dirs[dir % dirs.length];
        const ahead = new Vec3(p.x + dx, p.y, p.z + dz);

        // The block we will step onto has to exist. After mining its way along, the bot is often
        // standing in an open chamber of its own making with no wall in any direction - stairs
        // are impossible there, so pillar straight up instead of spinning on the spot.
        const stepBlock = bot.blockAt(ahead);
        if (!stepBlock || stepBlock.boundingBox !== 'block') {
            if (++dir % dirs.length === 0) {
                const lifted = await pillarUp(bot, 4);
                if (lifted < 0.5) break;   // out of blocks or boxed in; nothing more to try
            }
            continue;
        }

        let mined = 0;
        for (const target of [ahead.offset(0, 1, 0), ahead.offset(0, 2, 0), new Vec3(p.x, p.y + 2, p.z)]) {
            if (await digWithTool(bot, bot.blockAt(target))) mined++;
        }
        if (mined === 0 && stepBlock.boundingBox === 'block') { dir++; continue; }

        const gained = await hopForward(bot, dx, dz, 1600);
        if (gained < 0.5) dir++;   // no height gained: stairing into a wall, so turn
    }

    const climbed = bot.entity.position.y - startY;
    log(bot, `Climbed ${climbed.toFixed(0)} blocks toward the surface (now y=${bot.entity.position.y.toFixed(0)}).`);
    return climbed;
}

export async function travelDirection(bot, dx, dz, distance, step = 48) {
    const startPos = bot.entity.position.clone();
    const targetX = Math.floor(startPos.x + dx * distance);
    const targetZ = Math.floor(startPos.z + dz * distance);
    log(bot, `Travelling ${distance} blocks to (${targetX}, ${targetZ}). This may take a while.`);

    let legs = 0, dug = 0, stalls = 0;
    const deadline = Date.now() + 30 * 60 * 1000; // hard cap so this can never run forever

    // Surface travel only. If a previous leg ended in a cave, climb out before going further -
    // otherwise every route the planner can see from down there is also underground.
    const navMod = await import('./nav.js');
    let preferY = navMod.surfaceY(bot, startPos.x, startPos.z, 140, Math.floor(startPos.y) + 1);
    if (preferY !== null && preferY - startPos.y > 20) {
        log(bot, `Underground (${Math.round(preferY - startPos.y)} blocks below the surface); climbing out first.`);
        await climbToSurface(bot);
    }
    preferY = Math.floor(bot.entity.position.y);

    while (Date.now() < deadline) {
        if (bot.interrupt_code) return `Travel interrupted. ${travelReport(bot, startPos, dx, dz, distance, dug)}`;

        const pos = bot.entity.position;
        const covered = Math.abs(dx) * Math.abs(pos.x - startPos.x) + Math.abs(dz) * Math.abs(pos.z - startPos.z);
        if (covered >= distance - 2) break;

        const before = pos.clone();
        const wx = Math.floor(pos.x + dx * step);
        const wz = Math.floor(pos.z + dz * step);

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
                // Long-distance travel is the only caller that gets the measured water costs.
                // !navTo, moveAway and every mode-driven move stay on the land-only model that
                // has a 1018-block journey behind it: a cheaper river changes which nodes win
                // the whole A* frontier, not just the wet ones.
                swimEnabled: true,
            });
        } catch (err) {
            // fall through to the obstruction check
        }

        // Progress must be measured ALONG THE TRAVEL AXIS, not as total distance moved. When
        // the planner can only find a partial route it often heads the wrong way around an
        // obstacle; counting that as progress meant the "we are stuck, dig through" fallback
        // never fired and the bot wandered sideways for a quarter of an hour.
        const after = bot.entity.position;
        let moved = (after.x - before.x) * dx + (after.z - before.z) * dz;
        legs++;
        if (moved < 1.0) {
            // The pathfinder refuses to PLAN a route over a 1-block step on this server, so it
            // just stands still. Walking manually gets the bot moving, and AutoJump (see
            // auto_jump.js) then carries it over the step - measured: 9.4 blocks covered and a
            // step cleared where pathfinding moved 0.
            const beforeWalk = bot.entity.position.clone();
            await walkForward(bot, dx, dz, 4000);
            const afterWalk = bot.entity.position;
            const walkedOver = (afterWalk.x - beforeWalk.x) * dx + (afterWalk.z - beforeWalk.z) * dz;
            if (walkedOver > 1.0) { stalls = 0; continue; }
        }
        if (moved < 1.0) {
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
            if (inWater(bot)) {
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
    return travelReport(bot, startPos, dx, dz, distance, dug);
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
async function clearWayAhead(bot, dx, dz, allowTrees = false) {
    const p = bot.entity.position.floored();
    let removed = 0;
    let blockedByBuild = false;
    // Cut an OPEN TRENCH, not a tunnel. Deserts are sand and gravel - gravity blocks - so
    // boring a 2-high hole through a dune drops everything above straight onto the bot and
    // buries it (observed: 32 minutes entombed at y=55 with sand on every side). Clearing
    // well above head height lets the column collapse once and then stay clear.
    const heights = [0, 1, 2, 3, 4];
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
function pickBuildMaterial(bot) {
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
async function pillarUp(bot, blocks = 1) {
    const { Vec3 } = await import('vec3');
    const stackable = STACKABLE;
    const startY = bot.entity.position.y;

    for (let i = 0; i < blocks; i++) {
        if (bot.interrupt_code) break;
        const mat = stackable.map(n => bot.inventory.items().find(it => it.name === n)).find(Boolean);
        if (!mat) break;
        try { await bot.equip(mat, 'hand'); } catch (err) { break; }

        const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') break;

        // Wait for actual clearance instead of guessing a delay. A fixed sleep placed the block
        // while the bot was still inside the target cell, which silently fails - measured as
        // "climbed 0 blocks" against a wall it should have cleared. Jump height also varies
        // here because the physics is running on stale collision data.
        const baseY = bot.entity.position.y;
        bot.setControlState('forward', false);   // drifting off the pillar loses the gain
        try {
            await bot.look(bot.entity.yaw, Math.PI / 2, true);   // face straight down
            bot.setControlState('jump', true);
            const deadline = Date.now() + 900;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 40));
                if (bot.entity.position.y - baseY < 0.5) continue;
                try { await bot.placeBlock(below, new Vec3(0, 1, 0)); } catch (err) { /* retry next block */ }
                break;
            }
        } catch (err) {
            // look/jump failed; the next iteration retries
        } finally {
            bot.setControlState('jump', false);
        }
        await new Promise(r => setTimeout(r, 400));
        if (bot.entity.position.y - baseY < 0.5) break;   // not rising: out of room or blocked
    }
    return bot.entity.position.y - startY;
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
