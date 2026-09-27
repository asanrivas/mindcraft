import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { EventEmitter } from 'events';
import { launchBrowser, HEADLESS_GL_ARGS } from './browser_path.js';

const BLANK = 'about:blank';
// How long to keep the viewer loaded after a capture, in case more follow.
const KEEP_WARM_MS = 30000;
// Fallback only, for a viewer without the window.pv patch (see _ensureLoaded).
const WARMUP_MS = 2500;
// How many scene children mean "terrain has actually arrived".
//
// Measured against the live viewer 2026-09-22, sampling window.pv.viewer.scene.children
// from page load:
//   t=0.5s -> 15    t=1.5s -> 14    t=2.5s -> 14    t=6s -> 14    t=9s -> 10    t=13s -> 140
// The scaffolding (sky, lights, entities) is ~10-15 objects and is there almost immediately;
// the chunk meshes land in a burst somewhere after 9s and take the count to 140+. Note the
// count is NOT monotonic - it dips to 10 before the burst - so this threshold sits well clear
// of the baseline rather than watching for growth.
//
// The old fixed 2500ms sleep fired squarely in the flat part of that curve, so every capture
// returned a uniform sky-blue JPEG. That was invisible until the browser fix landed, because
// before it the camera never launched at all.
const READY_MIN_CHILDREN = 25;
// Ceiling on that wait. Chunk delivery depends on the server, the render distance and the
// host's CPU, so a slow machine must not hang the action - it gets a warning and a picture.
// 30s, not 20s: two cold captures on the same host crossed the threshold at ~13s and ~16.4s,
// which left only 3.6s of headroom under a 20s ceiling. The cost of the wider ceiling is paid
// only on a genuine failure, and only once per KEEP_WARM_MS window.
const READY_TIMEOUT_MS = 30000;
// Chunks keep meshing after the threshold is crossed; this lets the burst finish.
const SETTLE_MS = 700;

export class Camera extends EventEmitter {
    constructor (bot, fp, port = 3000) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.port = port;
        this.width = 800;
        this.height = 512;
        this.disabled = false;
        this.loaded = false;      // is the viewer page currently rendering?
        this._idleTimer = null;
        this._launch().then(() => {
            this.emit('ready');
        }).catch((err) => {
            console.warn('Camera initialization failed:', err.message);
            this.disabled = true;
            this.emit('error', err);
        });
    }

    async _launch () {
        // Not `puppeteer.launch()` directly: its cached download can be for the wrong CPU
        // architecture while the path still exists, which fails at posix_spawn with ENOEXEC and
        // disabled the camera for the whole process life on an aarch64 host. browser_path.js
        // tries puppeteer's own browser first and falls back to a system one, deciding by
        // LAUNCHING each candidate rather than by reasoning about its path.
        const { browser, executablePath } = await launchBrowser(puppeteer, {
            headless: true,
            args: HEADLESS_GL_ARGS,
        });
        this.browser = browser;
        if (executablePath) console.log(`[Camera] using system browser ${executablePath}`);
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: this.width, height: this.height });
        // Deliberately do NOT load the viewer here. Headless Chromium has no GPU, so WebGL
        // runs through SwiftShader on the CPU; leaving the prismarine-viewer scene loaded
        // keeps a three.js render loop software-rasterising a 3D world forever. Measured at
        // ~670% CPU (about 6.7 cores) sustained, for screenshots taken minutes apart.
        await this.page.goto(BLANK);
    }

    /** Bring the viewer up only when we actually need pixels. */
    async _ensureLoaded () {
        if (this.loaded) return;
        await this.page.goto(`http://localhost:${this.port}`, { waitUntil: 'load', timeout: 15000 });
        await this._waitForTerrain();
        this.loaded = true;
    }

    /**
     * Wait for the world to be in the scene, rather than for a fixed number of milliseconds.
     * Sleeping a constant is guessing; the scene graph says when chunks have actually arrived.
     */
    async _waitForTerrain () {
        // window.pv is installed by tools/setup_viewer_assets.mjs. Without it there is nothing
        // to measure, so fall back to the old sleep rather than pretend we checked.
        const patched = await this.page.evaluate(() => typeof window.pv !== 'undefined');
        if (!patched) {
            console.warn('[Camera] viewer is not patched with window.pv - falling back to a fixed '
                + 'warmup, which may capture an empty sky. Run: bun tools/setup_viewer_assets.mjs');
            await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
            return;
        }
        try {
            await this.page.waitForFunction(
                (min) => (window.pv?.viewer?.scene?.children?.length ?? 0) >= min,
                { timeout: READY_TIMEOUT_MS, polling: 250 },
                READY_MIN_CHILDREN
            );
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        } catch {
            // Say what is wrong and with what evidence. A silent sky-blue screenshot is the
            // failure this whole path exists to stop, so it must never pass unremarked.
            const n = await this.page.evaluate(() => window.pv?.viewer?.scene?.children?.length ?? -1);
            console.warn(`[Camera] terrain did not load within ${READY_TIMEOUT_MS}ms `
                + `(scene.children=${n}, wanted >=${READY_MIN_CHILDREN}) - capturing anyway; `
                + 'the image may be empty sky.');
        }
    }

    /** Drop back to a blank page so nothing renders while idle. */
    async _unload () {
        if (!this.loaded) return;
        this.loaded = false;
        try {
            await this.page.goto(BLANK);
        } catch (err) {
            console.warn('Camera unload failed:', err.message);
        }
    }

    _scheduleUnload () {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            this._idleTimer = null;
            this._unload();
        }, KEEP_WARM_MS);
        if (this._idleTimer.unref) this._idleTimer.unref();
    }

    async capture () {
        if (this.disabled) {
            throw new Error('Camera is disabled - headless browser not available');
        }
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }

        await this._ensureLoaded();
        // Still needed on the WARM path, where the page was already loaded and only the bot's
        // position/orientation has moved on. _ensureLoaded's settle covers the cold path.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        await this._ensureScreenshotDirectory();
        const buf = await this.page.screenshot({ type: 'jpeg', quality: 90 });
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);

        this._scheduleUnload();
        return filename;
    }

    async close () {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this.browser) {
            try { await this.browser.close(); } catch { /* already gone */ }
            this.browser = null;
        }
    }

    async _ensureScreenshotDirectory () {
        try {
            await fs.access(this.fp);
        } catch (e) {
            await fs.mkdir(this.fp, { recursive: true });
        }
    }
}
