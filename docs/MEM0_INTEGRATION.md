# Mem0 Integration for Mindcraft

Lightweight, fast memory layer inspired by [Mem0](https://github.com/mem0ai/mem0) for Andy's persistent memory.

## Why Mem0?

| Feature | Letta | Mem0 Local |
|---------|-------|------------|
| Speed | Slow (full agent) | Fast (direct Redis) |
| Complexity | High | Low |
| Storage | PostgreSQL | Redis |
| Embeddings | Cloud | Local (multilingual-e5-small) |
| Overhead | HTTP + agent loop | Direct access |

**Result**: 10x faster response times, simpler architecture, full local control.

## Architecture

```
Mem0Local (src/models/mem0_local.js)
├── Redis (memory storage)
├── Multilingual-e5-small (embeddings)
├── Azure Foundry Claude (LLM)
└── Semantic search (cosine similarity)
```

## Memory Categories

- `knowledge`: Static game knowledge (crafting, mobs, biomes)
- `preference`: Player preferences and likes
- `location`: Important coordinates and places
- `conversation`: Recent interactions
- `goal`: Current objectives
- `feature`: Bot capabilities

## Setup

### 1. Start Redis

```bash
docker run -d --name redis-mem0 -p 6379:6379 redis:7-alpine
```

### 2. Configure Azure Foundry

In `andy.json`:

```json
{
  "model": {
    "api": "mem0",
    "model": "claude-3-5-haiku-20241022",
    "url": "https://your-resource-name.services.ai.azure.com/models",
    "params": {
      "agent_name": "andy",
      "embedding_model": "Xenova/multilingual-e5-small"
    }
  }
}
```

### 3. Set API Key

```bash
export AZURE_FOUNDRY_API_KEY="your-key"
```

### 4. Migrate Letta Memories (First Time Only)

```bash
node migrate_letta_to_mem0.js
```

## Usage

### Add Memory

```javascript
const mem0 = new Mem0Local('claude-haiku', 'https://...', {
  agent_name: 'andy',
});

await mem0.addMemory('Player likes building oak houses', {
  user_id: 'john',
  category: 'preference',
  ttl: 86400, // Optional: expires in 24 hours
});
```

### Search Memories

```javascript
const results = await mem0.searchMemories('What does player like?', {
  user_id: 'john',
  category: 'preference',
  limit: 3,
});

// Returns: [
//   {
//     content: 'Player likes building oak houses',
//     similarity: 0.89,
//     category: 'preference',
//     ...
//   }
// ]
```

### List All Memories

```javascript
const memories = await mem0.listMemories('john', {
  category: 'location',
  limit: 10,
});
```

### Update Memory

```javascript
await mem0.updateMemory('mem_abc123', {
  content: 'Player likes building oak and spruce houses',
  metadata: { updated: true },
});
```

### Delete Memory

```javascript
await mem0.deleteMemory('mem_abc123');
```

## How It Works

### Automatic Memory Context

When Andy receives a message, Mem0:
1. **Embeds the query** using multilingual-e5-small
2. **Searches Redis** for relevant memories (top 3)
3. **Augments prompt** with memory context
4. **Calls Azure Foundry** with enriched context

```
User: "Build me a house"
  ↓
Mem0 searches memories
  ↓
[Relevant Memories]
1. Player likes oak houses (preference, 85% relevant)
2. Base at -150,64,200 (location, 72% relevant)
  ↓
Prompt to Claude: "...[memories]... Build me a house"
  ↓
Andy: "I'll build an oak house near your base!"
```

### Memory Schema

```javascript
{
  id: "mem_c84a971adf2ff960",
  agent_id: "andy",
  user_id: "john",
  content: "Player likes building oak houses",
  embedding: [0.1, 0.2, ..., 0.9],  // 384 dimensions
  category: "preference",
  metadata: {
    source: "conversation",
    created_at: "2025-12-25T12:00:00Z"
  },
  timestamp: 1735128000000
}
```

## Redis Keys

```
mem0:andy:mem_abc123          → Memory JSON
mem0:andy:users:john          → Set of memory IDs for user "john"
mem0:andy:users:system        → Set of system/shared knowledge
```

## Migration from Letta

The migration script (`migrate_letta_to_mem0.js`) transfers:

1. **minecraft_knowledge** → `knowledge` category
2. **crafting_recipes** → `knowledge` category
3. **mob_behavior** → `knowledge` category
4. **biome_info** → `knowledge` category
5. **navigation_features** → `feature` category

All migrated memories use `user_id: "system"` (shared across all users).

## Performance

| Operation | Time |
|-----------|------|
| Add memory | ~50ms |
| Search (top 3) | ~100ms |
| List memories | ~20ms |
| LLM call (with memory) | ~2-5s |

**Total latency**: ~2.1s (vs ~10s with Letta)

## Troubleshooting

### Redis Connection Failed

```bash
# Check Redis is running
docker ps | grep redis-mem0

# Start if not running
docker start redis-mem0

# Check logs
docker logs redis-mem0
```

### Embeddings Loading Slow

First run downloads model (~300MB) to `~/.cache/huggingface/`.
Subsequent runs load from cache in ~2s.

### Memory Not Found

```bash
# Check Redis keys
docker exec redis-mem0 redis-cli KEYS "mem0:andy:*"

# Count memories
docker exec redis-mem0 redis-cli SMEMBERS "mem0:andy:users:system"
```

## API Reference

See `src/models/mem0_local.js` for full API documentation.

## Resources

- [Mem0 GitHub](https://github.com/mem0ai/mem0) - Original inspiration
- [Redis](https://redis.io/) - Memory storage
- [Xenova Transformers.js](https://github.com/xenova/transformers.js) - Local embeddings
- [Azure AI Foundry](https://azure.microsoft.com/en-us/products/ai-services/ai-studio) - Claude API
