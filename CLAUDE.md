# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mindcraft is a multi-agent AI framework that allows LLMs to autonomously play Minecraft. It uses a distributed client-server architecture where each bot agent runs in a separate Node.js process, coordinated by a central MindServer that hosts a web UI and manages inter-agent communication.

## Development Commands

### Basic Operations
```bash
npm install                    # Install dependencies (first run downloads ~60MB Transformers.js model if local embeddings enabled)
node main.js                   # Start with default profile (andy.json)
npm start                      # Start with increased memory (4GB heap)
node main.js --profiles ./profiles/custom.json  # Use specific profile(s)
```

### Testing & Tasks
```bash
# Run a specific task
node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs

# Run with Docker (recommended for allow_insecure_coding)
docker-compose up
# or
docker run -i -t --rm -v $(pwd):/app -w /app -p 3000-3003:3000-3003 node:18 node main.js
```

### Development Tools
```bash
npx patch-package [package-name]  # Create patch for node_modules bug fixes
npx eslint .                      # Run linter (see eslint.config.js)
```

### Minecraft Setup
- Start Minecraft world, open to LAN on **port 55916** (or configure in settings.js)
- Or connect to online server by changing `host`, `port`, and `auth` in settings.js

## System Architecture

### Process Architecture

```
main.js
  ├─ MindServer (HTTP + Socket.io on port 8080)
  │  ├─ Express web UI (http://localhost:8080)
  │  └─ Agent coordination hub
  │
  └─ AgentProcess (spawns separate Node.js processes)
     └─ init_agent.js (bootstraps Agent instance)
        └─ Agent (src/agent/agent.js)
           ├─ Mineflayer bot (Minecraft connection)
           ├─ LLM client (model communication)
           ├─ ActionManager (command execution)
           ├─ ConversationManager (multi-player chat)
           ├─ History (memory management)
           └─ Modes (reactive behaviors)
```

**Key architectural principle**: Each agent runs in isolation (separate process) for graceful restarts and multi-agent coordination. All agents communicate through the central MindServer via Socket.io.

### Data Flow: User Message → Bot Action

1. **Minecraft Input** → Mineflayer `bot.on('chat')` event
2. **Conversation Queue** → `conversation.js` manages multi-player conversations
3. **Local Classification** (optional) → `local_classifier.js` attempts semantic command matching
   - High confidence match (≥0.75) → execute directly, skip LLM
   - Low confidence/no match → fallback to LLM
4. **LLM Processing** → `prompter.js` builds prompt with context placeholders
   - `$STATS`: health, hunger, position, time
   - `$INVENTORY`: current items
   - `$MEMORY`: summarized conversation history
   - `$NEARBY_BLOCKS`: important blocks with distance/direction
   - `$COMMAND_DOCS`: available commands (verbosity controlled by `command_docs_mode`)
   - `$EXAMPLES`: few-shot learning examples (selected via embeddings)
5. **Command Parsing** → `commands/index.js` extracts commands from LLM response
   - Expands aliases (`!pic` → `!putInChest`)
   - Normalizes format (handles space-separated args)
6. **Execution** → `action_manager.js` runs command with timeout/interrupt handling
   - `actions.js`: performative commands (crafting, mining, movement)
   - `queries.js`: information commands (inventory, stats, surroundings)
7. **Skills Layer** → `library/skills.js` implements actions via Mineflayer plugins
8. **Modes System** (parallel) → `modes.js` runs reactive behaviors every tick
   - `self_preservation`: drowning, burning, low health/hunger
   - `unstuck`: pathfinding timeouts, mining stuck detection
9. **Memory Management** → When context exceeds `max_messages`, summarize oldest chunk and save to `memory.json`

### Directory Structure

