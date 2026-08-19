import { AzureOpenAI } from "openai";
import { getKey, hasKey } from '../utils/keys.js';
import { GPT } from './gpt.js'

export class AzureGPT extends GPT {
    static prefix = 'azure';
    constructor(model_name, url, params) {
        super(model_name, url)

        this.model_name = model_name;
        this.params = params || {};

        const config = {};

        if (url)
            config.endpoint = url;

        config.apiKey = hasKey('AZURE_OPENAI_API_KEY') ? getKey('AZURE_OPENAI_API_KEY') : getKey('OPENAI_API_KEY');

        config.deployment = model_name;

        if (this.params.apiVersion) {
            config.apiVersion = this.params.apiVersion;
        }
        else {
            throw new Error('apiVersion is required in params for azure!');
        }

        console.log('[Azure Config Debug]');
        console.log('  endpoint:', config.endpoint);
        console.log('  deployment:', config.deployment);
        console.log('  apiVersion:', config.apiVersion);
        console.log('  apiKey:', config.apiKey ? `${config.apiKey.substring(0, 8)}...` : 'NOT SET');

        this.openai = new AzureOpenAI(config)
    }

    async sendRequest(turns, systemMessage) {
        let messages = [{role: 'system', content: systemMessage}, ...turns];
        let res = null;
        try {
            console.log(`Awaiting Azure OpenAI response from ${this.model_name}...`)
            const requestParams = { ...this.params };
            delete requestParams.apiVersion;

            // GPT-5 and newer models use max_completion_tokens instead of max_tokens
            if (this.model_name.includes('gpt-5') || this.model_name.includes('o1') || this.model_name.includes('o3')) {
                if (requestParams.max_tokens) {
                    requestParams.max_completion_tokens = requestParams.max_tokens;
                    delete requestParams.max_tokens;
                }
            }

            const completion = await this.openai.chat.completions.create({
                model: this.model_name,
                messages: messages,
                ...requestParams
            });
            console.log('Received.')
            res = completion.choices[0].message.content;
        }
        catch (err) {
            console.error(err);
            res = "My brain disconnected, try again.";
        }
        return res;
    }
}
