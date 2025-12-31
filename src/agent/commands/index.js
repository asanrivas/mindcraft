import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';
import settings from '../settings.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

// ============= COMMAND ALIASES =============
// Short aliases map to full command names (saves tokens in prompts)
const COMMAND_ALIASES = {
    // Chest commands (all start with 'c' prefix)
    'cp': 'chestPut',
    'ct': 'chestTake',
    'cv': 'chestView',
    'cda': 'chestDepositAll',
    'cl': 'chestList',
    'cn': 'chestName',
    'cln': 'chestListNamed',
    'cf': 'chestForget',
    'cpn': 'chestPutNamed',
    'ctn': 'chestTakeNamed',
    'cvn': 'chestViewNamed',
    'cds': 'chestDepositSorted',
    'cfi': 'chestFind',
    'ctr': 'chestTransfer',
    'dis': 'discard',
    
    // Movement commands
    'gtp': 'goToPlayer',
    'gtc': 'goToCoordinates',
    'fp': 'followPlayer',
    'ma': 'moveAway',
    'sfb': 'searchForBlock',
    'sfe': 'searchForEntity',
    
    // Action commands
    'cb': 'collectBlocks',
    'cr': 'craftRecipe',
    'sm': 'smeltItem',
    'atk': 'attack',
    'eq': 'equip',
    'eat': 'consume',
    'ph': 'placeHere',
    'gtb': 'goToBed',
    'ca': 'fill',
    'pt': 'plantTrees',
    
    // Info commands
    'inv': 'inventory',
    'st': 'stats',
    'nb': 'nearbyBlocks',
    'sur': 'surroundings',
    'ent': 'entities',
    'cft': 'craftable',
    'gcp': 'getCraftingPlan',
    'sa': 'scanArea',
    
    // Memory/Control commands
    'clr': 'clearChat',
    'clm': 'clearMemory',
    'g': 'goal',
    'eg': 'endGoal',
    'na': 'newAction',
    
    // Places
    'rh': 'rememberHere',
    'gtrp': 'goToRememberedPlace',
    'sp': 'savedPlaces',
};

// Create reverse map for lookup
const ALIAS_TO_COMMAND = {};
for (const [alias, command] of Object.entries(COMMAND_ALIASES)) {
    ALIAS_TO_COMMAND[alias] = command;
}

/**
 * Expand command alias to full command name
 * @param {string} message - message that may contain alias
 * @returns {string} - message with alias expanded
 */