```
src/
├── agent/                      # Core agent logic
│   ├── agent.js               # Main Agent class (orchestration)
│   ├── conversation.js        # Multi-player conversation queue
│   ├── history.js             # Message history + memory summarization
│   ├── action_manager.js      # Execution lifecycle (timeout/interrupt)
│   ├── local_classifier.js    # Local embeddings for intent matching
│   ├── modes.js               # Reactive behaviors (self-preservation, unstuck)
│   ├── commands/
│   │   ├── index.js          # Command registry, parsing, aliases
│   │   ├── actions.js        # Performative commands (60+ commands)
│   │   └── queries.js        # Information commands (20+ commands)
│   ├── library/
│   │   ├── skills.js         # Core action implementations (400+ lines)
│   │   └── world.js          # World queries (block finding, spatial)
│   └── vision/
│       ├── camera.js         # Canvas-based screenshot rendering
│       └── vision_interpreter.js  # LLM image analysis
│
├── models/                     # LLM provider integrations
│   ├── _model_map.js          # Dynamic API loader (discovers all providers)
│   ├── prompter.js            # Prompt construction with placeholders
│   ├── local_embedding.js     # Transformers.js offline embeddings
│   └── [provider].js          # 18+ providers (gpt, claude, gemini, ollama, etc.)
│
├── mindcraft/                  # Server infrastructure
│   ├── mindcraft.js           # Orchestration (createAgent, destroyAgent)
│   ├── mindserver.js          # HTTP/Socket.io server + Web UI
│   └── mcserver.js            # Minecraft server auto-detection
│
├── process/
│   ├── agent_process.js       # Process spawning & lifecycle
│   └── init_agent.js          # Agent bootstrap script
│
└── utils/
    ├── mcdata.js              # Minecraft data (recipes, items, blocks)
    ├── examples.js            # Example selection for few-shot learning
    └── translator.js          # Language translation support

profiles/                       # Bot configurations
├── defaults/
│   ├── _default.json          # Fallback values for all profiles
│   ├── assistant.json         # Conversational helper mode
│   ├── survival.json          # Survival-focused behavior
│   └── god_mode.json          # Admin/debugging mode
└── tasks/                     # Task-specific profiles

bots/[agent_name]/             # Runtime agent state (created on first run)
├── memory.json                # Persistent memory + spatial memory bank
├── last_profile.json          # Cached profile config
├── histories/                 # Conversation history snapshots (max 20 files)
├── logs/                      # Text conversation logs
├── screenshots/               # Vision system captures
└── action-code/               # Generated code from !newAction
```

## Key Systems

### Command System

**Three-tier structure:**
1. **Command Registry** (`commands/index.js`): Maps command names to functions
2. **Actions** (`commands/actions.js`): 60+ performative commands (!collectBlocks, !craftRecipe, etc.)
3. **Queries** (`commands/queries.js`): 20+ information commands (!inventory, !stats, etc.)

**Command aliases** (when `use_command_aliases: true`):
```javascript
!pic → !putInChest      !cb → !collectBlocks     !gcp → !getCraftingPlan
!tfc → !takeFromChest   !cr → !craftRecipe       !inv → !inventory
!vc  → !viewChest       !da → !depositAll        !sur → !surroundings
!gtp → !goToPlayer      !fp → !followPlayer      !clm → !clearMemory
!ca  → !coverArea       !pt → !plantTrees        !sa  → !scanArea
```

**Token optimization** (`command_docs_mode` in settings.js):
- `"full"` (~2000 tokens): Complete descriptions + parameter details
- `"compact"` (~800 tokens): Shortened descriptions
- `"minimal"` (~200 tokens): Just command names

### Area Building Commands

Commands for large-scale block operations with **smart resume** capability:

**`!coverArea(blockType, x1, z1, x2, z2, y)`** - Cover rectangular area with blocks
```javascript
!coverArea("dirt", -10, 50, 10, 70, 64)  // Cover from (-10,50) to (10,70) at y=64
```
- Scans area first, skips already-placed blocks
- If interrupted, re-running same command continues where left off
- Progress updates every 10 blocks

**`!plantTrees(saplingType, x1, z1, x2, z2, spacing)`** - Plant saplings in grid pattern
```javascript
!plantTrees("oak", 0, 0, 64, 64, 4)  // 64x64 area, 4-block gaps between trees
```
- Auto-detects ground level (no y coordinate needed)
- Skips existing saplings and grown trees
- Only plants on valid ground (dirt, grass_block, podzol, etc.)
- Default spacing of 4 blocks allows trees to grow properly

