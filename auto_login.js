/**
 * Auto-login script for Mindcraft
 * Checks the server every 5 minutes for players, then logs in andy when detected.
 * Once logged in, andy stays connected for long-term goals.
 */

import * as Mindcraft from './src/mindcraft/mindcraft.js';
import { getPlayerCount } from './src/mindcraft/mcserver.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

// Parse arguments
function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('interval', {
            type: 'number',
            describe: 'Check interval in minutes (default: from settings.js)'
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
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
    } else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// Environment variable overrides
if (process.env.MINECRAFT_PORT) {
    settings.port = parseInt(process.env.MINECRAFT_PORT);
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
if (process.env.CHECK_INTERVAL) {
    args.interval = parseInt(process.env.CHECK_INTERVAL);
}

// Use args.interval if provided, otherwise use settings, default to 5 minutes
const checkInterval = args.interval || settings.auto_login_interval || 5;
const CHECK_INTERVAL_MS = checkInterval * 60 * 1000; // Convert minutes to ms
let agentStarted = false;
let mindserverInitialized = false;

async function checkAndLogin() {
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
        console.log(`[Auto-Login] Players detected! Starting andy...`);

        // Initialize MindServer if not already done
        if (!mindserverInitialized) {
            await Mindcraft.init(
                settings.mindserver_host_public || false,
                settings.mindserver_port,
                settings.auto_open_ui
            );
            mindserverInitialized = true;
        }

        // Start all agents from profiles
        for (let profile of settings.profiles) {
            const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
            settings.profile = profile_json;
            await Mindcraft.createAgent(settings);
        }

        agentStarted = true;
        console.log(`[Auto-Login] Andy is now online and will stay connected for long-term goals.`);
        return true;
    }

    console.log(`[Auto-Login] No players online. Will check again in ${checkInterval} minutes.`);
    return false;
}

async function main() {
    console.log(`[Auto-Login] Starting auto-login monitor...`);
    console.log(`[Auto-Login] Check interval: ${checkInterval} minutes`);
    console.log(`[Auto-Login] Server: ${settings.host || 'localhost'}:${settings.port || 55916}`);
    console.log(`[Auto-Login] Profiles: ${settings.profiles.join(', ')}`);
    console.log('');

    // Initial check
    const started = await checkAndLogin();

    if (started) {
        console.log(`[Auto-Login] Agent started. Monitoring complete.`);
        return;
    }

    // Set up polling interval
    const intervalId = setInterval(async () => {
        if (agentStarted) {
            clearInterval(intervalId);
            return;
        }

        const started = await checkAndLogin();
        if (started) {
            clearInterval(intervalId);
        }
    }, CHECK_INTERVAL_MS);

    console.log(`[Auto-Login] Waiting for players... (checking every ${checkInterval} minutes)`);
}

main().catch(err => {
    console.error('[Auto-Login] Error:', err);
    process.exit(1);
});
