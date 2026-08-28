import * as world from '../library/world.js';
import * as skills from '../library/skills.js';
import * as swim from '../library/swim.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';
import Vec3 from 'vec3';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            // Only while wet, so the normal prompt costs nothing. Air matters urgently or not
            // at all, and the model cannot see oxygen any other way.
            if (swim.inWater(bot)) {
                res += `\n- In water: ${swim.isSubmerged(bot) ? 'SUBMERGED' : 'at surface'}, Air: ${swim.oxygen(bot)} / 20`;
                // Buoyancy state, because "the bot will not rise" is otherwise undiagnosable
                // from outside: it looks identical whether the assist is off, stuck in sink,
                // or holding jump against a ceiling.
                const sa = bot.swimAssist;
                if (sa) res += ` [assist: ${sa.stats.mode}, jump=${sa.stats.holdingJump}, boost=${sa.stats.boosted}]`;
                // The PHYSICS flag, not our block-name fallback. If these disagree, every water
                // control is a no-op: prismarine-physics applies neither water movement nor
                // ground acceleration, and the bot sits at vel=0 with the keys held.
                res += ` [physics.isInWater=${bot.entity.isInWater} vel.y=${bot.entity.velocity.y.toFixed(3)}]`;
            }
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;

            // Only shown while failed over, so the normal prompt costs nothing. Without it the
            // only symptom of the local server being down is that Andy suddenly writes differently.
            if (agent.prompter?.chat_model?.on_backup) {
                const st = agent.prompter.chat_model.status;
                res += `\n- Brain: BACKUP (${agent.prompter.chat_model.model_name}) - local model unreachable`;
                // Duration and retry cadence, so a multi-hour outage reads as an outage rather
                // than as "the bot is being weird today".
                if (st) res += ` for ${st.downMinutes.toFixed(0)} min, ${st.failures} failed attempt(s), next retry in ${st.retryInSec}s`;
            }


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "List the block types within reach of the bot, each with a distance and compass direction. Use to find out what is available nearby; !surroundings instead when you need to know what is directly in front of you.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            
            // Add important blocks with direction
            let important = world.getImportantBlocksWithDirection(bot, 32);
            if (important.length > 0) {
                res += '\nIMPORTANT_NEARBY:';
                for (let item of important) {
                    res += `\n- ${item}`;
                }
            }
            
            return pad(res);
        }
    },
    {
        name: "!surroundings",
        description: "Report what is immediately front/back/left/right/up/down of the bot, relative to its facing. Use before stepping, digging or placing; !nearbyBlocks for what exists in the area at all.",
        perform: function (agent) {
            let bot = agent.bot;
            let dirBlocks = world.getDirectionalBlocks(bot, 4);
            
            let res = `SURROUNDINGS (facing ${dirBlocks.facing.toUpperCase()}):`;
            res += `\nFront(4): ${dirBlocks.front.join(' → ')}`;
            res += `\nBack(4): ${dirBlocks.back.join(' → ')}`;
            res += `\nLeft(4): ${dirBlocks.left.join(' → ')}`;
            res += `\nRight(4): ${dirBlocks.right.join(' → ')}`;
            res += `\nUp(4): ${dirBlocks.up.join(' → ')}`;
            res += `\nDown(4): ${dirBlocks.down.join(' → ')}`;
            
            // Add important blocks
            let important = world.getImportantBlocksWithDirection(bot, 24);
            if (important.length > 0) {
                res += '\nIMPORTANT_BLOCKS:';
                for (let item of important) {
                    res += `\n- ${item}`;
                }
            }
            
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            if (!agent.task?.blueprint) {
                return pad("No blueprint is currently set. Use a construction task to set a blueprint first.");
            }
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            if (!agent.task?.blueprint) {
                return pad("No blueprint is currently set. Use a construction task to set a blueprint first.");
            }
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!buildStatus',
        description: 'Diff the world against a blueprint JSON: how much is built, and the nearest wrong blocks as Place/Replace fixes.',
        params: {
            'file': { type: 'string', description: 'Placements JSON path relative to the mindcraft root (e.g. "blueprints/survival_base.json").' },
            'x': { type: 'int', description: 'World X of the blueprint origin.' },
            'y': { type: 'int', description: 'World Y of the blueprint origin.' },
            'z': { type: 'int', description: 'World Z of the blueprint origin.' },
            'limit': { type: 'int', description: 'Max fixes to list (default 10).', optional: true }
        },
        perform: async function (agent, file, x, y, z, limit = 10) {
            const { blueprintStatus } = await import('../library/blueprint_builder.js');
            try {
                return pad(blueprintStatus(agent, file,
                    new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), Math.floor(limit)));
            } catch (e) {
                return `buildStatus failed: ${e.message}`;
            }
        }
    },
    {
        name: '!scanArea',
        description: 'List which block types fill a rectangle, with counts and percentages, at one Y level. Use to check the ground before building or planting. Use !gridView instead when you need each block\'s exact position.',
        params: {
            'x1': { type: 'int', description: 'X coordinate of the first corner.' },
            'z1': { type: 'int', description: 'Z coordinate of the first corner.' },
            'x2': { type: 'int', description: 'X coordinate of the second corner.' },
            'z2': { type: 'int', description: 'Z coordinate of the second corner.' },
            'y': { type: 'int', description: 'Y coordinate to scan at (optional, defaults to bot height).', optional: true }
        },
        perform: function (agent, x1, z1, x2, z2, y = null) {
            const result = skills.scanArea(agent.bot, x1, z1, x2, z2, y);
            let res = `AREA SCAN (${result.size.width}x${result.size.length} at y=${result.area.y})`;
            res += `\nFrom (${result.area.minX}, ${result.area.minZ}) to (${result.area.maxX}, ${result.area.maxZ})`;
            res += `\nTotal blocks: ${result.totalBlocks}`;
            res += `\nBlock composition:`;
            for (const [block, count] of result.topBlocks) {
                const percent = ((count / result.totalBlocks) * 100).toFixed(1);
                res += `\n- ${block}: ${count} (${percent}%)`;
            }
            return pad(res);
        }
    },
    {
        name: '!gridView',
        description: 'Draw one Y level of a rectangle as an ASCII map, one character per block. Use to verify a build or find the exact block that is wrong. Use !scanArea instead when you only need which blocks are present.',
        params: {
            'x1': { type: 'int', description: 'X coordinate of the first corner.' },
            'z1': { type: 'int', description: 'Z coordinate of the first corner.' },
            'x2': { type: 'int', description: 'X coordinate of the second corner.' },
            'z2': { type: 'int', description: 'Z coordinate of the second corner.' },
            'y': { type: 'int', description: 'Y coordinate to scan at (optional, defaults to bot height).', optional: true }
        },
        perform: function (agent, x1, z1, x2, z2, y = null) {
            const bot = agent.bot;
            const minX = Math.min(Math.floor(x1), Math.floor(x2));
            const maxX = Math.max(Math.floor(x1), Math.floor(x2));
            const minZ = Math.min(Math.floor(z1), Math.floor(z2));
            const maxZ = Math.max(Math.floor(z1), Math.floor(z2));
            const scanY = y !== null ? Math.floor(y) : Math.floor(bot.entity.position.y);

            // Block to character mapping
            const blockChars = {
                'air': ' ', 'cobblestone': '#', 'stone': 'S', 'dirt': 'd',
                'grass_block': 'g', 'water': '~', 'lava': 'L', 'sand': '.',
                'torch': '*', 'oak_log': 'O', 'spruce_log': 'T', 'oak_planks': '=',
                'glass': 'G', 'chest': 'C', 'podzol': 'p', 'fern': 'f',
                'short_grass': ',', 'tall_grass': '|', 'mossy_cobblestone': 'M',
                'stone_bricks': 'B', 'oak_door': 'D', 'spruce_door': 'D'
            };

            const getChar = (name) => blockChars[name] || (name ? name[0].toUpperCase() : '?');

            let res = `GRID VIEW (${maxX - minX + 1}x${maxZ - minZ + 1} at y=${scanY})`;
            res += `\nArea: (${minX}, ${minZ}) to (${maxX}, ${maxZ})`;
            res += `\nLegend: #=cobblestone ~=water *=torch T=log g=grass d=dirt p=podzol ' '=air`;
            res += `\n`;

            // X-axis labels (last 2 digits)
            res += `\n    `;
            for (let x = minX; x <= maxX; x++) {
                res += (Math.abs(x) % 10).toString();
            }

            // Grid rows (Z axis)
            const blockCounts = {};
            for (let z = minZ; z <= maxZ; z++) {
                res += `\n${z.toString().padStart(4)} `;
                for (let x = minX; x <= maxX; x++) {
                    const block = bot.blockAt(new Vec3(x, scanY, z));
                    const name = block ? block.name : 'air';
                    const char = getChar(name);
                    res += char;
                    blockCounts[name] = (blockCounts[name] || 0) + 1;
                }
            }

            // Summary
            res += `\n\nTop blocks:`;
            const sorted = Object.entries(blockCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
            for (const [name, count] of sorted) {
                res += ` ${getChar(name)}=${name}(${count})`;
            }

            return pad(res);
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
