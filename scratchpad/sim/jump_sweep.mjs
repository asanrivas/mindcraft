/**
 * How far can THIS bot actually jump, and by which mechanism?
 *
 *   bun scratchpad/sim/jump_sweep.mjs [--trace w] [--rise r] [--drop d]
 *
 * This is what sets `JUMP_REACH`, `TAKEOFF_LEAD` and `airSpeed`, and what decides which takeoff
 * mechanism ships. Nothing downstream is honest until it has run - the alternative is picking the
 * constants from vanilla theory and discovering on the live server that the bot cannot reach.
 *
 * Two mechanisms are compared on identical lanes:
 *
 *   A "onGround"  Assert `state.onGround = true` for the takeoff tick, while a solid block is
 *                 genuinely under the feet. prismarine-physics then fires the REAL jump
 *                 (index.js:725: `vel.y = 0.42`, plus `+0.2` along the heading when sprinting)
 *                 and grants ground acceleration for that tick. Vanilla numbers, no injection.
 *   B "impulse"   What `climbBank` already does: `vel.y += 0.42` by hand, plus an axial top-up.
 *                 Proven against this server, but hand-written velocity rather than the engine's.
 *
 * A lane is: walkway to x=0, a gap of `w` cells (x=1..w), far side from x=w+1, optionally raised
 * or lowered. Success is landing ON the far side - not merely leaving the ground.
 */
import { SimWorld, SimBot, CONTROLS } from './physics_sim.mjs';
import { Vec3 } from 'vec3';

const FLOOR_Y = 59;          // top face at y=60, so the walking surface is y=60
const RUNWAY = 10;           // blocks of walkway before the lip

/** Build a lane. `deep` removes the floor under the gap so a miss is a real fall. */
function lane({ width, rise = 0, drop = 0, deep = true }) {
    const w = new SimWorld();
    w.fill(-RUNWAY, FLOOR_Y, -2, 0, FLOOR_Y, 2, 'stone');                       // take-off side
    const farY = FLOOR_Y + rise - drop;
    w.fill(width + 1, farY, -2, width + 12, farY, 2, 'stone');                  // landing side
    if (!deep) w.fill(1, FLOOR_Y - 6, -2, width, FLOOR_Y - 6, 2, 'stone');      // a floor to miss onto
    return w;
}

/**
 * One attempt.
 *
 * The bot walks +x from the far end of the runway, and fires the takeoff when the gap between its
 * hitbox edge and the lip face reaches `lead`. `forward` and `sprint` stay held through the arc -
 * airborne acceleration is small but it is not nothing, and it is what a real player has too.
 */
