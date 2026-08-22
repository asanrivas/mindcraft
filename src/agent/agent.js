import { History } from './history.js';
import { getBudget, applyContextBudget } from '../utils/context_budget.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { Steering } from './steering.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { AutoJump } from './library/auto_jump.js';
import { SwimAssist } from './library/swim_assist.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat } from './connection_handler.js';
import { loadNamedChestsFromFile, setNamedChestsSaveCallback } from './library/skills.js';
import { IdleBehavior } from './idle_behavior.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;

        // Initialize components with more detailed error handling
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        // Probe the model's real context window and derive every context-sensitive limit from
        // it before anything reads those limits. History in particular caches max_messages at
        // construction, so this has to happen first.
        await applyContextBudget(settings, settings.profile);

        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        // User-authored standing instructions. Loaded here, before any prompt is built, so the
        // very first reply after a restart is already steered.
        this.steering = new Steering(this);
        this.steering.load();
        this.self_prompter = new SelfPrompter(this);
        this.idle_behavior = new IdleBehavior(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }

        // Always load named chests (they persist independently of conversation memory)
        const memoryFilePath = `./bots/${this.name}/memory.json`;
        loadNamedChestsFromFile(memoryFilePath);
        // Set up save callback so named chest changes persist
        setNamedChestsSaveCallback(() => this.history.save());

        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        initModes(this);

        this.bot.on('error', (err) => {
            const errMsg = err.message || err.toString();

            // Ignore parse errors - they happen with some chest interactions but aren't fatal
            if (errMsg.includes('Parse error') || errMsg.includes('array size is abnormally large')) {
                return; // Handled in the other error handler
            }

            if (errMsg.includes('PartialReadError') || errMsg.includes('buffer end')) {
                console.error(`${this.name}: Protocol error detected: ${errMsg}`);
                console.error('This typically means network instability or server lag.');
                console.error('Forcing restart in 3 seconds...');
                this._forceRestart(3000);
            } else if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
                this._forceRestart(3000);
            }
        });

        // Connection watchdog - detects stuck disconnects
        this._startConnectionWatchdog();

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();

            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);

                // The pathfinder's own jump does not carry momentum on this server (see
                // auto_jump.js), leaving the bot unable to climb 1-block steps. This presses
                // jump early enough that the bot is still moving when it leaves the ground.
                this.auto_jump = new AutoJump(this.bot);
                this.auto_jump.enable();

                // Owns the jump key while the bot is wet (jump is buoyancy in water, not
                // propulsion) and restores the sprint-swim speed the physics library omits.
                // Exposed on the bot so swim.js can reach it without an import cycle.
                this.swim_assist = new SwimAssist(this.bot);
                this.swim_assist.enable();
                this.bot.swimAssist = this.swim_assist;

                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));

                console.log(`${this.name} spawned.`);
                this.clearBotLogs();

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();

                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];

        // Every inbound line arrives TWICE: respondFunc is bound to both 'whisper' and 'chat',
        // and a server /msg (which is how RCON talks to the bot) fires both events. The bot then
        // answered its own duplicated history - measured live: every RCON instruction appeared
        // twice in the conversation, the model repeated one !serverFill four times, and the
        // duplicate turns helped drive 78 "context length exceeded" retries in a day.
        //
        // Deduped here rather than by unbinding an event: 'chat' is needed for public chat and
        // 'whisper' for private, and this also absorbs any other double-delivery path.
        const recent_messages = new Map(); // "user\0text" -> timestamp
        const DUPLICATE_WINDOW_MS = 1500;

        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                const key = `${username}\0${message}`;
                const now = Date.now();
                const seen = recent_messages.get(key);
                if (seen !== undefined && now - seen < DUPLICATE_WINDOW_MS) return;
                recent_messages.set(key, now);
                if (recent_messages.size > 64) {
                    for (const [k, t] of recent_messages)
                        if (now - t > DUPLICATE_WINDOW_MS) recent_messages.delete(k);
                }

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);

        this.bot.on('chat', (username, message) => {
            // With multiple agents, use smart filtering instead of blocking all public chat
            if (serverProxy.getNumOtherAgents() > 0) {
                const lowerMsg = message.toLowerCase();
                const lowerName = this.name.toLowerCase();

                // 1. Respond if message mentions this bot's name
                if (lowerMsg.includes(lowerName)) {
                    respondFunc(username, message);
                    return;
                }

                // 2. Respond to broadcast keywords (all bots should respond)
                const broadcastKeywords = ['everyone', 'all bots', 'all of you', 'both of you', 'you all'];
                if (broadcastKeywords.some(kw => lowerMsg.includes(kw))) {
                    respondFunc(username, message);
                    return;
                }

                // 3. Respond to important shared commands (all bots should act)
                const sharedCommands = ['go to bed', 'sleep', 'gotobed'];
                if (sharedCommands.some(cmd => lowerMsg.includes(cmd))) {
                    respondFunc(username, message);
                    return;
                }

                // 4. Respond to direct commands starting with !
                if (message.trim().startsWith('!')) {
                    respondFunc(username, message);
                    return;
                }

                // Otherwise, ignore public chat when multiple agents present
                return;
            }
            // Single agent mode - respond to all public chat
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res)
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);

        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = getBudget().behavior_log_chars;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);

                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }

            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            const errMsg = err.message || err.toString();

            // Ignore parse errors - they happen with some chest interactions but aren't fatal
            if (errMsg.includes('Parse error') || errMsg.includes('array size is abnormally large')) {
                console.warn('[Protocol] Parse error (non-fatal, ignoring):', errMsg.split('\n')[0]);
                return;
            }

            console.error('Error event!', err);
            // Check for connection-related errors
            if (errMsg.includes('ECONNRESET') ||
                errMsg.includes('ETIMEDOUT') ||
                errMsg.includes('ENOTCONN') ||
                errMsg.includes('socket hang up')) {
                console.error('[Connection] Network error detected, forcing restart...');
                this._forceRestart(2000);
            }
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            console.warn('Bot disconnected!', reason);
            // Clear watchdog interval
            if (this._watchdogInterval) {
                clearInterval(this._watchdogInterval);
            }
            // Use force restart for cleaner reconnection
            console.log('[Connection] Triggering auto-restart...');
            this._forceRestart(2000);
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            console.warn('Bot kicked!', reason);
            // Clear watchdog interval
            if (this._watchdogInterval) {
                clearInterval(this._watchdogInterval);
            }
            // Still restart on kick - server may have just restarted
            console.log('[Connection] Kicked, triggering auto-restart...');
            this._forceRestart(5000); // Wait 5 seconds before reconnecting after kick
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;

                // Store death in Mem0 if available
                if (this.prompter.chat_model?.recordDeath) {
                    this.prompter.chat_model.recordDeath(death_pos, message);
                }

                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });

        // Player join/leave events for Mem0
        this.bot.on('playerJoined', (player) => {
            if (player.username !== this.name) {
                console.log(`[Event] ${player.username} joined the game`);
                if (this.prompter.chat_model?.recordPlayerJoin) {
                    this.prompter.chat_model.recordPlayerJoin(player.username);
                }
            }
        });

        this.bot.on('playerLeft', (player) => {
            if (player.username !== this.name) {
                console.log(`[Event] ${player.username} left the game`);
                if (this.prompter.chat_model?.recordPlayerLeave) {
                    this.prompter.chat_model.recordPlayerLeave(player.username);
                }
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.idle_behavior.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }


    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        try {
            this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        } catch (e) {
            // Bot may already be disconnected
        }
        this.history.save();
        process.exit(code);
    }

    _forceRestart(delay = 0) {
        if (this._isRestarting) return; // Prevent multiple restart attempts
        this._isRestarting = true;

        console.log(`[Watchdog] Force restart scheduled in ${delay}ms`);

        setTimeout(() => {
            console.log('[Watchdog] Executing force restart...');
            try {
                this.bot.quit();
            } catch (e) {
                // Bot may already be disconnected
            }
            process.exit(1); // Exit with code 1 triggers auto-restart
        }, delay);
    }

    _startConnectionWatchdog() {
        this._lastActivity = Date.now();
        this._lastPlayerInteraction = Date.now();
        this._isRestarting = false;
        this._watchdogInterval = null;

        // Update activity timestamp on any bot event
        const updateActivity = () => {
            this._lastActivity = Date.now();
        };

        // Update player interaction timestamp on chat/whisper
        const updatePlayerInteraction = () => {
            this._lastPlayerInteraction = Date.now();
        };

        this.bot.on('move', updateActivity);
        this.bot.on('health', updateActivity);
        this.bot.on('time', updateActivity);
        this.bot.on('physicsTick', updateActivity);

        // Track player interactions separately
        this.bot.on('chat', (username) => {
            updateActivity();
            if (username !== this.name) {
                updatePlayerInteraction();
            }
        });
        this.bot.on('whisper', (username) => {
            updateActivity();
            if (username !== this.name) {
                updatePlayerInteraction();
            }
        });

        // Start watchdog after spawn
        this.bot.once('spawn', () => {
            const WATCHDOG_INTERVAL = 30000; // Check every 30 seconds
            const MAX_INACTIVE_TIME = 120000; // 2 minutes without activity = stuck
            const IDLE_DISCONNECT_TIMEOUT = (settings.idle_disconnect_timeout || 0) * 60 * 1000;

            this._watchdogInterval = setInterval(() => {
                const timeSinceActivity = Date.now() - this._lastActivity;
                const timeSincePlayerInteraction = Date.now() - this._lastPlayerInteraction;

                // Check if bot client is still connected
                const isConnected = this.bot._client &&
                                   this.bot._client.socket &&
                                   !this.bot._client.ended;

                if (!isConnected) {
                    console.warn('[Watchdog] Bot client disconnected but process still running!');
                    this._forceRestart(1000);
                    return;
                }

                if (timeSinceActivity > MAX_INACTIVE_TIME) {
                    console.warn(`[Watchdog] No activity for ${Math.round(timeSinceActivity/1000)}s - possible stuck state`);
                    console.warn('[Watchdog] Forcing restart...');
                    this._forceRestart(1000);
                    return;
                }

                // Idle disconnect check: no player interaction + no active goal
                if (IDLE_DISCONNECT_TIMEOUT > 0) {
                    const hasActiveGoal = this.self_prompter && this.self_prompter.isActive();
                    const isExecutingAction = this.actions && this.actions.executing;

                    if (!hasActiveGoal && !isExecutingAction && timeSincePlayerInteraction > IDLE_DISCONNECT_TIMEOUT) {
                        const idleMinutes = Math.round(timeSincePlayerInteraction / 60000);
                        console.log(`[Watchdog] Idle for ${idleMinutes} minutes with no goals. Disconnecting to save resources.`);
                        this._idleDisconnect();
                        return;
                    }
                }
            }, WATCHDOG_INTERVAL);

            console.log('[Watchdog] Connection watchdog started');
            if (IDLE_DISCONNECT_TIMEOUT > 0) {
                console.log(`[Watchdog] Idle disconnect enabled: ${settings.idle_disconnect_timeout} minutes`);
            }
        });
    }

    _idleDisconnect() {
        if (this._isRestarting) return;
        this._isRestarting = true;

        console.log('[Watchdog] Performing idle disconnect...');

        // Clear watchdog interval
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
        }

        // Save state before disconnecting
        this.history.add('system', 'Disconnecting due to idle timeout. Will reconnect when players are online.');
        this.history.save();

        try {
            this.bot.chat('Going idle. I\'ll be back when someone needs me!');
        } catch (e) {
            // Bot may already be disconnected
        }

        setTimeout(() => {
            try {
                this.bot.quit();
            } catch (e) {
                // Ignore
            }
            // Exit with code 0 - this tells agent_process NOT to auto-restart
            process.exit(0);
        }, 1000);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
