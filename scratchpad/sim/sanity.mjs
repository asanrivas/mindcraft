/**
 * Does the sandbox reproduce reality? Run this before trusting any sweep.
 *
 *   bun scratchpad/sim/sanity.mjs
 *
 * Two anchors: vanilla physics must give the textbook jump (apex ~1.25 blocks, ~12 ticks), and
 * the `brokenOnGround` pathology must give NO jump at all - which is the whole reason this bot
 * needs help in the first place.
 */
import { SimWorld, SimBot, CONTROLS } from './physics_sim.mjs';
import { Vec3 } from 'vec3';

const flat = () => new SimWorld().fill(-8, 59, -8, 24, 59, 8, 'stone');

function run({ brokenOnGround, jump, sprint, forward, ticks = 30 }) {
    const bot = new SimBot(flat(), new Vec3(0.5, 60, 0.5), { brokenOnGround });
    bot.yaw = Math.PI;                      // -sin/-cos => +z... we measure along whatever moves
    const c = CONTROLS();
    let apex = 0, startY = bot.pos.y, startX = bot.pos.x, startZ = bot.pos.z;
    for (let i = 0; i < ticks; i++) {
        c.jump = jump; c.sprint = sprint; c.forward = forward;
        bot.step(c);
        apex = Math.max(apex, bot.pos.y - startY);
    }
    const dist = Math.hypot(bot.pos.x - startX, bot.pos.z - startZ);
    return { apex, dist, endY: bot.pos.y - startY };
}

const show = (label, r) =>
    console.log(`${label.padEnd(42)} apex=${r.apex.toFixed(3)}  travelled=${r.dist.toFixed(2)}`);

console.log('=== vanilla physics (onGround works) ===');
show('stand still, jump', run({ brokenOnGround: false, jump: true, forward: false, sprint: false }));
show('walk', run({ brokenOnGround: false, jump: false, forward: true, sprint: false }));
show('sprint', run({ brokenOnGround: false, jump: false, forward: true, sprint: true }));
show('sprint-jump', run({ brokenOnGround: false, jump: true, forward: true, sprint: true }));

console.log('\n=== THIS SERVER (onGround stuck false) ===');
show('stand still, jump', run({ brokenOnGround: true, jump: true, forward: false, sprint: false }));
show('walk', run({ brokenOnGround: true, jump: false, forward: true, sprint: false }));
show('sprint-jump', run({ brokenOnGround: true, jump: true, forward: true, sprint: true }));

console.log('\nExpect: vanilla jump apex ~1.25; broken-onGround apex 0.00 and a crawl.');
