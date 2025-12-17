import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

export class Foundry {
    static prefix = 'foundry';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};

        // Extract resource name from URL if provided
        // URL format: https://resource-name.services.ai.azure.com/anthropic/
        if (url) {
            const match = url.match(/https:\/\/([^.]+)\.services\.ai\.azure\.com/);
            if (match) {
                config.resource = match[1];
            } else {
                // If URL doesn't match expected pattern, use it as baseURL
                config.baseURL = url;
            }
        }

        config.apiKey = getKey('AZURE_FOUNDRY_API_KEY');

        console.log('[Foundry] Initializing Azure AI Foundry client');
        if (config.resource) {
            console.log('  resource:', config.resource);
        } else if (config.baseURL) {
            console.log('  baseURL:', config.baseURL);
        }
        console.log('  deployment:', this.model_name);

        this.client = new AnthropicFoundry(config);
    }

    async sendRequest(turns, systemMessage) {
        const messages = strictFormat(turns);
        let res = null;
        try {
            console.log(`Awaiting Foundry response from ${this.model_name}...`)

            // Set default max_tokens if not provided
            let max_tokens = this.params.max_tokens;
            if (!max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    max_tokens = this.params.thinking.budget_tokens + 1000;
                } else {
                    max_tokens = 4096;
                }
            }

            // Filter out apiVersion from params since Foundry SDK doesn't use it
            const requestParams = { ...this.params };
            delete requestParams.apiVersion;
            requestParams.max_tokens = max_tokens;

            const resp = await this.client.messages.create({
                model: this.model_name,
                system: systemMessage,
                messages: messages,
                ...requestParams
            });

            console.log('Received.')

            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Foundry.';
            }
        }
        catch (err) {
            if (err.message.includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        return res;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Foundry.');
    }
}
