// Local llama.cpp / OpenAI-compatible server adapter.
// Uses /v1/chat/completions (llama.cpp does not fully support /v1/responses:
// assistant items 400 with "Cannot determine type of item").
import OpenAIApi from "openai";
import { strictFormat } from "../utils/text.js";

export class LlamaCpp {
    static prefix = "llamacpp";

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.openai = new OpenAIApi({
            baseURL: url || "http://127.0.0.1:8000/v1",
            apiKey: "local",
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = "***") {
        // system message must be first for the Qwen chat template
        const messages = [{ role: "system", content: systemMessage }].concat(strictFormat(turns));
        const pack = { model: this.model_name, messages, ...this.params };

        let res = null;
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
            res = text;
        } catch (err) {
            const status = err?.status || err?.code;
            if ((status === 400 || status === "context_length_exceeded") && turns.length > 1) {
                console.log("Local LLM rejected request, retrying with shorter context.");
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            }
            console.log(err);
            res = "My brain disconnected, try again.";
        }
        return res;
    }
}
