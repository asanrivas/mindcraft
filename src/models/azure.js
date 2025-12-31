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
            delete this.params.apiVersion;
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
}
