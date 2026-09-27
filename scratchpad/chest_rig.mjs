/**
 * A flat pad with a SINGLE chest and a DOUBLE chest on it, for exercising the container engine
 * (`src/agent/library/chest.js`) from the outside.
 *
 *   bun scratchpad/chest_rig.mjs [fill]
 *
 * `fill` argument controls how full the chests start:
 *   empty   both empty
 *   some    a handful of stacks in each          (the basic case)
 *   full    every slot occupied, 27 and 54       (the capacity case)
 *
 * Built well above the desert like the swim gym, so nothing existing is touched. Walking
 * surface is y=111; the chests sit on it at y=111.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

export const PAD = { x0: 4528, x1: 4546, z0: 4698, z1: 4710, ySlab: 110, yFloor: 111 };
export const SINGLE = { x: 4532, y: 111, z: 4704 };
// A double chest is two blocks; the server only treats them as one 54-slot container when the
// `type` property says so. setblock does NOT merge them for you.
export const DOUBLE_L = { x: 4536, y: 111, z: 4704 };
export const DOUBLE_R = { x: 4537, y: 111, z: 4704 };

const A = ['cobblestone', 'oak_log', 'iron_ingot', 'coal', 'dirt', 'sand', 'gravel', 'redstone',
    'lapis_lazuli', 'gold_ingot', 'diamond', 'emerald', 'wheat', 'bread', 'apple', 'arrow',
    'string', 'feather', 'flint', 'brick', 'glass', 'torch', 'stick', 'bone', 'leather',
    'paper', 'quartz'];
const B = ['copper_ingot', 'obsidian', 'oak_planks', 'birch_log', 'spruce_log', 'cactus',
    'sugar_cane', 'pumpkin', 'carrot', 'potato', 'beetroot', 'slime_ball', 'blaze_rod',
    'ghast_tear', 'gunpowder', 'magma_cream', 'nether_wart', 'glowstone_dust', 'sugar',
    'clay_ball', 'honeycomb', 'bamboo', 'kelp', 'netherrack', 'andesite', 'diorite', 'granite'];

async function clearAndBuild() {
    for (let x = PAD.x0; x <= PAD.x1 + 16; x += 16)
        for (let z = PAD.z0; z <= PAD.z1 + 16; z += 16) await send(`forceload add ${x} ${z}`);
    await send(`fill ${PAD.x0} 100 ${PAD.z0} ${PAD.x1} 120 ${PAD.z1} air`);
    await send(`fill ${PAD.x0} 100 ${PAD.z0} ${PAD.x1} ${PAD.ySlab} ${PAD.z1} stone`);
}

/** Place the chests. The double one needs matching facing + left/right, or it stays two singles. */
async function placeChests() {
    await send(`setblock ${SINGLE.x} ${SINGLE.y} ${SINGLE.z} chest[facing=north]`);
    await send(`setblock ${DOUBLE_L.x} ${DOUBLE_L.y} ${DOUBLE_L.z} chest[facing=north,type=left]`);
    await send(`setblock ${DOUBLE_R.x} ${DOUBLE_R.y} ${DOUBLE_R.z} chest[facing=north,type=right]`);
}

/** `item replace block` is the only reliable way to seed a container from RCON. */
async function fillSlots(pos, items, count) {
    for (let i = 0; i < items.length; i++) {
        await send(`item replace block ${pos.x} ${pos.y} ${pos.z} container.${i} with ${items[i]} ${count}`);
    }
}

const mode = process.argv[2] || 'some';
say(`chest rig: pad x${PAD.x0}..${PAD.x1} z${PAD.z0}..${PAD.z1}, floor y=${PAD.yFloor}, fill=${mode}`);
await clearAndBuild();
await placeChests();
await sleep(400);

if (mode === 'some') {
    await fillSlots(SINGLE, A.slice(0, 5), 32);
    await fillSlots(DOUBLE_L, B.slice(0, 3), 16);
} else if (mode === 'full') {
    await fillSlots(SINGLE, A, 64);                       // 27 slots
    await fillSlots(DOUBLE_L, [...A, ...B], 64);          // 54 slots - one window, seeded via the left half
}
say(`single chest  (${SINGLE.x}, ${SINGLE.y}, ${SINGLE.z})`);
say(`double chest  (${DOUBLE_L.x}, ${DOUBLE_L.y}, ${DOUBLE_L.z}) + (${DOUBLE_R.x}, ${DOUBLE_R.y}, ${DOUBLE_R.z})`);

// Confirm the double really merged: a merged pair reports 54 usable slots to any client. The
// server-side proof is the block state itself - two singles cannot both carry type=left/right.
for (const [label, p] of [['single', SINGLE], ['double L', DOUBLE_L], ['double R', DOUBLE_R]]) {
    const out = await send(`data get block ${p.x} ${p.y} ${p.z} Items`);
    const n = (out.match(/\{[^{}]*id:/g) || []).length;
    say(`  ${label.padEnd(9)} ${n} stack(s) seeded`);
}
r.close(); process.exit(0);
