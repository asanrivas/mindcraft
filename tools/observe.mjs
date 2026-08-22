#!/usr/bin/env node
/**
 * Run the observer client against a server and report what it sees.
 *
 * This is the M2 deliverable made usable: connect read-only, decode the
 * world, and print a snapshot. Its whole reason for existing is that it can
 * connect as **26.1 (protocol 775)** - the server's real version - which the
 * live mineflayer bot cannot, because mineflayer's testedVersions gate stops
 * at 1.21.11. Comparing the two is how we find out whether the version skew
 * is actually what breaks movement.
 *
 *   node tools/observe.mjs --version 26.1 --username observer1
 *   node tools/observe.mjs --version 1.21.11 --seconds 20 --json out.json
 *
 * NOTE: this joins the server as a real player. Use a username that is not
 * one of the live bots (andy/bob), and expect it to occupy a player slot.
 */
import fs from 'fs';
import { Vec3 } from 'vec3';
import { Observer } from '../src/mc/observer.js';
import settings from '../settings.js';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const options = {
    host: arg('host', settings.host),
    port: Number(arg('port', settings.port)),
    username: arg('username', 'observer'),
    version: arg('version', '26.1'),
    auth: arg('auth', settings.auth),
};
const seconds = Number(arg('seconds', 15));
const jsonOut = arg('json', null);
const radius = Number(arg('radius', 3));

// Absolute world coords to sample, e.g. --center " -2141,100,212". Without
// this the sample is bot-relative, which is NOT comparable between two runs:
// two clients stand in different places, so differing block counts would just
// reflect differing positions rather than any decode disagreement.
const centerArg = arg('center', null);
const center = centerArg
    ? (() => {
        const [x, y, z] = centerArg.split(',').map((n) => Number(n.trim()));
        return new Vec3(x, y, z);
    })()
    : null;

console.log(`[observe] connecting to ${options.host}:${options.port} as "${options.username}" using version ${options.version}`);

const observer = new Observer(options).connect();

let sawSpawn = false;
observer.on('login', (info) => {
    console.log(`[observe] login ok - dimension=${info.dimension} gameMode=${info.gameMode} minY=${info.minY} height=${info.height}`);
});
observer.on('spawn', (pos) => {
    sawSpawn = true;
    console.log(`[observe] spawned at ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);
});
observer.on('warning', (msg) => console.warn(`[observe] warning: ${msg}`));
observer.on('kicked', (packet) => console.error('[observe] kicked:', JSON.stringify(packet).slice(0, 300)));
observer.on('error', (err) => console.error('[observe] error:', err.message));
observer.on('end', (reason) => console.log('[observe] connection ended:', reason ?? '(no reason)'));

const timer = setTimeout(() => {
    const snap = observer.snapshot({ radius, center });
    const solidCount = Object.values(snap.blocks).filter((n) => n && n !== 'air' && n !== 'cave_air').length;

    console.log('\n=== observer snapshot ===');
    console.log(`spawned:          ${sawSpawn}`);
    console.log(`dimension:        ${snap.dimension}`);
    console.log(`loaded columns:   ${snap.loadedColumns}`);
    console.log(`world generation: ${snap.generation}`);
    console.log(`entities:         ${snap.entityCount}`);
    console.log(`blocks sampled:   ${Object.keys(snap.blocks).length} (${solidCount} non-air)`);
    const decodeErrors = Object.entries(snap.decodeErrors);
    if (decodeErrors.length) {
        console.log('decode errors:');
        for (const [name, count] of decodeErrors) console.log(`  ${name}: ${count}`);
    } else {
        console.log('decode errors:   none');
    }

    if (observer.position) {
        const below = observer.world.blockAt(observer.position.offset(0, -1, 0));
        console.log(`block below me:   ${below ? below.name : '(unknown - column not loaded)'}`);
    }

    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify(snap, null, 2));
        console.log(`\nwrote ${jsonOut}`);
    }

    observer.end();
    // The socket can keep the loop alive briefly after end(); nothing left to do.
    setTimeout(() => process.exit(sawSpawn ? 0 : 1), 500);
}, seconds * 1000);
if (typeof timer.unref === 'function') { /* keep it armed; we want the timeout */ }
