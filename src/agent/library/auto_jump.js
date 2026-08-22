import { Vec3 } from 'vec3';

/**
 * Vanilla-style auto-jump, implemented locally.
 *
 * Why this exists: this server runs Minecraft 26.1 (protocol 775) but the PrismarineJS stack
 * has no 26.x support, so mineflayer connects with 1.21.11 block/collision data. The resulting
 * physics mismatch means mineflayer-pathfinder's own jump never carries horizontal momentum -
 * measured directly: the bot pressed jump on 136 of 241 ticks and reached maxY 62.27 (clearing
 * a 62.0 step) yet finished 0.1 blocks from where it started. It bunny-hops against the wall
 * because by the time it jumps it has already decelerated to zero.
 *
 * The fix is timing, not force: jump while still ~0.9 blocks short of the obstruction, so the
 * bot is already moving when it leaves the ground and carries that velocity onto the ledge.
 * Raw jumps work fine (measured 1.25 blocks), so nothing here fights the physics engine - it
 * only presses the key earlier than the pathfinder would.
 */

const DEFAULTS = {
    lookAhead: 0.9,      // how far in front to probe, in blocks
    minSpeed: 0.045,     // ignore when essentially stationary
    jumpHoldTicks: 3,    // long enough to get full jump height
    // Short cooldown on purpose: a staircase needs a jump roughly every half second, and a
    // long cooldown made the bot climb one step and then stall waiting to be allowed to jump
    // again. The onGround check below already stops it firing while airborne.
    cooldownTicks: 2,
    maxRise: 1,          // only auto-jump single-block steps
};

export class AutoJump {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.opts = { ...DEFAULTS, ...options };
        this.enabled = false;
        this.holding = 0;
        this.cooldown = 0;
        this.jumps = 0;
        this._onTick = () => this._tick();
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this.bot.on('physicsTick', this._onTick);
        console.log('[AutoJump] enabled');
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.bot.removeListener('physicsTick', this._onTick);
        if (this.holding > 0) this.bot.setControlState('jump', false);
        this.holding = 0;
    }

    _tick() {
        const bot = this.bot;

        // Release the key once the hold window is over, then start the cooldown.
        if (this.holding > 0) {
            if (--this.holding === 0) {
                bot.setControlState('jump', false);
                this.cooldown = this.opts.cooldownTicks;
            }
            return;
        }
        if (this.cooldown > 0) { this.cooldown--; return; }

        if (!bot.entity) return;
        if (!this._grounded()) return;

        // Direction of actual travel; fall back to facing if velocity is tiny but we're walking.
        const v = bot.entity.velocity;
        let dx = v.x, dz = v.z;
        const speed = Math.hypot(dx, dz);
        if (speed < this.opts.minSpeed) {
            if (!bot.controlState?.forward) return;
            dx = -Math.sin(bot.entity.yaw);
            dz = -Math.cos(bot.entity.yaw);
        } else {
            dx /= speed; dz /= speed;
        }

        const pos = bot.entity.position;
        const ahead = pos.offset(dx * this.opts.lookAhead, 0, dz * this.opts.lookAhead);
        const feet = new Vec3(Math.floor(ahead.x), Math.floor(pos.y), Math.floor(ahead.z));

        if (!this._isSolid(feet)) return;                          // nothing to climb
        if (this._isSolid(feet.offset(0, 1, 0))) return;            // 2+ high: not a step
        if (this._isSolid(new Vec3(Math.floor(pos.x), Math.floor(pos.y) + 2, Math.floor(pos.z)))) return; // no headroom

        bot.setControlState('jump', true);
        this.holding = this.opts.jumpHoldTicks;
        this.jumps++;
    }

    /**
     * `onGround` cannot be trusted on this server - traces show it reading false for seconds at
     * a time while the bot is provably standing (constant y, zero velocity). Gating purely on it
     * meant this class never fired exactly when it was needed most. Treat a stable y with no
     * vertical motion as standing, which is what the flag was supposed to tell us.
     */
    _grounded() {
        const e = this.bot.entity;
        if (e.onGround) { this.stableTicks = 0; this.lastY = e.position.y; return true; }
        const dy = this.lastY === undefined ? 1 : Math.abs(e.position.y - this.lastY);
        this.lastY = e.position.y;
        if (dy < 0.01 && Math.abs(e.velocity.y) < 0.02) this.stableTicks = (this.stableTicks || 0) + 1;
        else this.stableTicks = 0;
        return this.stableTicks >= 4;
    }

    _isSolid(p) {
        const b = this.bot.blockAt(p);
        if (!b) return false;
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false;
        if (b.name.includes('water') || b.name.includes('lava')) return false;
        // boundingBox is the authority when the block data has it
        if (b.boundingBox) return b.boundingBox === 'block';
        return true;
    }
}
