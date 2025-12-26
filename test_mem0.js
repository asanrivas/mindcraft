/**
 * Test Mem0 integration with Andy's Azure Foundry Claude
 */

import { Mem0Local } from './src/models/mem0_local.js';

async function test() {
    console.log('🧪 Testing Mem0 Local Integration\n');

    const mem0 = new Mem0Local('claude-haiku-4-5', 'https://asan-miygeha8-westcentralus.services.ai.azure.com/models', {
        agent_name: 'andy',
        embedding_model: 'Xenova/multilingual-e5-small',
    });

    try {
        // Test 1: Add a test memory
        console.log('📝 Test 1: Adding test memory...');
        const memId = await mem0.addMemory('Test user likes building redstone contraptions', {
            user_id: 'test_user',
            category: 'preference',
        });
        console.log(`✅ Added memory: ${memId}\n`);

        // Test 2: Search memories
        console.log('🔎 Test 2: Searching memories...');
        const searchResults = await mem0.searchMemories('What does the user like to build?', {
            user_id: 'test_user',
            limit: 2,
        });
        console.log(`✅ Found ${searchResults.length} relevant memories:`);
        searchResults.forEach((r, idx) => {
            console.log(`   ${idx + 1}. [${(r.similarity * 100).toFixed(0)}%] ${r.content}`);
        });
        console.log('');

        // Test 3: List all test memories
        console.log('📋 Test 3: Listing all test memories...');
        const allMemories = await mem0.listMemories('test_user');
        console.log(`✅ Found ${allMemories.length} total memories for test_user\n`);

        // Test 4: Search system knowledge
        console.log('🔎 Test 4: Searching system knowledge...');
        const knowledgeResults = await mem0.searchMemories('How to craft a pickaxe?', {
            user_id: 'system',
            limit: 2,
        });
        console.log(`✅ Found ${knowledgeResults.length} knowledge memories:`);
        knowledgeResults.forEach((r, idx) => {
            console.log(`   ${idx + 1}. [${(r.similarity * 100).toFixed(0)}%] ${r.content.substring(0, 60)}...`);
        });
        console.log('');

        // Test 5: Test LLM integration (Azure Foundry)
        console.log('🤖 Test 5: Testing LLM integration with Azure Foundry...');
        const turns = [
            { role: 'user', content: 'What do I like to build?', name: 'test_user' },
        ];
        const systemMessage = 'You are Andy, a helpful Minecraft assistant.';

        console.log('   Calling Azure Foundry with memory context...');
        const response = await mem0.sendRequest(turns, systemMessage);
        console.log(`   Response: ${response.substring(0, 100)}...\n`);

        // Cleanup
        console.log('🧹 Cleaning up test memories...');
        await mem0.deleteMemory(memId);
        console.log('✅ Test memory deleted\n');

        console.log('✨ All tests passed!');

        await mem0.close();
    } catch (error) {
        console.error('❌ Test failed:', error);
        await mem0.close();
        process.exit(1);
    }
}

test();
