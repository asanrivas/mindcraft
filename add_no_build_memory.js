/**
 * Add "don't build/destroy" memory for asanrivas
 */

import { Mem0Local } from './src/models/mem0_local.js';

async function addMemory() {
    console.log('Adding no-build zone memory to Mem0...\n');

    const mem0 = new Mem0Local('claude-haiku-4-5', 'https://asan-miygeha8-westcentralus.services.ai.azure.com/models', {
        agent_name: 'andy',
        embedding_model: 'http://127.0.0.1:31234',
    });

    try {
        // Add restriction memory for asanrivas
        const memId = await mem0.addMemory(
            'asanrivas instructed: Do not build or destroy anything near coordinates x:1883, y:66, z:-2780 (beach area). This is a protected zone.',
            {
                user_id: 'asanrivas',
                category: 'rule',
                metadata: {
                    location: 'x:1883, y:66, z:-2780',
                    type: 'building_restriction',
                    importance: 'critical'
                }
            }
        );
        console.log(`✅ Added memory: ${memId}`);
        console.log('   Category: rule');
        console.log('   User: asanrivas');
        console.log('   Location: x:1883, y:66, z:-2780\n');

        // Verify it was saved
        console.log('Verifying memory was saved...');
        const memories = await mem0.listMemories('asanrivas');
        console.log(`✅ Found ${memories.length} memories for asanrivas:`);
        memories.forEach(m => {
            console.log(`   - ${m.content.substring(0, 80)}...`);
        });

        await mem0.close();
        console.log('\n✅ Memory saved successfully!');
        console.log('\nAndy will now remember this restriction when talking to asanrivas.');
    } catch (error) {
        console.error('❌ Failed:', error);
        await mem0.close();
        process.exit(1);
    }
}

addMemory();
