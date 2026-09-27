/**
 * Derive every context-sensitive limit from the model's actual window.
 *
 * These limits used to be scattered magic numbers (max_messages 30, memory cap 1000 chars,
 * output summary 500 chars, ...) all implicitly tuned for one context size. Swap the model or
 * change `-c` on the server and they silently stop making sense - either wasting most of the
 * window or overflowing it and triggering llama.cpp's reactive "drop the oldest turn and retry"
 * path, which burns a failed request per dropped turn.
 *
 * The window is read from the server at startup (llama.cpp reports the runtime `-c` value),
 * so changing `-c` is enough - nothing here needs editing by hand.
 *
 * Scaling is anchored to a verified baseline rather than to a theoretical percentage split;
 * see BASELINE below. Everything is clamped so a very small or very large window still yields
 * sane values.
 */

/** Rough chars-per-token for English + code. Good enough for budgeting; we never need exactness. */
export const CHARS_PER_TOKEN = 4;

/** Used when the model cannot tell us its window. */
export const DEFAULT_CONTEXT = 8192;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Baseline the scaling on a configuration that is known to work rather than on a theoretical
 * split. These are the values in force at 16k after this round of tuning and verification;
 * everything scales linearly from here, so changing `-c` on the server moves all of them
 * together and 16k keeps exactly the behaviour that was tested.
 *
 * Deliberately NOT proportional-to-fill: a 9B degrades as the window fills (context rot -
 * associative recall on 8B-class models falls off well before the nominal limit), so a bigger
 * window should buy headroom and safety margin, not automatically more history.
 */
const BASELINE_CTX = 16384;
const BASELINE = {
    max_tokens: 1024,           // enough for a multi-command reply; 300 truncated mid-command
    max_messages: 30,
    summary_chunk_size: 5,
    memory_chars: 1000,
    relevant_docs_count: 5,
    num_examples: 2,
    action_output_chars: 500,
    behavior_log_chars: 500,
};

/**
 * @param {number} n_ctx - the model's usable context window in tokens.
 * @returns {object} derived limits, scaled from the verified 16k baseline.
 */
export function computeBudget(n_ctx) {
    const ctx = (Number.isFinite(n_ctx) && n_ctx > 0) ? n_ctx : DEFAULT_CONTEXT;
    const k = ctx / BASELINE_CTX;
    // History grows more slowly than the window on purpose (sqrt): doubling context should not
    // double how much stale conversation the model has to read past.
    const kHist = Math.sqrt(k);

    const max_tokens = clamp(BASELINE.max_tokens * k, 256, 4096);
    const input = ctx - max_tokens;

    return {
        n_ctx: ctx,
        scale: Math.round(k * 100) / 100,
        max_tokens,
        input_budget: input,
        max_messages: clamp(BASELINE.max_messages * kHist, 10, 120),
        summary_chunk_size: clamp(BASELINE.summary_chunk_size * kHist, 3, 25),
        memory_chars: clamp(BASELINE.memory_chars * k, 500, 8000),
        relevant_docs_count: clamp(BASELINE.relevant_docs_count * k, 3, 20),
        num_examples: clamp(BASELINE.num_examples * kHist, 1, 8),
        action_output_chars: clamp(BASELINE.action_output_chars * k, 300, 4000),
        behavior_log_chars: clamp(BASELINE.behavior_log_chars * k, 250, 2000),
    };
}

/**
 * Ask an OpenAI-compatible server what context it was actually started with.
 * llama.cpp reports the runtime `-c` value in /v1/models -> data[0].meta.n_ctx, which is what
 * matters (not the model's trained maximum).
 * @param {string} baseUrl e.g. http://127.0.0.1:8000/v1
 * @param {number} timeoutMs
 * @returns {Promise<number|null>}
 */
export async function probeContextLimit(baseUrl, timeoutMs = 4000, modelId = null) {
    if (!baseUrl) return null;
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const body = await res.json();
        const entries = body?.data || [];
        // llama.cpp reports the runtime window under meta.n_ctx; OpenAI-compatible hosts
        // such as Fireworks report it per-model as context_length. Prefer the entry matching
        // the model we are actually using, else fall back to the first.
        const match = modelId ? entries.find(e => e?.id && modelId.includes(e.id)) : null;
        const entry = match || entries[0];
        const n_ctx = entry?.meta?.n_ctx ?? entry?.context_length;
        return Number.isFinite(n_ctx) && n_ctx > 0 ? n_ctx : null;
    } catch {
        return null; // server may not expose it, or may not be reachable yet
    } finally {
        clearTimeout(timer);
    }
}

let active = computeBudget(DEFAULT_CONTEXT);

/** The budget currently in force. */
export function getBudget() {
    return active;
}

/**
 * Probe the model and install the derived budget into the shared settings object.
 * Explicit user values in settings win - auto-scaling should never silently override a
 * deliberate choice.
 * @param {object} settings - the live settings object (mutated in place).
 * @param {object} profile - the agent profile (its model.params.max_tokens is filled in).
 */
export async function applyContextBudget(settings, profile) {
    const url = profile?.model?.url;
    const probed = await probeContextLimit(url, 4000, profile?.model?.model);
    const declared = settings.context_limit;
    // context_limit is an upper BOUND, not just a fallback. Some hosted models advertise
    // enormous windows (deepseek-v4-flash reports 1,048,576); scaling the prompt to fill
    // that would be both wasteful and expensive per turn on a paid endpoint.
    let n_ctx = probed || declared || DEFAULT_CONTEXT;
    if (declared && probed && probed > declared) {
        console.log(`[ContextBudget] model advertises ${probed}; capping at context_limit=${declared}`);
        n_ctx = declared;
    }
    active = computeBudget(n_ctx);

    const source = probed ? `probed from ${url}` : (declared ? 'settings.context_limit' : 'default');
    console.log(`[ContextBudget] n_ctx=${active.n_ctx} (${source}) -> `
        + `max_tokens=${active.max_tokens}, max_messages=${active.max_messages}, `
        + `memory=${active.memory_chars}ch, docs=${active.relevant_docs_count}, `
        + `examples=${active.num_examples}`);

    if (settings.auto_scale_context === false) {
        console.log('[ContextBudget] auto_scale_context disabled; keeping configured values.');
        return active;
    }

    // Only fill values the user left on "auto".
    const autoSet = (key, value) => {
        if (settings[key] === 'auto' || settings[key] === undefined || settings[key] === null) {
            settings[key] = value;
        }
    };
    autoSet('max_messages', active.max_messages);
    autoSet('num_examples', active.num_examples);
    autoSet('relevant_docs_count', active.relevant_docs_count);

    // Every model in the chain, not just the primary. A backup left on "auto" reaches its
    // server as the string and 400s - so the failover the whole FallbackModel exists to
    // provide would fail at exactly the moment it was needed, and only then.
    const resolveAuto = (entry) => {
        if (entry?.params && entry.params.max_tokens === 'auto') {
            entry.params.max_tokens = active.max_tokens;
        }
    };
    resolveAuto(profile?.model);
    const backups = profile?.backup_model;
    if (Array.isArray(backups)) backups.forEach(resolveAuto);
    else resolveAuto(backups);
    return active;
}
