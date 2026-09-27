/**
 * Jumping, for a bot whose `onGround` flag is broken.
 *
 * Modelled on SwimAssist, and owning the same two kinds of thing: a physical capability the
 * library will not give us, and the valve that switches it off when the server objects.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bot.entity.onGround` reads false for seconds while the bot is provably standing. Every jump in
 * prismarine-physics is gated on it (`index.js:725`), and so is ground acceleration
 * (`index.js:545`). So this bot **cannot jump at all** - measured in the headless sandbox
 * (`scratchpad/sim/`): vanilla apex 1.252, this server's apex **0.000**.
 *
 * THE MECHANISM, AND WHY IT IS A HYBRID
 * -------------------------------------
 * Two halves, and the sweep in `scratchpad/sim/RESULTS.md` shows neither is sufficient alone:
 *
 * 1. **Assert the flag for the take-off tick.** `PlayerState` reads `onGround` at the top of each
 *    tick, so setting it true - *while a solid block is genuinely under the feet* - makes the
 *    engine fire the REAL jump: `vel.y = 0.42` plus the `+0.2` sprint-jump boost along the
 *    heading. Vanilla numbers, computed by the engine, with none of the `negligeableVelocity`
 *    jerk that hand-written velocity produces. This asserts a truth the flag got wrong; it does
 *    not invent one.
 * 2. **Top up the axial speed through the arc.** The bot has no ground acceleration, so it
 *    arrives at the lip far slower than a player and the arc falls short. This is exactly what
 *    `climbBank`'s `STEP_IN_SPEED` does over a bank lip, one axis over.
 *
 * With only (1) the bot cannot clear a 3-wide gap without sprint; with only (2) the apex is short
 * because a hand-added impulse starts from an already-falling velocity - the engine *assigns*
 * 0.42, and `+=` costs a third of the jump height. Together: clears 4, works without sprint.
 *
 * THE CEILING IS VANILLA AND NOTHING MORE. `JUMP_AIR_SPEED` is 0.32 against
 * `physics.sprintSpeed` of 0.30; the impulse is the engine's own. Same discipline as SwimAssist's
 * boost, and the same valve underneath it.
 */

const DEFAULTS = {
    impulse: 0.42,            // the engine's own figure (prismarine-physics index.js:725)
    airSpeed: 0.32,           // vanilla sprint-jump take-off. Never raise this.
    windowMs: 1800,           // hard cap on one flight
    rubberBandLimit: 3,       // real corrections within the window that stand jumping down
    rubberBandWindowMs: 10000,
    mechanismFailures: 3,     // liftoffs that produced no rise before we stand down
    // A CORRECTION ONLY COUNTS IF THE SERVER ACTUALLY MOVED US. `forcedMove` fires on every
    // server position packet and this server sends them constantly, so counting packets means
    // counting routine syncs. Same trap SwimAssist's valve documents, and the one GroundTruth
    // was retuned for on 2026-08-30.
    //
    // The comparison is against the position ONE PHYSICS TICK ago, the way
    // `agent._wireTeleportDetection` does it - not against the previous packet. Sampling per
    // packet measures how far the bot flew between two syncs, which mid-jump is most of a
    // gap-crossing, so our own flight would have kept tripping the very valve this filters.
    // The threshold has to clear one tick of our OWN motion: the jump impulse is 0.42 and the
    // axial top-up 0.32, so a tick of honest flight is ~0.53 blocks. Hence 1.0, not 0.5.
    disagreeBlocks: 1.0,
    // STAND DOWN, DO NOT LATCH. This used to disable jumping for the whole SESSION. The teardown
    // (see CLAUDE.md) measured the climb gym at 1/4 without JumpAssist against 4/4 with it, so a
    // latched valve does not "degrade to bridging" - it cripples the bot until someone restarts
    // it, silently, hours later. Found live: andy tunnelling with
    // `jump: REFUSED (jumping disabled (server corrections))` while following a player.
    // A cooldown is the right shape and the codebase already uses it for the LLM circuit breaker.
    standDownMs: 60000,
};

