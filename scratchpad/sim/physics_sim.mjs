/**
 * A headless physics sandbox running THE SAME `prismarine-physics` the bot runs.
 *
 * WHY NOT three.js + a physics engine
 * -----------------------------------
 * three.js is a renderer, and bolting cannon/rapier underneath it would simulate *different*
 * physics from the one the bot actually experiences - so every constant calibrated there would be
 * wrong on arrival. The bot's physics is `prismarine-physics`; it is already installed and it runs
 * happily with no mineflayer, no server and no network. `node_modules/prismarine-physics/examples/
 * basic.js` is the worked example this file is built from.
 *
 * The point is the loop time. Calibrating a jump against the live server costs 45s per lane and
 * ~6 minutes per sweep; here a whole sweep is milliseconds, so the constants can be MEASURED
 * instead of guessed.
 *
 * WHAT IT CANNOT TELL US
 * ----------------------
 * Whether the SERVER accepts the movement. This is client-side physics only - anti-cheat, lag and
 * rubber-banding do not exist here. The sim calibrates; the live gym validates.
 */
import mcDataLoader from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import { Physics, PlayerState } from 'prismarine-physics';
import { Vec3 } from 'vec3';

export const VERSION = '1.21.11';
const mcData = mcDataLoader(VERSION);
const Block = prismarineBlock(VERSION);

const AIR = mcData.blocksByName.air.id;
const NAMED = (name) => mcData.blocksByName[name]?.id ?? AIR;

/**
 * A sparse voxel world. Anything not explicitly set is air, so a lane is described by the handful
 * of blocks that actually matter rather than by an array the size of the test rig.
 */
export class SimWorld {
    constructor() { this.blocks = new Map(); }

    static key(x, y, z) { return `${x},${y},${z}`; }

    set(x, y, z, name) {
        if (name === 'air') this.blocks.delete(SimWorld.key(x, y, z));
        else this.blocks.set(SimWorld.key(x, y, z), NAMED(name));
        return this;
    }

    /** Fill inclusive, the way the server's own `/fill` does, so lanes read like the live gym. */
    fill(x0, y0, z0, x1, y1, z1, name) {
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
            for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
                for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) this.set(x, y, z, name);
        return this;
    }

    getBlock(pos) {
        const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
        const type = this.blocks.get(SimWorld.key(x, y, z)) ?? AIR;
        const b = new Block(type, 0, 0);
        b.position = new Vec3(x, y, z);
        return b;
    }
}

/** The bot-shaped object `PlayerState` reads and `apply()` writes back to. */
function fakePlayer(pos) {
    return {
        entity: {
            position: pos.clone(),
            velocity: new Vec3(0, 0, 0),
            onGround: false,
            isInWater: false, isInLava: false, isInWeb: false,
            elytraFlying: false,
            isCollidedHorizontally: false, isCollidedVertically: false,
            yaw: 0, pitch: 0,
            effects: [],
        },
        inventory: { slots: [] },
        jumpTicks: 0,
        jumpQueued: false,
        fireworkRocketDuration: 0,
        version: VERSION,
    };
}

export const CONTROLS = () => ({
    forward: false, back: false, left: false, right: false,
    jump: false, sprint: false, sneak: false,
});

/**
 * One simulated bot in one world.
 *
 * `brokenOnGround` is the whole reason this exists. On our server `bot.entity.onGround` reads
 * false for seconds while the bot is provably standing, which means prismarine-physics gives it
 * only the AIRBORNE branch (`airborneAcceleration 0.02`, index.js:568-579) and never fires the
 * jump impulse at all (index.js:725, gated on `entity.onGround`). Forcing the flag false after
 * every `apply()` reproduces that exactly, so the sim measures what THIS bot experiences rather
 * than what vanilla does.
 */
export class SimBot {
    constructor(world, pos, opts = {}) {
        this.world = world;
        this.physics = Physics(mcData, world);
        this.bot = fakePlayer(pos);
        this.state = new PlayerState(this.bot, CONTROLS());
        this.brokenOnGround = opts.brokenOnGround ?? true;
        this.ticks = 0;
        this.trace = [];
    }

    get pos() { return this.bot.entity.position; }
    get vel() { return this.bot.entity.velocity; }
    set yaw(v) { this.bot.entity.yaw = v; this.state.yaw = v; }

    /** Is there a full block directly under the feet cell? The world's answer, never `onGround`. */
    grounded() {
        const p = this.pos.floored();
        const b = this.world.getBlock(p.offset(0, -1, 0));
        return b.boundingBox === 'block' && Math.abs(this.pos.y - Math.round(this.pos.y)) < 0.02;
    }

    /**
     * Advance one tick.
     *
     * `assertGround` is mechanism A: tell the state the truth the flag got wrong, for this tick
     * only. It has to be written onto the STATE (not the bot) because `simulatePlayer` reads the
     * state, and it has to be re-applied every tick we want it because `apply()` clobbers it.
     */
    step(controls, { assertGround = false } = {}) {
        Object.assign(this.state.control, controls);
        this.state.yaw = this.bot.entity.yaw;
        if (assertGround) this.state.onGround = true;

        this.physics.simulatePlayer(this.state, this.world).apply(this.bot);
        if (this.brokenOnGround) this.bot.entity.onGround = false;
        // The state is reused across ticks, so mirror the pathology there too or the next tick
        // reads a truth the real bot would never see.
        this.state.pos = this.bot.entity.position;
        this.state.vel = this.bot.entity.velocity;
        if (this.brokenOnGround) this.state.onGround = false;

        this.ticks++;
        this.trace.push({ t: this.ticks, x: this.pos.x, y: this.pos.y, z: this.pos.z,
                          vy: this.vel.y, vx: this.vel.x, vz: this.vel.z });
        return this;
    }
}

/** Blocks per tick along a unit heading. The honest measure of "how fast is it actually going". */
export const axial = (vel, dx, dz) => vel.x * dx + vel.z * dz;