**`!scanArea(x1, z1, x2, z2, y?)`** - Survey area and report block composition
```javascript
!scanArea(-10, -10, 10, 10)  // Scan 21x21 area at bot's height
```
Output:
```
AREA SCAN (21x21 at y=64)
Block composition:
- water: 156 (35.4%)
- grass_block: 142 (32.2%)
- dirt: 98 (22.2%)
```

**Resumable task flow**:
```
User: "plant trees in a 64x64 area"
Bot: !plantTrees("oak", 0, 0, 64, 64, 4)
Bot: Planting oak_sapling at 144 spots...
Bot: Progress: 50/144 saplings planted.
User: "stop"
Bot: Tree planting interrupted. Planted 52/144. Run same command to resume.
User: "continue planting trees"
Bot: !plantTrees("oak", 0, 0, 64, 64, 4)
Bot: Scanned grid: 52 saplings, 3 grown trees, 89 plantable spots...
Bot: Planting oak_sapling at 89 spots...
```

### Local Embeddings System (Transformers.js)

**Purpose**: Reduce API calls by matching commands locally before LLM invocation.

**Configuration** (settings.js):
```javascript
"use_local_embeddings": true,           // Enable local classification
"local_embedding_model": "Xenova/gte-small",  // 60MB model (or "Xenova/all-MiniLM-L6-v2" for better accuracy)
"local_intent_threshold": 0.75,         // Similarity threshold (higher = stricter)
"enable_simple_classifier": true,       // yes/no/stop/help detection
```

**Flow**:
```
User: "follow me"
  → LocalClassifier embeds message
  → Matches !followPlayer intent (92% similarity)
  → Extracts args: ["player_name", 3]
  → Executes directly (no LLM call)
```

**Fallback to LLM when**:
- No match found
- Low confidence (< threshold)
- Missing required arguments
- Complex requests (armor crafting, multi-step builds)
- Execution errors requiring replanning

**Implementation**:
- `src/models/local_embedding.js`: Model wrapper with LRU cache
- `src/agent/local_classifier.js`: Intent matching + argument extraction
- First run downloads model to `~/.cache/huggingface/`

### LLM Provider System

**Dynamic provider loading** (`models/_model_map.js`):
- Auto-discovers all provider classes at startup
- Each provider exports a class with static `prefix` field
- Selection logic: explicit `api` field or auto-detect from model name prefix

**Configuration** (in profile JSON like `andy.json`):
```json
{
  "model": "claude-haiku-4-5",          // Simple string
  // OR
  "model": {                            // Detailed config
    "api": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "url": "https://api.anthropic.com/v1/",
    "params": {
      "max_tokens": 8096,
      "temperature": 0.3
    }
  },
  "code_model": {...},     // For !newAction code generation
  "vision_model": {...},   // For screenshot analysis
  "embedding": {...},      // For example selection
  "speak_model": "..."     // For text-to-speech
}
```

**18+ supported providers**: openai, anthropic, google, mistral, ollama, replicate, groq, huggingface, xai, deepseek, qwen, novita, openrouter, glhf, hyperbolic, vllm, cerebras, mercury, foundry

### Azure AI Foundry Integration

**Azure AI Foundry** provides Anthropic Claude models through Azure's infrastructure. This is distinct from Azure OpenAI.

**Configuration** (in profile JSON):
```json
{
  "model": {
    "api": "foundry",
    "url": "https://your-resource-name.services.ai.azure.com/anthropic/",
    "model": "claude-haiku-4-5"
  }
}
```

**Setup**:
1. Create Azure AI Foundry resource in Azure portal
2. Extract resource name from URL: `https://RESOURCE-NAME.services.ai.azure.com`
3. Get API key from Azure portal
4. Add to `keys.json`: `"AZURE_FOUNDRY_API_KEY": "your-key"`
5. Set URL in profile with `/anthropic/` suffix

