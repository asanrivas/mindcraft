/**
 * `onGround`, computed from the world instead of believed from the flag.
 *
 * WHY THIS EXISTS
 * ---------------
 * This is the root cause the whole movement stack was built around. `bot.entity.onGround` reads
 * false while the bot is provably standing, and prismarine-physics gates BOTH jumping
 * (`index.js:725`) and ground acceleration (`index.js:545`) on it. So the bot cannot jump
 * (measured apex 0.000 against vanilla's 1.252) and gets no ground acceleration, and everything
 * else in this codebase is a workaround for those two facts:
 *
 *   - `auto_jump.js` refuses to gate on the flag and treats a stable y as standing;
 *   - `jump_assist.js` asserts the flag for a single take-off tick;
 *   - `followPath` pulses jump, because AIRBORNE acceleration is the only acceleration we get;
 *   - `swim.climbBank` injects `JUMP_IMPULSE` by hand;
 *   - `pillarUp` could not lift the bot at all.
 *
 * THE MECHANISM
 * -------------
 * prismarine-physics computes the flag in exactly one place (index.js:301):
 *
 *     entity.onGround = entity.isCollidedVertically && oldVelY < 0
 *
 * It needs a downward velocity going INTO the move. A resting body has its `vel.y` zeroed by the
 * previous tick's collision, and this server's position corrections zero it again - so `oldVelY`
 * is exactly 0, `0 < 0` is false, and a bot flush on stone is reported airborne. Captured live:
 *
 *     onGround=true   vel=(0.000, -0.078, 0.000)     <- gravity survived into the move
 *     onGround=false  vel=(0.000,  0.000, 0.000)     <- velocity zeroed; same block underfoot
 *
 * The flag is not reporting a fact about the world; it is reporting whether one particular
 * velocity happened to survive. So we compute the fact ourselves and assert it.
 *
 * THIS ASSERTS A TRUTH, IT DOES NOT INVENT ONE - the same discipline `jump_assist` states for
 * its single tick, applied continuously. Three conditions, all required, all conservative:
 *
 *   1. a full block under the FEET CELL (the world's answer, never the flag's);
 *   2. the body is FLUSH on that block's top face - a resting body sits at exactly .00, so
 *      anything above that is not touching it and must keep falling;
 *   3. `vel.y <= 0` - never claim ground contact for a body moving upward, or we would cancel
 *      the apex of our own jumps.
 *
 * A body genuinely falling past y=64.5 fails (2), and a body rising off a pillar fails (3).
 *
 * THE VALVE
 * ---------
 * Same shape as SwimAssist's and JumpAssist's. If the server starts correcting us while we are
 * asserting, we stand down for the session rather than fight it - and, as those two learned the
 * hard way, only corrections that arrive WHILE WE ARE ASSERTING are evidence. `forcedMove` fires
 * on every server position packet, including login and teleports, so an unconditional counter
 * trips during spawn before the bot has moved.
 */

const DEFAULTS = {
    flushEpsilon: 0.02,        // how far above a block face still counts as resting on it
    // A correction only counts as DISAGREEMENT if the server actually moved us vertically.
    // mineflayer emits `forcedMove` for every server position packet, and this server sends them
    // constantly, so counting packets stands the assist down within seconds of spawning - which
    // is precisely the trap SwimAssist's valve documents ("only corrections that arrive while
    // boosting are evidence"). Being ASSERTING is not a narrow enough condition, because we are
    // asserting on nearly every tick the bot spends standing still. The evidence we want is the
    // server telling us we are somewhere else vertically than we thought.
    disagreeY: 0.5,            // blocks of vertical disagreement that count as a real correction
    rubberBandLimit: 6,
    rubberBandWindowMs: 10000,
};

export class GroundTruth {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.opts = { ...DEFAULTS, ...options };
        this.enabled = false;
        this.disabled = false;     // latched for the session by the valve
        this.asserting = false;    // true on ticks where we corrected the flag
        this.corrections = 0;      // how many ticks we have fixed, for !stats
        this.forcedMoves = [];
        this.lastY = null;         // our own view of y, sampled each tick, for the valve
        this._onTick = () => this._tick();
        this._onForcedMove = () => this._forcedMove();
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.bot.on('physicsTick', this._onTick);
        this.bot.on('forcedMove', this._onForcedMove);
        console.log('[GroundTruth] enabled');
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.asserting = false;
        this.bot.removeListener('physicsTick', this._onTick);
        this.bot.removeListener('forcedMove', this._onForcedMove);
    }

    /**
     * Is the body resting on a solid block? Pure world reads plus the entity's own numbers.
     * Exported shape kept simple so `groundVerdict` below can be unit-tested without a bot.
     */
    standing() {
        const e = this.bot.entity;
        if (!e) return false;
        const below = this.bot.blockAt?.(e.position.floored().offset(0, -1, 0));
        return groundVerdict({
            solidBelow: !!below && below.boundingBox === 'block',
            frac: e.position.y - Math.floor(e.position.y),
            velY: e.velocity.y,
            epsilon: this.opts.flushEpsilon,
        });
    }

    _tick() {
        if (this.disabled) { this.asserting = false; return; }
        const e = this.bot.entity;
        if (!e) return;
        // Only ever turn the flag ON. Clearing it when we think the bot is airborne would
        // override the engine's own collision result, which is right far more often than we are.
        if (!e.onGround && this.standing()) {
            e.onGround = true;
            this.asserting = true;
            this.corrections++;
        } else {
            this.asserting = false;
        }
        this.lastY = e.position.y;
    }

    _forcedMove() {
        if (!this.asserting || this.lastY === null) return;   // spawn and teleports are not evidence
        // Did the server actually put us somewhere else vertically? A routine sync leaves y
        // where we had it and says nothing about whether we were on the ground.
        const dy = Math.abs((this.bot.entity?.position?.y ?? this.lastY) - this.lastY);
        if (dy < this.opts.disagreeY) return;
        const now = Date.now();
        this.forcedMoves = this.forcedMoves.filter((t) => now - t < this.opts.rubberBandWindowMs);
        this.forcedMoves.push(now);
        if (!this.disabled && this.forcedMoves.length > this.opts.rubberBandLimit) {
            this.disabled = true;
            this.asserting = false;
            console.warn(`[GroundTruth] server moved us vertically ${this.forcedMoves.length} `
                + `times in ${this.opts.rubberBandWindowMs / 1000}s while we asserted ground `
                + `contact - standing down for this session.`);
        }
    }
}

/**
 * Should we assert ground contact? Pure, so the boundaries are testable.
 *
 * @param {object} s
 * @param {boolean} s.solidBelow full block under the feet cell
 * @param {number}  s.frac       height above that block's top face (0 = flush)
 * @param {number}  s.velY       current vertical velocity
 * @param {number}  [s.epsilon]  how far above the face still counts as resting
 */
export function groundVerdict(s) {
    if (!s || !s.solidBelow) return false;
    const eps = s.epsilon ?? DEFAULTS.flushEpsilon;
    // A resting body sits at exactly .00 on the face. Anything higher is in the air and has to
    // keep falling, or we would let it jump from mid-flight.
    if (!(s.frac >= 0 && s.frac < eps)) return false;
    // Never claim contact for a body moving UP: that would cancel the apex of our own jump on
    // the very tick after take-off, which is the one tick that decides the whole flight.
    if (!(s.velY <= 0)) return false;
    return true;
}
