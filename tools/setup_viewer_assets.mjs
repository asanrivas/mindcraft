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
import { createHash } from 'crypto';
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

// 5. Keep three's legacy side-effect shim, or the viewer renders a BLACK SCREEN.
//
//    `lib/index.js` line 5 is a bare `require('three/examples/js/controls/OrbitControls')`
//    whose exports are never used - the module exists only for its last line,
//    `THREE.OrbitControls = OrbitControls`. three's package.json declares
//    `"sideEffects": false`, so webpack 5 tree-shakes that module away entirely and leaves
//    the call site at line 23 with nothing defining it:
//
//      pageerror: THREE.OrbitControls is not a constructor
//
//    That throw lands BETWEEN `new Viewer(renderer)` (line 21) and `window.pv = {...}`
//    (line 25), so the canvas is created and then nothing is ever drawn on it: no socket
//    handlers, no render loop, no window.pv. Measured 2026-09-22 against the live viewer -
//    `typeof THREE.OrbitControls === 'undefined'`, `window.viewer === undefined`, and an
//    all-black 800x512 screenshot. It is NOT darkness; it looks identical at noon.
//
//    The prebuilt bundle prismarine-viewer ships was not built by webpack 5, which is why
//    this appears only after step 6 has run once. Marking that path side-effectful is the
//    whole fix. Appended after the config's own object literals so nothing has to be parsed.
const wpFile = path.join(PV, 'webpack.config.js');
let wp = fs.readFileSync(wpFile, 'utf8');
if (!wp.includes('mindcraft: keep three')) {
    wp = wp.replace('module.exports = [indexConfig, workerConfig]',
        `// PATCHED (mindcraft: keep three's legacy examples/js shims). three declares
// "sideEffects": false, so webpack 5 drops the OrbitControls shim that lib/index.js needs
// and the viewer renders black. See tools/setup_viewer_assets.mjs step 5.
indexConfig.module = indexConfig.module || {}
indexConfig.module.rules = (indexConfig.module.rules || []).concat([
  { include: /three[\\/\\\\]examples[\\/\\\\]js/, sideEffects: true }
])

module.exports = [indexConfig, workerConfig]`);
    fs.writeFileSync(wpFile, wp);
    say('patched webpack.config.js to keep three/examples/js side effects');
}

// 6. Rebuild the browser bundles so they carry minecraft-data for this version and the patches
//    above. The worker bundle is the slow one (~4.5 min, 121MB); the index bundle is ~6s.
//
//    Invoked through THIS runtime rather than through `node_modules/.bin/webpack`. That shim
//    starts `#!/usr/bin/env node`, so on a host running the project under bun with no `node`
//    on PATH the whole step died with `env: 'node': No such file or directory` - after the
//    atlas had already been installed, which made it look like the rebuild had succeeded.
//    SKIPPED WHEN NOTHING CHANGED, because this build is the most expensive thing in the
//    repo. Measured 2026-09-22 on a 2-core 11.9GB arm64 host that also runs the Minecraft
//    server (2.7GB): webpack peaked at 5.5-5.7GB RSS and drove available memory down to
//    809MB, at which point another session killed it to save the box. Re-running it when the
//    output would be byte-identical spends that for nothing.
//
//    webpack's own `output.compareBeforeEmit` already avoids REWRITING an identical file -
//    which is why worker.js can keep an older mtime after a successful build - but it still
//    does the whole build to find that out. The stamp below skips the build itself.
//
//    Fingerprint, not mtime: mtimes change when `bun install` reinstalls identical files.
const stampFile = path.join(PV, 'public/.mindcraft-stamp.json');
const fingerprint = () => {
    const h = createHash('sha256');
    h.update(VERSION);
    for (const f of ['lib/index.js', 'webpack.config.js', 'viewer/lib/version.js']) {
        h.update(fs.readFileSync(path.join(PV, f)));
    }
    // Bundle size, so a truncated or half-written bundle never counts as current.
    for (const b of ['public/index.js', 'public/worker.js']) {
        const p2 = path.join(PV, b);
        h.update(String(fs.existsSync(p2) ? fs.statSync(p2).size : 0));
    }
    return h.digest('hex');
};
const bundlesExist = ['public/index.js', 'public/worker.js'].every(b => fs.existsSync(path.join(PV, b)));
let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* absent or corrupt */ }
const current = bundlesExist && stamp && stamp.fingerprint === fingerprint();

if (current && !process.env.VIEWER_FORCE_REBUILD) {
    say(`browser bundles already current for ${VERSION} - skipping the rebuild `
        + '(set VIEWER_FORCE_REBUILD=1 to force it)');
} else {
    if (!fs.existsSync(path.join(PV, 'node_modules/webpack'))) {
        say('installing webpack into prismarine-viewer (one time)');
        run(process.argv0 === 'bun' ? 'bun' : process.execPath, ['add', '-d', 'webpack@^5', 'webpack-cli@^6'], PV);
    }
    say('rebuilding browser bundles - the worker bundle takes several minutes and peaks near 6GB');
    const wpCli = path.join(PV, 'node_modules/webpack-cli/bin/cli.js');
    run(process.execPath, [wpCli], PV);
    // Written only after webpack returns 0, so a killed build is never recorded as current.
    fs.writeFileSync(stampFile, JSON.stringify({ version: VERSION, fingerprint: fingerprint(), at: new Date().toISOString() }, null, 2));
}

say(`done. Restart the bot, then check the log for "Using version: ${VERSION}".`);
