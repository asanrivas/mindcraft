#!/usr/bin/env bun
/**
 * Teach prismarine-viewer to render this server's Minecraft version.
 *
 *   bun tools/setup_viewer_assets.mjs            # 1.21.11
 *   bun tools/setup_viewer_assets.mjs 1.21.11
 *
 * WHY: the viewer ships textures and block states only up to 1.21.4, and its prebuilt browser
 * bundle only carries minecraft-data for those versions. Against a 1.21.11 server that means
 * 107 block types render as the wrong block or vanish - pale oak, copper chests, copper golem
 * statues, firefly bush, cactus flower, leaf litter, wildflowers, dried ghast, dry grass, the
 * whole shelf family.
 *
 * Everything this does lives in node_modules, so `bun install` wipes it. Re-run this script
 * afterwards. It is idempotent.
 *
 * Steps: fetch assets -> build atlas + block states -> install them -> register the version ->
 * expose window.pv for tools/timelapse.mjs -> rebuild the browser bundles.
 */
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const VERSION = process.argv[2] || '1.21.11';
const ROOT = path.resolve(import.meta.dir, '..');
const PV = path.join(ROOT, 'node_modules/prismarine-viewer');
const CACHE = path.join(ROOT, '.viewer-assets-cache');
const require = createRequire(path.join(ROOT, '/'));
const say = (m) => console.log(`[viewer-assets] ${m}`);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (!fs.existsSync(PV)) { console.error('prismarine-viewer is not installed'); process.exit(1); }

// 1. minecraft-assets carries the raw textures/models. Kept out of the project's own
//    dependencies because it unpacks to ~142MB for every Minecraft version ever.
if (!fs.existsSync(path.join(CACHE, 'node_modules/minecraft-assets'))) {
    say('fetching minecraft-assets (~142MB, one time)');
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, 'package.json'), '{"name":"viewer-assets-cache","private":true}\n');
    run('bun', ['add', 'minecraft-assets@1.19.0'], CACHE);
}
const dataDir = path.join(CACHE, 'node_modules/minecraft-assets/minecraft-assets/data', VERSION);
if (!fs.existsSync(dataDir)) { console.error(`minecraft-assets has no data for ${VERSION}`); process.exit(1); }

// 2. Build the atlas and block states. Do NOT go through `require('minecraft-assets')(VERSION)`:
//    its own version table stops at 1.21.8, so it silently hands back the wrong directory.
//    The generators only need these three fields.
const mcAssets = {
    version: VERSION,
    directory: dataDir,
    blocksStates: require(path.join(dataDir, 'blocks_states.json')),
    blocksModels: require(path.join(dataDir, 'blocks_models.json')),
};
const { makeTextureAtlas } = require(path.join(PV, 'viewer/lib/atlas.js'));
const { prepareBlocksStates } = require(path.join(PV, 'viewer/lib/modelsBuilder.js'));

say(`building atlas for ${VERSION}`);
const atlas = makeTextureAtlas(mcAssets);
fs.writeFileSync(path.join(PV, 'public/textures', `${VERSION}.png`), atlas.canvas.toBuffer('image/png'));
const states = prepareBlocksStates(mcAssets, atlas);
fs.writeFileSync(path.join(PV, 'public/blocksStates', `${VERSION}.json`), JSON.stringify(states));
fs.rmSync(path.join(PV, 'public/textures', VERSION), { recursive: true, force: true });
fs.cpSync(dataDir, path.join(PV, 'public/textures', VERSION), { recursive: true });
say(`installed ${Object.keys(states).length} block states + texture atlas`);

// 3. Register the version, or the client keeps falling back to the newest it knows.
const verFile = path.join(PV, 'viewer/lib/version.js');
let v = fs.readFileSync(verFile, 'utf8');
if (!v.includes(`'${VERSION}'`)) {
    v = v.replace(/(\n?const supportedVersions = \[[^\]]*)\]/, `$1, '${VERSION}']`);
    fs.writeFileSync(verFile, v);
    say(`registered ${VERSION} in supportedVersions`);
}

// 4. Expose the scene graph. The client keeps `viewer`/`controls` module-local and only aims
//    the orbit camera at the bot once, so tools/timelapse.mjs has nothing to drive without this.
const idxFile = path.join(PV, 'lib/index.js');
let idx = fs.readFileSync(idxFile, 'utf8');
if (!idx.includes('window.pv')) {
    idx = idx.replace(
        'let controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)',
        `let controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)

window.pv = {
  viewer,
  get controls () { return controls },
  botPos: null,
  birdCam (height = 60) {
    const p = window.pv.botPos
    if (!p || !controls) return false
    controls.target.set(p.x, p.y, p.z)
    viewer.camera.position.set(p.x, p.y + height, p.z + 0.01)
    viewer.camera.up.set(0, 1, 0)
    viewer.camera.lookAt(p.x, p.y, p.z)
    controls.update()
    return true
  }
}`);
    idx = idx.replace('    if (pos.y > 0 && firstPositionUpdate) {',
        '    window.pv.botPos = { x: pos.x, y: pos.y, z: pos.z }\n    if (pos.y > 0 && firstPositionUpdate) {');
    fs.writeFileSync(idxFile, idx);
    say('patched lib/index.js to expose window.pv');
}

// 5. Rebuild the browser bundles so they carry minecraft-data for this version and the patch
//    above. The worker bundle is the slow one (~4.5 min, 121MB); the index bundle is ~6s.
if (!fs.existsSync(path.join(PV, 'node_modules/webpack'))) {
    say('installing webpack into prismarine-viewer (one time)');
    run('bun', ['add', '-d', 'webpack@^5', 'webpack-cli@^6'], PV);
}
say('rebuilding browser bundles - the worker bundle takes several minutes');
run(path.join(PV, 'node_modules/.bin/webpack'), [], PV);

say(`done. Restart the bot, then check the log for "Using version: ${VERSION}".`);
