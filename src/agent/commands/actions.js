import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!clearMemory',
        description: 'Clear all memory including chat history and saved memory. Use when the bot is confused or has wrong information stuck in memory.',
        perform: async function (agent) {
            // Clear both turns and memory
            agent.history.turns = [];
            agent.history.memory = '';
            
            // Reset self-prompter state
            if (agent.self_prompter.isActive()) {
                agent.self_prompter.stopLoop();
            }
            
            // Save the cleared state to disk immediately
            await agent.history.save();
            
            return agent.name + "'s memory has been completely cleared and saved. Starting fresh with no prior context.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location. For long distances (100+ blocks), automatically uses surface navigation with waypoints to avoid caves.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);

            // Also store in Mem0 with coordinates
            if (agent.prompter?.chat_model?.recordImportantLocation) {
                agent.prompter.chat_model.recordImportantLocation(name, pos, `Saved by player request`);
            }

            return `Location "${name}" saved at x:${Math.round(pos.x)} y:${Math.round(pos.y)} z:${Math.round(pos.z)}.`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!chestPut',
        description: 'Put the given item in a storage container. Uses nearest chest if no coordinates specified.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the container.' },
            'num': { type: 'int', description: 'The number of items to put in the container.', domain: [1, Number.MAX_SAFE_INTEGER] },
            'x': { type: 'int', description: 'X coordinate of the chest. Optional - omit to use nearest chest.', optional: true },
            'y': { type: 'int', description: 'Y coordinate of the chest. Optional.', optional: true },
            'z': { type: 'int', description: 'Z coordinate of the chest. Optional.', optional: true }
        },
        perform: runAsAction(async (agent, item_name, num, x, y, z) => {
            await skills.putInChest(agent.bot, item_name, num, x, y, z);
        })
    },
    {
        name: '!chestTake',
        description: 'Take items from a storage container. Uses nearest chest if no coordinates specified.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] },
            'x': { type: 'int', description: 'X coordinate of the chest. Optional - omit to use nearest chest.', optional: true },
            'y': { type: 'int', description: 'Y coordinate of the chest. Optional.', optional: true },
            'z': { type: 'int', description: 'Z coordinate of the chest. Optional.', optional: true }
        },
        perform: runAsAction(async (agent, item_name, num, x, y, z) => {
            await skills.takeFromChest(agent.bot, item_name, num, x, y, z);
        })
    },
    {
        name: '!chestView',
        description: 'View the items/counts of a storage container. Uses nearest chest if no coordinates specified.',
        params: {
            'x': { type: 'int', description: 'X coordinate of the chest. Optional - omit to use nearest chest.', optional: true },
            'y': { type: 'int', description: 'Y coordinate of the chest. Optional.', optional: true },
            'z': { type: 'int', description: 'Z coordinate of the chest. Optional.', optional: true }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            await skills.viewChest(agent.bot, x, y, z);
        })
    },
    {
        name: '!chestDepositAll',
        description: 'Deposit ALL items from inventory into a storage container. Keeps essential tools by default. Uses nearest chest if no coordinates specified.',
        params: {
            'except': { type: 'string', description: 'Comma-separated list of items to keep (e.g., "torch,food,coal"). Optional.', optional: true },
            'x': { type: 'int', description: 'X coordinate of the chest. Optional - omit to use nearest chest.', optional: true },
            'y': { type: 'int', description: 'Y coordinate of the chest. Optional.', optional: true },
            'z': { type: 'int', description: 'Z coordinate of the chest. Optional.', optional: true }
        },
        perform: runAsAction(async (agent, except, x, y, z) => {
            const excludeItems = except ? except.split(',').map(s => s.trim()) : [];
            await skills.depositAllItems(agent.bot, excludeItems, x, y, z);
        })
    },
    {
        name: '!chestList',
        description: 'List all storage containers (chests, barrels, shulker boxes) within range, sorted by distance.',
        params: {
            'range': { type: 'int', description: 'Search radius in blocks. Default 32.', optional: true, domain: [1, 128] }
        },
        perform: runAsAction(async (agent, range) => {
            const searchRange = range || 32;
            const containers = skills.listNearbyChests(agent.bot, searchRange);
            if (containers.length === 0) {
                skills.log(agent.bot, `No storage containers found within ${searchRange} blocks.`);
                return;
            }
            skills.log(agent.bot, `Found ${containers.length} storage containers within ${searchRange} blocks:`);
            for (const c of containers.slice(0, 10)) {
                skills.log(agent.bot, `  ${c.type} at (${c.position.x}, ${c.position.y}, ${c.position.z}) - ${c.distance} blocks away`);
            }
            if (containers.length > 10) {
                skills.log(agent.bot, `  ... and ${containers.length - 10} more`);
            }
        })
    },
    // ============= CHEST MASTER COMMANDS =============
    {
        name: '!chestName',
        description: 'Give a friendly name to a chest at specific coordinates for easy access later (e.g., "ores", "food", "building").',
        params: {
            'name': { type: 'string', description: 'Friendly name for the chest (e.g., "ores", "food", "building", "dump").' },
            'x': { type: 'int', description: 'X coordinate of the chest.' },
            'y': { type: 'int', description: 'Y coordinate of the chest.' },
            'z': { type: 'int', description: 'Z coordinate of the chest.' }
        },
        perform: runAsAction(async (agent, name, x, y, z) => {
            const success = skills.nameChest(agent.bot, name, x, y, z);
            // Store in Mem0 for semantic memory recall
            if (success && agent.prompter?.chat_model?.recordImportantLocation) {
                agent.prompter.chat_model.recordImportantLocation(
                    `chest_${name}`,
                    { x, y, z },
                    `Named chest "${name}" for storing ${name} items`
                );
            }
        })
    },
    {
        name: '!chestListNamed',
        description: 'List all named chests that have been saved.',
        params: {},
        perform: runAsAction(async (agent) => {
            skills.listNamedChests(agent.bot);
        })
    },
    {
        name: '!chestForget',
        description: 'Remove a named chest from memory.',
        params: {
            'name': { type: 'string', description: 'Name of the chest to forget.' }
        },
        perform: runAsAction(async (agent, name) => {
            skills.forgetChest(agent.bot, name);
        })
    },
    {
        name: '!chestPutNamed',
        description: 'Put items into a named chest.',
        params: {
            'chest_name': { type: 'string', description: 'Name of the chest to put items in.' },
            'item_name': { type: 'ItemName', description: 'The item to put in the chest.' },
            'num': { type: 'int', description: 'Number of items to put. Use -1 for all.', domain: [-1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, chest_name, item_name, num) => {
            await skills.putInNamedChest(agent.bot, chest_name, item_name, num);

            // Store in Mem0 for semantic recall
            const chest = skills.getNamedChest(chest_name);
            if (chest && agent.prompter?.chat_model?.recordChestDeposit) {
                await agent.prompter.chat_model.recordChestDeposit(
                    chest_name,
                    { x: chest.x, y: chest.y, z: chest.z },
                    [{ name: item_name, count: num }]
                );
            }
        })
    },
    {
        name: '!chestTakeNamed',
        description: 'Take items from a named chest.',
        params: {
            'chest_name': { type: 'string', description: 'Name of the chest to take items from.' },
            'item_name': { type: 'ItemName', description: 'The item to take.' },
            'num': { type: 'int', description: 'Number of items to take. Use -1 for all.', domain: [-1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, chest_name, item_name, num) => {
            await skills.takeFromNamedChest(agent.bot, chest_name, item_name, num);
        })
    },
    {
        name: '!chestViewNamed',
        description: 'View the contents of a named chest.',
        params: {
            'chest_name': { type: 'string', description: 'Name of the chest to view.' }
        },
        perform: runAsAction(async (agent, chest_name) => {
            await skills.viewNamedChest(agent.bot, chest_name);
        })
    },
    {
        name: '!chestDepositSorted',
        description: 'Auto-sort inventory items into named chests by category (ores, building, food, tools, weapons, armor). Set up category chests first with !chestName.',
        params: {
            'except': { type: 'string', description: 'Comma-separated list of items to keep. Optional.', optional: true }
        },
        perform: runAsAction(async (agent, except) => {
            const excludeItems = except ? except.split(',').map(s => s.trim()) : [];
            const result = await skills.depositAllSorted(agent.bot, excludeItems);

            // Store deposits in Mem0 for semantic recall
            if (result.success && result.deposits && agent.prompter?.chat_model?.recordChestDeposit) {
                for (const deposit of result.deposits) {
                    await agent.prompter.chat_model.recordChestDeposit(
                        deposit.chestName,
                        deposit.location,
                        deposit.items
                    );
                }
            }
        })
    },
    {
        name: '!chestFind',
        description: 'Search for an item across all nearby chests and report which containers have it.',
        params: {
            'item_name': { type: 'ItemName', description: 'The item to search for.' },
            'range': { type: 'int', description: 'Search radius in blocks. Default 32.', optional: true, domain: [1, 128] }
        },
        perform: runAsAction(async (agent, item_name, range) => {
            await skills.findItemInChests(agent.bot, item_name, range || 32);
        })
    },
    {
        name: '!chestTransfer',
        description: 'Transfer items from one chest to another.',
        params: {
            'item_name': { type: 'string', description: 'Item to transfer, or "all" for everything.' },
            'num': { type: 'int', description: 'Number of items to transfer. Use -1 for all.', domain: [-1, Number.MAX_SAFE_INTEGER] },
            'from_x': { type: 'int', description: 'Source chest X coordinate.' },
            'from_y': { type: 'int', description: 'Source chest Y coordinate.' },
            'from_z': { type: 'int', description: 'Source chest Z coordinate.' },
            'to_x': { type: 'int', description: 'Destination chest X coordinate.' },
            'to_y': { type: 'int', description: 'Destination chest Y coordinate.' },
            'to_z': { type: 'int', description: 'Destination chest Z coordinate.' }
        },
        perform: runAsAction(async (agent, item_name, num, from_x, from_y, from_z, to_x, to_y, to_z) => {
            await skills.transferBetweenChests(agent.bot, item_name, num, from_x, from_y, from_z, to_x, to_y, to_z);
        })
    },
    // ============= END CHEST MASTER COMMANDS =============
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!fill',
        description: 'Fill a rectangular area with blocks. Can build floors (height=1) or walls (height=5+). Like Minecraft /fill command.',
        params: {
            'blockType': { type: 'BlockOrItemName', description: 'The block type to place (e.g., "dirt", "cobblestone").' },
            'x1': { type: 'int', description: 'X coordinate of the first corner.' },
            'z1': { type: 'int', description: 'Z coordinate of the first corner.' },
            'x2': { type: 'int', description: 'X coordinate of the second corner.' },
            'z2': { type: 'int', description: 'Z coordinate of the second corner.' },
            'y': { type: 'int', description: 'Y coordinate (starting height) to place blocks at.' },
            'height': { type: 'int', description: 'How many levels high to build (default 1). Use 5 for standard walls.', optional: true }
        },
        perform: runAsAction(async (agent, blockType, x1, z1, x2, z2, y, height = 1) => {
            const placed = await skills.fill(agent.bot, blockType, x1, z1, x2, z2, y, height);
            return `Filled area with ${placed} ${blockType} blocks.`;
        }, true, 600)  // resume=true allows resuming after interruption
    },
    {
        name: '!plantTrees',
        description: 'Plant saplings in a grid pattern with specified spacing. Automatically detects ground height. Great for creating tree farms or forests.',
        params: {
            'saplingType': { type: 'BlockOrItemName', description: 'Type of sapling (e.g., "oak", "birch", "spruce"). Will auto-add "_sapling" if needed.' },
            'x1': { type: 'int', description: 'X coordinate of the first corner.' },
            'z1': { type: 'int', description: 'Z coordinate of the first corner.' },
            'x2': { type: 'int', description: 'X coordinate of the second corner.' },
            'z2': { type: 'int', description: 'Z coordinate of the second corner.' },
            'spacing': { type: 'int', description: 'Gap between saplings (default 4 blocks for trees to grow properly).', optional: true }
        },
        perform: runAsAction(async (agent, saplingType, x1, z1, x2, z2, spacing = 4) => {
            const planted = await skills.plantTreeGrid(agent.bot, saplingType, x1, z1, x2, z2, spacing);
            return `Planted ${planted} ${saplingType} saplings with ${spacing} block spacing.`;
        }, true, 600)  // resume=true allows resuming after interruption
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            // Resolve player name with fuzzy matching
            const resolvedName = skills.resolvePlayerName(agent.bot, player_name);
            if (!resolvedName) {
                skills.log(agent.bot, `Could not find player "${player_name}". Nearby players: ${Object.keys(agent.bot.players).filter(n => n !== agent.bot.username).join(', ') || 'none'}`);
                return false;
            }
            let player = agent.bot.players[resolvedName]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${resolvedName}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!tillAndSow',
        description: 'Till the ground at the given position and optionally plant a seed.',
        params: {
            'x': { type: 'float', description: 'The x coordinate to till.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'The y coordinate to till.', domain: [-64, 320] },
            'z': { type: 'float', description: 'The z coordinate to till.', domain: [-Infinity, Infinity] },
            'seed_type': { type: 'string', description: 'The seed type to plant (e.g., "wheat_seeds", "carrot", "potato"). Use "none" to only till.' }
        },
        perform: runAsAction(async (agent, x, y, z, seed_type) => {
            const seedArg = seed_type === 'none' ? null : seed_type;
            await skills.tillAndSow(agent.bot, x, y, z, seedArg);
        })
    },
    {
        name: '!fillBucket',
        description: 'Fill an empty bucket with water or lava from the nearest source block.',
        params: {
            'liquid_type': { type: 'string', description: 'The liquid to collect: "water" or "lava".' }
        },
        perform: runAsAction(async (agent, liquid_type) => {
            await skills.fillBucket(agent.bot, liquid_type);
        })
    },
];
