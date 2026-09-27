/**
 * What does `onGround` actually do on this server?
 *
 * Everything in this codebase's movement stack is a workaround for `bot.entity.onGround`
 * reading false while the bot is provably standing: AutoJump refuses to gate on it, JumpAssist
 * asserts it for a take-off tick, `followPath` pulses jump because airborne acceleration is the
 * only acceleration we get, and `pillarUp` could not lift the bot at all. Every one of those was
 * built on the OBSERVATION that the flag is wrong. None of them established WHY, so none of them
 * could fix it - only route around it.
 *
 * prismarine-physics computes the flag in exactly one place (index.js:301):
 *
 *     entity.onGround = entity.isCollidedVertically && oldVelY < 0
 *
 * so it needs BOTH a vertical collision this tick AND a downward velocity going into the move.
 * That pair is what this samples, per tick, alongside the world's own answer (is the block under
 * the feet solid?). The four combinations mean different things and want different fixes:
 *
 *   solid below, collided, velY<0    - working correctly
 *   solid below, collided, velY==0   - the velocity was zeroed before the move, so the collision
 *                                      does not count. A CLIENT bug we can correct.
 *   solid below, no collision        - the body is not touching what is under it: it is resting
 *                                      above the block face, which points at server corrections.
 *   nothing below                    - genuinely airborne; the flag is right and must stay false.
 *
 * Same discipline as `swim_probe.js`: measure the constants rather than reason about them.
 */

/** Is there a full block under the feet cell? The world's answer, never the flag's. */
function solidUnderFeet(bot) {
    const b = bot.blockAt?.(bot.entity.position.floored().offset(0, -1, 0));
    return { solid: !!b && b.boundingBox === 'block', name: b?.name ?? 'void' };
}

/**
 * Sample the ground state every physics tick.
 *
 * @param {object} bot
 * @param {number} ms how long to watch
 * @returns {Promise<object>} counts and a short sample trace
 */
export async function measureGround(bot, ms = 3000) {
    const samples = [];
    const onTick = () => {
        const e = bot.entity;
        const u = solidUnderFeet(bot);
        samples.push({
            t: Date.now(),
            y: e.position.y,
            vy: e.velocity.y,
            onGround: !!e.onGround,
            colV: !!e.isCollidedVertically,
            solid: u.solid,
            under: u.name,
        });
    };

    // Stand still: any control state held would change what we are measuring.
    const held = { ...(bot.controlState ?? {}) };
    try { bot.clearControlStates(); } catch { /* not fatal */ }

    bot.on('physicsTick', onTick);
    await new Promise((r) => setTimeout(r, ms));
    bot.removeListener('physicsTick', onTick);
    for (const [k, v] of Object.entries(held)) {
        if (v) { try { bot.setControlState(k, true); } catch { /* ignore */ } }
    }

    const n = samples.length || 1;
    const count = (f) => samples.filter(f).length;

    // The fractional height above the block face is the tell for the third case: a body resting
    // ON a face sits at exactly .00, and anything above that is not touching it.
    const fracs = samples.map((s) => s.y - Math.floor(s.y));
    const restingFlush = count((s, i) => Math.abs(fracs[i]) < 0.001);

    const out = {
        ticks: samples.length,
        onGround: count((s) => s.onGround),
        collidedVertically: count((s) => s.colV),
        solidUnderFeet: count((s) => s.solid),
        velYNegative: count((s) => s.vy < 0),
        velYZero: count((s) => s.vy === 0),
        restingFlush,
        // The diagnostic combination: the world says we are standing, the flag says we are not.
        standingButNotGrounded: count((s) => s.solid && !s.onGround),
        yMin: Math.min(...samples.map((s) => s.y)),
        yMax: Math.max(...samples.map((s) => s.y)),
        trace: samples.slice(0, 12).map((s) =>
            `y=${s.y.toFixed(3)} vy=${s.vy.toFixed(4)} ground=${s.onGround ? 1 : 0}`
            + ` colV=${s.colV ? 1 : 0} under=${s.under}`),
        pct: (x) => ((100 * x) / n).toFixed(0),
    };
    // ALWAYS LOG IT. A command invoked over RCON has its return value whispered back to a
    // "player" called Rcon, who does not exist - so the whisper is dropped and the measurement
    // vanishes. Everything else diagnostic in this codebase reports through console.log for
    // exactly that reason.
    console.log(formatGround(out));
    return out;
}

export function formatGround(m) {
    if (!m.ticks) return 'GROUND PROBE: no physics ticks observed.';
    const p = (x) => `${x}/${m.ticks} (${m.pct(x)}%)`;
    return [
        `GROUND PROBE over ${m.ticks} ticks, y ${m.yMin.toFixed(3)}..${m.yMax.toFixed(3)}`,
        `  solid block under feet : ${p(m.solidUnderFeet)}`,
        `  onGround true          : ${p(m.onGround)}`,
        `  isCollidedVertically   : ${p(m.collidedVertically)}`,
        `  velocity.y < 0         : ${p(m.velYNegative)}`,
        `  velocity.y == 0        : ${p(m.velYZero)}`,
        `  resting flush on face  : ${p(m.restingFlush)}`,
        `  STANDING BUT NOT GROUNDED: ${p(m.standingButNotGrounded)}`,
        ...m.trace.map((t) => `  ${t}`),
    ].join('\n');
}
