import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

const BLANK = 'about:blank';
// How long to keep the viewer loaded after a capture, in case more follow.
const KEEP_WARM_MS = 30000;
// Time for the viewer's socket.io connection to pull chunks before the first shot.
const WARMUP_MS = 2500;

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
        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
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
        await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
        this.loaded = true;
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
        // let the viewer catch up to the bot's latest position/orientation
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
