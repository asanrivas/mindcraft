/**
 * Pure helpers shared between `scratchpad/obedience_ab.mjs` (the live, model-dependent
 * A/B harness) and `tests/obedience_contract.test.mjs` (the offline doc-contract test).
 *
 * Split out on purpose: the test file must never import `obedience_ab.mjs` directly, because
 * that script has top-level side effects (chdir, a live LlamaCpp request) that would run a
 * network call during `bun run test`. Everything here is data in, data out.
 */
import { createHash } from 'node:crypto';

/** Stable fingerprint of a rendered command-docs string. */
export function hashDocs(docs) {
    return createHash('sha256').update(docs).digest('hex');
}

/**
 * Is the last recorded obedience run (`scratchpad/obedience.last.json`, per-machine and
 * gitignored) still trustworthy for the CURRENT rendered docs - and if so, did it pass?
 *
 * Four branches, all reachable without a model:
 *   - 'unmeasured' - no prior run recorded at all (fresh clone, or harness never run).
 *   - 'stale'      - a prior run exists but the docs have changed since (hash mismatch).
 *                    Non-fatal: the harness needs a live LLM box (amyasan) whose whole
 *                    premise on this branch is that it is routinely unavailable, so an
 *                    unmeasured change must not block unrelated commits.
 *   - 'fresh-pass' - docs unchanged since the last run, and that run met the score bar.
 *   - 'fresh-fail' - docs unchanged since the last run, and that run fell short: a REAL,
 *                    measured regression, and the only branch that should fail a build.
 *
 * @param {string} currentHash - hashDocs() of the docs as rendered right now.
 * @param {{docsHash?: string, score?: number}|null|undefined} last - parsed obedience.last.json.
 * @param {{minScore?: number}} [opts]
 * @returns {'unmeasured'|'stale'|'fresh-pass'|'fresh-fail'}
 */
export function obedienceVerdict(currentHash, last, { minScore = 7 } = {}) {
    if (!last || typeof last.docsHash !== 'string') return 'unmeasured';
    if (last.docsHash !== currentHash) return 'stale';
    return (typeof last.score === 'number' && last.score >= minScore) ? 'fresh-pass' : 'fresh-fail';
}
