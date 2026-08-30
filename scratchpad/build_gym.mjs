import fs from 'fs';
import { Rcon } from './rcon2.mjs';
const say = (s) => fs.writeSync(1, s + '\n');
const r = await new Rcon().connect();
const run = async (c) => { const out = await r.send(c); if (/error|Failed|Unknown/i.test(out)) say('  ! ' + c + ' -> ' + out.slice(0,80)); return out; };

// Floating rig, well above the desert (terrain here tops out ~75), so nothing existing is
// touched. Base slab top = y110; the walking surface is y111.
const X0 = 4500, X1 = 4524;
const Z0 = 4700;
const YB = 100, YTOP = 110;          // solid slab from 100..110
const LANES = 10;
const LANE_W = 3, LANE_PITCH = 4;    // 3 wide + 1 wall

say(`clearing and building slab x${X0}..${X1} z${Z0}..${Z0 + LANES * LANE_PITCH}`);
// forceload the whole footprint so fills apply
for (let x = X0; x <= X1 + 16; x += 16) for (let z = Z0; z <= Z0 + LANES * LANE_PITCH + 16; z += 16) await run(`forceload add ${x} ${z}`);

await run(`fill ${X0} ${YB} ${Z0} ${X1} ${YTOP + 12} ${Z0 + LANES * LANE_PITCH} air`);
await run(`fill ${X0} ${YB} ${Z0} ${X1} ${YTOP} ${Z0 + LANES * LANE_PITCH} stone`);

// Each lane: a pool of depth d whose SURFACE is level with the bank's top face - the exact
// geometry that defeats a floating bot (it must rise ~0.7 blocks onto a 1-block bank).
for (let i = 0; i < LANES; i++) {
    const d = i + 1;                       // water depth, 1..10
    const z0 = Z0 + 1 + i * LANE_PITCH;
    const z1 = z0 + LANE_W - 1;
    // pool: x 4502..4508, carved down d blocks from the top and filled with water
    await run(`fill 4502 ${YTOP - d + 1} ${z0} 4508 ${YTOP} ${z1} water`);
    // spawn pocket at the west end is part of the pool; the bank is x4509.. (untouched stone)
    // lane wall
    if (i < LANES - 1) await run(`fill ${X0} ${YTOP + 1} ${z1 + 1} ${X1} ${YTOP + 3} ${z1 + 1} stone`);
    say(`lane ${d}: depth ${d}, z ${z0}..${z1}, pool x4502..4508, bank x4509 top=y${YTOP + 1}`);
}
// Outer walls so a freed bot cannot wander off the rig
await run(`fill ${X0} ${YTOP + 1} ${Z0} ${X0} ${YTOP + 3} ${Z0 + LANES * LANE_PITCH} stone`);
await run(`fill ${X1} ${YTOP + 1} ${Z0} ${X1} ${YTOP + 3} ${Z0 + LANES * LANE_PITCH} stone`);
say('built.');
r.close(); process.exit(0);
