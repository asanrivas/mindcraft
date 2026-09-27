import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const run = (c) => r.send(c);
const X0 = 4500, X1 = 4524, Z0 = 4700, YTOP = 110, LANES = 10, PITCH = 4;

// The first run escaped its lane and mined down through the slab, which invalidates the test.
// Seal every lane into a corridor whose ONLY exit is the bank: walls on both z sides and both
// ends, tall enough that a jump cannot clear them.
say('sealing lanes');
// z walls at the north end and south end of the whole rig
await run(`fill ${X0} ${YTOP + 1} ${Z0} ${X1} ${YTOP + 5} ${Z0} stone`);
await run(`fill ${X0} ${YTOP + 1} ${Z0 + LANES * PITCH} ${X1} ${YTOP + 5} ${Z0 + LANES * PITCH} stone`);
// raise the per-lane dividers and the x-edge walls
for (let i = 0; i < LANES - 1; i++) {
    const zWall = Z0 + 1 + i * PITCH + 3;
    await run(`fill ${X0} ${YTOP + 1} ${zWall} ${X1} ${YTOP + 5} ${zWall} stone`);
}
await run(`fill ${X0} ${YTOP + 1} ${Z0} ${X0} ${YTOP + 5} ${Z0 + LANES * PITCH} stone`);
await run(`fill ${X1} ${YTOP + 1} ${Z0} ${X1} ${YTOP + 5} ${Z0 + LANES * PITCH} stone`);
// A lid over the POOL half only, so the bot cannot jump/pillar out sideways; the bank half
// stays open so a successful climb is unambiguous.
for (let i = 0; i < LANES; i++) {
    const z0 = Z0 + 1 + i * PITCH, z1 = z0 + 2;
    await run(`fill 4501 ${YTOP + 4} ${z0} 4508 ${YTOP + 4} ${z1} stone`);
}
say('sealed. verifying lane 1 walls...');
for (const [x, y, z, what] of [[4504, 111, 4700, 'north wall'], [4504, 111, 4704, 'divider'], [4504, 114, 4702, 'pool lid']]) {
    say(`  ${what}: ${(await run(`execute if block ${x} ${y} ${z} stone`)) === 'Test passed'}`);
}
r.close(); process.exit(0);
