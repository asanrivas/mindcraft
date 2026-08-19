/**
 * Migration script: Letta memory blocks → Mem0
 *
 * Usage: node migrate_letta_to_mem0.js
 */

import { Mem0Local } from './src/models/mem0_local.js';

// Letta memory blocks to migrate
const LETTA_MEMORIES = [
    {
        category: 'knowledge',
        content: 'Minecraft version 1.21.11. The Pale Garden biome has the Creaking mob, which is hostile and spawns at night.',
    },
    {
        category: 'knowledge',
        content: 'Crafting recipes: wooden pickaxe needs 3 planks + 2 sticks. Iron armor needs 24 iron ingots total. Torches need 1 coal + 1 stick.',
    },
    {
        category: 'knowledge',
        content: 'Mob behavior: Zombies, skeletons, creepers, spiders are hostile. Cows, pigs, sheep, chickens are passive. Wolves can be tamed. Endermen only attack if looked at.',
    },
    {
        category: 'knowledge',
        content: 'Biome info: Plains have villages and horses. Deserts have temples and cacti. Forests have wolves and trees. Swamps have witch huts and slimes. Mountains have emeralds and goats.',
    },
    {
        category: 'feature',
        content: 'Navigation: For long distance travel (100+ blocks), I use surface navigation with 50-block waypoints to avoid caves. I detect underground areas by checking for solid blocks above me.',
    },
];

async function migrate() {
    console.log('🔄 Starting Letta → Mem0 migration...\n');

    // Initialize Mem0
    const mem0 = new Mem0Local(null, null, {
        agent_name: 'andy',
        embedding_model: 'Xenova/multilingual-e5-small',
    });

    try {
        await mem0.init();

        // Migrate each memory
        let migrated = 0;
        for (const memory of LETTA_MEMORIES) {
            const memId = await mem0.addMemory(memory.content, {
                user_id: 'system', // System knowledge shared across all users
                category: memory.category,
                metadata: {
                    source: 'letta_migration',
                    migrated_at: new Date().toISOString(),
                },
            });

            console.log(`✅ Migrated: ${memory.category} → ${memId}`);
            migrated++;
        }

        console.log(`\n🎉 Migration complete! ${migrated} memories transferred.\n`);

        // Verify migration
        console.log('🔍 Verifying memories...');
        const allMemories = await mem0.listMemories('system');
        console.log(`Found ${allMemories.length} memories in Mem0\n`);

        // Test search
        console.log('🔎 Testing semantic search:');
        const searchResults = await mem0.searchMemories('How do I craft a pickaxe?', {
            user_id: 'system',
            limit: 2,
        });

        searchResults.forEach((result, idx) => {
            console.log(`${idx + 1}. [${(result.similarity * 100).toFixed(0)}%] ${result.content.substring(0, 80)}...`);
        });

        console.log('\n✨ Mem0 is ready to use!');

        await mem0.close();
    } catch (error) {
        console.error('❌ Migration failed:', error);
        await mem0.close();
        process.exit(1);
    }
}

migrate();
