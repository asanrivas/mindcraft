const settings = {
    minecraft_version: "auto", // Server protocol is 775 (MC 26.1) but its ping name says "Purpur 1.21.11". mineflayer/prismarine-chunk have no 26.x support yet, so we connect as 1.21.11 - see PHYSICS NOTE in docs.
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

    allow_insecure_coding: true, // allows newAction command and model can write/run code on your computer. enable at own risk
    allow_vision: true, // allows vision model to interpret screenshots as inputs
    // Pruned to cut command-doc tokens and reduce tool confusion on a small model.
    // Blueprint commands are dead without a loaded task; conversation commands need a
    // second bot; !help re-emits the entire doc block into history.
    blocked_actions: ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel",
                      "!startConversation", "!endConversation", "!help",
                      // !fill and !serverFill take DIFFERENT argument orders; exposing both
                      // reliably confuses a 9B model (it corrupted its own memory over it).
                      // !serverFill is also far more reliable - !fill managed 3/9 blocks on
                      // flat ground. Keep exactly one fill command visible.
                      "!fill"],
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
    auto_login: false, // wait for players before logging in (or use --auto_login flag)
    auto_login_interval: 5, // minutes between server checks for players

    // Idle disconnect settings
    idle_disconnect_timeout: 0, // minutes of idle time before disconnecting (0 = disabled)
};

export default settings;
