/**
 * Does a transfer LOSE items when the bot's inventory cannot hold them?
 *
 * Observed once by accident: a `!chestTransfer` that reported "my inventory is full" and moved
 * nothing left the SOURCE CHEST EMPTY, with a cobblestone item entity lying on the pad. This
 * counts every side of the ledger before and after so the question is answered with numbers.
 *
 *   bun scratchpad/chest_loss.mjs [freeSlots]     default 1
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
const SEED = ['cobblestone', 'oak_log', 'iron_ingot', 'coal', 'dirt'];
const FREE = Number(process.argv[2] ?? 1);

/** `clear <player> <item> 0` COUNTS without removing - the only RCON read that is not truncated. */
async function held(item) {
    const out = await send(`clear andy ${item} 0`);
    const m = out.match(/(\d+)/);
    return /Found no/.test(out) ? 0 : (m ? +m[1] : 0);
}
/** A DOUBLE chest is two block entities of 27 slots each. `data get block` on one half shows
 *  only that half's Items list, so counting 54 slots at one coordinate silently loses whatever
 *  landed in the other half - which reads exactly like the engine having eaten the items. */
async function chestCount(pos, item) {
    const halves = (pos.x === DOUBLE.x && pos.y === DOUBLE.y && pos.z === DOUBLE.z)
        ? [DOUBLE, { x: DOUBLE.x + 1, y: DOUBLE.y, z: DOUBLE.z }]
        : [pos];
    let sum = 0;
    for (const h of halves) sum += await halfCount(h, item);
    return sum;
}
async function halfCount(pos, item) {
    let total = 0;
    for (let s = 0; s < 27; s++) {
        const out = await send(`data get block ${pos.x} ${pos.y} ${pos.z} Items[{Slot:${s}b}].count`);
        if (/Found no|Can't|Unable/i.test(out)) continue;
        const id = await send(`data get block ${pos.x} ${pos.y} ${pos.z} Items[{Slot:${s}b}].id`);
        if (!id.includes(item)) continue;
        const m = out.match(/:\s*(\d+)/);
        if (m) total += +m[1];
    }
    return total;
}
const groundCount = async () => {
    const out = await send(`execute positioned 4534 111 4704 run execute if entity @e[type=item,distance=..30] run say ITEMS`);
    return /ITEMS/.test(out) ? 'some' : 'none';
};

/** Read the log from a BYTE offset. `readFileSync(...).slice(n)` slices CHARACTERS, so a single
 *  multi-byte character anywhere earlier shifts the window and the delivery check silently
 *  fails - which read as "command never reached the agent" for commands that plainly ran. */
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
    // Confirm delivery by POLLING, never by re-sending on a fixed 1.2s beat. The log write can
    // lag the send, so a blind retry lands a SECOND copy of the command - which shows up as
    // `action "action:chestTransfer" trying to interrupt current action "action:chestTransfer"`
    // and makes the run measure an interrupted transfer instead of a transfer.
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
        await send(`msg andy ${text}`);
        for (let poll = 0; poll < 12 && !delivered; poll++) {
            await sleep(400);
            delivered = since(before).includes(`received message from Rcon : ${text}`);
        }
    }
    if (!delivered) say('  !! command never reached the agent');
    await sleep(waitMs);
    return since(before);
}

say(`=== transfer with ${FREE} free inventory slot(s) ===`);
await send('msg andy !stop'); await sleep(1200);
await send(`tp andy 4534.5 111 4706.5`); await sleep(1500);
await send(`execute positioned 4534 111 4704 run kill @e[type=item,distance=..30]`);

// A known inventory: clear, then fill exactly (36 - FREE) slots with distinct junk.
await send('clear andy');
const JUNK = ['stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'basalt',
    'netherrack', 'sandstone', 'terracotta', 'bricks', 'oak_planks', 'birch_planks',
    'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'glass',
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool',
    'brown_wool', 'green_wool', 'red_wool', 'black_wool', 'clay', 'gravel'];
const fillN = 36 - FREE;
for (let i = 0; i < fillN; i++) await send(`give andy ${JUNK[i]} 64`);

// A known chest: exactly 5 stacks of 64 in the single, double left empty.
for (let s = 0; s < 54; s++) await send(`item replace block ${SINGLE.x} ${SINGLE.y} ${SINGLE.z} container.${s} with air`);
for (let s = 0; s < 54; s++) await send(`item replace block ${DOUBLE.x} ${DOUBLE.y} ${DOUBLE.z} container.${s} with air`);
for (let s = 0; s < 54; s++) await send(`item replace block ${DOUBLE.x + 1} ${DOUBLE.y} ${DOUBLE.z} container.${s} with air`);
for (let i = 0; i < SEED.length; i++)
    await send(`item replace block ${SINGLE.x} ${SINGLE.y} ${SINGLE.z} container.${i} with ${SEED[i]} 64`);
await sleep(800);

const before = {};
for (const it of SEED) before[it] = { chest: await chestCount(SINGLE, it), bag: await held(it) };
say('BEFORE  ' + SEED.map(i => `${i}: chest=${before[i].chest} bag=${before[i].bag}`).join('  '));
say(`ground: ${await groundCount()}`);

const out = await command(`!chestTransfer("all", -1, ${SINGLE.x}, ${SINGLE.y}, ${SINGLE.z}, ${DOUBLE.x}, ${DOUBLE.y}, ${DOUBLE.z})`, 45000);
say('--- what the bot said ---');
for (const l of out.split('\n').filter(l => /\[andy\]|\[chest\]/.test(l) && !/torch_placing/.test(l)))
    say('   ' + l.replace(/^\[[^\]]+\] /, '').trim());

const after = {};
for (const it of SEED) after[it] = { src: await chestCount(SINGLE, it), dst: await chestCount(DOUBLE, it), bag: await held(it) };
say('--- ledger (64 seeded of each) ---');
let lost = 0;
for (const it of SEED) {
    const total = after[it].src + after[it].dst + after[it].bag;
    const gap = before[it].chest + before[it].bag - total;
    lost += gap;
    say(`   ${it.padEnd(12)} src=${String(after[it].src).padStart(3)} dst=${String(after[it].dst).padStart(3)} bag=${String(after[it].bag).padStart(3)}  total=${String(total).padStart(3)}  ${gap ? `LOST ${gap}` : 'accounted for'}`);
}
say(`ground after: ${await groundCount()}`);
say(`\nRESULT: ${lost === 0 ? 'nothing lost' : `${lost} item(s) UNACCOUNTED FOR`}`);
r.close(); process.exit(0);
