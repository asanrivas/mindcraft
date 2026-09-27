/**
 * Movement for the owned client: physics, control state, and the position packets.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * This is the piece that turns `observer.js` (read-only) into something that can act. It is
 * deliberately NOT a physics engine. Today's measurements settled that question:
 *
 *   - a clean client on this server reports `onGround` 60/60 true and jumps to apex **1.252**,
 *     the exact vanilla figure - so the engine's simulation is correct here;
 *   - the "apex 0.000 / onGround is broken" claim came from a sandbox that FORCES the flag
 *     false and then measures no jump;
 *   - world decode was already proven identical across 24,389 blocks, 0 errors.
 *
 * So the layers we BORROW are the ones that were never wrong: `minecraft-protocol` for
 * transport and codec, `prismarine-chunk`/`-block`/`-registry` for world decode, and
 * `prismarine-physics` for the simulation. What we BUILD is the layer where mineflayer actually
 * fails - packet policy, acknowledgement, and an action surface that never awaits an event this
 * server does not send.
 *
 * Writing our own physics would be re-deriving the half that demonstrably works, and every
 * constant in `nav.js` is calibrated against THIS engine's numbers.
 *
 * THE POSITION PACKET IS THE WHOLE INTERFACE
 * ------------------------------------------
 * The protocol reports POSITION, not velocity. Anything we do to `vel` is invisible to the
 * server except through where we end up - which is why re-arm RATE could not matter in the
 * cadence measurement, and why every anti-cheat trip anyone traced came from real displacement.
 * So this sends position and nothing else, and it sends it at the tick rate rather than as fast
 * as it can: mineflayer tops out at 20/s for the same reason, and the server never objected to
 * that rate in 45s of unthrottled measurement.
 */
import { EventEmitter } from 'events';
import { Physics, PlayerState } from 'prismarine-physics';
import Vec3 from 'vec3';

/** Vanilla tick. The server expects roughly this cadence and nothing faster buys anything. */
export const TICK_MS = 50;

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

/**
 * Adapt the owned `World` to the shape prismarine-physics expects.
 *
 * It only ever asks for `getBlock(pos)`, and it needs the block to carry `boundingBox`,
 * `position` and `shapes` - which is what `world.blockAt` already returns via prismarine-block.
 * Returning `null` for an unloaded column is correct: the engine treats it as air, and pretending
 * otherwise would make the bot collide with chunks it cannot see.
 */
function physicsWorld(world) {
    return {
        getBlock(pos) {
            try {
                return world.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
            } catch {
                return null;
            }
        },
    };
}

export class PlayerController extends EventEmitter {
    /**
     * @param {object} o
     * @param {import('../net/connection.js').Connection} o.connection
     * @param {object} o.world      the owned World
     * @param {object} o.registry   prismarine-registry for this version
     * @param {object} o.entity     { position: Vec3, yaw, pitch } - the local player
     */
    constructor({ connection, world, registry, entity, version }) {
        super();
        this.version = version;
        this.connection = connection;
        this.world = world;
        this.registry = registry;
        this.entity = entity;

        this.physics = Physics(registry, physicsWorld(world));
        this.controlState = Object.fromEntries(CONTROLS.map((c) => [c, false]));
        this.state = null;
        this.running = false;
        this._timer = null;
        this.ticks = 0;
        this.simMs = 0;   // cumulative time inside simulatePlayer, for the tick-rate diagnostic
        // Sent only when something changed. A stationary client still sends periodically so the
        // server does not time it out, but flooding identical positions buys nothing.
        this._lastSent = null;
        this._lastSentAt = 0;
    }

    setControlState(control, value) {
        if (!CONTROLS.includes(control)) throw new Error(`unknown control ${control}`);
        this.controlState[control] = !!value;
    }

    clearControlStates() {
        for (const c of CONTROLS) this.controlState[c] = false;
    }

