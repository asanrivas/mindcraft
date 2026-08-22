#!/usr/bin/env node
/**
 * Version parity harness: connect the SAME observer client to the SAME server
 * twice - once as 1.21.11 (protocol 774, what the live mineflayer bot uses)
 * and once as 26.1 (protocol 775, what the server actually is) - and diff
 * what each decodes at IDENTICAL absolute world coordinates.
 *
 * This is the experiment that decides the whole project's premise. Two
 * possible outcomes, both valuable:
 *
 *   - Blocks DISAGREE -> the version skew genuinely corrupts the world view,
 *     which is very likely also what breaks collision/onGround. Owning the
 *     client (or lifting mineflayer's version gate) fixes real damage.
 *   - Blocks AGREE -> the 774/775 chunk formats are compatible, so the skew
 *     is NOT what breaks movement, and the cause is elsewhere (most likely
 *     server-side movement validation - see docs/CLIENT_REPLACEMENT.md
 *     riskiest assumption #1). That would redirect the effort before months
 *     are spent on the wrong layer.
 *
 * Runs sequentially, not concurrently: the server whitelist has a limited set
 * of names and two clients with the same username would collide.
 *
 *   node tools/parity_versions.mjs --username amy --center " -2141,100,212"
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const username = arg('username', 'amy');
const center = arg('center', null);
const radius = arg('radius', '6');
const seconds = arg('seconds', '20');
const versions = (arg('versions', '1.21.11,26.1')).split(',');

if (!center) {
    console.error('--center "x,y,z" is required: a bot-relative sample is not comparable between runs.');
    process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-parity-'));
const snaps = {};

for (const version of versions) {
    const out = path.join(tmp, `snap-${version}.json`);
    console.log(`\n--- observing as ${version} ---`);
    const res = spawnSync('node', [
        new URL('./observe.mjs', import.meta.url).pathname,
        '--version', version,
        '--username', username,
        '--seconds', seconds,
        '--radius', radius,
        '--center', center,
        '--json', out,
    ], { stdio: 'inherit' });

    if (res.status !== 0 || !fs.existsSync(out)) {
        console.error(`\nFAILED to get a snapshot for ${version} - cannot compare.`);
        process.exit(1);
    }
    snaps[version] = JSON.parse(fs.readFileSync(out, 'utf8'));
}

const [a, b] = versions;
const snapA = snaps[a];
const snapB = snaps[b];

const keys = [...new Set([...Object.keys(snapA.blocks), ...Object.keys(snapB.blocks)])].sort();
const disagreements = [];
let bothKnown = 0;
let onlyA = 0;
let onlyB = 0;

for (const key of keys) {
    const va = snapA.blocks[key];
    const vb = snapB.blocks[key];
    // null means "column not loaded" - not a decode disagreement, just a
    // coverage difference. Counting those as mismatches would drown the real
    // signal, so they are reported separately.
    if (va === null && vb === null) continue;
    if (va === null) { onlyB++; continue; }
    if (vb === null) { onlyA++; continue; }
    bothKnown++;
    if (va !== vb) disagreements.push({ key, [a]: va, [b]: vb });
}

console.log('\n\n================ PARITY REPORT ================');
console.log(`versions compared:      ${a}  vs  ${b}`);
console.log(`sample center:          ${center}   radius ${radius}`);
console.log(`blocks known to both:   ${bothKnown}`);
console.log(`known only to ${a}: ${onlyA}`);
console.log(`known only to ${b}: ${onlyB}`);
console.log(`DISAGREEMENTS:          ${disagreements.length}`);

if (disagreements.length) {
    console.log('\nfirst 25 disagreements:');
    for (const d of disagreements.slice(0, 25)) {
        console.log(`  ${d.key.padEnd(20)} ${a}=${String(d[a]).padEnd(22)} ${b}=${d[b]}`);
    }
    const pct = ((disagreements.length / bothKnown) * 100).toFixed(2);
    console.log(`\nVERDICT: the two protocol versions decode the world DIFFERENTLY (${pct}% of shared blocks).`);
    console.log('The version skew corrupts the world view - owning the client fixes real damage.');
} else if (bothKnown === 0) {
    console.log('\nVERDICT: INCONCLUSIVE - no block was loaded by both runs. Widen --radius or pick a --center near spawn.');
} else {
    console.log('\nVERDICT: identical block decode across both protocol versions.');
    console.log('The 774/775 chunk formats agree, so the version skew is NOT corrupting the world view.');
    console.log('=> Movement breakage is very likely NOT a chunk/collision-data problem.');
    console.log('   See docs/CLIENT_REPLACEMENT.md riskiest assumption #1 (server-side movement validation).');
}

console.log('\nentity counts:  ' + `${a}=${snapA.entityCount}  ${b}=${snapB.entityCount}`);
console.log('loaded columns: ' + `${a}=${snapA.loadedColumns}  ${b}=${snapB.loadedColumns}`);
console.log(`decode errors:  ${a}=${JSON.stringify(snapA.decodeErrors)}  ${b}=${JSON.stringify(snapB.decodeErrors)}`);
console.log(`\nraw snapshots kept in ${tmp}`);