function attempt({ width, rise = 0, drop = 0, deep = true, mechanism, lead, airSpeed, sprint = true,
                   maxTicks = 80, trace = false }) {
    const world = lane({ width, rise, drop, deep });
    const bot = new SimBot(world, new Vec3(-RUNWAY + 1.5, FLOOR_Y + 1, 0.5), { brokenOnGround: true });
    bot.yaw = -Math.PI / 2;                       // -sin(yaw) = +1  =>  facing +x
    const c = CONTROLS();
    c.forward = true;
    c.sprint = sprint;

    const LIP = 1.0;                              // the gap starts at x=1, so its face is x=1.0
    const HALF = 0.3;                             // bot hitbox half-width
    const landX = width + 1;
    const landY = FLOOR_Y + 1 + rise - drop;

    let launched = false, apex = 0, launchX = null, liftVy = 0;
    for (let i = 0; i < maxTicks; i++) {
        const gapToLip = LIP - (bot.pos.x + HALF);

        // TAKEOFF. Only from the ground, only once, only when the lip is `lead` away.
        const takeoff = !launched && gapToLip <= lead && bot.grounded();
        if (takeoff) {
            launched = true;
            launchX = bot.pos.x;
            if (mechanism === 'impulse' || mechanism === 'hybrid') {
                // ASSIGN, do not add. The engine does `vel.y = 0.42` (index.js:725); `+=` from a
                // velocity that is already falling (-0.08 on a bot the engine thinks is airborne)
                // yields 0.34 and an apex of 0.87 instead of 1.25 - measured, first sweep.
                bot.vel.y = 0.42;
                if (bot.vel.x < airSpeed) bot.vel.x = airSpeed;
            }
        }
        // 'hybrid' takes the engine's real jump AND guarantees the run-up: assert the ground
        // flag so index.js:725 fires the genuine impulse and sprint boost, then top the axial
        // speed up the way climbBank's STEP_IN_SPEED does over a bank lip.
        const asserts = (mechanism === 'onGround' || mechanism === 'hybrid') && takeoff;
        c.jump = asserts;
        bot.step(c, { assertGround: asserts });
        if (takeoff) liftVy = bot.vel.y;

        if (launched) {
            apex = Math.max(apex, bot.pos.y - (FLOOR_Y + 1));
            // Mechanism B sustains the run-up the broken ground flag denies us, exactly as
            // climbBank's STEP_IN_SPEED does over a bank lip. Mechanism A gets the engine's own
            // sprint-jump boost instead and needs no help.
            if ((mechanism === 'impulse' || mechanism === 'hybrid')
                && bot.vel.x < airSpeed && bot.pos.y > landY - 0.1)
                bot.vel.x = airSpeed;
        }

        const onFarSide = bot.pos.x + HALF > landX && bot.grounded()
                       && Math.abs(bot.pos.y - landY) < 0.3;
        if (launched && onFarSide)
            return { ok: true, ticks: i, apex, span: bot.pos.x - launchX, liftVy, trace: bot.trace };
        if (bot.pos.y < FLOOR_Y - 3) break;                  // fell in
    }
    return { ok: false, apex, span: launchX == null ? 0 : bot.pos.x - launchX, liftVy,
             fell: bot.pos.y < FLOOR_Y, trace: bot.trace };
}

/** Best result over a range of takeoff leads - the lead itself is one of the unknowns. */
function bestOver(opts, leads) {
    let best = null;
    for (const lead of leads) {
        const r = attempt({ ...opts, lead });
        if (r.ok && (!best || r.span > best.span)) best = { ...r, lead };
    }
    return best;
}

const LEADS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.70];
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : Number(args[i + 1]); };

const rise = flag('--rise', 0), drop = flag('--drop', 0);
console.log(`jump sweep - rise ${rise}, drop ${drop}, deep gap, sprint held\n`);
console.log('width  mechanism   result   ticks  apex   span   lead   liftVy');

for (const width of [0, 1, 2, 3, 4, 5, 6]) {
    for (const mechanism of ['onGround', 'impulse', 'hybrid']) {
        const airSpeed = 0.32;
        const r = bestOver({ width, rise, drop, mechanism, airSpeed }, LEADS);
        if (r) {
            console.log(`${String(width).padStart(5)}  ${mechanism.padEnd(10)}  CLEARED  `
                + `${String(r.ticks).padStart(5)}  ${r.apex.toFixed(2)}   ${r.span.toFixed(2)}   `
                + `${r.lead.toFixed(2)}   ${r.liftVy.toFixed(3)}`);
        } else {
            const f = attempt({ width, rise, drop, mechanism, airSpeed, lead: 0.2 });
            console.log(`${String(width).padStart(5)}  ${mechanism.padEnd(10)}  ${f.fell ? 'FELL   ' : 'SHORT  '}  `
                + `    -  ${f.apex.toFixed(2)}   ${f.span.toFixed(2)}      -   ${f.liftVy.toFixed(3)}`);
        }
    }
}

// A sprint-less run matters because `followPath` only sprints when aiming far ahead
// (nav.js: `wet || (aim > i && distance > 3)`), so a jump fired mid-leg may have no sprint at all.
console.log('\nwithout sprint:');
console.log('width  mechanism   result   span');
for (const width of [0, 1, 2, 3]) {
    for (const mechanism of ['onGround', 'impulse', 'hybrid']) {
        const r = bestOver({ width, rise, drop, mechanism, airSpeed: 0.32, sprint: false }, LEADS);
        console.log(`${String(width).padStart(5)}  ${mechanism.padEnd(10)}  ${r ? 'CLEARED' : 'SHORT  '}  `
            + `${(r ? r.span : 0).toFixed(2)}`);
    }
}
