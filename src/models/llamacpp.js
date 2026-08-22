// Local llama.cpp / OpenAI-compatible server adapter.
// Uses /v1/chat/completions (llama.cpp does not fully support /v1/responses:
// assistant items 400 with "Cannot determine type of item").
import OpenAIApi from "openai";
import { strictFormat } from "../utils/text.js";

// The server is reached over an SSH tunnel from a Windows box, so "down" here means a dead
// socket, not an API error. Bound the wait: without a timeout a half-open tunnel hangs the
// request forever and the agent never gets to try its backup. Generous because a cold local
// model genuinely takes tens of seconds on first token.
const DEFAULT_TIMEOUT_MS = 120000;

export class LlamaCpp {
    static prefix = "llamacpp";

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = { ...(params || {}) };
        const timeout = this.params.timeout ?? DEFAULT_TIMEOUT_MS;
        delete this.params.timeout; // ours, not a completion parameter
        this.openai = new OpenAIApi({
            baseURL: url || "http://127.0.0.1:8000/v1",
            apiKey: "local",
            timeout,
            maxRetries: 0, // failover is handled by FallbackModel; retrying a dead tunnel wastes time
        });
    }

    /**
     * @throws on any failure. Callers wrap this in FallbackModel, which is the single place that
     * decides whether the local server is down and routes to the backup brain. Swallowing the
     * error here (it used to return "My brain disconnected") made that impossible to detect.
     */
    async sendRequest(turns, systemMessage, stop_seq = "***") {
        // system message must be first for the Qwen chat template
        const messages = [{ role: "system", content: systemMessage }].concat(strictFormat(turns));
        const pack = { model: this.model_name, messages, ...this.params };

        try {
            console.log("Awaiting local llm response from", this.model_name);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion.choices[0];
            const msg = choice.message || {};
            // thinking models may leave content empty and put text in reasoning_content
            let text = (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning_content || "");
            const i = text.indexOf(stop_seq);
            if (i !== -1) text = text.slice(0, i);
            if (!text.trim() && choice.finish_reason === "length") {
                text = "My response was cut off, try again.";
            }
            console.log("Received.");
            return text;
        } catch (err) {
            const status = err?.status || err?.code;
            if ((status === 400 || status === "context_length_exceeded") && turns.length > 1) {
                console.log("Local LLM rejected request, retrying with shorter context.");
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            throw err;
        }
    }
}
