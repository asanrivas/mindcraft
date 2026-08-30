/**
 * How forgiving is the takeoff? And do rises and drops work?
 *
 *   bun scratchpad/sim/lead_window.mjs
 *
 * `jump_sweep.mjs` reports the BEST lead, which flatters the mechanism: if only one lead in the
 * range works, the jump is a coin flip on a live server where the tick the decision lands on is
 * not ours to choose. What matters is the WINDOW - how many of the leads work - and the same
 * question asked of a rise (the ledge case the user actually asked for) and of a drop.
 */
import { SimWorld, SimBot, CONTROLS } from './physics_sim.mjs';
import { Vec3 } from 'vec3';

const FLOOR_Y = 59, RUNWAY = 10, HALF = 0.3, LIP = 1.0;

function attempt({ width, rise = 0, drop = 0, lead, airSpeed = 0.32, sprint = true, maxTicks = 90 }) {
    const w = new SimWorld();
    w.fill(-RUNWAY, FLOOR_Y, -2, 0, FLOOR_Y, 2, 'stone');
    const farY = FLOOR_Y + rise - drop;
    w.fill(width + 1, farY, -2, width + 12, farY, 2, 'stone');
    // Headroom over the take-off side must exist or a rise lane traps the bot under its own roof.
    const bot = new SimBot(w, new Vec3(-RUNWAY + 1.5, FLOOR_Y + 1, 0.5), { brokenOnGround: true });
    bot.yaw = -Math.PI / 2;
    const c = CONTROLS(); c.forward = true; c.sprint = sprint;
    const landX = width + 1, landY = FLOOR_Y + 1 + rise - drop;
    let launched = false, launchX = null;
    for (let i = 0; i < maxTicks; i++) {
        const takeoff = !launched && (LIP - (bot.pos.x + HALF)) <= lead && bot.grounded();
        if (takeoff) {
            launched = true; launchX = bot.pos.x;
            bot.vel.y = 0.42;
            if (bot.vel.x < airSpeed) bot.vel.x = airSpeed;
        }
        c.jump = takeoff;
        bot.step(c, { assertGround: takeoff });
        if (launched && bot.vel.x < airSpeed && bot.pos.y > landY - 0.1) bot.vel.x = airSpeed;
        if (launched && bot.pos.x + HALF > landX && bot.grounded()
            && Math.abs(bot.pos.y - landY) < 0.3) return { ok: true, span: bot.pos.x - launchX };
        if (bot.pos.y < FLOOR_Y - 3) break;
    }
    return { ok: false };
}

const LEADS = [0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.70, 1.00];

function window(opts) {
    const good = LEADS.filter(lead => attempt({ ...opts, lead }).ok);
    return good.length ? `${good.length}/${LEADS.length}  [${good[0].toFixed(2)}..${good.at(-1).toFixed(2)}]` : '-';
}

console.log('LEVEL gaps - how many take-off leads work');
console.log('width  sprint            no sprint');
for (const width of [0, 1, 2, 3, 4, 5])
    console.log(`${String(width).padStart(5)}  ${window({ width }).padEnd(18)}${window({ width, sprint: false })}`);

console.log('\nRISE 1 (a step up, across a gap) - the ledge case');
console.log('width  sprint            no sprint');
for (const width of [0, 1, 2, 3])
    console.log(`${String(width).padStart(5)}  ${window({ width, rise: 1 }).padEnd(18)}${window({ width, rise: 1, sprint: false })}`);

console.log('\nRISE 2 - must be impossible; vanilla jump apex is 1.25');
for (const width of [0, 1])
    console.log(`width ${width}: ${window({ width, rise: 2 })}`);

console.log('\nDROP - landing lower');
console.log('drop   width 1            width 3');
for (const drop of [1, 2, 3])
    console.log(`${String(drop).padStart(4)}   ${window({ width: 1, drop }).padEnd(18)}${window({ width: 3, drop })}`);