**Key differences from Azure OpenAI**:
- Uses `foundry` provider, not `azure`
- URL format: `*.services.ai.azure.com/anthropic/`
- Supports Claude models (Haiku, Sonnet, Opus)
- Requires `AZURE_FOUNDRY_API_KEY` environment variable

### Memory System

**Turn-based history** (`history.js`):
- Stores conversation as turns: `{role: "user|assistant|system", content: "..."}`
- When turns exceed `max_messages` (default: 15):
  1. Take oldest 5 turns
  2. Call LLM to summarize via `saving_memory` prompt
  3. Save to `bots/[name]/memory.json`
  4. Clear summarized turns from context

**Spatial memory bank** (`memory_bank.js`):
```javascript
rememberPlace(name, x, y, z)  // Save location
recallPlace(name)              // Retrieve coords
```

**Semantic memory search** (when `use_local_embeddings: true`):
- Embed memory summaries
- Find relevant past context by similarity
- Reduces forgetting in long sessions

**Persistence**:
- `./bots/[agent_name]/memory.json`: Current memory + summarized history
- `./bots/[agent_name]/histories/`: Conversation snapshots (kept: latest 20)
- `./bots/[agent_name]/logs/`: Text logs

### Vision System

**Components**:
- `vision/camera.js`: Canvas-based rendering of bot view
- `vision/browser_viewer.js`: Three.js 3D viewer (localhost:3000+)
- `vision/vision_interpreter.js`: LLM image analysis

**Operations**:
```javascript
lookAtPlayer(name, direction)    // Position camera, analyze view
lookAtPosition(x, y, z)          // Look at coordinates
getCenterBlockInfo()             // Identify block in crosshairs
```

**Note**: Disabled in Docker (headless) - returns graceful fallback.

### Modes System

**Reactive behaviors** (`modes.js`) that run in parallel with commands:

```javascript
self_preservation: {
  // Triggers: drowning, burning, health < 10, hunger < 8
  // Actions: surface, extinguish, eat, flee combat
},
unstuck: {
  // Triggers: pathfinding timeout, mining stuck, repeated failures
  // Actions: stop, backup, retry with different approach
}
```

**State machine**: Each mode has `on`, `active`, `paused` states. Updates run ~100ms per tick without blocking command execution.

## Configuration Files

### settings.js (Global)
```javascript
// Minecraft connection
"host": "localhost",                // or IP address
"port": 25565,                      // or -1 for auto-scan
"auth": "offline",                  // or "microsoft" for online servers
"minecraft_version": "auto",        // auto-detect or specify like "1.21.6"

// MindServer
"mindserver_port": 8080,            // Web UI port
"mindserver_host_public": false,    // true = accessible on LAN (0.0.0.0)
"auto_open_ui": true,               // Open browser on startup

// Profiles
"base_profile": "assistant",        // Default profile
"profiles": ["./andy.json"],        // Agent profile paths

// Features
"allow_insecure_coding": false,     // Enable !newAction (code execution)
"allow_vision": true,               // Enable screenshot analysis
"render_bot_view": true,            // Enable 3D viewer (localhost:3000+)
"chat_ingame": true,                // Show bot responses in Minecraft chat

// Memory
"load_memory": true,                // Load memory.json on startup
"max_messages": 15,                 // Context window before summarization
"num_examples": 2,                  // Few-shot examples to include

// Token optimization
"command_docs_mode": "compact",     // "full", "compact", or "minimal"
"include_inventory": true,          // Include inventory in prompt
"include_stats": true,              // Include health/hunger/position
"include_nearby_blocks": true,      // Include nearby blocks
"use_command_aliases": true,        // Enable short aliases

// Local embeddings (Transformers.js)
"use_local_embeddings": false,      // Enable local classification
"local_embedding_model": "Xenova/gte-small",  // Model name
"local_intent_threshold": 0.75,     // Similarity threshold (0-1)
"enable_simple_classifier": true,   // yes/no/stop detection
```

