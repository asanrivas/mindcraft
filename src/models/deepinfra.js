import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

/**
 * Deep Infra (OpenAI-compatible), chat and embeddings.
 *
 *   "model": { "api": "deepinfra", "model": "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo" }
 *   "embedding": { "api": "deepinfra", "model": "BAAI/bge-large-en-v1.5" }
 *
 * Model ids are the vendor's fully-qualified `org/name` strings and are passed through
 * untouched - there is no short-name table here on purpose. Deep Infra serves 194 models as
 * of 2026-09-22 and renames them faster than a table could track; a stale alias would resolve
 * to a model that no longer exists and fail as an opaque 404 mid-conversation.
 *
 * THE DEFAULT IS A NON-REASONING MODEL, DELIBERATELY. Measured against this account on
 * 2026-09-22 with max_tokens=60, one command-issuing turn:
 *
 *   meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo   finish=stop     content "/tp 4412 64 4934"
 *   deepseek-ai/DeepSeek-V4-Flash-0731             finish=stop     content, cheapest of the three
 *   Qwen/Qwen3-32B                                 finish=length   content ''  <- all 60 tokens
 *                                                                                 went to hidden
 *                                                                                 reasoning
 *
 * That last row is the failure fireworks.js already documents, reproduced on a second
 * provider: a reasoning model spends the completion budget before emitting any content, so a
 * small max_tokens returns an EMPTY string rather than an error. Pick a reasoning model here
 * only with a generous max_tokens, and read the thrown message below when it comes back blank.
 */
export class DeepInfra {
    static prefix = 'deepinfra';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        this.openai = new OpenAIApi({
            baseURL: url || 'https://api.deepinfra.com/v1/openai',
            apiKey: getKey('DEEPINFRA_API_KEY'),
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
            messages,
            stop: stop_seq,
            ...this.params,
        };

        let res = null;
        try {
            console.log(`Awaiting deepinfra api response... (${pack.model})`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion.choices[0];
            if (choice.finish_reason === 'length' && !choice.message.content) {
                // Budget exhausted with nothing said. Treated as a context problem so the
                // shorter-context retry below gets a turn at it.
                throw new Error('Context length exceeded');
            }
            res = choice.message.content;
            if (!res || !res.trim()) {
                // Throw, never return a placeholder string. CLAUDE.md: a placeholder reads as
                // SUCCESS to FallbackModel and stops the failover chain, so an outage here
                // would look like the bot simply talking nonsense. Name the likely cause -
                // hidden reasoning - because that is what an empty body means in practice, and
                // the reasoning text is not in `content` where the agent could see it.
                const reasoned = !!choice.message.reasoning_content;
                throw new Error('Empty content returned by ' + pack.model
                    + (reasoned ? ' - the whole token budget went to hidden reasoning. Raise max_tokens or use a non-reasoning model.'
                                : ' - no content and no reasoning; check the model id.'));
            }
            console.log('Received.');
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            // Everything else goes up as-is: fallback.js is the ONLY place that decides whether
            // a provider is down, and it classifies from the error it is handed.
            throw err;
        }
        return res;
    }

    /**
     * Deep Infra does serve embeddings, so this is real rather than a throw. 1024 dims from
     * the default, measured 2026-09-22. `model_name` is used when present because an embedding
     * instance is constructed from the profile's `embedding` entry, same convention as gpt.js.
     */
    async embed(text) {
        if (text.length > 8191) text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'BAAI/bge-large-en-v1.5',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}
