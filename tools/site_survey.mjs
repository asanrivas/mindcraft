#!/usr/bin/env bun
/**
 * Where does a blueprint FIT? Rank real ground against its footprint.
 *
 *   bun tools/site_survey.mjs --blueprint blueprints/cathedral.json --around 4700,4650
 *   bun tools/site_survey.mjs --blueprint blueprints/cathedral.json --around 4700,4650 \
 *       --radius 256 --step 64 --sample 6 --top 5
 *
 *   --around x,z   centre of the search (defaults to the bot's spawn)
 *   --radius n     how far out to look, blocks (default 256)
 *   --step n       spacing between candidate centres (default 64)
 *   --sample n     footprint sampling stride (default 6; every column would be 7,590 reads)
 *   --top n        how many candidates to print in full (default 5)
 *   --wait n       seconds to wait for a teleport / chunk load (default 20)
 *   --allow-water n  tolerate this many watery/void sample columns (default 0)
 *   --allow-built n  tolerate this many BUILT sample columns (default 0, and leave it there)
 *
 * WHY THIS EXISTS. `blueprints/cathedral.json` is 69x110 in plan - 7,590 columns. Eyeballing that
 * from the air does not answer "is it flat", and the two tools we had cannot either: `!scanArea`
 * reports composition with no positions, and `tools/survey.mjs` probes single cells over RCON
 * (a 69x110 footprint is thousands of `execute if block` probes, and this server stops accepting
 * RCON connections after ~13 rapid ones). So: read the world through a bot, which has the chunks
 * in memory already, and use the same `nav.surfaceY` the navigator uses so "standable" means here
 * what it means everywhere else.
 *
 * READ-ONLY. It places nothing and digs nothing. The only thing it changes is where the probe bot
 * is standing - it teleports ITSELF (probe1 is an operator), which loads chunks around each
 * candidate. That is server work, so announce a large sweep.
 *
 * WHAT IT REPORTS, and why each line is a disqualifier rather than a score:
 *   built     a surface block that is not natural terrain - somebody's build, or one of ours.
 *             Never site a 35,000-block cathedral on top of it, however flat it is.
 *   water     the footprint crosses a river, lake or ocean. The builder does not drain.
 *   nosurface no standable column at all: void, a cave roof, or unloaded chunk.
 *   spread    max - min surface height over the samples. This is the number that decides how
 *             much terracing the build implies, and the builder does not terrace.
 */
import { Vec3 } from 'vec3';
import fs from 'fs';
import real from '../settings.js';
import { setSettings } from '../src/agent/settings.js';
import * as mc from '../src/utils/mcdata.js';
import { surfaceY } from '../src/agent/library/nav.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const log = (m) => console.log(`[site] ${m}`);

const bpPath = arg('blueprint', 'blueprints/cathedral.json');
const radius = Number(arg('radius', 256));
const step = Number(arg('step', 64));
const stride = Number(arg('sample', 6));
const topN = Number(arg('top', 5));
const waitS = Number(arg('wait', 20));
const allowWater = Number(arg('allow-water', 0));
const allowBuilt = Number(arg('allow-built', 0));

const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
const size = bp.meta?.size;
if (!size) { log(`${bpPath} has no meta.size - cannot know its footprint`); process.exit(2); }
const W = size.width, L = size.length;
log(`${bpPath}: ${bp.meta?.name ?? 'unnamed'}, footprint ${W}x${L}, ${bp.placements?.length ?? 0} blocks`);

// Natural surfaces only. A surface block outside this set means the footprint overlaps something
// that was built - by a player, or by one of our own bots - and the site is disqualified outright.
const NATURAL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'red_sand', 'gravel',
    'sandstone', 'red_sandstone', 'clay', 'moss_block', 'mud', 'packed_mud', 'snow_block', 'snow',
    'calcite', 'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta',
    'brown_terracotta', 'red_terracotta', 'light_gray_terracotta', 'ice', 'packed_ice', 'blue_ice']);
