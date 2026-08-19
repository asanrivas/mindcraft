# CLAUDE.md - Mindcraft AI Bot Framework

## Quick Reference

```bash
# Start/Stop
sudo systemctl restart mindcraft-andy    # Restart bot
sudo systemctl status mindcraft-andy     # Check status
tail -f /home/azureuser/mindcraft/logs/andy-service.log  # View logs

# RCON commands (mc alias)
mc "msg andy <message>"                  # Send message to bot
mc "give andy cobblestone 640"           # Give items
mc "tp andy 1500 65 -900"                # Teleport

# Development
bun install && bun run main.js           # Start manually
npx patch-package [pkg]                  # Patch node_modules
```

## Architecture

```
main.js → MindServer (:8080) + AgentProcess → Agent
  Agent: Mineflayer bot + LLM client + ActionManager + Modes
```

**Data flow**: Chat → Conversation → LocalClassifier (optional) → LLM → Commands → Skills → Mineflayer

**Key dirs**: `src/agent/commands/` (actions.js, queries.js), `src/agent/library/` (skills.js, world.js), `src/models/` (providers), `bots/[name]/` (runtime state)

## Commands

**Building**: `!fill(blockType, x1, z1, x2, z2, y, height)` - Fill area with blocks, height for walls
**Movement**: `!goToPlayer`, `!followPlayer`, `!goToCoordinates`
**Resources**: `!collectBlocks`, `!craftRecipe`, `!getCraftingPlan`
**Storage**: `!putInChest`, `!takeFromChest`, `!depositAll`
**Info**: `!inventory`, `!stats`, `!surroundings`, `!scanArea`

Aliases: `!ca`→fill, `!cb`→collectBlocks, `!cr`→craftRecipe, `!gcp`→getCraftingPlan, `!inv`→inventory

## Adding Commands

```javascript
// In src/agent/commands/actions.js
export const myCommand = {
    name: "!myCommand",
    description: "Description for LLM",
    params: { "arg1": {type: "string", description: "..."} },
    perform: async (agent, arg1) => { return "result"; }
}
// Register in index.js: actionsList = [..., myCommand]
```

## Configuration

**settings.js**: `host`, `port`, `max_messages`, `command_docs_mode` (full/compact/minimal)
**andy.json**: `model` config, `conversing` prompt, `saving_memory` prompt

**Prompt placeholders**: `$STATS`, `$INVENTORY`, `$MEMORY`, `$COMMAND_DOCS`, `$EXAMPLES`

## LLM Providers

18+ providers auto-discovered. Config: `{"api": "foundry", "model": "claude-sonnet-4-5", "url": "..."}`
Azure Foundry: URL ends with `/anthropic/`, key: `AZURE_FOUNDRY_API_KEY`

**copilot-mem0** (`src/models/copilot_mem0.js`): GitHub Copilot + Claude + Mem0 cloud memory
- Token priority: 1) `~/.openclaw/credentials/github-copilot.token.json`  2) exchange `GITHUB_TOKEN` PAT
- Calls `https://api.githubcopilot.com/chat/completions` (OpenAI-compatible, vscode-chat integration)
- Models: `claude-haiku-4.5`, `claude-sonnet-4.5`, `claude-opus-4.5/4.6`, `gpt-5`, `gpt-5-mini`, `gemini-3-flash-preview`
- **Tiered routing**: set `"model": "tiered"` — haiku classifies complexity, routes to haiku/sonnet/opus
  - `simple` → haiku  (greetings, status, follow/stop)
  - `medium` → sonnet (crafting, mining, navigation, small builds)
  - `hard`   → opus   (large builds >20 blocks, multi-step plans, complex strategies)
  - Override via params: `tier_router`, `tier_simple`, `tier_medium`, `tier_hard`
- Augments every request with Mem0 semantic memory; stores conversation + events (user + system pool)
- Event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) match `Mem0Local` interface
- Profile: `profiles/copilot.json` | Keys needed: `MEM0_API_KEY` (+ `GITHUB_TOKEN` if openclaw token expired)

## Modes System

`modes.js`: self_preservation (health/hunger), unstuck (pathfinding), cowardice, self_defense
Use `excludeFromInterrupt: ["action:fill"]` to prevent mode interruption during builds

## Memory

**Active systems:**
- `bots/[name]/memory.json`: Named chest locations (loaded on startup via ChestMaster, always active)
- `MemoryBank` (`src/agent/memory_bank.js`): In-memory spatial store for `!rememberHere`/`!goToRememberedPlace` — lost on restart
- `src/models/mem0_local.js`: Mem0 cloud integration (sdk: `mem0ai`, key in `keys.json`) — **NOT active**: only loads when `"api": "mem0"` in profile; Andy uses `"api": "azure"`

**Active (openclaw-style):**
- `use_memory_saving: true` in `andy.json` — when `max_messages` (30) is hit, oldest turns are distilled by LLM into structured memory (Goal/Locations/Lessons/Players sections, max 1000 chars)
- `load_memory: true` in `settings.js` — memory + saved_places restored from `memory.json` on every restart
- `$MEMORY` injected into `conversing` prompt — Andy always sees its curated memory in every response

**To enable Mem0:** Change `andy.json` model to `"api": "mem0"` and set model/url to Azure Foundry endpoint. Mem0 event hooks (`recordDeath`, `recordPlayerJoin`, `recordChestDeposit`) are already wired in `agent.js` and `actions.js` — they become active automatically.

## Common Issues

| Issue | Fix |
|-------|-----|
| Command 0 args | Check quote format (use ASCII `"` not curly `"`) |
| embed not function | Check embedding model has `embed()` method |
| Bot stuck | Check modes.js unstuck, reduce area size |
| Vision blank | Expected in Docker/headless |

## Web UI

- **MindServer**: http://localhost:8080 (set `mindserver_host_public: true` for LAN)
- **3D Viewer**: http://localhost:3000 (per agent: 3001, 3002...)
- **Map**: http://localhost:8090 (run `./regenerate_map.sh` first)

## Security

`allow_insecure_coding: true` enables `!newAction` (LLM code execution). Use Docker for safety.
