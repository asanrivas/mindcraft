import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

/**
 * Fireworks AI (OpenAI-compatible).
 *
 * Used here as the backup brain when the local llama-server tunnel is unavailable.
 * Model ids are fully qualified, e.g.
 *   accounts/fireworks/models/deepseek-v4-flash-0731
 *
 * Note these are reasoning models: they spend completion tokens on hidden reasoning before
 * emitting any content. With a small max_tokens the whole budget goes to reasoning and the
 * reply comes back EMPTY (observed: max_tokens=20 -> 20 reasoning tokens, content ''). So the
 * default here is generous and reasoning_effort defaults to 'low', which is plenty for
 * issuing Minecraft commands and keeps latency down.
 */
export class Fireworks {
    static prefix = 'fireworks';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        const config = {
            baseURL: url || 'https://api.fireworks.ai/inference/v1',
            apiKey: getKey('FIREWORKS_API_KEY'),
        };
        this.openai = new OpenAIApi(config);
    }

    _qualify(name) {
        if (!name) return 'accounts/fireworks/models/deepseek-v4-flash-0731';
        return name.startsWith('accounts/') ? name : `accounts/fireworks/models/${name}`;
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this._qualify(this.model_name),
            messages,
            stop: stop_seq,
            max_tokens: 1024,
            reasoning_effort: 'low',
            ...this.params,
        };

        let res = null;
        try {
            console.log(`Awaiting fireworks api response... (${pack.model})`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion.choices[0];
            if (choice.finish_reason === 'length' && !choice.message.content) {
                // Ran out of budget mid-reasoning, so nothing was actually said.
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = choice.message.content;
            if (!res || !res.trim()) {
                // Throwing rather than returning a placeholder: as a backup brain this sits in a
                // FallbackModel chain, and a placeholder string reads as success, stopping the
                // chain before the next provider is tried.
                throw new Error('Empty content returned; reasoning consumed the token budget. Raise max_tokens.');
            }
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            throw err;
        }
        return res;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by the Fireworks provider.');
    }
}
