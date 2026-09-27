/**
 * Headless-browser resolution tests. No browser, no network:
 *   bun tests/browser_path.test.mjs
 *
 * What these pin, and why it needed a test rather than a comment: the camera was dead on an
 * aarch64 host because puppeteer's cached Chrome was an x86-64 binary, filed under a directory
 * named `linux_arm-152.0.7977.42`. Every check short of executing it passed - the path existed,
 * it was a regular file, it had the execute bit. So the ordering and the failure CLASSIFICATION
 * are the whole mechanism, and both are pure functions here.
 *
 * The launch loop is exercised with a fake puppeteer, so a machine with no browser at all (CI)
 * still runs every branch.
 */
import { browserCandidates, isUnrunnableError, launchBrowser, HEADLESS_GL_ARGS } from '../src/agent/vision/browser_path.js';

let failures = 0;
const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); failures++; }
};

const never = () => false;
const always = () => true;

// --- candidate ordering ---------------------------------------------------------------------
{
    // Puppeteer's own browser is version-matched to the installed puppeteer, so where it works
    // it IS the right answer. It must come before any system browser.
    const c = browserCandidates({}, 'linux', always);
    check('bundled browser is tried first', c[0] === undefined);
    check('system browsers follow it', c.length > 1 && typeof c[1] === 'string');
    check('chromium precedes google-chrome on linux',
        c.indexOf('/usr/bin/chromium') < c.indexOf('/usr/bin/google-chrome'));
}
{
    // An operator who sets the variable knows something we do not - it outranks the bundle.
    const c = browserCandidates({ PUPPETEER_EXECUTABLE_PATH: '/opt/my/chrome' }, 'linux', always);
    check('PUPPETEER_EXECUTABLE_PATH wins outright', c[0] === '/opt/my/chrome');
    check('and the bundle is still tried after it', c.includes(undefined));
}
{
    const c = browserCandidates({ CHROME_PATH: '/opt/chrome' }, 'linux', never);
    check('CHROME_PATH is honoured too', c[0] === '/opt/chrome');
}
{
    // NOT filtered by existsSync: if an operator's explicit path is wrong, the error must name
    // THEIR path rather than silently falling through as though they had set nothing.
    const c = browserCandidates({ PUPPETEER_EXECUTABLE_PATH: '/nope/chrome' }, 'linux', never);
    check('an explicit path is kept even when absent', c[0] === '/nope/chrome');
}
{
    const both = browserCandidates({ PUPPETEER_EXECUTABLE_PATH: '/x', CHROME_PATH: '/x' }, 'linux', never);
    check('duplicate candidates are collapsed', both.filter(p => p === '/x').length === 1);
}

// --- every platform gets somewhere to look --------------------------------------------------
{
    const linux = browserCandidates({}, 'linux', always);
    const mac = browserCandidates({}, 'darwin', always);
    const win = browserCandidates({}, 'win32', always);
    check('linux has system candidates', linux.some(p => typeof p === 'string'));
    check('darwin has system candidates', mac.some(p => typeof p === 'string' && p.includes('.app')));
    check('win32 has system candidates', win.some(p => typeof p === 'string' && p.endsWith('.exe')));
    // An unknown platform must still yield the bundled browser rather than an empty list -
    // returning nothing would turn "we did not recognise your OS" into "you have no browser".
    const weird = browserCandidates({}, 'freebsd', always);
    check('an unknown platform still tries the bundle', weird.length >= 1 && weird.includes(undefined));
}
{
    const none = browserCandidates({}, 'linux', never);
    check('with nothing installed, only the bundle is offered', none.length === 1 && none[0] === undefined);
}

