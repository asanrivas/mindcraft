import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        config.baseURL = url || 'https://openrouter.ai/api/v1';

        const apiKey = getKey('OPENROUTER_API_KEY');
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
        }

        // Pass the API key to OpenAI compatible Api
        config.apiKey = apiKey; 

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='*') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        // Choose a valid model from openrouter.ai (for example, "openai/gpt-4o")
        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq,
            ...this.params,
        };

        let res = null;
        try {
            console.log('Awaiting openrouter api response...');
            let completion = await this.openai.chat.completions.create(pack);
            if (!completion?.choices?.[0]) {
                throw new Error('No completion or choices returned');
            }
            const choice = completion.choices[0];
            res = choice.message?.content;
            if (!res || !res.trim()) {
                // Reasoning models spend the completion budget on hidden reasoning and can
                // return EMPTY content - measured on stealth/ox-alpha: 200 tokens consumed,
                // content ''. Raise max_tokens rather than shipping the blank.
                throw new Error(`Empty content (finish_reason=${choice.finish_reason}, `
                    + `completion_tokens=${completion.usage?.completion_tokens}) - raise max_tokens`);
            }
            console.log('Received.');
        } catch (err) {
            // THROW, never return a placeholder. A placeholder string reads as SUCCESS to
            // FallbackModel and stops the chain before the next backup is ever tried - the
            // exact bug fireworks.js and llamacpp.js already had (docs/LLM_FAILOVER.md 4).
            throw err;
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Openrouter.');
    }
}