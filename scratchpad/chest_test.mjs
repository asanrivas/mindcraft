/**
 * Drive the container engine through the rig from `chest_rig.mjs` and print what the bot said.
 *
 *   bun scratchpad/chest_test.mjs [step ...]      (default: all steps)
 *
 * Each step sends one command, waits for the agent to log its output, and echoes every
 * `[andy] ...` line that appeared. RCON drops sends under load, so delivery is confirmed
 * against the log before the reply is waited for - a dropped command otherwise reads as a
 * silent failure of the command itself.
 */
import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const send = (c) => r.send(c);
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const LOG = '/home/asanrivas/mindcraft/logs/service.log';
const BOT = 'andy';

const SINGLE = '4532, 111, 4704';
const DOUBLE = '4536, 111, 4704';

const logSize = () => fs.statSync(LOG).size;
function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}

async function command(text, waitMs = 8000) {
    const before = logSize();
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
        await send(`msg ${BOT} ${text}`);
        await sleep(1200);
        delivered = since(before).includes(`${BOT} received message from Rcon : ${text}`);
    }
    if (!delivered) { say(`  !! command never reached the agent: ${text}`); return; }
    await sleep(waitMs);
    const lines = since(before).split('\n')
        .filter(l => l.includes(`[${BOT}]`) || l.startsWith('Successfully') || l.startsWith('Could not'))
        .filter(l => !/torch_placing: skipping|IdleBehavior|Auto-Login/.test(l));
    for (const l of lines) say('   ' + l.replace(/^\[[^\]]+\] /, '').trim());
}

const STEPS = {
    async setup() {
        say('\n== setup: park the bot between the two chests, clear any running action ==');
        await send(`msg ${BOT} !stop`);
        await send(`msg ${BOT} !marathonReset`);
        await sleep(1500);
        await send(`tp ${BOT} 4534.5 111 4706.5`);
        await sleep(2000);
        await command('!stop', 2000);
    },
    async list()      { say('\n== !chestList: what does it see? =='); await command('!chestList(16)'); },
    async viewSingle(){ say('\n== !chestView on the SINGLE chest =='); await command(`!chestView(${SINGLE})`, 12000); },
    async viewDouble(){ say('\n== !chestView on the DOUBLE chest =='); await command(`!chestView(${DOUBLE})`, 12000); },
    async put()       { say('\n== !chestPut into the single =='); await command(`!chestPut("dirt", 10, ${SINGLE})`, 12000); },
    async take()      { say('\n== !chestTake from the single =='); await command(`!chestTake("cobblestone", 5, ${SINGLE})`, 12000); },
    async transfer()  { say('\n== !chestTransfer single -> double =='); await command(`!chestTransfer("all", -1, ${SINGLE}, ${DOUBLE})`, 40000); },
    async after()     {
        say('\n== after the transfer ==');
        await command(`!chestView(${SINGLE})`, 12000);
        await command(`!chestView(${DOUBLE})`, 12000);
    },
};

const order = ['setup', 'list', 'viewSingle', 'viewDouble', 'put', 'take', 'transfer', 'after'];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : order;
for (const s of wanted) {
    if (!STEPS[s]) { say(`unknown step ${s}`); continue; }
    await STEPS[s]();
}
r.close(); process.exit(0);
