#!/usr/bin/env bun
/**
 * Record a top-down timelapse of a bot from the prismarine-viewer scene.
 *
 *   bun tools/timelapse.mjs --seconds 1800 --interval 5   # --height defaults to 16
 *
 * Writes recordings/timelapse-<port>-<timestamp>.mp4 unless you pass --out.
 *
 * Why it works this way
 * --------------------
 * The viewer's browser client keeps `viewer` and `controls` as module locals, and third-person
 * mode aims `controls.target` at the bot only on the FIRST position update - so a headless
 * screenshotter has no way to place the camera, and the bot walks out of frame within seconds.
 * `lib/index.js` is patched to expose `window.pv` (see CLAUDE.md, "Recording a run"); this tool
 * parks the camera directly above the bot before every frame, which is what makes it a
 * follow-cam rather than a fixed shot of wherever the run started.
 *
 * COST: headless Chromium has no GPU here, so the viewer's WebGL runs on SwiftShader - about
 * 6.7 of this machine's 8 cores while the scene renders. That is why frames are taken on an
 * interval rather than continuously. Shorten `--interval` only while watching server tick health.
 *
 * Requires `viewer_first_person: false` in settings.js - a first-person viewer DISPOSES the
 * OrbitControls this depends on - and a bot restart after changing it.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const require = createRequire('/home/asanrivas/mindcraft/');
const puppeteer = require('puppeteer');

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const port = Number(arg('port', 3000));
const seconds = Number(arg('seconds', 600));
const interval = Number(arg('interval', 5));     // seconds between frames
// 16, not 70. At 70 the bot is a two-pixel speck - measured by shooting the same scene at
// 10/16/24/40: 10 is so tight you lose all terrain context, 40+ makes the bot unreadable.
// 16 keeps the bot clearly legible with enough ground around it to see where it is going.
const height = Number(arg('height', 16));        // blocks above the bot
const fps = Number(arg('fps', 12));              // playback rate
const width = Number(arg('width', 960));
const tall = Number(arg('tallpx', 600));
// Default somewhere durable and findable. The frames go to /tmp, but the finished video is
// the deliverable - writing it to a scratch directory means losing it to the next cleanup.
const outFile = path.resolve(arg('out', `recordings/timelapse-${port}-${Date.now()}.mp4`));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const frameDir = arg('frames', `/tmp/timelapse-frames-${port}`);
// Chunks have to arrive and mesh before the first frame, or you record blue sky.
const warmup = Number(arg('warmup', 25));

fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });

const log = (m) => console.log(`[timelapse] ${m}`);

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width, height: tall });
page.on('pageerror', (e) => log(`page error: ${String(e).slice(0, 120)}`));

log(`loading viewer on :${port}`);
await page.goto(`http://localhost:${port}`, { waitUntil: 'load', timeout: 60000 });
log(`warming up ${warmup}s for chunks to mesh`);
await new Promise((r) => setTimeout(r, warmup * 1000));

const exposed = await page.evaluate(() => typeof window.pv === 'object');
if (!exposed) {
    log('window.pv is missing - lib/index.js is not patched, or public/index.js predates the patch.');
    await browser.close();
    process.exit(2);
}

const total = Math.max(1, Math.floor(seconds / interval));
let taken = 0, unplaced = 0;
for (let i = 0; i < total; i++) {
    const placed = await page.evaluate((h) => window.pv.birdCam(h), height);
    // Give the render loop a couple of frames to draw from the new camera pose.
    await new Promise((r) => setTimeout(r, 250));
    const file = path.join(frameDir, `f${String(i).padStart(6, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
    taken++;
    if (!placed) unplaced++;
    if (i % 12 === 0) {
        const pos = await page.evaluate(() => window.pv.botPos);
        log(`frame ${i + 1}/${total}${pos ? ` bot=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})` : ' bot=?'}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, interval * 1000 - 250)));
}
await browser.close();
log(`captured ${taken} frames (${unplaced} before the bot reported a position)`);

await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-framerate', String(fps), '-i', path.join(frameDir, 'f%06d.jpg'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile], { stdio: 'ignore' });
    ff.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
});
log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB, ${(taken / fps).toFixed(1)}s at ${fps}fps)`);
process.exit(0);