### Agent Profiles (e.g., andy.json)
```javascript
{
  "name": "andy",                   // Bot name (must match Minecraft account for online servers)
  "model": {...},                   // LLM configuration
  "conversing": "You are andy...",  // System prompt for chat
  "saving_memory": "...",           // Prompt for memory summarization
  "coding": "...",                  // Prompt for !newAction code generation
  // ... other customizations
}
```

**Profile inheritance**: Profiles inherit from `base_profile` → `profiles/defaults/_default.json` → custom profile. Custom values override defaults.

## Important Patterns & Conventions

### Async/Await + Callbacks
- All command functions are async
- ActionManager wraps them with timeout/interrupt handling
- Mineflayer callbacks are promisified where needed

### Command Execution Isolation
- Each command runs through `ActionManager.runAction(label, function, {timeout})`
- Previous action interrupted via `agent.bot.interrupt_code = true`
- Prevents infinite loops and hung operations

### Local-First with LLM Fallback
```
Try local classifier (fast, no tokens)
  ├─ Simple classifier: yes/no/stop/help
  ├─ Command intent matching: semantic similarity
  └─ Item name fuzzy matching

Fall back to LLM if:
  ├─ No local match
  ├─ Low confidence
  ├─ Missing arguments
  └─ Complex multi-step tasks
```

### Socket.io Event Protocol

**Agent Process → MindServer**:
- `login-agent`: Connect agent
- `bot-output`: Send chat/command output
- `get-full-state`: Request bot state for UI
- `disconnect`: Logout agent

**MindServer → Agent Process**:
- `send-message`: Player message to bot
- `restart-agent`: Force restart
- `set-agent-settings`: Live reconfiguration

### Error Handling in Commands
- Commands return string messages (success/failure)
- Errors propagate to LLM for replanning
- Graceful degradation (e.g., vision fails → continue without vision)

### Prompt Placeholder System
Prompter replaces placeholders in profile prompts:
- `$STATS` → health, hunger, position, time, weather
- `$INVENTORY` → item counts (controlled by `include_inventory`)
- `$MEMORY` → summarized conversation history
- `$NEARBY_BLOCKS` → important blocks with distance/direction
- `$COMMAND_DOCS` → available commands (verbosity controlled by `command_docs_mode`)
- `$EXAMPLES` → few-shot examples (selected via embeddings)

## Development Guidelines

### Adding a New Command

1. **Define command** in `src/agent/commands/actions.js` or `queries.js`:
```javascript
export const myNewCommand = {
    name: "!myNewCommand",
    description: "Description shown to LLM",
    params: {
        "param1": {type: "string", description: "First parameter"},
        "count": {type: "number", description: "Optional count"}
    },
    perform: async function(agent, param1, count=1) {
        // Implementation
        return "Success message";
    }
}
```

2. **Register command** in `commands/index.js`:
```javascript
import { myNewCommand } from './actions.js';
const actionsList = [..., myNewCommand];
```

3. **Add alias** (optional) in `commands/index.js`:
```javascript
const COMMAND_ALIASES = {
    ...
    'mnc': 'myNewCommand'
};
```

4. **Add intent mapping** (optional) for local classifier in `local_classifier.js`:
```javascript
this.commandIntents = {
    ...
    "!myNewCommand": [
        "do my thing",
        "perform my action",
        "execute my command"
    ]
};
```

### Adding a New LLM Provider

1. **Create provider file** at `src/models/[provider].js`:
```javascript
export class MyProviderModel {
    static prefix = "myprovider";  // Used for auto-detection

    constructor(model_name, url = "https://api.myprovider.com/v1/", params = {}) {
        this.model_name = model_name;
        this.url = url;
        this.params = params;
    }

    async sendRequest(turns, system_message) {
        // API call implementation
        return response_text;
    }

    async sendRequestStream(turns, system_message, onChunk) {
        // Streaming implementation (optional)
    }

    async embed(text) {
        // Embedding implementation (optional)
    }
}
```

2. **No registration needed**: `_model_map.js` auto-discovers via file system scan.

