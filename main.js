import * as Mindcraft from './src/mindcraft/mindcraft.js';
import { getPlayerCount } from './src/mindcraft/mcserver.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

let mindserverInitialized = false;

// Add timestamps to all console output
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

console.log = (...args) => originalLog(`[${getTimestamp()}]`, ...args);
console.error = (...args) => originalError(`[${getTimestamp()}] ERROR:`, ...args);
console.warn = (...args) => originalWarn(`[${getTimestamp()}] WARN:`, ...args);

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .option('auto_login', {
            type: 'boolean',
            describe: 'Wait for players before logging in',
            default: false
        })
        .option('interval', {
            type: 'number',
            describe: 'Auto-login check interval in minutes'
        })
        .help()
        .alias('help', 'h')
        .parse();
}
const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        settings.task = tasks[args.task_id];
        settings.task.task_id = args.task_id;
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = process.env.MINECRAFT_PORT;
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = process.env.MINDSERVER_PORT;
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) {
    settings.allow_insecure_coding = true;
}
if (process.env.BLOCKED_ACTIONS) {
    settings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
}
if (process.env.MAX_MESSAGES) {
    settings.max_messages = process.env.MAX_MESSAGES;
}
if (process.env.NUM_EXAMPLES) {
    settings.num_examples = process.env.NUM_EXAMPLES;
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL;
}
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}
if (process.env.AUTO_LOGIN) {
    args.auto_login = process.env.AUTO_LOGIN === 'true';
}
if (process.env.CHECK_INTERVAL) {
    args.interval = parseInt(process.env.CHECK_INTERVAL);
}

// Auto-login functionality
const checkInterval = args.interval || settings.auto_login_interval || 5;
const CHECK_INTERVAL_MS = checkInterval * 60 * 1000;

async function checkForPlayers() {
    const host = settings.host || 'localhost';
    const port = settings.port || 55916;

    console.log(`[Auto-Login] Checking server ${host}:${port} for players...`);

    const playerInfo = await getPlayerCount(host, port);

    if (!playerInfo) {
        console.log(`[Auto-Login] Server not reachable. Will retry in ${checkInterval} minutes.`);
        return false;
    }

    console.log(`[Auto-Login] Server status: ${playerInfo.online}/${playerInfo.max} players online`);

    if (playerInfo.sample && playerInfo.sample.length > 0) {
        const names = playerInfo.sample.map(p => p.name).join(', ');
        console.log(`[Auto-Login] Players: ${names}`);
    }

    if (playerInfo.online > 0) {
        console.log(`[Auto-Login] Players detected! Starting agents...`);
        return true;
    }

    console.log(`[Auto-Login] No players online. Will check again in ${checkInterval} minutes.`);
    return false;
}

async function waitForPlayers() {
    // Initial check
    if (await checkForPlayers()) {
        return;
    }

    // Poll until players found
    return new Promise((resolve) => {
        const intervalId = setInterval(async () => {
            if (await checkForPlayers()) {
                clearInterval(intervalId);
                resolve();
            }
        }, CHECK_INTERVAL_MS);

        console.log(`[Auto-Login] Waiting for players... (checking every ${checkInterval} minutes)`);
    });
}

async function startAgents() {
    // Only initialize MindServer once
    if (!mindserverInitialized) {
        await Mindcraft.init(settings.mindserver_host_public || false, settings.mindserver_port, settings.auto_open_ui);
        mindserverInitialized = true;
    }

    const exitPromises = [];

    for (let i = 0; i < settings.profiles.length; i++) {
        const profile = settings.profiles[i];
        const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
        settings.profile = profile_json;
        await Mindcraft.createAgent(settings);

        // Set up exit callback to detect when agent disconnects
        const agentProcess = Mindcraft.getAgentProcess(profile_json.name);
        if (agentProcess) {
            const exitPromise = new Promise(resolve => {
                agentProcess.onExit((code, signal) => {
                    console.log(`[Auto-Login] Agent ${profile_json.name} exited cleanly (idle disconnect)`);
                    resolve();
                });
            });
            exitPromises.push(exitPromise);
        }

        // Add delay between agents to allow spawn before next connection
        // Need longer delay because createAgent() returns before bot spawns
        if (i < settings.profiles.length - 1) {
            console.log(`[Startup] Waiting 15s before starting next agent...`);
            await new Promise(resolve => setTimeout(resolve, 15000));
        }
    }

    // Return a promise that resolves when all agents exit cleanly
    return Promise.all(exitPromises);
}

(async () => {
    const autoLoginEnabled = args.auto_login || settings.auto_login;

    if (autoLoginEnabled) {
        console.log(`[Auto-Login] Mode enabled. Check interval: ${checkInterval} minutes`);
        console.log(`[Auto-Login] Server: ${settings.host || 'localhost'}:${settings.port || 55916}`);
        console.log(`[Auto-Login] Profiles: ${settings.profiles.join(', ')}`);
        console.log('');

        // Continuous loop: wait for players -> start agents -> wait for exit -> repeat
        while (true) {
            await waitForPlayers();
            await startAgents();
            console.log(`[Auto-Login] All agents disconnected. Returning to player detection mode...`);
        }
    } else {
        // Non-auto-login mode: just start agents once
        await startAgents();
    }
})();