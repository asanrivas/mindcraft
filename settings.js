const settings = {
    minecraft_version: "auto", // Server protocol is 775 (MC 26.1) but its ping name says "Purpur 1.21.11". mineflayer's testedVersions gate stops at 1.21.11 - the packages below it (minecraft-protocol, minecraft-data, prismarine-chunk, prismarine-registry) already support 26.1 - so we connect as 1.21.11 until that gate is lifted. See CLAUDE.md "Movement".
    mc_client: "mineflayer", // "mineflayer" (default) or "native" - see src/mc/index.js and docs/CLIENT_REPLACEMENT.md. Do not set "native" yet - it isn't built.
    host: "localhost", // or "localhost", "your.ip.address.here"
    port: 25565, // set to -1 to automatically scan for open ports
    auth: "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    mindserver_port: 8080,
    mindserver_host_public: true, // false = localhost only, true = accessible on LAN
    auto_open_ui: false, // opens UI in browser on startup (disabled - no display)

    base_profile: "assistant", // survival, assistant, creative, or god_mode
    profiles: [
        "./andy.json",
        // bob is back in this list ON PURPOSE (2026-08-26). He used to run in his own
        // service (mindcraft-bob.service, MindServer :8082) so andy restarts could not
        // kill his long builds - that cost is real and we accepted it, because two
        // MindServers meant the bots could not see each other AT ALL:
        //
        //   serverProxy.agents only ever holds the agents of ITS OWN MindServer, so
        //   agents.length was 1 on both sides. convoManager.isOtherAgent('bob') was
        //   false, sendToBot bailed with "tried to send bot message to non-bot bob",
        //   and - worse - agent.js's smart public-chat filter is gated on
        //   getNumOtherAgents() > 0, so BOTH bots fell through to the
        //   "Single agent mode - respond to all public chat" branch and treated the
        //   other as an ordinary player. Andy ran a full LLM turn on 47 of bob's chat
        //   lines. What stopped a runaway loop was bob's only_chat_with list, not any
        //   safeguard in the code.
        //
        // One MindServer fixes both halves: the filter activates, and respondFunc's
        // `if (convoManager.isOtherAgent(username))` branch now ignores the other bot's
        // public chat outright, so bot-to-bot traffic goes over the socket protocol
        // that actually has turn-taking brakes.
        //
        // Viewer ports do not collide: mindcraft.js does `3000 + agentIndex`, so andy
        // gets 3000 and bob 3001 within one process.
        //
        // DISABLED 2026-08-26 to stop token burn. Bob was in a !stay(30) self-prompt loop -
        // 1003 turns, one model round-trip every ~33s, producing nothing. Re-enable by
        // uncommenting; everything above still holds and he will re-register with andy's
        // MindServer automatically. NOTE: with him commented out andy is a single agent
        // again, so getNumOtherAgents() is 0 and the smart public-chat filter goes back to
        // "respond to all public chat" - that only matters if a second bot returns.
        // "./bob.json",
        // "./rosetta.json", // Letta-powered agent with persistent memory (requires ~/letta running)
        // "./profiles/andy-4-reasoning.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    load_memory: true, // load memory from previous session
    init_message: "You just (re)connected. Check your MEMORY for an unfinished task: if there is one, resume it right now with !goal(\"<the task>\") instead of greeting. Otherwise greet briefly with your name.", // sends to all on spawn
    only_chat_with: [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    speak: false,
    // allows all bots to speak through text-to-speech.
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech.
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    chat_ingame: true, // bot responses are shown in minecraft chat
    language: "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    render_bot_view: true, // show bot's view in browser at localhost:3000, 3001...
    // true = the bot's own eyes (what !vision wants). false = a third-person orbit camera,
    // which is what tools/timelapse.mjs needs: first person disposes the OrbitControls it
    // drives to park the camera overhead. Changing this needs a bot restart.
    viewer_first_person: false,

    allow_insecure_coding: true, // allows newAction command and model can write/run code on your computer. enable at own risk
    allow_vision: true, // allows vision model to interpret screenshots as inputs
    // Pruned to cut command-doc tokens and reduce tool confusion on a small model.
    // Blueprint commands are dead without a loaded task; !help re-emits the entire doc
    // block into history.
    // !startConversation / !endConversation were blocked because they "need a second bot".
    // There IS a second bot now that andy and bob share a MindServer (see profiles above),
    // so they are unblocked - they are the ONLY way to reach the turn-taking protocol in
    // conversation.js (the 30s response monitor, the "I'm talking to someone else"
    // rejection, endConversation). Re-block them if the two start burning tokens on chatter.
    blocked_actions: ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel",
                      "!help",
                      // !fill and !serverFill take DIFFERENT argument orders; exposing both
                      // reliably confuses a 9B model (it corrupted its own memory over it).
                      // !serverFill is also far more reliable - !fill managed 3/9 blocks on
                      // flat ground. Keep exactly one fill command visible.
                      "!fill",
                      // !goToCoordinates is mineflayer-pathfinder, which cannot move this bot.
                      // Measured 2026-08-26: a 14-block walk on flat ground at constant Y hung
                      // for 6+ hours, position unchanged to eight decimals across 24 checks,
                      // CPU climbing 53% -> 77% the whole time. It never returned on its own.
                      // !navTo and !travel do the same job with our own A* planner and work.
                      // NOTE: this closes ONE entry point, not the bug. !goToPlayer and
                      // !followPlayer still drive through pathfinder and can hang the same way.
                      "!goToCoordinates"],

    // Hidden from the model's command docs, but STILL CALLABLE from chat - unlike
    // blocked_actions, which calls blacklistCommands() and deletes the command from
    // commandMap for everyone. These are measurement harnesses a person drives by hand
    // (CLAUDE.md documents !swimProbe and !creativeIdSweep as exactly that). The model
    // must not see them: each burns a whole action slot producing numbers it cannot act
    // on, and !climbBankTest rendered in the compact docs as "Debug: repeatedly attempt
    // swim" - which reads like an ordinary swim command.
    hidden_actions: ["!climbBankTest", "!buildFooting", "!swimProbe", "!creativeIdSweep",
                     // !goToSurface is skills.goToSurface -> goToPosition -> bot.pathfinder,
                     // the same executor !goToCoordinates was blocked for, and it is registered
                     // with runAsAction(fn) i.e. timeout -1. A hang therefore pins
                     // currentActionLabel forever and NO action can ever start again. !climbOut
                     // does the same job through our own navigator. Hidden rather than blocked
                     // so it stays available by hand for comparison.
                     "!goToSurface"],
    code_timeout_mins: 10, // minutes code is allowed to run. -1 for no timeout (leaves runaway generated code unbounded)
    relevant_docs_count: "auto", // "auto" scales with context window; or a number, -1 for all

    max_messages: "auto", // "auto" scales with context window; or a number
    num_examples: "auto", // "auto" scales with context window; or a number
    max_commands: -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    show_command_syntax: "full", // "full", "shortened", or "none"
    narrate_behavior: true, // chat simple automatic actions ('Picking up item!')

    // Context auto-scaling: limits below marked "auto" are derived from the model's real
    // context window, probed from the server at startup (llama.cpp reports the runtime -c
    // value). Set auto_scale_context: false to use literal values everywhere, or set
    // context_limit to declare the window when the server does not report one.
    auto_scale_context: true,
    context_limit: 32768, // upper bound on context used; also the fallback if unprobeable

    // Token optimization settings
    command_docs_mode: "compact", // "full", "compact", or "minimal" - reduces command doc tokens
    include_inventory: true, // include inventory in prompt (set false to save tokens)
    include_stats: true, // include stats/position in prompt
    include_nearby_blocks: true, // include nearby blocks in prompt
    use_command_aliases: true, // allow short aliases like !pic for !putInChest
    chat_bot_messages: true, // publicly chat messages to other bots

    spawn_timeout: 60, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    block_place_delay: 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    log_all_prompts: true, // log ALL prompts to file

    // Auto-login settings
    // Enabled 2026-08-26: only run andy while a human is on the server, so he stops burning
    // model calls into an empty world. main.js polls the server ping every auto_login_interval
    // minutes; on `online > 0` it starts the agents, and when they all exit it loops straight
    // back to polling. The two settings below are HALVES OF ONE FEATURE - auto_login gets him
    // back on, idle_disconnect_timeout is the only thing that ever gets him off.
    auto_login: true, // wait for players before logging in (or use --auto_login flag)
    auto_login_interval: 5, // minutes between server checks for players

    // Idle disconnect settings
    // GOTCHA: the watchdog (agent.js ~line 813) requires ALL THREE of
    //     !hasActiveGoal && !isExecutingAction && timeSincePlayerInteraction > timeout
    // and `hasActiveGoal` is `self_prompter.isActive()`. Andy holds a persistent user-authored
    // goal ("mine minerals below the base..."), so while that goal is set he will NEVER idle
    // out and auto_login can never recycle him. Clear it with !endGoal if you want him to
    // actually go offline between sessions.
    idle_disconnect_timeout: 10, // minutes of idle time before disconnecting (0 = disabled)
};

export default settings;