    /** Instant look. There is no smooth-turn variant on purpose - see block_io's header. */
    look(yaw, pitch) {
        this.entity.yaw = yaw;
        this.entity.pitch = pitch;
    }

    lookAt(point) {
        const p = this.entity.position;
        const dx = point.x - p.x, dy = point.y - (p.y + 1.62), dz = point.z - p.z;
        this.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
    }

    start() {
        if (this.running) return;
        this.running = true;
        // ONE shim object, reused: `PlayerState` reads from it and `.apply()` writes back to
        // it, so they must be the same reference or the simulation result lands nowhere.
        this._bot = this._simBot();
        this.state = new PlayerState(this._bot, this.controlState);
        this._timer = setInterval(() => this._tick(), TICK_MS);
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    stop() {
        this.running = false;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * `PlayerState` takes a BOT, not an entity, and reads a specific set of fields off it
     * (prismarine-physics index.js:804+). This is the smallest shape that satisfies exactly
     * those reads and nothing more - anything it does not touch is deliberately absent, so a
     * future version reaching for a new field crashes here instead of silently simulating
     * something else. The list was read out of the constructor, not guessed:
     *
     *   bot.version, bot.jumpTicks, bot.jumpQueued, bot.fireworkRocketDuration,
     *   bot.inventory.slots (armour + enchantments),
     *   bot.entity.{position, velocity, onGround, yaw, pitch, attributes, effects,
     *               isInWater, isInLava, isInWeb, isCollidedHorizontally,
     *               isCollidedVertically, elytraFlying}
     */
    _simBot() {
        const e = this.entity;
        e.velocity = e.velocity ?? new Vec3(0, 0, 0);
        e.onGround = e.onGround ?? false;
        e.isInWater = e.isInWater ?? false;
        e.isInLava = e.isInLava ?? false;
        e.isInWeb = e.isInWeb ?? false;
        e.isCollidedHorizontally = e.isCollidedHorizontally ?? false;
        e.isCollidedVertically = e.isCollidedVertically ?? false;
        e.elytraFlying = e.elytraFlying ?? false;
        e.attributes = e.attributes ?? {};
        e.effects = e.effects ?? {};
        return {
            version: this.version,
            entity: e,
            jumpTicks: 0,
            jumpQueued: false,
            fireworkRocketDuration: 0,
            // No armour and no enchantments yet: the owned client has no inventory layer, and
            // an EMPTY slot list is the honest representation of that. Wrong armour would
            // silently change fall damage and speed; absent armour just means unarmoured.
            inventory: { slots: [] },
        };
    }

    _tick() {
        if (!this.running) return;
        const t0 = Date.now();
        try {
            this.state.control = this.controlState;
            this.physics.simulatePlayer(this.state, physicsWorld(this.world)).apply(this._bot);
            this.ticks++;
            this.simMs += Date.now() - t0;
            this._sendPosition();
            this.emit('tick', this.entity);
        } catch (err) {
            // A physics throw must not kill the connection - report it and keep the socket alive
            // so the caller can decide. A dead tick loop with a live socket is easier to diagnose
            // than a client that vanished.
            this.emit('physicsError', err);
        }
    }

    _sendPosition() {
        const p = this.entity.position;
        const now = Date.now();
        const moved = !this._lastSent
            || Math.abs(p.x - this._lastSent.x) > 1e-4
            || Math.abs(p.y - this._lastSent.y) > 1e-4
            || Math.abs(p.z - this._lastSent.z) > 1e-4;
        // Keepalive cadence for a stationary client. Vanilla sends a position every 20 ticks
        // when nothing changes; without it a server may treat us as not responding.
        if (!moved && now - this._lastSentAt < 1000) return;

        this.connection.write('position_look', {
            x: p.x, y: p.y, z: p.z,
            yaw: (this.entity.yaw * 180) / Math.PI,
            pitch: (this.entity.pitch * 180) / Math.PI,
            onGround: !!this.entity.onGround,
        });
        this._lastSent = p.clone();
        this._lastSentAt = now;
    }
}
