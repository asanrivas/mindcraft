/**
 * The case the user asked for: a FULL single chest and a FULL double chest, and a transfer
 * between them.
 *
 *   bun scratchpad/chest_full.mjs srcfull      27 stacks -> empty double   (should all move)
 *   bun scratchpad/chest_full.mjs bothfull     27 stacks -> full double    (should refuse honestly)
 *   bun scratchpad/chest_full.mjs partial      !chestTake of a part-stack  (the right-click path)
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';
const SINGLE = { x: 4532, y: 111, z: 4704 };
const DOUBLE = { x: 4536, y: 111, z: 4704 };
const RIGHT = { x: 4537, y: 111, z: 4704 };

function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}
async function command(text, waitMs) {
    const before = fs.statSync(LOG).size;
    let delivered = false;
    for (let a = 0; a < 3 && !delivered; a++) {
        await send(`msg andy ${text}`);
        for (let p = 0; p < 12 && !delivered; p++) {
            await sleep(400);
            delivered = since(before).includes(`received message from Rcon : ${text}`);
        }
    }
    if (!delivered) say('  !! never delivered');
    await sleep(waitMs);
    for (const l of since(before).split('\n')
        .filter(l => /\[andy\]|\[chest\]/.test(l) && !/torch_placing|IdleBehavior/.test(l)))
        say('   ' + l.replace(/^\[[^\]]+\] /, '').trim());
}

/** Count occupied slots of one block entity, 0..26. */
async function used(pos) {
    let n = 0;
    for (let s = 0; s < 27; s++) {
        const out = await send(`data get block ${pos.x} ${pos.y} ${pos.z} Items[{Slot:${s}b}].count`);
        if (!/Found no|Can't|Unable/i.test(out)) n++;
    }
    return n;
}
const A = ['cobblestone','oak_log','iron_ingot','coal','dirt','sand','gravel','redstone',
    'lapis_lazuli','gold_ingot','diamond','emerald','wheat','bread','apple','arrow','string',
    'feather','flint','brick','glass','torch','stick','bone','leather','paper','quartz'];
const B = ['copper_ingot','obsidian','oak_planks','birch_log','spruce_log','cactus','sugar_cane',
    'pumpkin','carrot','potato','beetroot','slime_ball','blaze_rod','ghast_tear','gunpowder',
    'magma_cream','nether_wart','glowstone_dust','sugar','clay_ball','honeycomb','bamboo','kelp',
    'netherrack','andesite','diorite','granite'];

async function clearChest(pos) { for (let s = 0; s < 27; s++) await send(`item replace block ${pos.x} ${pos.y} ${pos.z} container.${s} with air`); }
async function fill(pos, items) { for (let i = 0; i < items.length; i++) await send(`item replace block ${pos.x} ${pos.y} ${pos.z} container.${i} with ${items[i]} 64`); }

await send('msg andy !stop'); await sleep(1200);
await send('tp andy 4534.5 111 4706.5'); await sleep(1500);
await send('clear andy');
await send('execute positioned 4534 111 4704 run kill @e[type=item,distance=..30]');
await clearChest(SINGLE); await clearChest(DOUBLE); await clearChest(RIGHT);

const mode = process.argv[2] || 'srcfull';
if (mode === 'srcfull') {
    await fill(SINGLE, A);
    say('=== FULL single chest (27/27) -> EMPTY double chest ===');
} else if (mode === 'bothfull') {
    await fill(SINGLE, A); await fill(DOUBLE, A); await fill(RIGHT, B);
    say('=== FULL single (27/27) -> FULL double (54/54) ===');
} else if (mode === 'partial') {
    await fill(SINGLE, A.slice(0, 3));
    say('=== part-stack take: the right-click path ===');
}
await sleep(800);
say(`before:  single ${await used(SINGLE)}/27   double ${await used(DOUBLE)}+${await used(RIGHT)}/54`);

const t0 = Date.now();
if (mode === 'partial') {
    await command(`!chestTake("cobblestone", 10, ${SINGLE.x}, ${SINGLE.y}, ${SINGLE.z})`, 15000);
    await command(`!chestPut("cobblestone", 3, ${DOUBLE.x}, ${DOUBLE.y}, ${DOUBLE.z})`, 15000);
} else {
    await command(`!chestTransfer("all", -1, ${SINGLE.x}, ${SINGLE.y}, ${SINGLE.z}, ${DOUBLE.x}, ${DOUBLE.y}, ${DOUBLE.z})`, 60000);
}
say(`after:   single ${await used(SINGLE)}/27   double ${await used(DOUBLE)}+${await used(RIGHT)}/54   (${((Date.now()-t0)/1000).toFixed(1)}s)`);
say(`ground:  ${/ITEMS/.test(await send('execute positioned 4534 111 4704 run execute if entity @e[type=item,distance=..30] run say ITEMS')) ? 'ITEMS ON THE FLOOR' : 'clean'}`);
r.close(); process.exit(0);
