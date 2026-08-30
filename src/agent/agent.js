import { History } from './history.js';
import { getBudget, applyContextBudget } from '../utils/context_budget.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { difficultyName, installDifficultyField } from './difficulty.js';
import { reconnectDirective, standDownIsCurrent, isStandDown } from './resume_policy.js';
import { deixisVerdict } from './deixis.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, takesOverBot, blacklistCommands } from './commands/index.js';
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
import { JumpAssist } from './library/jump_assist.js';
import { GroundTruth } from './library/ground_truth.js';
import * as swim from './library/swim.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat } from './connection_handler.js';
import { loadNamedChestsFromFile, setNamedChestsSaveCallback } from './library/skills.js';
import { IdleBehavior } from './idle_behavior.js';

/**
 * How far the server must move the bot in ONE position packet to count as a teleport.
 *
 * This is the load-bearing constant of teleport detection, not a tuning knob. `forcedMove`
 * fires on every server position packet - login, respawn, and the routine anti-cheat
 * corrections this server sends constantly - and only distance separates a correction from a
 * teleport. 8 blocks is far above any correction observed here and far below any deliberate
 * teleport (the smallest real one in the logs is a `/tp andy asanrivas` across a valley).
 */
const TELEPORT_MIN_BLOCKS = 8;
/** Login sends a position packet before the bot has done anything. Ignore that one. */
const TELEPORT_SPAWN_GRACE_MS = 5000;
/** Being moved several times in a row is ONE event to the model, not five. */
const TELEPORT_REPORT_COOLDOWN_MS = 3000;

/**
 * Should this position jump be reported to the model as a teleport?
 *
 * Pure, and exported, because the live path can only ever exercise whichever branch the world
 * happens to take - and the branches that matter most are the ones that must NOT fire.
 *
 * @returns {'report'|'below-threshold'|'spawn'|'expected'|'cheat'|'coalesced'}
 */