export function expandCommandAlias(message) {
    if (!settings.use_command_aliases) return message;
    
    // Match !alias or !alias(...) pattern
    const aliasMatch = message.match(/^!(\w+)/);
    if (!aliasMatch) return message;
    
    const potentialAlias = aliasMatch[1];
    if (ALIAS_TO_COMMAND[potentialAlias]) {
        const fullCommand = ALIAS_TO_COMMAND[potentialAlias];
        return message.replace(`!${potentialAlias}`, `!${fullCommand}`);
    }
    return message;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

// Regex for space-separated format: !command "arg1" arg2 or !command arg1 arg2
const spaceSeparatedRegex = /^!(\w+)\s+(.+)$/;

/**
 * Normalize various quote characters to standard ASCII double quotes
 * Handles: curly quotes, smart quotes, guillemets, etc.
 * @param {string} text
 * @returns {string}
 */
function normalizeQuotes(text) {
    return text
        // Curly double quotes (U+201C, U+201D)
        .replace(/[\u201C\u201D]/g, '"')
        // Curly single quotes (U+2018, U+2019)
        .replace(/[\u2018\u2019]/g, "'")
        // Guillemets (U+00AB, U+00BB)
        .replace(/[\u00AB\u00BB]/g, '"')
        // Prime marks (U+2032, U+2033)
        .replace(/\u2032/g, "'")
        .replace(/\u2033/g, '"')
        // Fullwidth quotes (U+FF02)
        .replace(/\uFF02/g, '"');
}

/**
 * Normalizes command format from space-separated to parenthesis format
 * Also fixes unquoted strings inside parentheses
 * e.g. !getCraftingPlan "torch" 1 -> !getCraftingPlan("torch", 1)
 * e.g. !goal(build a house) -> !goal("build a house")
 * @param {string} message
 * @returns {string}
 */
function normalizeCommandFormat(message) {
    // Check if command has parentheses with unquoted content
    const parenMatch = message.match(/^(!(\w+)\()(.+)\)(.*)$/);
    if (parenMatch) {
        const prefix = parenMatch[1]; // "!goal("
        const commandName = parenMatch[2]; // "goal"
        const argsContent = parenMatch[3]; // "build 20x20 fence..."
        const suffix = parenMatch[4]; // anything after ")"
        
        // Parse arguments inside parentheses
        const normalizedArgs = parseAndQuoteArgs(argsContent);
        return `${prefix}${normalizedArgs})${suffix}`;
    }
    
    // Handle space-separated format: !command arg1 arg2
    const match = message.match(spaceSeparatedRegex);
    if (!match) {
        return message;
    }
    
    const commandName = match[1];
    const argsString = match[2].trim();
    
    const normalizedArgs = parseAndQuoteArgs(argsString);
    if (!normalizedArgs) {
        return message;
    }
    
    return `!${commandName}(${normalizedArgs})`;
}

/**
 * Parse arguments and ensure strings are properly quoted
 * @param {string} argsString - Raw arguments string
 * @returns {string} Normalized arguments with proper quoting
 */
function parseAndQuoteArgs(argsString) {
    const args = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = 0; i < argsString.length; i++) {
        const char = argsString[i];
        
        if ((char === '"' || char === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = char;
            current += '"'; // Normalize to double quotes
        } else if (char === quoteChar && inQuotes) {
            inQuotes = false;
            current += '"'; // Normalize to double quotes
            args.push(current);
            current = '';
            quoteChar = '';
        } else if (char === ',' && !inQuotes) {
            // Handle comma-separated args
            if (current.trim()) {
                args.push(quoteArgIfNeeded(current.trim()));
                current = '';
            }
        } else if (char === ' ' && !inQuotes && !argsString.includes(',')) {
            // Handle space-separated args (only if no commas present)
            if (current.trim()) {
                args.push(quoteArgIfNeeded(current.trim()));
                current = '';
            }
        } else {
            current += char;
        }
    }
    
    // Handle last argument
    if (current.trim()) {
        args.push(quoteArgIfNeeded(current.trim()));
    }
    
    if (args.length === 0) {
        return null;
    }
    
    return args.join(', ');
}

/**
 * Quote an argument if it's a string (not a number or boolean)
 * @param {string} arg
 * @returns {string}
 */
function quoteArgIfNeeded(arg) {
    // Already quoted
    if ((arg.startsWith('"') && arg.endsWith('"')) || 
        (arg.startsWith("'") && arg.endsWith("'"))) {
        // Normalize to double quotes
        return `"${arg.slice(1, -1)}"`;
    }
    
    // Number
    if (/^-?\d+(\.\d+)?$/.test(arg)) {
        return arg;
    }
    
    // Boolean
    if (arg === 'true' || arg === 'false') {
        return arg;
    }
    
    // String - needs quotes
    return `"${arg}"`;
}

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    // Normalize curly/smart quotes to ASCII quotes (LLMs often output Unicode quotes)
    message = normalizeQuotes(message);

    // Expand command aliases first (e.g., !pic -> !putInChest)
    message = expandCommandAlias(message);

    // Normalize space-separated format to parenthesis format
    message = normalizeCommandFormat(message);
    
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    const requiredParams = params.filter(p => !p.optional);

    if (args.length < requiredParams.length || args.length > params.length) {
        if (requiredParams.length === params.length)
            return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;
        else
            return `Command ${command.name} was given ${args.length} args, but requires ${requiredParams.length}-${params.length} args.`;
    }


    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    // Normalize space-separated format first
    const normalized = normalizeCommandFormat(message);
    const commandMatch = normalized.match(commandRegex);
    if (commandMatch) {
        return normalized.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

function numRequiredParams(command) {
    const params = commandParams(command);
    return params.filter(p => !p.optional).length;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        const minParams = numRequiredParams(command);
        const maxParams = numParams(command);
        if (numArgs < minParams || numArgs > maxParams) {
            if (minParams === maxParams)
                return `Command ${command.name} was given ${numArgs} args, but requires ${maxParams} args.`;
            else
                return `Command ${command.name} was given ${numArgs} args, but requires ${minParams}-${maxParams} args.`;
        }
        else {
            const result = await command.perform(agent, ...parsed.args);
            return result;
        }
    }
}

/**
 * Get the alias for a command name (if exists)
 */
function getCommandAlias(commandName) {
    const name = commandName.replace('!', '');
    for (const [alias, fullName] of Object.entries(COMMAND_ALIASES)) {
        if (fullName === name) return alias;
    }
    return null;
}

/**
 * Generate command documentation based on mode setting
 * @param {Object} agent 
 * @returns {string} command documentation
 */
export function getCommandDocs(agent) {
    const mode = settings.command_docs_mode || 'full';
    const showAliases = settings.use_command_aliases;
    
    const typeTranslations = {
        'float': 'num', 'int': 'num', 'BlockName': 'str', 
        'ItemName': 'str', 'BlockOrItemName': 'str', 'boolean': 'bool', 'string': 'str'
    };
    const typeTranslationsFull = {
        'float': 'number', 'int': 'number', 'BlockName': 'string',
        'ItemName': 'string', 'BlockOrItemName': 'string', 'boolean': 'bool', 'string': 'string'
    };
    
    let docs = '';
    
    if (mode === 'minimal') {
        // Minimal: just command names and aliases
        docs = `\n*COMMANDS: Use !cmd or !cmd("arg1",arg2). `;
        if (showAliases) docs += `Aliases in [brackets]. `;
        docs += `*\n`;
        
        const cmdNames = [];
        for (let command of commandList) {
            if (agent.blocked_actions.includes(command.name)) continue;
            const alias = getCommandAlias(command.name);
            const aliasStr = (showAliases && alias) ? `[${alias}]` : '';
            cmdNames.push(`${command.name}${aliasStr}`);
        }
        docs += cmdNames.join(', ') + '\n';
        
    } else if (mode === 'compact') {
        // Compact: command + short description + params inline
        docs = `\n*CMDS - syntax: !cmd or !cmd("arg",num). `;
        if (showAliases) docs += `[alias]=shortcut. `;
        docs += `*\n`;
        
        for (let command of commandList) {
            if (agent.blocked_actions.includes(command.name)) continue;
            
            const alias = getCommandAlias(command.name);
            const aliasStr = (showAliases && alias) ? `[${alias}]` : '';
            
            // Shorten description to first sentence or 60 chars
            let shortDesc = command.description.split('.')[0];
            if (shortDesc.length > 60) shortDesc = shortDesc.substring(0, 57) + '...';
            
            // Inline params
            let paramStr = '';
            if (command.params) {
                const params = Object.entries(command.params).map(([name, p]) => {
                    const type = typeTranslations[p.type] || p.type;
                    return `${name}:${type}`;
                });
                paramStr = params.length > 0 ? `(${params.join(',')})` : '';
            }
            
            docs += `${command.name}${aliasStr}${paramStr}: ${shortDesc}\n`;
        }
        
    } else {
        // Full: original format with aliases
        docs = `\n*COMMAND DOCS\nUse commands with syntax: !commandName or !commandName("arg1", 1.2, ...).`;
        if (showAliases) docs += ` Short aliases shown in [brackets].`;
        docs += `\nUse double quotes for strings. One command per response.\n`;
        
        for (let command of commandList) {
            if (agent.blocked_actions.includes(command.name)) continue;
            
            const alias = getCommandAlias(command.name);
            const aliasStr = (showAliases && alias) ? ` [${alias}]` : '';
            
            docs += `${command.name}${aliasStr}: ${command.description}\n`;
            if (command.params) {
                docs += 'Params:\n';
                for (let param in command.params) {
                    const type = typeTranslationsFull[command.params[param].type] || command.params[param].type;
                    docs += `  ${param}: (${type}) ${command.params[param].description}\n`;
                }
            }
        }
    }
    
    return docs + '*\n';
}
