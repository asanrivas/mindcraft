import { OpenAI } from 'openai';
const client = new OpenAI({ apiKey: 'test' });
console.log('OpenAI properties:', Object.keys(client));
if (client.chat) console.log('chat properties:', Object.keys(client.chat));
if (client.responses) console.log('responses properties:', Object.keys(client.responses));
