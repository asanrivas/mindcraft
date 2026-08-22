import * as skills from '../library/skills.js';
import * as swim from '../library/swim.js';
import { measureSwim, formatProbe } from '../library/swim_probe.js';
import * as worldGuard from '../library/world_guard.js';
import * as creative from '../library/creative.js';
import { Vec3 } from 'vec3';
import fs from 'fs';
import settings from '../settings.js';
import convoManager from '../conversation.js';


/**
 * Send a slash command and wait for the server's reply.
 *
 * There is no request/response channel for commands - the answer arrives as an ordinary chat
 * line - so listen on `messagestr` for something matching `pattern` and give up after
 * `timeoutMs` rather than hanging if the bot lacks permission and the server says nothing.
 *
 * @returns {Promise<string|null>} the matching line, or null on timeout
 */
async function runServerCommand(bot, command, pattern, timeoutMs = 8000) {
    return await new Promise((resolve) => {
        let done = false;
        const finish = (val) => {
            if (done) return;
            done = true;
            bot.removeListener('messagestr', onMsg);
            clearTimeout(timer);
            resolve(val);
        };
        const onMsg = (message) => {
            // Skip player chat. The agent narrates every command it runs ("*asanrivas used
            // worldSeed*"), and that echo matched the reply pattern before the real answer
            // arrived - so the command returned its own announcement as the server's response.
            if (/^<[^>]+>/.test(message)) return;
            if (message.includes(bot.username)) return;
            if (pattern.test(message)) finish(message);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        bot.on('messagestr', onMsg);
        bot.chat(command);
    });
}

function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            return await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        // Surface the command's own return value alongside the bot output log. Commands
        // report concrete outcomes ("Filled area with 0 sandstone blocks"); dropping them
        // left the model free to assume success from prose alone.
        const summary = code_return.result;
        if (summary !== undefined && summary !== null && summary !== '') {
            return code_return.message ? `${code_return.message}\n${summary}` : String(summary);
        }
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
        name: '!travel',
        description: 'Travel a long distance in a compass direction (west/east/north/south). Walks and mines through obstructions; does not rely on jumping. Reports VERIFIED distance actually covered.',
        params: {
            'direction': { type: 'string', description: 'One of: west, east, north, south.' },
            'distance': { type: 'int', description: 'How many blocks to travel.', domain: [1, 100000] }
        },
        perform: runAsAction(async (agent, direction, distance) => {
            const dirs = { west: [-1, 0], east: [1, 0], north: [0, -1], south: [0, 1] };
            const d = dirs[String(direction).toLowerCase()];
            if (!d) return `Unknown direction "${direction}". Use west, east, north or south.`;
            return await skills.travelDirection(agent.bot, d[0], d[1], distance);
        }, true, 45)  // resume=true so it can be continued; 45 min ceiling
    },
    {
        name: '!navTo',
        description: 'Go to x y z using the built-in navigator (own A* + raw movement, does not use mineflayer-pathfinder).',
        params: {
            'x': { type: 'int', description: 'target x' },
            'y': { type: 'int', description: 'target y' },
            'z': { type: 'int', description: 'target z' }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            const nav = await import('../library/nav.js');
            const { Vec3 } = await import('vec3');
            const start = agent.bot.entity.position.clone();
            const t0 = Date.now();
            const probe = nav.planPath(agent.bot, new Vec3(x, y, z));
            console.warn(`[navTo] plan took ${Date.now() - t0}ms length=${probe ? probe.length : 'null'} first=${probe && probe[1] ? JSON.stringify(probe[1]) : '-'} last=${probe && probe.length ? JSON.stringify(probe[probe.length-1]) : '-'}`);
            const res = await nav.navigateTo(agent.bot, new Vec3(x, y, z), {});
            const p = agent.bot.entity.position;
            return `NAV: arrived=${res.arrived} covered=${res.covered.toFixed(1)} replans=${res.replans} `
                + `from=(${start.x.toFixed(0)},${start.y.toFixed(0)},${start.z.toFixed(0)}) `
                + `to=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`;
        }, true, 10)
    },
    {
        name: '!climbOut',
        description: 'Cut a staircase up to the surface. Use when stuck underground in a cave or tunnel.',
        perform: runAsAction(async (agent) => {
            const before = agent.bot.entity.position.y;
            const gained = await skills.climbToSurface(agent.bot);
            const p = agent.bot.entity.position;
            return `CLIMB: gained ${gained.toFixed(0)} blocks, y ${before.toFixed(0)} -> ${p.y.toFixed(0)}.`;
        }, true, 15)
    },
    {
        name: '!swimTo',
        description: 'Swim to a point in or across water. Handles depth automatically and sprint-swims when submerged.',
        params: {
            'x': { type: 'float', description: 'x coordinate.' },
            'y': { type: 'float', description: 'y coordinate.' },
            'z': { type: 'float', description: 'z coordinate.' }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            const bot = agent.bot;
            if (!swim.inWater(bot)) return 'Not in water - walk to the water first, then swim.';
            const r = await swim.swimTo(bot, new Vec3(x, y, z));
            const p = bot.entity.position;
            const speed = r.ms > 0 ? (r.covered / (r.ms / 1000)) : 0;
            return `VERIFIED SWIM: arrived=${r.arrived}, covered ${r.covered.toFixed(1)} blocks in `
                + `${(r.ms / 1000).toFixed(1)}s (${speed.toFixed(2)} b/s), ${r.remaining.toFixed(1)} to go, `
                + `oxygen ${r.oxygenStart}->${r.oxygenEnd}, reason=${r.reason}. `
                + `Now at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}).`;
        }, true, 5)
    },
    {
        name: '!dive',
        description: 'Dive down underwater by a number of blocks. Surfaces automatically when air runs low.',
        params: {
            'depth': { type: 'int', description: 'How many blocks to descend.', domain: [1, 100] }
        },
        perform: runAsAction(async (agent, depth) => {
            const bot = agent.bot;
            if (!swim.inWater(bot)) return 'Not in water - get in the water first.';
            // The hunting mode will chase a cod mid-dive and fight the descent for the controls.
            bot.modes.pause('hunting');
            try {
                const startY = bot.entity.position.y;
                const r = await swim.dive(bot, startY - depth);
                return `VERIFIED DIVE: y ${startY.toFixed(0)} -> ${r.y.toFixed(0)} `
                    + `(${r.descended.toFixed(1)}/${depth} blocks in ${(r.ms / 1000).toFixed(1)}s), `
                    + `oxygen ${r.oxygenStart}->${r.oxygenEnd}, reason=${r.reason}.`;
            } finally {
                bot.modes.unpause('hunting');
            }
        }, false, 2)
    },
    {
        name: '!surface',
        description: 'Swim up to the surface for air. Finds another way up if the water above is capped.',
        perform: runAsAction(async (agent) => {
            const bot = agent.bot;
            // The drowning mode does exactly this job and already has the controls. Racing it
            // starves both: each interrupt aborts the other's climb, and the bot keeps drowning
            // while the two hand off. Whoever got there first finishes the job.
            if (bot.modes.exists('drowning') && bot.modes.isActive('drowning')) {
                return 'The drowning response is already surfacing me - leaving it to finish.';
            }
            bot.modes.pause('hunting');
            try {
                const r = await swim.surface(bot);
                if (!r.surfaced) {
                    return `VERIFIED SURFACE: FAILED, reason=${r.reason}`
                        + `${r.blocker ? ` (blocked by ${r.blocker})` : ''}, still at y=${r.y.toFixed(0)} `
                        + `with ${r.oxygenEnd}/20 air.`;
                }
                return `VERIFIED SURFACE: y ${(r.y - r.rose).toFixed(0)} -> ${r.y.toFixed(0)} in `
                    + `${(r.ms / 1000).toFixed(1)}s, oxygen ${r.oxygenStart}->${r.oxygenEnd}, reason=${r.reason}.`;
            } finally {
                bot.modes.unpause('hunting');
            }
        }, false, 1)
    },
    {
        // Diagnostic. The whole water cost model in nav.js rests on a claim that the bot "barely
        // moves while swimming"; this is what settles it with numbers instead of a comment.
        name: '!swimProbe',
        description: 'Measure how fast this server actually lets you swim. Run while floating in open water.',
        perform: runAsAction(async (agent) => {
            const m = await measureSwim(agent.bot);
            return formatProbe(m);
        }, false, 3)
    },
    {
        // Steering is rendered verbatim into every prompt and is never round-tripped through the
        // model the way `history.memory` is - that channel is model-written and has already
        // corrupted itself once in this project, rewriting a command signature until the bot
        // acted on its own bad note. Directives change only when a user asks; the guard below
        // stops an autonomous loop from rewriting its own instructions.
        name: '!steer',
        description: 'Give me a standing instruction that shapes how I talk and act. Persists across restarts. Example: !steer("be brief, no questions")',
        params: {
            'instruction': { type: 'string', description: 'The standing instruction, kept short.' }
        },
        perform: async function (agent, instruction) {
            // Refuse while self-prompting. Relaying what a user just asked for is the point of
            // this command, but an autonomous loop editing its own standing instructions is the
            // same self-corruption that wrecked `history.memory` in this project.
            if (agent.self_prompter && agent.self_prompter.isActive())
                return 'I will not change my own standing instructions while running autonomously. Ask me directly.';
            return agent.steering.add(instruction).message;
        }
    },
    {
        name: '!steering',
        description: 'List the standing instructions currently steering me, numbered.',
        perform: async function (agent) {
            return agent.steering.list();
        }
    },
    {
        name: '!unsteer',
        description: 'Remove a standing instruction by its number from !steering, or "all" to clear them.',
        params: {
            'which': { type: 'string', description: 'The number shown by !steering, or "all".' }
        },
        perform: async function (agent, which) {
            if (agent.self_prompter && agent.self_prompter.isActive())
                return 'I will not remove my own standing instructions while running autonomously. Ask me directly.';
            return agent.steering.remove(which).message;
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
        }, false, 3)   // bounded: this routes through mineflayer-pathfinder, which cannot move
                       // the bot here, so without a ceiling it pins currentActionLabel until
                       // something else forces a stop (observed: 5 minutes frozen mid-igloo)
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
        description: 'Place a given block next to you. Do NOT use to build structures, only use for single blocks/torches/beds.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            // Next to the bot, not inside it - see skills.placeNearby.
            const ok = await skills.placeNearby(agent.bot, type);
            return ok ? `Placed ${type}.` : `Could not place ${type} nearby.`;
        })
    },
    {
        name: '!fill',
        description: 'Manually walk and place blocks (slow, can fail on rough terrain - prefer !serverFill). Takes only X/Z corners then a SINGLE y and a height: (blockType, x1, z1, x2, z2, y, height). This is NOT the vanilla /fill order.',
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
            // skills.fill returns a VERIFIED summary read back from world state, not a
            // self-reported count - pass it through unchanged.
            return await skills.fill(agent.bot, blockType, x1, z1, x2, z2, y, height);
        }, true, 600)  // resume=true allows resuming after interruption
    },
    {
        name: '!buildBlueprint',
        description: 'Hand-build a blueprint placements JSON block by block: fly to each position (creative), auto-compute the look angle and click face, place with own hands. No server /setblock.',
        params: {
            'file': { type: 'string', description: 'Path to the placements JSON, relative to the mindcraft root (e.g. "blueprints/survival_base.json").' },
            'x': { type: 'int', description: 'World X of the blueprint origin (its local 0,0,0 min-corner).' },
            'y': { type: 'int', description: 'World Y of the blueprint origin.' },
            'z': { type: 'int', description: 'World Z of the blueprint origin.' }
        },
        perform: runAsAction(async (agent, file, x, y, z) => {
            const { buildBlueprint } = await import('../library/blueprint_builder.js');
            return await buildBlueprint(agent, file, new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
        }, false, 240)  // minutes - a few thousand blocks at ~1s each needs hours of headroom
    },
    {
        name: '!serverFill',
        description: 'PREFERRED for building. Instant server /fill - thousands of blocks at once, no walking. Takes BOTH corners in full 3D: (blockType, x1, y1, z1, x2, y2, z2). Note this is a DIFFERENT argument order from !fill.',
        params: {
            'blockType': { type: 'BlockOrItemName', description: 'The block type to place (e.g., "stone_bricks", "cobblestone").' },
            'x1': { type: 'int', description: 'X coordinate of the first corner.' },
            'y1': { type: 'int', description: 'Y coordinate of the first corner.' },
            'z1': { type: 'int', description: 'Z coordinate of the first corner.' },
            'x2': { type: 'int', description: 'X coordinate of the second corner.' },
            'y2': { type: 'int', description: 'Y coordinate of the second corner.' },
            'z2': { type: 'int', description: 'Z coordinate of the second corner.' },
            'mode': { type: 'string', description: 'Fill mode: "replace" (default), "hollow", "outline", "destroy", or "keep".', optional: true }
        },
        perform: async (agent, blockType, x1, y1, z1, x2, y2, z2, mode = 'replace') => {
            const validModes = ['replace', 'hollow', 'outline', 'destroy', 'keep'];
            if (!validModes.includes(mode)) mode = 'replace';

            // Refuse edits that destroy something irreplaceable or bury the bot. A model cannot
            // see that the cell it is about to overwrite holds its own bed; the edit itself has
            // to notice. See world_guard.js for the night this cost.
            // Pass the MODE, never a substituted blockType: hollow paints the shell with
            // blockType and only the interior with air, so 'air' here disabled the entombment
            // check on exactly the fills that can bury the bot.
            const guard = worldGuard.checkEditForBot(agent.bot,
                { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }, blockType, { mode });
            if (!guard.ok) {
                return `REFUSED: ${guard.reason} Move it, or use !forceFill if you really mean it.`;
            }
            const guardNote = guard.warning ? ` [GUARD: ${guard.warning}]` : '';

            const command = `/fill ${Math.floor(x1)} ${Math.floor(y1)} ${Math.floor(z1)} ${Math.floor(x2)} ${Math.floor(y2)} ${Math.floor(z2)} ${blockType} ${mode}`;
            agent.bot.chat(command);

            // Give the server a moment to apply, then read the region back. Reporting the
            // requested block count would claim success even when the command silently
            // failed (no operator permission, unloaded chunks, bad block name).
            await new Promise(r => setTimeout(r, 600));
            if (guardNote) console.warn(`[worldGuard]${guardNote}`);
            if (mode === 'replace' || mode === 'keep') {
                const check = skills.verifyRegion(agent.bot,
                    Math.min(Math.floor(x1), Math.floor(x2)), Math.min(Math.floor(z1), Math.floor(z2)),
                    Math.max(Math.floor(x1), Math.floor(x2)), Math.max(Math.floor(z1), Math.floor(z2)),
                    Math.min(Math.floor(y1), Math.floor(y2)),
                    Math.abs(Math.floor(y2) - Math.floor(y1)) + 1, blockType);
                return `Ran ${command}\n${check.summary}`;
            }
            const dx = Math.abs(x2 - x1) + 1;
            const dy = Math.abs(y2 - y1) + 1;
            const dz = Math.abs(z2 - z1) + 1;
            return `Ran ${command} (${mode} mode, ${dx * dy * dz} blocks in region).`;
        }
    },
    {
        name: '!serverSummon',
        description: 'INSTANT summon using server /summon command. Spawns entities immediately at specified location.',
        params: {
            'entityType': { type: 'string', description: 'The entity to summon (e.g., "villager", "iron_golem", "cow").' },
            'x': { type: 'int', description: 'X coordinate to summon at.', optional: true },
            'y': { type: 'int', description: 'Y coordinate to summon at.', optional: true },
            'z': { type: 'int', description: 'Z coordinate to summon at.', optional: true }
        },
        perform: async (agent, entityType, x, y, z) => {
            const pos = agent.bot.entity.position;
            const spawnX = x !== undefined ? Math.floor(x) : Math.floor(pos.x);
            const spawnY = y !== undefined ? Math.floor(y) : Math.floor(pos.y);
            const spawnZ = z !== undefined ? Math.floor(z) : Math.floor(pos.z);

            const command = `/summon ${entityType} ${spawnX} ${spawnY} ${spawnZ}`;
            agent.bot.chat(command);

            return `Summoned ${entityType} at (${spawnX}, ${spawnY}, ${spawnZ})`;
        }
    },
    {
        // Rescue hatch, not a travel shortcut. Terrain edits made while testing have several
        // times dropped the bot into a pit or sealed it underground with no reachable way out,
        // and nothing in the normal movement stack can recover from that. This teleports it
        // clear - but ONLY while an operator-created marker file exists on disk, so the model
        // can never invoke it to skip a journey it is supposed to walk.
        // Deliberately NOT a generic "run any server command" passthrough. The model can call
        // every command in this list, and an unrestricted /-passthrough would hand it /op, /ban
        // and /kill. Narrow commands keep the blast radius to what they say on the tin.
        name: '!serverGamemode',
        description: 'Operator: change this bot\'s gamemode (survival, creative, adventure, spectator).',
        params: {
            'mode': { type: 'string', description: 'survival, creative, adventure or spectator.' }
        },
        perform: runAsAction(async (agent, mode) => {
            const m = String(mode).toLowerCase();
            const allowed = ['survival', 'creative', 'adventure', 'spectator'];
            if (!allowed.includes(m)) return `Unknown gamemode "${mode}". Use one of: ${allowed.join(', ')}.`;
            const line = await runServerCommand(agent.bot, `/gamemode ${m} ${agent.name}`,
                /game ?mode|permission|Unknown/i, 5000);
            await new Promise(r => setTimeout(r, 600));
            return `GAMEMODE: now ${agent.bot.game.gameMode}${line ? ` (server said: ${line})` : ''}.`;
        }, false, 1)
    },
    {
        // Death becomes possible the moment the bot leaves creative, and world spawn here is
        // thousands of blocks from anywhere it is working. Set this before switching.
        name: '!serverSpawnpoint',
        description: 'Operator: set this bot\'s respawn point to its current position.',
        perform: runAsAction(async (agent) => {
            const p = agent.bot.entity.position;
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const line = await runServerCommand(agent.bot, `/spawnpoint ${agent.name} ${x} ${y} ${z}`,
                /spawn ?point|permission|Unknown/i, 5000);
            return `SPAWNPOINT set to (${x}, ${y}, ${z})${line ? `. Server said: ${line}` : ' (no confirmation from server)'}.`;
        }, false, 1)
    },
    {
        name: '!shoot',
        description: 'Shoot a mob with bow or crossbow from range. Refuses players. Needs arrows.',
        params: {
            'mob_type': { type: 'string', description: 'The mob to shoot, e.g. "zombie", "skeleton".' },
            'weapon': { type: 'string', description: '"bow", "crossbow" or "auto".', optional: true }
        },
        perform: runAsAction(async (agent, mob_type, weapon) => {
            const w = ['bow', 'crossbow', 'auto'].includes(String(weapon)) ? weapon : 'auto';
            return await skills.shootBow(agent.bot, mob_type, w);
        }, false, 3)
    },
    {
        // Provisioning for survival-mode testing. Narrow like the rest: gives to THIS bot only,
        // never to arbitrary players, so it cannot be used to shower someone else with gear.
        name: '!serverGive',
        description: 'Operator: give this bot an item via server /give.',
        params: {
            'item': { type: 'ItemName', description: 'The item to give.' },
            'count': { type: 'int', description: 'How many.', domain: [1, 640] }
        },
        perform: runAsAction(async (agent, item, count) => {
            // No runServerCommand here: its reply reader drops any line containing the bot's
            // username (to ignore the agent's own chat echo), and "Gave 5 [Diamond] to andy"
            // always contains it - so every give stalled the full 5s timeout and reported
            // "no confirmation" even on success. The inventory recount is the real verification.
            agent.bot.chat(`/give ${agent.name} ${item} ${Math.floor(count)}`);
            await new Promise(r => setTimeout(r, 700));
            const held = agent.bot.inventory.items().filter(i => i.name === item)
                .reduce((n, i) => n + i.count, 0);
            return `GIVE: now holding ${held} ${item}.`;
        }, false, 1)
    },
    {
        name: '!worldSeed',
        description: 'Ask the server for the world seed. Requires operator permission.',
        perform: runAsAction(async (agent) => {
            const line = await runServerCommand(agent.bot, '/seed', /Seed:\s*\[|^\[?-?\d{6,}|permission|Unknown/i, 6000);
            if (!line) return 'No reply from the server - /seed may need operator permission.';
            const m = line.match(/(-?\d{4,})/);
            return m ? `WORLD SEED: ${m[1]}` : `Server said: ${line}`;
        }, false, 1)
    },
    {
        // Uses the SERVER's own world generator, so the answer is exact for this seed - which
        // beats reproducing the biome maths against a stale minecraft-data copy, especially on
        // a 26.1 server the local stack does not fully understand.
        name: '!locateBiome',
        description: 'Find the nearest biome of a given type using the server world generator, e.g. "frozen_ocean" or "ice_spikes".',
        params: {
            'biome': { type: 'string', description: 'Biome id, with or without the minecraft: prefix.' }
        },
        perform: runAsAction(async (agent, biome) => {
            const id = String(biome).includes(':') ? String(biome) : `minecraft:${biome}`;
            const line = await runServerCommand(agent.bot, `/locate biome ${id}`, /nearest|could not|unknown|no biome/i, 15000);
            if (!line) return `No reply from the server for ${id} - /locate may need operator permission.`;
            // "The nearest minecraft:frozen_ocean is at [1234, ~, -5678] (890 blocks away)"
            const m = line.match(/\[\s*(-?\d+)\s*,\s*(~|-?\d+)\s*,\s*(-?\d+)\s*\]/);
            if (!m) return `Server said: ${line}`;
            const p = agent.bot.entity.position;
            const dist = Math.hypot(Number(m[1]) - p.x, Number(m[3]) - p.z);
            return `BIOME ${id} at x=${m[1]} z=${m[3]} (y=${m[2]}), ${dist.toFixed(0)} blocks away. `
                + `Server said: ${line}`;
        }, false, 2)
    },
    {
        name: '!serverTp',
        description: 'Operator rescue only. Disabled unless a marker file is present; not usable for travel.',
        params: {
            'x': { type: 'int', description: 'X coordinate.' },
            'y': { type: 'int', description: 'Y coordinate.' },
            'z': { type: 'int', description: 'Z coordinate.' }
        },
        perform: async (agent, x, y, z) => {
            const marker = './bots/' + agent.name + '/ALLOW_RESCUE_TP';
            if (!fs.existsSync(marker))
                return 'Refused: rescue teleport is disabled. Walk there instead.';
            fs.unlinkSync(marker); // single use - re-arm deliberately, never by accident
            agent.bot.chat(`/tp ${agent.name} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`);
            await new Promise(r => setTimeout(r, 1200));
            const p = agent.bot.entity.position;
            return `Rescue teleport used (one-shot, now disarmed). Now at ` +
                `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}).`;
        }
    },
    {
        // The escape hatches. A guard with no override becomes an obstacle people route around
        // by other means; an explicit, separately-named command keeps the refusal meaningful
        // while leaving the operator (and a model that has been told why) a way through.
        name: '!forceFill',
        description: 'Like !serverFill but ignores the protection guard. Only for edits you have checked yourself.',
        params: {
            'blockType': { type: 'BlockOrItemName', description: 'The block type to place.' },
            'x1': { type: 'int', description: 'X of first corner.' },
            'y1': { type: 'int', description: 'Y of first corner.' },
            'z1': { type: 'int', description: 'Z of first corner.' },
            'x2': { type: 'int', description: 'X of second corner.' },
            'y2': { type: 'int', description: 'Y of second corner.' },
            'z2': { type: 'int', description: 'Z of second corner.' }
        },
        perform: async (agent, blockType, x1, y1, z1, x2, y2, z2) => {
            const g = worldGuard.checkEditForBot(agent.bot, { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }, blockType);
            agent.bot.chat(`/fill ${Math.floor(x1)} ${Math.floor(y1)} ${Math.floor(z1)} ${Math.floor(x2)} ${Math.floor(y2)} ${Math.floor(z2)} ${blockType} replace`);
            await new Promise(r => setTimeout(r, 600));
            return `FORCED FILL done${g.ok ? '' : ` (guard had warned: ${g.reason})`}`;
        }
    },
    {
        name: '!forceSetblock',
        description: 'Like !serverSetblock but ignores the protection guard.',
        params: {
            'blockType': { type: 'BlockOrItemName', description: 'The block type to place.' },
            'x': { type: 'int', description: 'X coordinate.' },
            'y': { type: 'int', description: 'Y coordinate.' },
            'z': { type: 'int', description: 'Z coordinate.' }
        },
        perform: async (agent, blockType, x, y, z) => {
            const g = worldGuard.checkEditForBot(agent.bot, { x, y, z }, { x, y, z }, blockType);
            agent.bot.chat(`/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${blockType}`);
            return `FORCED setblock ${blockType} at (${x}, ${y}, ${z})${g.ok ? '' : ` (guard had warned: ${g.reason})`}`;
        }
    },
    {
        name: '!serverSetblock',
        description: 'INSTANT setblock using server /setblock command. Places a single block immediately.',
        params: {
            'blockType': { type: 'BlockOrItemName', description: 'The block type to place.' },
            'x': { type: 'int', description: 'X coordinate.' },
            'y': { type: 'int', description: 'Y coordinate.' },
            'z': { type: 'int', description: 'Z coordinate.' },
            // Block states have to be a SEPARATE argument: the BlockOrItemName validator checks
            // the name against the registry, so "red_bed[part=foot]" is rejected outright. Some
            // blocks are unusable without one - a bed placed with no part/facing is half a bed,
            // which pops straight off and cannot set a respawn point.
            'state': { type: 'string', description: 'Optional block state, e.g. "facing=east,part=foot". Use "none" for no state.' }
        },
        perform: async (agent, blockType, x, y, z, state) => {
            // Same guard as !serverFill, and this is the command that actually did the damage:
            // a single setblock landed on the bot's own bed.
            const g = worldGuard.checkEditForBot(agent.bot, { x, y, z }, { x, y, z }, blockType);
            if (!g.ok) return `REFUSED: ${g.reason} Use !forceSetblock if you really mean it.`;
            const clean = String(state ?? '').trim().replace(/^\[|\]$/g, '');
            const suffix = (!clean || clean.toLowerCase() === 'none') ? '' : `[${clean}]`;
            const command = `/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${blockType}${suffix}`;
            agent.bot.chat(command);
            return `Set block ${blockType}${suffix} at (${x}, ${y}, ${z})`;
        }
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
            // Stand down if the mode already owns this job. Both sides of the livelock fence:
            // the guard here, "action:goToBed" in night_safety's excludeFromInterrupt.
            if (agent.bot.modes.exists('night_safety') && agent.bot.modes.isActive('night_safety'))
                return 'Night safety is already handling bed/shelter - leaving it to finish.';
            const r = await skills.goToBed(agent.bot);
            return r.slept ? 'Slept.' : `Did not sleep: ${r.reason}.`;
        }, false, 3)   // 3 min ceiling - the default -1 is the pin-forever hazard
    },
    {
        name: '!shelter',
        description: 'Dig in and seal a one-block shelter for the night. Use when there is no bed.',
        perform: runAsAction(async (agent) => {
            if (agent.bot.modes.exists('night_safety') && agent.bot.modes.isActive('night_safety'))
                return 'Night safety is already handling bed/shelter - leaving it to finish.';
            const r = await skills.emergencyShelter(agent.bot);
            return r.sheltered ? `VERIFIED SHELTER: sealed.` : `Could not shelter: ${r.reason}.`;
        }, false, 3)
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
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. Refused if the last build verification showed the work is incomplete.',
        perform: async function (agent) {
            // Guard against declaring victory the world does not support. Prompt rules alone
            // do not prevent this (the model will assert completion regardless), so the check
            // is made against the last verified region read rather than against intent.
            const v = agent.bot.last_verification;
            const RECENT_MS = 5 * 60 * 1000;
            if (v && !v.complete && (Date.now() - v.at) < RECENT_MS) {
                return `Refusing to end goal: the last verification found only ${v.correct}/${v.total} `
                    + `${v.blockType} blocks in place (${v.pct}%). The task is NOT finished. `
                    + `Fix the missing blocks, then re-run the fill to re-verify.`;
            }
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
    {
        name: '!creativeGive',
        description: 'Creative mode only: put an item straight into your own inventory, no /give needed.',
        params: {
            'item': { type: 'ItemName', description: 'The item to summon, e.g. "cobblestone".' },
            'count': { type: 'int', description: 'How many.', domain: [1, 2304] }
        },
        perform: runAsAction(async (agent, item, count) => {
            const r = await creative.giveItem(agent.bot, item, count);
            if (!r.ok) return `CREATIVE GIVE FAILED: ${r.error || 'unknown error'}`;
            return `CREATIVE GIVE: ${r.placed} ${r.item} across ${r.slots.length} slot(s).`;
        }, false, 1)
    },
    {
        name: '!creativeKit',
        description: 'Creative mode only: stock a ready-made kit of items (building, mining, or survival).',
        params: {
            'kit': { type: 'string', description: 'Which kit: "building", "mining", "survival", or "all".' }
        },
        perform: runAsAction(async (agent, kit) => {
            const r = await creative.giveKit(agent.bot, kit);
            if (r.error) return `CREATIVE KIT FAILED: ${r.error}`;
            const ok = r.results.filter(x => x.ok);
            const bad = r.results.filter(x => !x.ok);
            let line = `CREATIVE KIT "${r.kit}": ${ok.length} item(s) stocked`;
            if (bad.length) line += `; ${bad.length} failed (${bad.slice(0, 3).map(b => `${b.item}: ${b.error}`).join(', ')})`;
            return line + '.';
        }, false, 2)
    },
    {
        name: '!creativeClear',
        description: 'Creative mode only: empty your entire inventory.',
        perform: runAsAction(async (agent) => {
            const r = await creative.clearInventory(agent.bot);
            if (!r.ok) return `CREATIVE CLEAR FAILED: ${r.error}`;
            return `CREATIVE CLEAR: emptied ${r.cleared} slot(s).`;
        }, false, 1)
    },
    {
        name: '!creativeIdSweep',
        description: 'Diagnostic: give one of each id-sweep sample so item ids can be checked server-side.',
        perform: runAsAction(async (agent) => {
            const r = await creative.idSweep(agent.bot);
            if (r.error) return `ID SWEEP FAILED: ${r.error}`;
            return 'ID SWEEP: ' + r.asked.map(a => `${a.item}=${a.id}${a.placed ? '' : '(FAILED)'}`).join(' ');
        }, false, 2)
    },
    {
        name: '!creativeStatus',
        description: 'Report your game mode, and whether creative item ids match this server.',
        perform: runAsAction(async (agent) => {
            const mode = creative.gameMode(agent.bot);
            if (mode !== 'creative') return `GAME MODE: ${mode}. Creative commands are unavailable.`;
            const p = await creative.probeIdMapping(agent.bot);
            if (p.error) return `GAME MODE: creative. Probe failed: ${p.error}`;
            return p.ok
                ? `GAME MODE: creative. Item ids OK (asked ${p.asked}, got ${p.got}).`
                : `GAME MODE: creative. ITEM ID MISMATCH - asked ${p.asked} (id ${p.askedId}), got ${p.got ?? 'nothing'} (id ${p.gotId ?? 'n/a'}).`;
        }, false, 1)
    },
];
