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

    /**
     * In water, but standing on the bottom with the head in air - a puddle or a ford, which for
     * propulsion is land. Distinct from afloat, which is SwimAssist's.
     */
    _wading() {
        const bot = this.bot;
        if (!bot.entity) return false;
        const p = bot.entity.position.floored();
        const head = bot.blockAt(p.offset(0, 1, 0));
        if (head && (head.name === 'water' || head.name === 'flowing_water')) return false;
        const below = bot.blockAt(p.offset(0, -1, 0));
        return !!below && below.boundingBox === 'block';
    }

    _tick() {
        const bot = this.bot;

        // Water belongs to SwimAssist - but only where SwimAssist is actually USING the jump
        // key, which is while the bot is SUBMERGED or genuinely afloat. A bot bobbing at a
        // stable surface height satisfies _grounded()'s stable-y test, so there the two would
        // fight over the same control state every tick.
        //
        // WADING is different: in a puddle or at a ford the bot stands on solid ground with its
        // head in air, SwimAssist's `auto` mode presses nothing, and standing down here left NO
        // subsystem pressing jump - which on this server, where `onGround` reads false while the
        // bot is provably standing, means no acceleration from any source. Measured at
        // (4281, 62, 4935): vel=(0.000, 0.000, 0.000) with `forward` held, for twenty minutes.
        if (bot.entity?.isInWater && !this._wading()) {
            if (this.holding > 0) { this.holding = 0; this.cooldown = 0; }
            return;
        }

        // A DELIBERATE JUMP IS IN FLIGHT: hands off. JumpAssist asserts the ground flag and drives
        // the arc, and our own timing logic would fight it for the key mid-flight.
        //
        // Clear `holding` WITHOUT releasing, exactly as the water bail above does. Releasing here
        // would press `jump` false on the very tick JumpAssist set it true, which is the take-off
        // tick - the one tick in the whole flight that matters.
        if (bot.jumpAssist?.active) {
            if (this.holding > 0) { this.holding = 0; this.cooldown = 0; }
            return;
        }

        // Release the key once the hold window is over, then start the cooldown.
        if (this.holding > 0) {
            if (--this.holding === 0) {
                bot.setControlState('jump', false);
                this.cooldown = this.opts.cooldownTicks;
            } else if (bot.controlState?.jump !== true) {
                // RE-ASSERT AGAINST THE REAL CONTROL STATE, never against `holding`.
                // Same invariant SwimAssist's `_setJump` had to learn, different subsystem:
                // trust the key, not our own belief about the key. Anything that calls
                // `bot.clearControlStates()` - the action manager on an interrupt, a mode,
                // another skill's cleanup - drops jump behind our back, and a `holding` counter
                // that still says "mid-jump" then never presses again. Jump is the only
                // propulsion this server gives us, so one silent drop is a stalled bot.
                //
                // HONESTY NOTE: this is defensive, not measured. It was written for a specific
                // mechanism - mineflayer-pathfinder clearing jump unconditionally every tick at
                // index.js:629 - and the A/B that was supposed to prove it measured nothing (the
                // test drove `!goToCoordinates`, which settings.js blacklists, so the command was
                // dropped before parsing and BOTH arms were void). That mechanism is in any case
                // no longer live: nothing executes on pathfinder any more. Kept because the rule
                // it encodes is right and the cost is one comparison; delete it freely if it
                // ever gets in the way.
                bot.setControlState('jump', true);
            }
            return;
        }
        if (this.cooldown > 0) { this.cooldown--; return; }

        if (!bot.entity) return;
        if (!this._grounded()) { this._why('not_grounded'); return; }

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

        // SWEEP THE BODY WIDTH, not the centre line. The bot is 0.6 blocks wide, and the block
        // that actually stops it is often the one its shoulder is against - not the one 0.9
        // blocks along its centre. Probing a single point reported `nothing_ahead` 14-20 times
        // a SECOND while the bot stood face-on to a sandstone step and mined it instead of
        // stepping up. `nav.js` already learned this for path smoothing (`bodyClear`, r=0.32);
        // this is the same sweep, in the same units.
        const r = 0.32;
        const px = -dz, pz = dx;                       // perpendicular to the heading
        const seen = new Set();
        let step = null;
        for (const off of [0, -r, r]) {                // straight ahead first, then each shoulder
            const ax = pos.x + dx * this.opts.lookAhead + px * off;
            const az = pos.z + dz * this.opts.lookAhead + pz * off;
            const cell = new Vec3(Math.floor(ax), Math.floor(pos.y), Math.floor(az));
            const key = `${cell.x},${cell.z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!this._isSolid(cell)) continue;        // nothing to climb in this column
            if (this._isSolid(cell.offset(0, 1, 0))) continue;   // 2+ high here: not a step
            step = cell;
            break;
        }
        if (!step) { this._why(seen.size ? 'nothing_ahead' : 'no_samples'); return; }
        if (this._isSolid(new Vec3(Math.floor(pos.x), Math.floor(pos.y) + 2, Math.floor(pos.z)))) { this._why('no_headroom'); return; }

        this._why('JUMPED');
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
    /**
     * Tally why auto-jump did or did not fire, and print it once a second.
     *
     * "The bot mines the step instead of climbing it" is the symptom; the cause is whichever
     * gate below keeps returning early, and from outside the two are indistinguishable. The
     * suspect is `_grounded()`: it needs FOUR consecutive ticks of near-zero vertical motion,
     * which stepped terrain may never provide.
     */
    _why(reason) {
        this._tally = this._tally || {};
        this._tally[reason] = (this._tally[reason] || 0) + 1;
        // Silent unless explicitly switched on. This tally found the body-sweep and grounded
        // bugs, but at one line per second it floods the shared log - enough to push other
        // agents' lines out of any tail-based search, which broke the test harness's own
        // "did the command arrive?" check. Set AUTOJUMP_DEBUG=1 to bring it back.
        if (!process.env.AUTOJUMP_DEBUG) { this._tally = {}; return; }
        const now = Date.now();
        if (!this._tallyAt) this._tallyAt = now;
        if (now - this._tallyAt < 1000) return;
        this._tallyAt = now;
        const t = this._tally; this._tally = {};
        const parts = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`[${this.bot.username ?? '?'}] autojump: ${parts} stableTicks=${this.stableTicks ?? 0} onGround=${this.bot.entity?.onGround}`);
    }

    _grounded() {
        const e = this.bot.entity;
        if (e.onGround) { this.stableTicks = 0; this.lastY = e.position.y; return true; }

        // POSITIVE TEST: is there solid ground under the feet, and are we not rising?
        //
        // The stable-y fallback below infers standing from STILLNESS, and a bot that is walking
        // is never still - measured live at `stableTicks=0` on 100% of ticks while the bot ran
        // at 3.5 blocks/s. So auto-jump only ever fired on the rare tick where `onGround`
        // happened to be true, and the whole class was effectively dead while moving, which is
        // exactly when a step needs clearing. Asking the WORLD what is under the feet is ground
        // truth; `onGround` is the flag that lies here.
        const below = this.bot.blockAt(e.position.offset(0, -0.2, 0));
        if (below && below.boundingBox === 'block' && e.velocity.y <= 0.01) {
            this.lastY = e.position.y;
            return true;
        }
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
