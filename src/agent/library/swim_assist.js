import { inWater, isSubmerged, inLava, verticalIntent } from './swim.js';

/**
 * Always-on swimming support, modelled on AutoJump.
 *
 * Owns two things while the bot is wet, and nothing else in the codebase may touch either:
 *
 * 1. **The jump key.** In water, jump is buoyancy, not propulsion (prismarine-physics adds
 *    vel.y += 0.04 per tick while it is held). Its default mode is `auto`, which holds jump
 *    whenever the head is underwater. That is deliberate: it means the failure mode of a crash
 *    ANYWHERE in the swimming code is a bot floating at the surface, not one sitting on the
 *    seabed running out of air.
 *
 * 2. **Sprint-swimming.** prismarine-physics never reads `control.sprint` inside its water
 *    branch, so the 1.13+ swimming pose simply does not exist for this bot - a sprinting
 *    submerged player moves at exactly walking-swim speed. We restore parity by raising
 *    `bot.physics.liquidAcceleration` while submerged and sprinting: `moveEntityWithHeading`
 *    re-reads that constant every tick, so the acceleration curve and strafing stay correct.
 *    Adding to `bot.entity.velocity` directly also works but fights `negligeableVelocity` and
 *    produces jerk.
 *
 *    The ceiling is VANILLA PARITY and nothing more: 0.032/(1-0.8) = 0.16 b/t, exactly what a
 *    real player gets by holding sprint underwater. This is restoring a mechanic the library
 *    forgot, not exceeding what a legitimate client can do.
 */

const DEFAULTS = {
    boostAccel: 0.026,      // 0.13 b/t. Raise to 0.032 (vanilla 0.16 b/t) once measured safe.
    requireSubmerged: true, // vanilla only sprint-swims in the swimming pose
    sinkAssist: 0.015,      // extra downward accel in 'sink' mode; sinking is otherwise 0.025 b/t
    band: 0.35,
    rubberBandLimit: 3,     // forcedMove corrections within the window that kill the boost
    rubberBandWindowMs: 10000,
};

