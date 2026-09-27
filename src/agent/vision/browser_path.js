import fs from 'fs';

/**
 * Finding a headless browser that can actually RUN on this machine.
 *
 * Why this is not just `puppeteer.launch()`: puppeteer's cached download can be for the wrong
 * CPU architecture, and the path still exists, so every check short of executing it passes.
 * Measured on an aarch64 host 2026-09-22 - both cached builds were x86-64 ELF, including the
 * one puppeteer had filed under an ARM-looking name:
 *
 *   ~/.cache/puppeteer/chrome/linux-127.0.6533.88/.../chrome       ELF 64-bit ... x86-64
 *   ~/.cache/puppeteer/chrome/linux_arm-152.0.7977.42/.../chrome   ELF 64-bit ... x86-64
 *
 * `posix_spawn` then fails with ENOEXEC, `Camera._launch()` rejects, and the camera disables
 * itself for the life of the process - three log lines per restart and no vision at all.
 *
 * The rule here is CLAUDE.md's: measure the thing you are concluding about. Do not inspect the
 * path, the arch string or the ELF header and reason about whether it would run - TRY TO LAUNCH
 * IT, and move to the next candidate when it fails. A wrong-arch binary fails in milliseconds,
 * so the attempt costs nothing.
 *
 * Order matters. Puppeteer's own bundled browser is tried FIRST on purpose: it is version-
 * matched to the installed puppeteer, so where it works it is the right answer, and a system
 * browser is the fallback rather than the default. An explicit environment override outranks
 * both, because an operator who set it knows something we do not.
 */

/** Ordered system browser paths per platform. Nothing here is required to exist. */
const SYSTEM_BROWSERS = {
    linux: [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
        '/usr/bin/brave-browser',
    ],
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
};

/**
 * Flags that let a headless browser render WebGL on a machine with no GPU.
 *
 * `--enable-unsafe-swiftshader` and NOT `--use-gl=swiftshader`: newer Chrome refuses the
 * software rasteriser unless the former is passed, and without any software fallback the
 * prismarine-viewer canvas comes back BLACK on a headless server - the same symptom as a
 * broken bundle, from a completely different cause. Forcing `--use-gl=swiftshader` would also
 * work here but would drag a GPU-equipped host down to software rendering for no reason, so
 * this only permits the fallback rather than mandating it.
 */
export const HEADLESS_GL_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader'];

/**
 * Candidate executables, best first. Pure, so the ordering is testable without a browser.
 *
 * `undefined` means "let puppeteer choose its own bundled browser" and is a real candidate,
 * not a placeholder - it is how a normal install gets its version-matched Chrome.
 *
 * @param {Object} [env]       defaults to process.env
 * @param {string} [platform]  defaults to process.platform
 * @param {(p: string) => boolean} [exists]  path test, injectable for tests
 * @returns {Array<string|undefined>}
 */
export function browserCandidates(env = process.env, platform = process.platform, exists = fs.existsSync) {
    const out = [];
    const push = (p) => { if (!out.includes(p)) out.push(p); };

    // An operator's explicit choice wins outright, and is NOT filtered by `exists`: if someone
    // set it and it is wrong, the error should name their path rather than silently ignoring it.
    if (env.PUPPETEER_EXECUTABLE_PATH) push(env.PUPPETEER_EXECUTABLE_PATH);
    if (env.CHROME_PATH) push(env.CHROME_PATH);

    push(undefined);   // puppeteer's own, version-matched

    for (const p of (SYSTEM_BROWSERS[platform] || [])) {
        if (exists(p)) push(p);
    }
    return out;
}

/** Did this failure mean "that binary cannot run here" rather than "the browser said no"? */
export function isUnrunnableError(err) {
    const msg = String(err?.message || err || '');
    if (['ENOEXEC', 'ENOENT', 'EACCES'].includes(err?.code)) return true;
    return /ENOEXEC|ENOENT|EACCES|not exist|Could not find|no such file|Failed to launch/i.test(msg);
}

/**
 * Launch the first candidate that actually starts.
 *
 * @param {Object} puppeteer            the puppeteer module (injected, so tests need no browser)
 * @param {Object} [launchOpts]         passed through to puppeteer.launch
 * @param {Object} [deps]               {env, platform, exists} overrides for testing
 * @returns {Promise<{browser: Object, executablePath: string|undefined, attempts: Array}>}
 * @throws  an Error naming every candidate and why it failed
 */
export async function launchBrowser(puppeteer, launchOpts = {}, deps = {}) {
    const candidates = browserCandidates(deps.env, deps.platform, deps.exists);
    const attempts = [];

    for (const executablePath of candidates) {
        const label = executablePath || 'puppeteer bundled browser';
        try {
            const browser = await puppeteer.launch({ ...launchOpts, executablePath });
            return { browser, executablePath, attempts };
        } catch (err) {
            attempts.push({ label, reason: String(err?.message || err).split('\n')[0].slice(0, 160) });
            // A browser that launched and then refused something is not an architecture
            // problem, and trying six more copies of Chrome will not help. Stop and report.
            if (!isUnrunnableError(err)) break;
        }
    }

    const detail = attempts.map(a => `  ${a.label}: ${a.reason}`).join('\n');
    throw new Error(
        'No usable headless browser. Tried:\n' + detail
        + '\nInstall one (apt: chromium; brew: --cask chromium) or set PUPPETEER_EXECUTABLE_PATH.'
    );
}
