#!/usr/bin/env bun
/**
 * One oblique still of a bot's viewer scene - for LOOKING AT A BUILD.
 *
 *   bun tools/snapshot.mjs --port 3001 --out shots/house.png
 *   bun tools/snapshot.mjs --port 3001 --at 4716,68,4614 --dist 30 --yaw 135 --pitch 35
 *
 * Why not tools/timelapse.mjs: its only camera is `window.pv.birdCam`, which parks straight
 * overhead looking down. A roof from directly above is a flat rectangle - you cannot see
 * whether it has a pitch, whether the walls are the right height, whether the door is a hole
 * or a door. Reviewing a structure needs an OBLIQUE view, so this drives
 * `window.pv.viewer.camera` directly (the same patch timelapse relies on) instead of adding
 * another baked-in camera to node_modules, which `bun install` would wipe.
 *
 * --at defaults to the bot's own position, so the common case needs no coordinates.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire('/home/asanrivas/mindcraft/');
const puppeteer = require('puppeteer');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const port   = Number(arg('port', 3001));
const dist   = Number(arg('dist', 28));      // camera distance from the target
const yawDeg = Number(arg('yaw', 135));      // compass bearing the camera sits at
const pitDeg = Number(arg('pitch', 35));     // degrees above the horizon
const width  = Number(arg('width', 1280));
const tall   = Number(arg('tallpx', 800));
// Chunks have to arrive AND mesh before the first frame, or you photograph blue sky.
const warmup = Number(arg('warmup', 25));
const at     = arg('at', null);              // "x,y,z"; default = the bot
const outFile = path.resolve(arg('out', `recordings/snapshot-${port}-${Date.now()}.png`));
fs.mkdirSync(path.dirname(outFile), { recursive: true });

const log = (m) => console.log(`[snapshot] ${m}`);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width, height: tall });
page.on('pageerror', (e) => log(`page error: ${String(e).slice(0, 140)}`));

log(`loading viewer on :${port}`);
await page.goto(`http://localhost:${port}`, { waitUntil: 'load', timeout: 60000 });
if (!(await page.evaluate(() => typeof window.pv === 'object'))) {
    log('window.pv missing - run: bun tools/setup_viewer_assets.mjs');
    await browser.close();
    process.exit(2);
}
log(`warming up ${warmup}s for chunks to mesh`);
await new Promise((r) => setTimeout(r, warmup * 1000));

const placed = await page.evaluate(({ at, dist, yawDeg, pitDeg }) => {
    const v = window.pv.viewer, c = window.pv.controls;
    if (!v || !c) return null;
    const t = at ? { x: at[0], y: at[1], z: at[2] } : window.pv.botPos;
    if (!t) return null;
    const yaw = yawDeg * Math.PI / 180, pit = pitDeg * Math.PI / 180;
    const horiz = Math.cos(pit) * dist;
    c.target.set(t.x, t.y, t.z);
    v.camera.position.set(t.x + Math.sin(yaw) * horiz, t.y + Math.sin(pit) * dist, t.z + Math.cos(yaw) * horiz);
    v.camera.up.set(0, 1, 0);
    v.camera.lookAt(t.x, t.y, t.z);
    c.update();
    return t;
}, { at: at ? at.split(',').map(Number) : null, dist, yawDeg, pitDeg });

if (!placed) { log('no target: bot position never arrived and no --at given'); await browser.close(); process.exit(3); }
// let the render loop draw a few frames from the new pose
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: outFile, type: 'png' });
await browser.close();
log(`target=(${placed.x.toFixed(0)}, ${placed.y.toFixed(0)}, ${placed.z.toFixed(0)}) dist=${dist} yaw=${yawDeg} pitch=${pitDeg}`);
log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1e3).toFixed(0)} KB)`);
process.exit(0);
