/**
 * Does a person's "stop" survive a restart?
 *
 *   bun scratchpad/resume_test.mjs stop     goal, then "stop", then restart -> must NOT resume
 *   bun scratchpad/resume_test.mjs keep     goal, no stop, then restart     -> must resume
 *
 * The control matters as much as the case: a fix that stops the bot resuming ANYTHING has not
 * fixed the bug, it has removed the feature.
 */
import fs from 'fs';
import { execSync } from 'child_process';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const LOG = '/home/asanrivas/mindcraft/logs/service.log';
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

function since(offset) {
    const fd = fs.openSync(LOG, 'r');
    const len = Math.max(0, fs.statSync(LOG).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
}

let r = await new Rcon().connect();
const send = (c) => r.send(c);
async function command(text, waitMs = 6000) {
    const before = fs.statSync(LOG).size;
    let delivered = false;
    for (let a = 0; a < 3 && !delivered; a++) {
        await send(`msg andy ${text}`);
        for (let p = 0; p < 12 && !delivered; p++) {
            await sleep(400);
            delivered = since(before).includes(`received message from Rcon : ${text}`);
        }
    }
    if (!delivered) say(`  !! never delivered: ${text}`);
    await sleep(waitMs);
    return since(before);
}

const mode = process.argv[2] || 'stop';
const GOAL = 'count to ten out loud';   // deliberately free of stand-down words

say(`=== reconnect policy: ${mode} ===`);
await command('!endGoal', 4000);
await command(`!goal("${GOAL}")`, 8000);
const active = /self prompt loop|starting self-prompt/i.test(since(fs.statSync(LOG).size - 40000));
say(`goal set, self-prompt loop running: ${active}`);

if (mode === 'stop') {
    say(`user says: "stop"`);
    await command('stop', 6000);
}

r.close();
say('restarting the agent...');
const mark = fs.statSync(LOG).size;
execSync('/home/asanrivas/mindcraft/scratchpad/restart_bot.sh', { stdio: 'ignore' });
const deadline = Date.now() + 150000;
while (Date.now() < deadline && !/andy spawned/.test(since(mark))) await sleep(3000);
await sleep(20000);

const after = since(mark);
for (const l of after.split('\n').filter(l => /reconnect:|self prompt|self-prompt|Generated response|received message from system/.test(l)))
    say('   ' + l.slice(0, 220));

// "Resumed" now means the AGENT restarted the loop, by either route: replaying a persisted
// loop, or starting one from the goal record when no loop was persisted. Asserting only on the
// first missed the case the fix is for.
const resumed = /starting self-prompt loop/.test(after)
    || /restarting the self-prompt loop from the goal record/.test(after);
const toldNotTo = /Do NOT resume/.test(after);
say(`\nself-prompt loop restarted: ${resumed}`);
say(`told not to resume:         ${toldNotTo}`);
const want = mode === 'stop' ? !resumed && toldNotTo : resumed;
say(`RESULT: ${want ? 'PASS' : 'FAIL'}`);
process.exit(want ? 0 : 1);
