# Letta Client Integration

Connect to the self-hosted Letta server with Azure Anthropic Claude.

## Quick Start for Mindcraft

### 1. Profile Configuration (andy.json or custom profile)

```json
{
  "name": "andy",
  "model": {
    "api": "letta",
    "model": "openai-proxy/claude-sonnet-4-5",
    "url": "http://localhost:8283",
    "params": {
      "agent_name": "andy-minecraft"
    }
  }
}
```

### 2. Available Models

- `openai-proxy/claude-sonnet-4-5` - Claude Sonnet 4.5 (recommended)
- `openai-proxy/claude-haiku-4-5` - Claude Haiku 4.5 (faster)
- `openai-proxy/claude-opus-4-5` - Claude Opus 4.5 (most capable)

### 3. Local Embeddings (Multilingual)

The Letta client includes local embedding support using `Xenova/multilingual-e5-small`:
- **384 dimensions** - Same as gte-small
- **94 languages** - Full support for English and Malay
- **~300MB memory** - Efficient for 8GB RAM systems
- **LRU cache** - 500 entries for fast repeated queries

Custom embedding model in profile:
```json
{
  "model": {
    "api": "letta",
    "model": "openai-proxy/claude-sonnet-4-5",
    "params": {
      "agent_name": "andy-minecraft",
      "embedding_model": "Xenova/multilingual-e5-base"
    }
  }
}
```

### 4. Environment Variable (optional)

```bash
export LETTA_BASE_URL=http://localhost:8283
```

---

## Configuration

```
LETTA_BASE_URL=http://localhost:8283
```

## TypeScript Client

```typescript
// letta-client.ts
const LETTA_BASE_URL = "http://localhost:8283";

interface Agent {
  id: string;
  name: string;
  model: string;
}

interface Message {
  id: string;
  message_type: string;
  content: string;
}

interface ChatResponse {
  messages: Message[];
  usage: {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
  };
}

// Create an agent
async function createAgent(name: string): Promise<Agent> {
  const response = await fetch(`${LETTA_BASE_URL}/v1/agents/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      model: "openai-proxy/claude-sonnet-4-5",
      embedding: "letta/letta-free",
    }),
  });
  return response.json();
}

// Send message to agent
async function sendMessage(agentId: string, message: string): Promise<ChatResponse> {
  const response = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: message }],
    }),
  });
  return response.json();
}

// List all agents
async function listAgents(): Promise<Agent[]> {
  const response = await fetch(`${LETTA_BASE_URL}/v1/agents/`);
  return response.json();
}

// Get agent by ID
async function getAgent(agentId: string): Promise<Agent> {
  const response = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`);
  return response.json();
}

// Delete agent
async function deleteAgent(agentId: string): Promise<boolean> {
  const response = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
    method: "DELETE",
  });
  return response.ok;
}

// Extract assistant response from chat response
function getAssistantMessage(response: ChatResponse): string | undefined {
  const msg = response.messages?.find(m => m.message_type === "assistant_message");
  return msg?.content;
}

// Example usage
async function main() {
  // Create a new agent
  console.log("Creating agent...");
  const agent = await createAgent("minecraft-bot");
  console.log("Agent created:", agent.id);

  // Send a message
  console.log("\nSending message...");
  const response = await sendMessage(agent.id, "Hello! What should I build in Minecraft?");
  console.log("Response:", getAssistantMessage(response));

  // List all agents
  console.log("\nAll agents:");
  const agents = await listAgents();
  agents.forEach(a => console.log(`- ${a.name} (${a.id})`));
}

main().catch(console.error);
```

## JavaScript Client

```javascript
// letta-client.js
const LETTA_BASE_URL = "http://localhost:8283";

// Create an agent
async function createAgent(name) {
  const res = await fetch(`${LETTA_BASE_URL}/v1/agents/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      model: "openai-proxy/claude-sonnet-4-5",
      embedding: "letta/letta-free",
    }),
  });
  return res.json();
}

// Send message to agent
async function sendMessage(agentId, message) {
  const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: message }],
    }),
  });
  return res.json();
}