// Naturally GENERATED, so not evidence of a build - but not ground to measure a height from
// either. Counted with the canopy. The case that made this necessary: a wild pumpkin at
// (3922,64,4701) disqualified the flattest site found in a 113-candidate sweep as "built",
// which is the same false-positive shape as substring-matching a block name.
const WILD = new Set(['pumpkin', 'melon', 'cactus', 'sugar_cane', 'dead_bush', 'sweet_berry_bush',
    'brown_mushroom', 'red_mushroom', 'lily_pad', 'vine', 'snow', 'turtle_egg']);
const WATER = new Set(['water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
const CANOPY = /(_log|_wood|_leaves|mushroom_block|bamboo)$/;

/** Candidate footprint centres: a square grid, nearest the middle first. */
function candidates(cx, cz) {
    const out = [];
    for (let dx = -radius; dx <= radius; dx += step)
        for (let dz = -radius; dz <= radius; dz += step)
            out.push({ x: cx + dx, z: cz + dz, d: Math.hypot(dx, dz) });
    return out.filter(c => c.d <= radius).sort((a, b) => a.d - b.d);
}

async function teleportTo(bot, x, y, z) {
    bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
    const deadline = Date.now() + waitS * 1000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400));
        if (bot.entity.position.distanceTo(new Vec3(x, bot.entity.position.y, z)) < 8) return true;
    }
    return false;
}

/**
 * Wait until the footprint's corners and centre are readable. `blockAt` returning null is an
 * unloaded chunk, and treating that as "no surface" would reject good sites for being far away -
 * the same "a negative read is not evidence" trap the rest of this repo keeps paying for.
 */