export function teleportVerdict({ jumped, sinceSpawnMs, expected = false, cheatOn = false,
                                  sinceLastReportMs = Infinity }) {
    if (!(jumped >= TELEPORT_MIN_BLOCKS)) return 'below-threshold';
    if (sinceSpawnMs < TELEPORT_SPAWN_GRACE_MS) return 'spawn';
    if (expected) return 'expected';
    if (cheatOn) return 'cheat';
    if (sinceLastReportMs < TELEPORT_REPORT_COOLDOWN_MS) return 'coalesced';
    return 'report';
}

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        // The last thing a HUMAN said, restored from memory.json below. Outranks `$MEMORY` on
        // reconnect: a stored task must never outlive a spoken "stop".
        this.last_directive = null;
        this.count_id = count_id;
        // Set before any packet can arrive: an unset value would make the grace-window check
        // NaN, which compares false, and the login teleport would be reported as an operator
        // moving the bot.
        this._spawned_at = Date.now();

        // Initialize components with more detailed error handling
        this.actions = new ActionManager(this);

        // MUST run before `new Prompter`, which constructs the model providers. LlamaCpp copies
        // its params at construction (`this.params = { ...params }`), so a max_tokens still set
        // to "auto" at that moment is frozen into the provider and reaches llama-server as the
        // STRING "auto" - every request then 400s with `Field 'max_tokens': type must be number,
        // but is string`, and the agent silently runs on its backup model forever. This used to
        // sit after the Prompter (and after the name check), which is why the local model could
        // not serve as the primary at all.
        await applyContextBudget(settings, settings.profile);

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
        // Hidden, not blocked: kept in commandMap so a person can still call them from chat,
        // but omitted from the docs the model sees. See settings.hidden_actions.
        this.hidden_actions = settings.hidden_actions || [];

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        // IMMEDIATELY, in the same synchronous block as the bot's construction - see the method.
        this._wireDifficulty();

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
            // Stamped so teleport detection can ignore the position packet that arrives with
            // the login itself - see TELEPORT_SPAWN_GRACE_MS.
            this._spawned_at = Date.now();
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
                if (settings.assists?.auto_jump !== false) this.auto_jump.enable();
                // Exposed so JumpAssist and the navigator can coordinate with it - AutoJump has
                // to stand down while a deliberate jump is in flight, or it fights for the key.
                this.bot.autoJump = this.auto_jump;

                // Owns the jump key while the bot is wet (jump is buoyancy in water, not
                // propulsion) and restores the sprint-swim speed the physics library omits.
                // Exposed on the bot so swim.js can reach it without an import cycle.
                this.swim_assist = new SwimAssist(this.bot);
                if (settings.assists?.swim_assist !== false) this.swim_assist.enable();
                this.bot.swimAssist = this.swim_assist;

                // Deliberate jumps - gaps and standstill steps. `onGround` reads false here, so
                // the engine never fires a jump at all (measured: apex 0.00 against vanilla's
                // 1.25); JumpAssist asserts the flag for the take-off tick and sustains the
                // run-up. Carries its own forcedMove valve, so a server that objects degrades
                // the bot to bridging rather than getting it kicked.
                this.jump_assist = new JumpAssist(this.bot);
                if (settings.assists?.jump_assist !== false) this.jump_assist.enable();
                this.bot.jumpAssist = this.jump_assist;

                // THE ROOT CAUSE, not another workaround. prismarine-physics derives `onGround`
                // from whether a downward velocity survived into the move, and this server's
                // position corrections zero that velocity - so a bot standing flush on stone is
                // reported airborne, and the engine then withholds BOTH jumping and ground
                // acceleration. GroundTruth recomputes the flag from the world. Installed AFTER
                // JumpAssist so that when both fire on one tick the cheaper, always-on answer
                // is already in place.
                this.ground_truth = new GroundTruth(this.bot);
                if (settings.assists?.ground_truth !== false) this.ground_truth.enable();
                this.bot.groundTruth = this.ground_truth;

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

        // Decide what "reconnected" means from STATE, not by asking the model to work it out
        // from `$MEMORY`. `settings.init_message` used to say "check your MEMORY for an
        // unfinished task and resume it", which is an invitation to invent one out of location
        // notes - and no amount of a person saying "stop" beforehand could outvote it.
        const goalRecord = this.history.store?.get?.('goal') ?? null;
        const standDown = standDownIsCurrent({
            lastDirective: this.last_directive,
            goalUpdated: goalRecord?.updated ?? null,
        });
        if (init_message) {
            init_message = reconnectDirective({
                goal: this.history.store?.goal?.() ?? null,
                selfPrompt: save_data?.self_prompt ?? null,
                lastDirective: this.last_directive,
                goalUpdated: goalRecord?.updated ?? null,
            });
            console.log(`[${this.name}] reconnect: ${init_message}`);
        }

        // THE AGENT RESTARTS ITS OWN LOOP. It must not delegate that to the model.
        //
        // The reconnect message used to end "resume exactly that with !goal(...)", and for a
        // USER-AUTHORED goal that instruction cannot succeed: `!goal` from the model is refused
        // outright - `Kept the existing goal: ... (user goal)` - and the refusal path never
        // reaches `self_prompter.start`. Caught by the control half of the reconnect test: the
        // model obeyed, emitted `!goal("count to ten out loud")`, and the loop never started.
        // The one case where resuming matters most is exactly the case where asking the model
        // to do it cannot work.
        //
        // `save_data.self_prompt` is not a reliable signal on its own either. It is written as
        // `isStopped() ? null : prompt`, so any save taken while the loop happens to be down -
        // and `!endGoal` forces one - persists null while the goal RECORD lives on. So fall
        // back to the goal record, which is the durable statement of what a person asked for.
        const resumeTask = (!standDown)
            ? (save_data?.self_prompt || this.history.store?.goal?.() || null)
            : null;

        if (resumeTask) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            if (save_data?.self_prompt) {
                await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
            } else {
                console.log(`[${this.name}] reconnect: restarting the self-prompt loop from the `
                    + `goal record ("${resumeTask}") - no live loop was persisted.`);
                this.self_prompter.start(resumeTask);
            }
        }
        else if (save_data?.self_prompt && standDown) {
            // THE LOOP IS THE TEETH. Telling the model not to resume is not enough: `!stop`
            // leaves self-prompting running by design ("Agent stopped. Self-prompting still
            // active."), the loop is persisted, and `handleLoad` restarts it on the next boot -
            // which is the bot carrying on with the old task no matter what the prompt says.
            // The goal RECORD is left alone: deleting a user-authored goal is `!endGoal`'s
            // authority, not something a fuzzy text match should do behind the user's back.
            console.log(`[${this.name}] reconnect: not restarting the self-prompt loop `
                + `("${this.last_directive?.text}" from ${this.last_directive?.from} stands). `
                + `Goal record left intact; say !goal to start again.`);
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

        // REMEMBER THE LAST THING A PERSON SAID, and persist it. On reconnect it outranks
        // anything in memory - see resume_policy.js for the bug that made this necessary.
        // Only humans: a system prompt is our own words coming back, and another bot's chatter
        // is not an instruction.
        if (!self_prompt && !from_other_bot) {
            this.last_directive = { from: source, text: String(message).trim(), at: Date.now() };
            // Persist a stand-down IMMEDIATELY. The ordinary save at the bottom of this method
            // is never reached for a message that is a command - `!stop` returns from the
            // forced-command branch above it - and "!stop, then restart" is precisely the case
            // this whole mechanism exists for. Rare enough that the extra write costs nothing.
            if (isStandDown(this.last_directive.text)) this.history.save();
        }

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
                // Authorship, recorded at the only point where it is still known. By the time a
                // command's perform() runs, the text alone cannot say whether a person typed it
                // or the model emitted it - and memory_store needs that to protect a user's goal
                // from being overwritten by one the model invented. Inferring it later from
                // self_prompter.isActive() is wrong: the model issues !goal from an ordinary
                // turn, before the loop starts, and that read as "user".
                this.command_author = 'user';
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

        // Resolve "here". A player message carries no coordinates, and the model only sees
        // the bot's OWN position - so "build hut here" from 100 blocks away got coordinates
        // invented near the bot (and then a 2.3M-block garbled !fill, 2026-08-29). When the
        // message points at the speaker, hand the model their real position; when their
        // entity is not visible, say so explicitly rather than let it guess. Humans only:
        // system text is our own words, and another bot's "here" is its own problem.
        if (!self_prompt && !from_other_bot) {
            const speakerPos = this.bot?.players?.[source]?.entity?.position ?? null;
            const note = deixisVerdict(source, message, speakerPos);
            if (note) await this.history.add('system', note);
        }
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

                // A command a PERSON asked for outranks one the model thought of. Without this,
                // any long user-issued action is cancelled by the model's very next turn:
                // observed live, a marathon the user had just started was killed six seconds in
                // by `!travel("west", 500)` left over from a stale conversational thread, and
                // the run silently became a walk in the opposite direction.
                //
                // Only ACTIONS are blocked - queries (!stats, !inventory) are free, so the model
                // can still see what is going on and answer. Modes are untouched: drowning and
                // self-defence still interrupt everything, including this.
                if (takesOverBot(command_name) && this.actions.isUserOwned()) {
                    const busy = `Refused ${command_name}: '${this.actions.currentActionLabel}' `
                        + `was started by a user and is still running. Wait for it to finish, or `
                        + `ask them to stop it - you cannot cancel it yourself.`;
                    console.log(`[${this.name}] ${busy}`);
                    this.history.add('system', busy);
                    break;
                }

                this.command_author = 'model';   // see the note on the user path above
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

    /**
     * Suppress teleport reporting for a while, because we are about to cause one ourselves.
     *
     * `!serverTp` and a respawn both move the bot a long way on purpose; reporting those as
     * "somebody teleported you" and cancelling the action that asked for it would break the
     * rescue hatch and spam the model after every death.
     */
    expectTeleport(ms = 4000, reason = 'expected') {
        this._expected_teleport_until = Date.now() + ms;
        this._expected_teleport_reason = reason;
    }

    /**
     * Notice when the SERVER moves the bot, and tell the model.
     *
     * Until now nothing consumed this at all: mineflayer emits `forcedMove` from its server
     * position-packet handler (`physics.js`), which is exactly what `/tp` produces, but the only
     * listeners were the swim probe and SwimAssist's anti-cheat valve. So an operator could
     * `/tp andy asanrivas` and the bot would carry on toward wherever it had been walking - the
     * in-flight travel leg keeps its original target, so it immediately walks back the way it
     * came. Observed live: `/tp andy asanrivas` at 00:22:57 and again at 00:36:28, each time
     * followed by the bot heading straight back for a base 7000 blocks away.
     *
     * THE THRESHOLD IS THE WHOLE DESIGN. `forcedMove` fires on EVERY server position packet -
     * login, respawn, and the routine anti-cheat corrections this server sends constantly (see
     * `swim_assist.js`, whose valve was tripped during spawn by exactly this mistake). A
     * correction nudges the bot; a teleport moves it far in a single packet. Only distance
     * separates them.
     */
    /**
     * Repair mineflayer's difficulty reporting, before anything can read it.
     *
     * `lib/plugins/game.js` assigns the field with `if (packet.difficulty)` - and PEACEFUL IS
     * ZERO, which is falsy. So on a Peaceful world the login packet never sets it and
     * `bot.game.difficulty` reads `undefined` forever. Every guard written against it then fails
     * OPEN: `mode:night_safety`'s Peaceful check saw `undefined`, concluded the world was
     * dangerous, and dug the bot in for the night - cancelling a user's marathon 12 seconds
     * after it started.
     *
     * **This must be wired at CONSTRUCTION, not in `startEvents()`.** It was, and that is why
     * the first fix did not work: `startEvents()` runs from the `spawn` handler, by which time
     * the `login` and `difficulty` packets have long since been dispatched, so the listener
     * could never fire. The mode kept digging in on a Peaceful world, and the only thing that
     * ever set the field was a human running `/difficulty` afterwards. Registered here, in the
     * same synchronous block as `initBot`, no packet can have been handled yet.
     */
    _wireDifficulty() {
        // Both rules live in `difficulty.js`, with the measurements behind them, and are unit
        // tested there - a live check can only ever exercise whichever world you happen to be on.
        const setDifficulty = (packet) => {
            const name = difficultyName(packet?.difficulty);
            if (!name || !this.bot.game) return;
            installDifficultyField(this.bot.game);
            this.bot.game.difficulty = name;
        };
        this.bot._client.on('login', setDifficulty);
        this.bot._client.on('difficulty', setDifficulty);
    }

    _wireTeleportDetection() {
        // Sampled every physics tick, so at forcedMove time it holds the position from at most
        // ~50ms ago - under a block of ordinary movement, and far below the threshold.
        let lastPos = null;
        this.bot.on('physicsTick', () => {
            if (this.bot.entity?.position) lastPos = this.bot.entity.position.clone();
        });

        this.bot.on('forcedMove', () => {
            const now = this.bot.entity?.position;
            if (!now || !lastPos) { lastPos = now?.clone() ?? null; return; }

            const jumped = lastPos.distanceTo(now);
            const from = lastPos.clone();
            lastPos = now.clone();

            const verdict = teleportVerdict({
                jumped,
                sinceSpawnMs: Date.now() - this._spawned_at,
                expected: Date.now() < (this._expected_teleport_until ?? 0),
                // With cheats on, teleporting is a normal way to travel and not worth narrating.
                cheatOn: !!(this.bot.modes?.exists('cheat') && this.bot.modes.isOn('cheat')),
                sinceLastReportMs: Date.now() - (this._last_teleport_report ?? -Infinity),
            });
            if (verdict !== 'report') {
                if (verdict !== 'below-threshold') {
                    console.log(`[${this.name}] teleport ignored (${verdict}`
                        + `${verdict === 'expected' ? `: ${this._expected_teleport_reason}` : ''}), `
                        + `${jumped.toFixed(0)} blocks`);
                }
                return;
            }
            this._last_teleport_report = Date.now();

            const fmt = (p) => `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`;
            const interrupted = this.actions.currentActionLabel;
            console.log(`[${this.name}] TELEPORTED ${jumped.toFixed(0)} blocks `
                + `${fmt(from)} -> ${fmt(now)}${interrupted ? ` during ${interrupted}` : ''}`);

            // Cancel what was running, AND its resume. Cancelling the action alone is not
            // enough - the idle handler replays the stored resume, so the bot would walk back
            // to the old target anyway, which is the whole behaviour this is here to stop.
            // A destination chosen before the move is simply no longer the destination.
            if (interrupted) {
                this.actions.cancelResume();
                this.actions.stop();
            }

            this.handleMessage('system',
                `(AUTO MESSAGE) You were teleported ${jumped.toFixed(0)} blocks by the server, `
                + `from ${fmt(from)} to ${fmt(now)}. `
                + (interrupted
                    ? `Your action '${interrupted}' was cancelled, because its destination was `
                      + `chosen before you were moved. `
                    : '')
                + 'Do not walk back unless someone asks you to. Check where you are now and '
                + 'wait for instructions.');
        });
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
            // A respawn is a position jump, and mineflayer emits a DELAYED forcedMove 1.5s
            // later for it (physics.js). Do not report that as somebody teleporting the bot.
            this.expectTeleport(6000, 'respawn');
        });

        this._wireTeleportDetection();
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
            // Not while wet. SwimAssist owns the jump key whenever the bot is in water - that
            // key is its buoyancy, not a movement input - and clearing it here drops the bot
            // off the surface until SwimAssist's next tick notices. `self_preservation`'s idle
            // branch already carries this guard; this one was missed, and it fires after EVERY
            // action completes, which is most of the time a floating bot is idle at all.
            if (!swim.inWater(this.bot)) this.bot.clearControlStates();
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