// --- failure classification -----------------------------------------------------------------
// This is the distinction that decides whether to keep trying browsers or stop and report.
{
    check('ENOEXEC is unrunnable', isUnrunnableError(Object.assign(new Error('spawn'), { code: 'ENOEXEC' })));
    check('the real aarch64 message is unrunnable',
        isUnrunnableError(new Error("ENOEXEC: unknown error, posix_spawn '/home/u/.cache/puppeteer/chrome/linux_arm-152/chrome-linux64/chrome'")));
    check('ENOENT is unrunnable', isUnrunnableError({ code: 'ENOENT' }));
    check('puppeteer\'s own wording is unrunnable', isUnrunnableError(new Error('Could not find Chrome (ver. 131)')));
    check('Failed to launch is unrunnable', isUnrunnableError(new Error('Failed to launch the browser process')));
    // A browser that started and then objected is not an architecture problem.
    check('a protocol timeout is NOT unrunnable', !isUnrunnableError(new Error('Timed out waiting for the debugger')));
    check('null is not unrunnable', !isUnrunnableError(null));
}

// --- the launch loop ------------------------------------------------------------------------
/** @param {(path: string|undefined) => any} behaviour */
function fakePuppeteer(behaviour) {
    const tried = [];
    return {
        tried,
        launch: async (opts) => {
            tried.push(opts.executablePath);
            const r = behaviour(opts.executablePath);
            if (r instanceof Error) throw r;
            return r;
        },
    };
}
const enoexec = () => Object.assign(new Error('ENOEXEC: posix_spawn'), { code: 'ENOEXEC' });

{
    const pp = fakePuppeteer(() => ({ ok: true }));
    const { browser, executablePath } = await launchBrowser(pp, {}, { env: {}, platform: 'linux', exists: always });
    check('a working bundle is used and nothing else is tried', browser.ok === true && pp.tried.length === 1);
    check('and it reports no system path', executablePath === undefined);
}
{
    // The aarch64 case: the bundle cannot exec, a system browser can.
    const pp = fakePuppeteer((p) => (p === undefined ? enoexec() : { ok: true }));
    const { browser, executablePath, attempts } = await launchBrowser(pp, {}, { env: {}, platform: 'linux', exists: always });
    check('an unrunnable bundle falls through to a system browser', browser.ok === true);
    check('and the system path is reported for the log', executablePath === '/usr/bin/chromium');
    check('the failed attempt is recorded', attempts.length === 1 && /ENOEXEC/.test(attempts[0].reason));
}
{
    // A non-arch failure must NOT march through every browser on the machine.
    const pp = fakePuppeteer(() => new Error('Timed out waiting for the debugger'));
    let err = null;
    try { await launchBrowser(pp, {}, { env: {}, platform: 'linux', exists: always }); } catch (e) { err = e; }
    check('a non-arch failure stops after the first candidate', pp.tried.length === 1);
    check('and it still throws', err !== null);
}
{
    const pp = fakePuppeteer(() => enoexec());
    let err = null;
    try { await launchBrowser(pp, {}, { env: {}, platform: 'linux', exists: always }); } catch (e) { err = e; }
    check('all candidates failing throws', err !== null);
    check('the error names every candidate tried', err && pp.tried.every(p => err.message.includes(p || 'bundled')));
    check('and says how to fix it', err && /PUPPETEER_EXECUTABLE_PATH/.test(err.message));
    check('it never returns a browser-shaped placeholder', err instanceof Error);
}
{
    // Caller options must survive; the resolver only decides the executable.
    const pp = fakePuppeteer(() => ({ ok: true }));
    await launchBrowser(pp, { headless: true, args: HEADLESS_GL_ARGS }, { env: {}, platform: 'linux', exists: never });
    check('software-GL fallback is permitted', HEADLESS_GL_ARGS.includes('--enable-unsafe-swiftshader'));
    // Forcing swiftshader would drag a GPU host down to software rendering for no reason.
    check('but software rendering is not forced', !HEADLESS_GL_ARGS.some(a => a.startsWith('--use-gl=')));
    check('sandbox flags are kept for containers', HEADLESS_GL_ARGS.includes('--no-sandbox'));
}

if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('PASS: headless browser resolution correct');