3. **Add API key** to `keys.json`:
```json
{
    "MYPROVIDER_API_KEY": "your-key-here"
}
```

4. **Use in profile**:
```json
{
    "model": {
        "api": "myprovider",
        "model": "myprovider-model-name"
    }
}
```

### Patching Node Modules

Some dependencies have bugs. To patch:
```bash
# 1. Edit file in node_modules/[package]/...
# 2. Create patch
npx patch-package [package-name]
# 3. Patch is saved to patches/ and auto-applied on npm install
```

### Memory Management Best Practices

**When designing prompts** (in profile JSON):
- Keep `saving_memory` prompt concise: "Save ONLY current goal, important locations, key lessons. Max 200 chars."
- Avoid storing: completed tasks, inventory counts, failed attempts, old goals
- NEW goals REPLACE old goals completely

**When modifying history system**:
- Test with long conversations (100+ messages) to ensure summarization works
- Verify memory.json stays reasonably sized (<10KB per agent)
- Check that context window stays under `max_messages`

## Common Development Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Bot crashes with "Cannot read property 'x' of undefined" | Mineflayer bot not spawned yet | Check `bot._client` or wait for `bot.once('spawn')` |
| Command not recognized | Not registered in commandMap | Add to `actionsList` or `queryList` in `commands/index.js` |
| Local classifier always fails | Embeddings not loaded | Ensure `use_local_embeddings: true` and first run completes model download |
| Vision returns blank | Headless environment | Vision requires GL context, fails gracefully in Docker |
| Memory grows unbounded | Summarization not triggering | Check `max_messages` is set and LLM is responding to `saving_memory` prompt |
| Multi-agent chat loops | Bot name mismatch | For online servers, profile name must exactly match Minecraft account name |
| Can't connect to local server from Docker | Wrong host address | Use `"host": "host.docker.internal"` instead of `"localhost"` |
| Patches not applying | Missing postinstall | Ensure `"postinstall": "patch-package"` in package.json scripts |

## Testing & Debugging

**Manual testing in Minecraft**:
```
# In-game chat commands to test:
"follow me"                          # Test local classifier
"craft a pickaxe for yourself"       # Test complex planning
"!inventory"                         # Test direct command
"collect some wood"                  # Test item name fuzzy matching
"yes"                                # Test simple classifier
"!surroundings"                      # Test spatial awareness
"cover the pond with dirt"           # Test area covering
"plant oak trees in a grid"          # Test tree planting
"!scanArea(-5, -5, 5, 5)"           # Test area scanning
```

**Logs**:
- Conversation: `bots/[agent_name]/logs/conversation_*.txt`
- Memory: `bots/[agent_name]/memory.json`
- Console output: Enable `"log_all_prompts": true` in settings.js

**Web UI**: http://localhost:8080
- View all agents
- See bot state (health, position, inventory)
- Send messages
- Restart/stop agents

**3D Viewer**: http://localhost:3000 (3001, 3002... for multiple agents)
- First-person view of bot
- Real-time world rendering

## Security Considerations

**Code execution** (`allow_insecure_coding: true`):
- Enables `!newAction` command: LLM writes JS code executed on your machine
- Code runs in SES (Secure EcmaScript) sandbox with limited access
- **NEVER** use on public servers - vulnerable to prompt injection
- Recommended: Run in Docker container when enabled

**Public server connection**:
- Set `"auth": "microsoft"` for official servers
- Bot will use account from Minecraft launcher
- Ensure bot name in profile matches Minecraft account exactly

**LAN access** (`mindserver_host_public: true`):
- Web UI becomes accessible to anyone on your network
- No authentication by default
- Only enable on trusted networks

## Production Deployment

### Running in Background (Linux/Azure)

**Using nohup**:
```bash
nohup node main.js > nohup.out 2>&1 &
# or with bun
nohup bun main.js > nohup.out 2>&1 &

# Check logs
tail -f nohup.out

# Stop process
ps aux | grep "node main.js"
kill <PID>
```

### Environment Variables