// Chat helper - returns just the text response
async function chat(agentId, message) {
  const data = await sendMessage(agentId, message);
  return data.messages?.find(m => m.message_type === "assistant_message")?.content;
}

// List all agents
async function listAgents() {
  const res = await fetch(`${LETTA_BASE_URL}/v1/agents/`);
  return res.json();
}

// Delete agent
async function deleteAgent(agentId) {
  const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
    method: "DELETE",
  });
  return res.ok;
}

module.exports = {
  createAgent,
  sendMessage,
  chat,
  listAgents,
  deleteAgent,
};
```

## Quick Test

```javascript
// test-letta.js
const { createAgent, chat } = require('./letta-client.js');

async function test() {
  const agent = await createAgent("test-bot");
  console.log("Agent ID:", agent.id);

  const response = await chat(agent.id, "What is 2 + 2?");
  console.log("Response:", response);
}

test();
```

## Available Models

- `openai-proxy/claude-sonnet-4-5` - Claude Sonnet 4.5 (recommended)
- `openai-proxy/claude-haiku-4-5` - Claude Haiku 4.5 (faster, cheaper)
- `openai-proxy/claude-opus-4-5` - Claude Opus 4.5 (most capable)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/agents/` | List all agents |
| POST | `/v1/agents/` | Create new agent |
| GET | `/v1/agents/{id}` | Get agent details |
| DELETE | `/v1/agents/{id}` | Delete agent |
| POST | `/v1/agents/{id}/messages` | Send message to agent |
| GET | `/v1/models/` | List available models |
| GET | `/v1/providers/` | List configured providers |

## Memory Blocks API

Memory blocks allow persistent knowledge storage attached to agents.

```bash
# Create a memory block
curl -X POST http://localhost:8283/v1/blocks/ \
  -H "Content-Type: application/json" \
  -d '{
    "label": "minecraft_knowledge",
    "description": "Minecraft game knowledge",
    "value": "Minecraft version 1.21.11. Pale Garden biome has Creaking mob."
  }'

# Attach block to agent
curl -X PATCH "http://localhost:8283/v1/agents/{agent_id}/core-memory/blocks/attach/{block_id}"

# List agent's memory blocks
curl http://localhost:8283/v1/agents/{agent_id}/core-memory/blocks

# Update a memory block
curl -X PATCH http://localhost:8283/v1/blocks/{block_id} \
  -H "Content-Type: application/json" \
  -d '{"value": "Updated knowledge content"}'

# Delete a memory block
curl -X DELETE http://localhost:8283/v1/blocks/{block_id}
```

## Memory Tools API

Attach real-time memory tools to agents for seamless memory operations during conversations.

```bash
# List available tools
curl http://localhost:8283/v1/tools/

# Key memory tools:
# - core_memory_append (letta_memory_core) - Add to core memory
# - archival_memory_insert (letta_core) - Add to archival memory
# - archival_memory_search (letta_core) - Search archival memory
# - memory_apply_patch (letta_memory_core) - Update memory with patches
# - conversation_search (letta_core) - Search past conversations

# Attach tool to agent
curl -X PATCH "http://localhost:8283/v1/agents/{agent_id}/tools/attach/{tool_id}"

# List agent's attached tools
curl http://localhost:8283/v1/agents/{agent_id}/tools
```

## Andy's Current Memory Blocks

Andy (agent: andy-minecraft) has these memory blocks attached:
- `minecraft_knowledge` - MC version 1.21.11, Pale Garden biome, Creaking mob
- `crafting_recipes` - Common recipes and tips (tools, armor, torches)
- `mob_behavior` - Hostile vs friendly mobs, combat patterns
- `biome_info` - Biome resources, structures, and dangers

## Server Status

```bash
# Check if server is running
curl http://localhost:8283/

# List models
curl http://localhost:8283/v1/models/

# List agents
curl http://localhost:8283/v1/agents/

# Get agent conversation history
curl http://localhost:8283/v1/agents/{agent_id}/messages
```