export class SwimAssist {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.opts = { ...DEFAULTS, ...options };
        this.enabled = false;
        this.mode = 'auto';          // auto | climb | sink | hold | off
        this.targetY = null;
        this.holdingJump = false;
        this.intent = 'hold';
        this.boosted = false;
        this.boostDisabled = false;
        this.savedAccel = null;
        this.forcedMoves = [];
        this._onTick = () => this._tick();
        this._onForcedMove = () => this._forcedMove();
        this._onReset = () => this._restore(true);
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.bot.on('physicsTick', this._onTick);
        this.bot.on('forcedMove', this._onForcedMove);
        // A leaked liquidAcceleration would silently alter LAVA movement forever, so restore it
        // on anything that can interrupt the normal leave-the-water path.
        this.bot.on('death', this._onReset);
        this.bot.on('respawn', this._onReset);
        console.log('[SwimAssist] enabled');
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.bot.removeListener('physicsTick', this._onTick);
        this.bot.removeListener('forcedMove', this._onForcedMove);
        this.bot.removeListener('death', this._onReset);
        this.bot.removeListener('respawn', this._onReset);
        this._restore(true);
    }

    /**
     * @param {'auto'|'climb'|'sink'|'hold'|'off'} mode
     * @param {number|null} targetY required by 'hold'
     */
    setMode(mode, targetY = null) {
        this.mode = mode;
        this.targetY = targetY;
        if (mode === 'off') this._releaseJump();
    }

    get stats() {
        return {
            mode: this.mode,
            boosted: this.boosted,
            boostDisabled: this.boostDisabled,
            holdingJump: this.holdingJump,
            rubberBands: this.forcedMoves.length,
        };
    }

    _forcedMove() {
        // Only corrections that arrive WHILE we are boosting are evidence against the boost.
        // mineflayer emits forcedMove for every server position packet - login, teleports and
        // routine corrections all count - so an unconditional counter trips the valve before
        // the bot has been near water. Observed live: 4 "rubber-bands" during spawn.
        if (!this.boosted) return;
        const now = Date.now();
        this.forcedMoves = this.forcedMoves.filter(t => now - t < this.opts.rubberBandWindowMs);
        this.forcedMoves.push(now);
        if (!this.boostDisabled && this.forcedMoves.length > this.opts.rubberBandLimit) {
            // The server is correcting us. Degrade to plain swimming rather than get kicked.
            this.boostDisabled = true;
            this._restoreAccel();
            console.warn(`[SwimAssist] server rubber-banded ${this.forcedMoves.length} times in `
                + `${this.opts.rubberBandWindowMs / 1000}s - sprint-swim boost disabled for this session.`);
        }
    }

    _restoreAccel() {
        if (this.savedAccel !== null && this.bot.physics) {
            this.bot.physics.liquidAcceleration = this.savedAccel;
        }
        this.savedAccel = null;
        this.boosted = false;
    }

    _releaseJump() {
        // Only ever release a jump WE are holding: something else may be mid-jump on land.
        if (this.holdingJump) {
            this.bot.setControlState('jump', false);
            this.holdingJump = false;
        }
    }

    _restore(resetMode = false) {
        this._restoreAccel();
        this._releaseJump();
        if (resetMode) { this.mode = 'auto'; this.targetY = null; this.intent = 'hold'; }
    }

    /**
     * Assert the jump key against the bot's ACTUAL control state, not against what we last
     * asked for.
     *
     * This used to early-return when `on === this.holdingJump`, which made the cached flag the
     * source of truth. Anything else calling `bot.clearControlStates()` - the action manager on
     * an interrupt, a mode, another skill's cleanup - then set jump false behind our back, and
     * because our flag still said "holding", we never pressed it again. Buoyancy died silently
     * while `!stats` cheerfully reported `jump=true`.
     *
     * Observed: submerged, `physics.isInWater=true`, `jump=true`, and `vel.y=-0.005` - pure
     * sinking with the key supposedly held. The bot sat at 0/20 air taking drowning damage.
     */
    _setJump(on) {
        const actual = this.bot.controlState?.jump;
        if (actual !== on) this.bot.setControlState('jump', on);
        this.holdingJump = on;
    }

    _tick() {
        const bot = this.bot;
        if (!bot.entity) return;

        if (!inWater(bot)) { this._restore(true); return; }
        // isInWater and isInLava share the same physics branch and can both be true at a
        // boundary. Never boost, and never manage buoyancy, while any lava is involved.
        if (inLava(bot)) { this._restore(); return; }

        // 'off' means hands off EVERYTHING, not just the jump key. This used to skip only the
        // buoyancy switch below while still rewriting liquidAcceleration every tick, which
        // silently overwrote the swim probe's own value - making a boost that works measure as
        // "no effect" because all three boost phases read back SwimAssist's 0.026.
        if (this.mode === 'off') { this._restore(); return; }

        const submerged = isSubmerged(bot);

        // --- sprint-swim boost -------------------------------------------------------------
        const wantBoost = !this.boostDisabled
            && bot.controlState?.sprint
            && bot.controlState?.forward
            && (!this.opts.requireSubmerged || submerged);
        if (wantBoost && bot.physics) {
            if (this.savedAccel === null) this.savedAccel = bot.physics.liquidAcceleration;
            bot.physics.liquidAcceleration = this.opts.boostAccel;
            this.boosted = true;
        } else if (this.savedAccel !== null) {
            this._restoreAccel();
        }

        // --- buoyancy ----------------------------------------------------------------------
        switch (this.mode) {
            case 'climb':
                this._setJump(true);
                break;
            case 'sink':
                this._setJump(false);
                // Sinking unaided is 0.025 b/t - seven times slower than rising, which makes an
                // unassisted dive painfully slow. This keeps it usable without exceeding the
                // speed a player gets by swimming downward.
                if (bot.entity.velocity) bot.entity.velocity.y -= this.opts.sinkAssist;
                break;
            case 'hold': {
                const y = bot.entity.position.y;
                const target = this.targetY ?? y;
                this.intent = verticalIntent(y, target, this.opts.band, this.intent);
                this._setJump(this.intent === 'up');
                if (this.intent === 'down' && bot.entity.velocity) {
                    bot.entity.velocity.y -= this.opts.sinkAssist;
                }
                break;
            }
            case 'auto':
            default:
                // Positive buoyancy: keep the head above water and stay there.
                this._setJump(submerged);
                break;
        }
    }
}