async function waitForChunks(bot, x0, z0, y) {
    const probes = [[x0, z0], [x0 + W - 1, z0], [x0, z0 + L - 1], [x0 + W - 1, z0 + L - 1],
        [x0 + (W >> 1), z0 + (L >> 1)]];
    const deadline = Date.now() + waitS * 1000;
    while (Date.now() < deadline) {
        if (probes.every(([x, z]) => bot.blockAt(new Vec3(x, y, z)) !== null)) return true;
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

function assess(bot, x0, z0) {
    const heights = [];
    let built = 0, water = 0, nosurface = 0, canopy = 0, samples = 0;
    const builtAt = [];
    for (let x = x0; x < x0 + W; x += stride) {
        for (let z = z0; z < z0 + L; z += stride) {
            samples++;
            const y = surfaceY(bot, x, z, 140, 40);
            if (y === null) { nosurface++; continue; }
            const ground = bot.blockAt(new Vec3(x, y - 1, z));
            const feet = bot.blockAt(new Vec3(x, y, z));
            const name = ground?.name ?? '';
            if (WATER.has(name) || (feet && WATER.has(feet.name))) { water++; continue; }
            if (CANOPY.test(name) || WILD.has(name)) { canopy++; continue; }   // vegetation, not ground
            if (!NATURAL.has(name)) {
                built++;
                if (builtAt.length < 3) builtAt.push(`${name}@(${x},${y - 1},${z})`);
                continue;
            }
            heights.push(y);
        }
    }
    if (!heights.length) return { samples, built, water, nosurface, canopy, builtAt, usable: 0 };
    heights.sort((a, b) => a - b);
    const median = heights[heights.length >> 1];
    const within = (n) => heights.filter(h => Math.abs(h - median) <= n).length / heights.length;
    return {
        samples, built, water, nosurface, canopy, builtAt,
        usable: heights.length,
        median, min: heights[0], max: heights[heights.length - 1],
        spread: heights[heights.length - 1] - heights[0],
        flat1: within(1), flat2: within(2),
    };
}

/**
 * One number to sort by - but disqualifiers are NOT folded into it. A site with one built column
 * is not "slightly worse", it is unusable, and a score that averages that away is how a build ends
 * up on top of somebody's house.
 */
function score(a) {
    if (!a.usable) return -1;
    if (a.built > allowBuilt || a.water > allowWater || a.nosurface > allowWater) return -1;
    return a.flat1 * 100 - a.spread * 2 - (a.canopy / a.samples) * 10
        - (a.water + a.nosurface) * 3 - a.built * 20;
}

/**
 * How bad is a rejected site? A sweep that only says "no" 133 times teaches nothing about where to
 * look next, and the temptation is then to loosen the rules blindly. Rank the near misses by how
 * many columns actually disqualify them, weighting `built` hardest because it is the one that
 * cannot be traded away.
 */
function shortfall(a) {
    if (!a.usable) return Infinity;
    return a.built * 20 + a.water + a.nosurface + a.spread * 0.5;
}

setSettings({ ...real, minecraft_version: arg('version', '1.21.11') });
const bot = mc.initBot(arg('username', 'probe1'));
bot.on('kicked', (r) => { log(`kicked: ${r}`); process.exit(1); });
bot.on('error', (e) => log(`error: ${e.message}`));

bot.once('spawn', async () => {
    const here = bot.entity.position.floored();
    log(`spawned as ${bot.username} at ${here}`);
    const [cx, cz] = (arg('around', `${here.x},${here.z}`)).split(',').map(Number);
    const cands = candidates(cx, cz);
    log(`${cands.length} candidate centres within ${radius} of (${cx},${cz}), step ${step}; `
        + `sampling every ${stride} blocks = ${Math.ceil(W / stride) * Math.ceil(L / stride)} columns each`);

    const results = [];
    for (const c of cands) {
        const x0 = c.x - (W >> 1), z0 = c.z - (L >> 1);
        if (!(await teleportTo(bot, c.x, 140, c.z))) { log(`(${c.x},${c.z}) could not get there`); continue; }
        if (!(await waitForChunks(bot, x0, z0, 100))) { log(`(${c.x},${c.z}) chunks did not load`); continue; }
        const a = assess(bot, x0, z0);
        a.centre = c; a.origin = { x: x0, z: z0 };
        a.score = score(a);
        results.push(a);
        const why = a.score < 0
            ? `REJECTED (${[a.built && `${a.built} built`, a.water && `${a.water} water`,
                a.nosurface && `${a.nosurface} nosurface`].filter(Boolean).join(', ')})`
            : `flat±1 ${(a.flat1 * 100).toFixed(0)}%  spread ${a.spread}  y≈${a.median}`;
        log(`(${c.x},${c.z}) ${why}`);
    }

    const good = results.filter(r => r.score >= 0).sort((a, b) => b.score - a.score);
    console.log('');
    log(`${good.length} of ${results.length} candidates are usable at all`);
    for (const a of good.slice(0, topN)) {
        // The blueprint's y=0 layer is its own grass/dirt platform, so the ORIGIN y is the existing
        // ground's top block - not the standable cell above it - or the platform floats one block up.
        console.log(`  !buildBlueprint("${bpPath}", ${a.origin.x}, ${a.median - 1}, ${a.origin.z})`);
        console.log(`      centre (${a.centre.x},${a.centre.z})  flat±1 ${(a.flat1 * 100).toFixed(0)}%  `
            + `flat±2 ${(a.flat2 * 100).toFixed(0)}%  spread ${a.spread} (y ${a.min}-${a.max})  `
            + `canopy ${a.canopy}/${a.samples}  ${a.centre.d.toFixed(0)} blocks from the search centre`);
    }
    // ALWAYS rank the near misses, not only when nothing passes. Measured 2026-09-22: a 113
    // candidate sweep returned exactly one pass, with spread 20 (unbuildable), while three sites
    // were rejected on a SINGLE water or built column and their flatness was never printed. A
    // disqualifier is a yes/no about THIS footprint - shift it 32 blocks and the column may fall
    // outside - so hiding the rest of the numbers hides where to look next.
    const misses = results.filter(r => r.usable && r.score < 0)
        .sort((x, y) => shortfall(x) - shortfall(y)).slice(0, 8);
    if (misses.length) {
        log('closest misses (a disqualifier one column wide may fall outside a shifted footprint):');
        for (const a of misses) {
            log(`  (${a.centre.x},${a.centre.z}) y≈${a.median} spread ${a.spread} `
                + `flat±1 ${(a.flat1 * 100).toFixed(0)}%  built ${a.built} water ${a.water} `
                + `void ${a.nosurface} canopy ${a.canopy}/${a.samples}`
                + (a.builtAt.length ? `  [${a.builtAt[0]}]` : ''));
        }
    }
    if (!good.length) {
        log('nothing usable at these tolerances.');
        log('Trees are clearable, so a high canopy count is a real option; water is not drained '
            + 'and `built` must stay at 0.');
    }
    bot.quit();
});
