import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

/**
 * DigitalOcean GradientAI serverless inference (OpenAI-compatible).
 *
 * Endpoint: https://inference.do-ai.run/v1   Key: DIGITALOCEAN_API_KEY (a `doo_v1_...` token)
 *
 * Serves 72 models under plain, UNqualified ids - `deepseek-4-flash`, `llama-4-maverick`,
 * `openai-gpt-5-mini`, `anthropic-claude-opus-5`. Unlike Fireworks there is no `accounts/...`
 * prefix to bolt on, so the model name is passed straight through.
 *
 * Two things measured against Andy's real ~7.6k-token prompt on 2026-08-26:
 *
 *  - **Some models are tier-locked, and they fail with 403, not 404.** `anthropic-claude-haiku-4.5`
 *    returned `{"message":"this model is not available for your subscription tier","type":
 *    "forbidden_error"}` in 886ms. That is an *authorization* failure on an otherwise healthy
 *    endpoint, so it must NOT open the fallback circuit breaker - the provider is up, this one
 *    model is simply not ours to call. It just throws and the chain moves on.
 *
 *  - **The reasoning-model empty-reply trap applies here too.** `openai-gpt-oss-120b` burned all
 *    512 completion tokens on hidden reasoning and returned `finish_reason: 'length'` with
 *    content `''` after 26.7s. Same handling as Fireworks: throw rather than return the empty
 *    string, because a placeholder reads as success and stops the FallbackModel chain.
 *
 * Measured latency on that prompt: llama-4-maverick 2.7s, deepseek-4-flash 10.0s.
 */
export class DigitalOcean {
    static prefix = 'digitalocean';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        this.openai = new OpenAIApi({
            baseURL: url || 'https://inference.do-ai.run/v1',
            apiKey: getKey('DIGITALOCEAN_API_KEY'),
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || 'deepseek-4-flash',
            messages,
            stop: stop_seq,
            max_tokens: 4096,
            ...this.params,
        };

        let res = null;
        try {
            console.log(`Awaiting digitalocean api response... (${pack.model})`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion.choices[0];
            if (choice.finish_reason === 'length' && !choice.message.content) {
                throw new Error('Context length exceeded');
            }
            console.log('Received.');
            res = choice.message.content;
            if (!res || !res.trim()) {
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
        throw new Error('Embeddings are not supported by the DigitalOcean provider.');
    }
}
