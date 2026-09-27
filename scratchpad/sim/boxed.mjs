/**
 * What does the PLANNER do when the bot is walled in?
 *
 *   bun scratchpad/sim/boxed.mjs
 *
 * Reported as "Andy can't reach me with blocks surrounding him". Before driving the live bot,
 * ask the planner directly - it is pure block reads, so it runs offline against the same
 * `SimWorld` the physics sandbox uses.
 */
import { SimWorld } from './physics_sim.mjs';
import { planPath } from '../../src/agent/library/nav.js';
import { Vec3 } from 'vec3';

/** nav.js only needs `blockAt` and `entity.position` to plan. */
function planBot(world, pos) {
    return {
        username: 'sim',
        entity: { position: pos, velocity: new Vec3(0, 0, 0) },
        blockAt: (v) => world.getBlock(v),
        game: { gameMode: 'survival' },
        inventory: { items: () => [] },
    };
}

const GY = 59;   // floor block; feet at 60

function box({ roof = true, walls = true, thickness = 1, wallHeight = 2 }) {
    const w = new SimWorld();
    w.fill(-20, GY, -20, 20, GY, 20, 'stone');                       // ground
    if (walls) {
        for (let t = 0; t < thickness; t++) {
            const r = 1 + t;
            for (let dy = 1; dy <= wallHeight; dy++) {
                for (let d = -r; d <= r; d++) {
                    w.set(1 + t, GY + dy, d, 'stone');   w.set(-1 - t, GY + dy, d, 'stone');
                    w.set(d, GY + dy, 1 + t, 'stone');   w.set(d, GY + dy, -1 - t, 'stone');
                }
            }
        }
    }
    if (roof) w.fill(-2, GY + 3, -2, 2, GY + 3, 2, 'stone');
    return w;
}

const GOAL = { x: 12, y: GY + 1, z: 0 };

function report(label, world) {
    const bot = planBot(world, new Vec3(0.5, GY + 1, 0.5));
    const t0 = Date.now();
    const path = planPath(bot, GOAL, {});
    const ms = Date.now() - t0;
    if (!path) { console.log(`${label.padEnd(38)} NO PATH        (${ms}ms)`); return; }
    const end = path[path.length - 1];
    const reaches = Math.abs(end.x - (GOAL.x + 0.5)) < 1.5 && Math.abs(end.z - (GOAL.z + 0.5)) < 1.5;
    console.log(`${label.padEnd(38)} ${reaches ? 'REACHES GOAL' : 'STUB'.padEnd(12)}  `
        + `len=${String(path.length).padStart(3)} end=(${end.x.toFixed(1)}, ${end.y}, ${end.z.toFixed(1)}) (${ms}ms)`);
}

console.log('goal is 12 blocks east, on open ground\n');
report('open ground (control)', box({ roof: false, walls: false }));
report('walls only, 2 high, 1 thick', box({ roof: false }));
report('walls + roof (fully sealed)', box({}));
report('walls 3 high, no roof', box({ roof: false, wallHeight: 3 }));
report('walls 2 thick, no roof', box({ roof: false, thickness: 2 }));
report('walls 2 thick + roof', box({ thickness: 2 }));

console.log('\nSame, but with digging disabled (what a mode-driven move gets):');
for (const [label, world] of [['walls + roof', box({})], ['walls only', box({ roof: false })]]) {
    const bot = planBot(world, new Vec3(0.5, GY + 1, 0.5));
    const path = planPath(bot, GOAL, { allowDig: false });
    console.log(`  ${label.padEnd(20)} ${path ? `len=${path.length}` : 'NO PATH'}`);
}