export class JumpAssist {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.opts = { ...DEFAULTS, ...options };
        this.enabled = false;
        /**
         * True only from take-off to landing. AutoJump stands down while it is set, so a LEAK
         * here silently destroys the bot's ability to climb any one-block step - the single
         * capability the whole navigator is built on. Hence three independent guards: the
         * `finally` in the caller, the self-expiry in `_tick`, and `!stats` exposing it.
         */
        this.active = false;
        this.activeUntil = 0;
        this.disabledUntil = 0;   // valve tripped or mechanism dead - RECOVERS, see standDownMs
        this.jumps = 0;
        this.failures = 0;
        this.forcedMoves = [];
        this.heading = null;      // unit {dx, dz} we are driving along while airborne
        this._onTick = () => this._tick();
        this._onForcedMove = () => this._forcedMove();
        this._onReset = () => this.end();
    }

    /** True only while standing down. A getter so every existing `disabled` read still works. */
    get disabled() { return Date.now() < this.disabledUntil; }

    /** Stand jumping down for a while, and say when it will be back. */
    _standDown(reason) {
        if (this.disabled) return;
        this.disabledUntil = Date.now() + this.opts.standDownMs;
        this.failures = 0;
        this.forcedMoves = [];
        this.end();
        console.warn(`[JumpAssist] ${reason} - jumping stood down for `
            + `${Math.round(this.opts.standDownMs / 1000)}s, then it retries.`);
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.bot.on('physicsTick', this._onTick);
        this.bot.on('forcedMove', this._onForcedMove);
        // A flight interrupted by death or respawn must not leave `active` set - see above.
        this.bot.on('death', this._onReset);
        this.bot.on('respawn', this._onReset);
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.bot.removeListener('physicsTick', this._onTick);
        this.bot.removeListener('forcedMove', this._onForcedMove);
        this.bot.removeListener('death', this._onReset);
        this.bot.removeListener('respawn', this._onReset);
        this.end();
    }

    get stats() {
        return {
            active: this.active,
            disabled: this.disabled,
            jumps: this.jumps,
            failures: this.failures,
            rubberBands: this.forcedMoves.length,
        };
    }

    /**
     * Is there a full block under the feet? The world's answer, never `onGround`.
     *
     * This is the honesty check on the whole mechanism: we only assert the ground flag when the
     * bot really is on the ground. Copied from `climbBank`'s `standingOnSolid` - the block below
     * the FEET CELL, not 0.2 below the eye position, because a bot resting a third of a block
     * above the boundary still floors into its own cell.
     */
    grounded() {
        const b = this.bot.blockAt?.(this.bot.entity.position.floored().offset(0, -1, 0));
        return !!b && b.boundingBox === 'block';
    }

    /**
     * Begin a flight along a unit heading. Returns false if we must not jump.
     *
     * The take-off itself happens on the next `physicsTick`, not here: the flag has to be set on
     * the tick the engine reads it, and setting it now would be overwritten by the `apply()` of
     * the tick already in progress.
     */
    begin(dx, dz) {
        if (this.disabled || this.active) return false;
        if (!this.grounded()) return false;
        this.active = true;
        this.activeUntil = Date.now() + this.opts.windowMs;
        this.heading = { dx, dz };
        this.pendingTakeoff = true;
        this.launchY = this.bot.entity.position.y;
        this.apex = 0;
        return true;
    }

    /** End a flight. Idempotent, and safe to call from a `finally` that does not know the state. */
    end() {
        this.active = false;
        this.pendingTakeoff = false;
        this.heading = null;
    }

    _tick() {
        // SELF-EXPIRY. The caller's `finally` should always run, but if it does not - an
        // interrupt, a throw, a process wedged mid-await - AutoJump would be muted forever and
        // the bot would lose one-block steps with no visible cause.
        if (this.active && Date.now() > this.activeUntil) this.end();
        if (!this.active) return;

        const e = this.bot.entity;
        if (this.pendingTakeoff) {
            if (!this.grounded()) return;          // wait for a tick where the assertion is true
            this.pendingTakeoff = false;
            this.jumps++;
            this._lastSeen = e.position.clone();   // baseline for the rubber-band comparison
            // Assert the truth the flag got wrong, for this tick only. `apply()` will overwrite
            // it back to false immediately after the simulation runs.
            e.onGround = true;
            this.bot.setControlState('jump', true);
            this._launchedAt = Date.now();
            return;
        }

        // Release the key once we are moving upward - holding it does nothing airborne, and a
        // held key is one more thing to leak.
        if (this.bot.controlState?.jump && e.velocity.y > 0.1) {
            this.bot.setControlState('jump', false);
        }

        this.apex = Math.max(this.apex, e.position.y - this.launchY);

        // The run-up the broken ground flag denies us. Project the current velocity on the
        // heading and top it up - never add, so this cannot compound into a speed the server
        // would not believe.
        const h = this.heading;
        if (h) {
            const along = e.velocity.x * h.dx + e.velocity.z * h.dz;
            if (along < this.opts.airSpeed) {
                const need = this.opts.airSpeed - along;
                e.velocity.x += need * h.dx;
                e.velocity.z += need * h.dz;
            }
        }

        // The rubber-band baseline, resampled every tick. See `disagreeBlocks`: compared against
        // the previous PACKET this measures our own flight, which is exactly what the filter is
        // supposed to exclude.
        this._lastSeen = e.position.clone?.() ?? null;
    }

    /** Did the last flight actually leave the ground? Used to latch a dead mechanism. */
    noteOutcome(rose) {
        if (rose) { this.failures = 0; return; }
        if (++this.failures >= this.opts.mechanismFailures) {
            this._standDown(`${this.failures} take-offs produced no rise`);
        }
    }

    _forcedMove() {
        // Only corrections that arrive WHILE WE ARE AIRBORNE are evidence against jumping.
        // mineflayer emits forcedMove for every server position packet - login, teleports and
        // routine corrections all count - so an unconditional counter trips the valve before the
        // bot has jumped at all. SwimAssist observed 4 "rubber-bands" during spawn.
        if (!this.active || this.disabled) return;
        // Did the server actually MOVE us? A routine sync leaves us where we were and says
        // nothing about the jump. Compare against where our own physics thinks we are.
        const p = this.bot.entity?.position;
        if (!p || !this._lastSeen) { this._lastSeen = p?.clone?.() ?? null; return; }
        const moved = p.distanceTo(this._lastSeen);
        this._lastSeen = p.clone();
        if (moved < this.opts.disagreeBlocks) return;

        const now = Date.now();
        this.forcedMoves = this.forcedMoves.filter(t => now - t < this.opts.rubberBandWindowMs);
        this.forcedMoves.push(now);
        if (this.forcedMoves.length > this.opts.rubberBandLimit) {
            this._standDown(`server moved us ${this.forcedMoves.length} times mid-flight`);
        }
    }
}