Override settings.js values with environment variables (useful for Docker/production):

```bash
MINECRAFT_PORT=25565          # Override minecraft port
MINDSERVER_PORT=8080          # Override web UI port
PROFILES='["./andy.json"]'    # Override profile paths (JSON array)
INSECURE_CODING=true          # Enable !newAction command
BLOCKED_ACTIONS='["!delete"]' # Block specific commands (JSON array)
MAX_MESSAGES=20               # Override max_messages
NUM_EXAMPLES=3                # Override num_examples
LOG_ALL=true                  # Enable verbose logging
```

**Example with environment variables**:
```bash
MINDSERVER_PORT=9000 MAX_MESSAGES=30 node main.js
```

### Docker Deployment

**Docker considerations**:
- WebGL/vision disabled in headless environment (graceful fallback)
- Use `host.docker.internal` to connect to Minecraft on host machine
- Port mapping: `-p 8080:8080 -p 3000-3010:3000-3010`
- Environment variables: Set via `-e` flag or docker-compose.yml

**Example Docker run**:
```bash
docker run -i -t --rm \
  -v $(pwd):/app -w /app \
  -p 8080:8080 -p 3000-3010:3000-3010 \
  -e MINDSERVER_PORT=8080 \
  -e MAX_MESSAGES=20 \
  node:18 node main.js
```

**Docker Compose**:
```yaml
version: '3'
services:
  mindcraft:
    image: node:18
    volumes:
      - .:/app
    working_dir: /app
    ports:
      - "8080:8080"
      - "3000-3010:3000-3010"
    environment:
      - MINDSERVER_PORT=8080
      - DISPLAY=:99
      - GALLIUM_DRIVER=softpipe
    command: node main.js
```

### Azure VM Deployment

**Firewall configuration** (using Azure CLI):
```bash
# Open web UI port
az network nsg rule create \
  --resource-group YOUR_RG \
  --nsg-name YOUR_NSG \
  --name open-port-8080 \
  --priority 1021 \
  --destination-port-ranges 8080 \
  --access Allow --protocol Tcp

# Open 3D viewer ports (supports multiple agents)
az network nsg rule create \
  --resource-group YOUR_RG \
  --nsg-name YOUR_NSG \
  --name open-port-3000-3010 \
  --priority 1022 \
  --destination-port-ranges 3000-3010 \
  --access Allow --protocol Tcp
```

**Access from external IP**:
- Web UI: `http://<AZURE_PUBLIC_IP>:8080`
- 3D Viewer: `http://<AZURE_PUBLIC_IP>:3000` (agent 1), `:3001` (agent 2), etc.

**Set `mindserver_host_public` in settings.js**:
```javascript
"mindserver_host_public": true,  // Listen on 0.0.0.0 instead of 127.0.0.1
```

### Web UI and 3D Viewer Integration

**Architecture**:
- MindServer hosts web UI on port 8080
- Each agent gets assigned viewer port: `3000 + agentIndex`
- Web UI embeds viewer via iframe using dynamic URL construction

**How viewer URLs work**:
```javascript
// In src/mindcraft/public/index.html
const viewerURL = `${window.location.protocol}//${window.location.hostname}:${viewerPort}`;
// Result: Uses same hostname as web UI (localhost or public IP)
```

**Port allocation**:
- First agent: 3000
- Second agent: 3001
- Third agent: 3002
- etc.

**Troubleshooting viewer issues**:
- Ensure viewer ports are open in firewall
- Check `render_bot_view: true` in settings
- Verify Prismarine-viewer is running (check logs: "Prismarine viewer web server running on *:3000")
- In Docker: WebGL may be disabled, viewer won't render (expected)

## Related Documentation

- **Mineflayer docs**: https://prismarinejs.github.io/mineflayer/
- **Minecraft data**: Use `mcdata.js` utilities, not raw minecraft-data
- **MineCollab paper**: See `minecollab.md` for research context
- **FAQ**: See `FAQ.md` in repository
- **Discord**: https://discord.gg/mp73p35dzC (primary support channel)
