import { Vec3 } from 'vec3';
import { digWithTool, isWaterName, isSwimmable, isLavaName } from './tools.js';

/**
 * Swimming, diving and surfacing.
 *
 * Water is the one part of this server's physics that is NOT broken. Everything else in this
 * codebase works around `bot.entity.onGround` reading false while the bot is provably standing;
 * water is immune to that, and it is worth writing down why, because the whole design follows:
 *
 *   - `isInWater` is recomputed every tick in prismarine-physics `simulatePlayer` from an AABB
 *     block scan around the position. It never reads `onGround`.
 *   - Swim-up works: the jump handler checks `if (isInWater || isInLava) vel.y += 0.04` BEFORE
 *     it checks `onGround`, so the branch that is dead on land is live in water.
 *   - Terminal horizontal speed is liquidAcceleration/(1-waterInertia) = 0.02/0.2 = 0.1 b/t,
 *     i.e. 2 blocks/s. For comparison this bot's measured overland travel is ~25 blocks/MINUTE.
 *
 * Two consequences shape the code below:
 *
 * 1. **Pitch is not a movement input.** prismarine-physics `applyHeading` uses `entity.yaw`
 *    only; pitch is copied into the player state and never read. Steering is therefore yaw for
 *    horizontal and a JUMP DUTY CYCLE for vertical. We still set pitch, because it aims the
 *    head for `bot.dig` and looks right to observers, but never as a control input.
 *
 * 2. **Rise is 7x faster than sink.** Holding jump gives (0.04-0.005)/0.2 = 0.175 b/t up;
 *    releasing everything gives only 0.005/0.2 = 0.025 b/t down. Vertical control is a
 *    hysteresis band around the target, not a proportional controller - see `verticalIntent`.
 *
 * The jump key has exactly ONE owner while the bot is wet: SwimAssist. Nothing in this file
 * presses it directly. Jump contention between AutoJump, hopForward and an old self_preservation
 * branch that pressed jump and never released it is precisely the bug this replaces.
 */

const DEFAULTS = {
    tickMs: 100,
    arrive: 1.5,          // 3D distance that counts as arrived
    band: 0.35,           // vertical hysteresis half-width
    stallMs: 2500,        // no improvement for this long -> give up
    stallImprove: 0.25,   // blocks of progress that count as improvement
    timeoutMs: 30000,
    surfaceTimeoutMs: 12000,
    maxRise: 24,          // how far up to look for air
    sprint: true,
};

// ---------------------------------------------------------------------------------------------
// Detection. The physics flag is the truth; block names are the fallback.
// `bot.entity.isInWater` is written only by prismarine-physics, so it is undefined until the
// first physics tick after spawn and whenever `bot.physicsEnabled` is false.
// ---------------------------------------------------------------------------------------------

function nameAt(bot, pos) {
    const b = bot.blockAt(pos);
    return b ? b.name : null;
}

/** Is any part of the bot's body in water? */
export function inWater(bot) {
    if (!bot || !bot.entity) return false;
    if (bot.entity.isInWater === true) return true;
    const p = bot.entity.position.floored();
    for (const dy of [0, 1]) {
        if (isSwimmable(nameAt(bot, p.offset(0, dy, 0)))) return true;
    }
    return false;
}

/**
 * Is the head underwater? This - not `inWater` - is what drains oxygen, and it is the condition
 * for sprint-swimming. A bot bobbing at the surface is in water but breathing.
 */
export function isSubmerged(bot) {
    if (!bot || !bot.entity) return false;
    const head = bot.entity.position.floored().offset(0, 1, 0);
    return isSwimmable(nameAt(bot, head));
}

export function inLava(bot) {
    if (!bot || !bot.entity) return false;
    if (bot.entity.isInLava === true) return true;
    const p = bot.entity.position.floored();
    for (const dy of [0, 1]) {
        if (isLavaName(nameAt(bot, p.offset(0, dy, 0)))) return true;
    }
    return false;
}

/**
 * Air supply, 0-20.
 *
 * Undefined until the first submersion, so default to a full tank. Clamped at the bottom
 * because `air_supply` keeps counting DOWN past zero while the entity drowns - observed
 * reporting "Air: -1 / 20" in chat. Nothing here should have to reason about negative air.
 */
export function oxygen(bot) {
    const o = bot?.oxygenLevel;
    if (typeof o !== 'number') return 20;
    return Math.max(0, Math.min(20, o));
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * What is above this column, and can the bot breathe there?
 *
 * An unloaded chunk (`blockAt` returns null) counts as BLOCKED, never as air. Treating unknown
 * as air is how a bot swims confidently into a ceiling it cannot see.
 *
 * @returns {{y:number|null, blocked:boolean, blocker:string|null}}
 */
export function airPocketAbove(bot, x, z, fromY, maxRise = DEFAULTS.maxRise) {
    for (let i = 1; i <= maxRise; i++) {
        const y = Math.floor(fromY) + i;
        const n = nameAt(bot, new Vec3(Math.floor(x), y, Math.floor(z)));
        if (n === null) return { y: null, blocked: true, blocker: 'unloaded' };
        if (isSwimmable(n)) continue;                       // still water, keep rising
        if (n === 'air' || n === 'cave_air' || n === 'void_air') return { y, blocked: false, blocker: null };
        return { y: null, blocked: true, blocker: n };      // a ceiling
    }
    return { y: null, blocked: true, blocker: 'too_deep' };
}

/** Y of the first breathable cell straight up, or null if the column is capped. */
export function waterSurfaceY(bot, x, z, fromY, maxRise = DEFAULTS.maxRise) {
    return airPocketAbove(bot, x, z, fromY, maxRise).y;
}

/**
 * Nearest neighbouring column that reaches open air. Used when our own column is capped - under
 * ice, or inside a flooded cave. Spiral outward so the first hit is the closest.
 * @returns {{pos:Vec3, y:number}|null}
 */
export function nearestOpenColumn(bot, radius = 6, maxRise = DEFAULTS.maxRise) {
    const p = bot.entity.position.floored();
    let best = null, bestD = Infinity;
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (dx === 0 && dz === 0) continue;
            const d = Math.hypot(dx, dz);
            if (d > radius || d >= bestD) continue;
            const x = p.x + dx, z = p.z + dz;
            // The cell at our own height must be swimmable, or we cannot get there horizontally.
            if (!isSwimmable(nameAt(bot, new Vec3(x, p.y, z)))) continue;
            const air = airPocketAbove(bot, x, z, p.y, maxRise);
            if (air.blocked) continue;
            bestD = d;
            best = { pos: new Vec3(x + 0.5, p.y, z + 0.5), y: air.y };
        }
    }
    return best;
}

/** How many swimmable cells are under the bot before something solid. */
export function waterDepthBelow(bot, maxDepth = 24) {
    const p = bot.entity.position.floored();
    let d = 0;
    for (let i = 0; i < maxDepth; i++) {
        const b = bot.blockAt(new Vec3(p.x, p.y - i, p.z));
        if (!b || !isSwimmable(b.name)) break;
        d++;
    }
    return d;
}

/**
 * Find the deepest water column within reach.
 *
 * Rivers here are often one block deep, which is enough to swim across but not enough to dive
 * in - and a bot that cannot submerge cannot be tested for oxygen, sinking or sprint-swimming.
 * @returns {{pos:Vec3, depth:number, distance:number}|null}
 */
export function deepestWaterNear(bot, radius = 48, want = 4) {
    let ids = [];
    try {
        const reg = bot.registry?.blocksByName;
        ids = ['water', 'flowing_water'].map(n => reg?.[n]?.id).filter(id => id !== undefined);
    } catch { /* fall through - no registry, no search */ }
    if (!ids.length) return null;

    const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 2048 });
    const columns = new Map();
    for (const v of found) {
        const k = `${v.x},${v.z}`;
        const prev = columns.get(k);
        if (!prev || v.y > prev.y) columns.set(k, v);   // keep the surface block of each column
    }

    let best = null;
    for (const top of columns.values()) {
        let depth = 0;
        for (let i = 0; i < 24; i++) {
            const b = bot.blockAt(new Vec3(top.x, top.y - i, top.z));
            if (!b || !isSwimmable(b.name)) break;
            depth++;
        }
        const distance = bot.entity.position.distanceTo(top);
        // Prefer deep, then near. Stop early once a column is deep enough to dive in.
        if (!best || depth > best.depth || (depth === best.depth && distance < best.distance)) {
            best = { pos: new Vec3(top.x + 0.5, top.y, top.z + 0.5), depth, distance };
            if (depth >= want && distance < 8) break;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------------------------
// Vertical control (pure - unit tested)
// ---------------------------------------------------------------------------------------------

/**
 * Which way to swim vertically, with hysteresis.
 *
 * Rising is 7x faster than sinking, so a naive "above target? stop jumping" controller
 * overshoots on every cycle and the bot porpoises. The dead band around the target is what makes
 * the duty cycle settle; `prev` keeps the current intent inside the band instead of chattering.
 *
 * @returns {'up'|'down'|'hold'}
 */
export function verticalIntent(y, targetY, band = DEFAULTS.band, prev = 'hold') {
    if (y < targetY - band) return 'up';
    if (y > targetY + band) return 'down';
    // Inside the band: keep doing what we were doing until we cross the centre line.
    if (prev === 'up' && y < targetY) return 'up';
    if (prev === 'down' && y > targetY) return 'down';
    return 'hold';
}

// ---------------------------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------------------------

function assist(bot) {
    return bot.swimAssist || null;
}

function setMode(bot, mode, targetY = null) {
    const a = assist(bot);
    if (a) a.setMode(mode, targetY);
}

function releaseControls(bot) {
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    setMode(bot, 'auto');
}

/** Aim the body along the horizontal, and the head along the full 3D line (cosmetic only). */
async function aimAt(bot, target, force = false) {
    const p = bot.entity.position;
    const dx = target.x - p.x, dz = target.z - p.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < 0.01 && !force) return;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(-(target.y - (p.y + 1.62)), Math.max(horiz, 0.01));
    if (force || Math.abs(((yaw - bot.entity.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.05) {
        await bot.look(yaw, pitch, true);
    }
}

/** Straight line from the bot to a target passes through lava? Cheap sample, not a raycast. */
function lavaOnLine(bot, target) {
    const p = bot.entity.position;
    const d = target.minus(p);
    const steps = Math.ceil(d.norm());
    for (let i = 1; i <= steps; i++) {
        const q = p.plus(d.scaled(i / steps)).floored();
        for (const dy of [0, 1]) {
            if (isLavaName(nameAt(bot, q.offset(0, dy, 0)))) return true;
        }
    }
    return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Swim to a 3D point.
 *
 * @returns {Promise<{arrived:boolean, covered:number, remaining:number, ms:number,
 *                    reason:string, oxygenStart:number, oxygenEnd:number}>}
 */
export async function swimTo(bot, target, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const t0 = Date.now();
    const start = bot.entity.position.clone();
    const oxygenStart = oxygen(bot);
    const dist = (a, b) => a.distanceTo(b);

    const done = (reason) => {
        releaseControls(bot);
        const p = bot.entity.position;
        return {
            arrived: reason === 'arrived',
            covered: dist(start, p),
            remaining: dist(p, target),
            ms: Date.now() - t0,
            reason,
            oxygenStart,
            oxygenEnd: oxygen(bot),
        };
    };

    if (inLava(bot)) return done('lava');
    if (lavaOnLine(bot, target)) return done('lava_on_route');

    let best = dist(bot.entity.position, target);
    let lastProgress = Date.now();
    let intent = 'hold';

    await aimAt(bot, target, true);
    bot.setControlState('forward', true);

    while (true) {
        if (bot.interrupt_code) return done('interrupted');
        if (Date.now() - t0 > o.timeoutMs) return done('timeout');
        if (inLava(bot)) return done('lava');

        const p = bot.entity.position;
        const d = dist(p, target);
        if (d <= o.arrive) return done('arrived');

        // outOfLiquidImpulse popped us onto a bank. Usually success - we asked to cross.
        if (!inWater(bot) && bot.entity.isCollidedHorizontally) return done('beached');

        if (d < best - o.stallImprove) { best = d; lastProgress = Date.now(); }
        else if (Date.now() - lastProgress > o.stallMs) return done('stall');

        intent = verticalIntent(p.y, target.y, o.band, intent);
        setMode(bot, intent === 'up' ? 'climb' : intent === 'down' ? 'sink' : 'hold', target.y);

        // Sprint-swimming only applies while fully submerged, same as vanilla.
        bot.setControlState('sprint', !!o.sprint && isSubmerged(bot));

        await aimAt(bot, target);
        await sleep(o.tickMs);
    }
}

/**
 * Descend to an absolute Y.
 * @returns {Promise<{reached:boolean, y:number, descended:number, ms:number, reason:string,
 *                    oxygenStart:number, oxygenEnd:number}>}
 */
export async function dive(bot, targetY, opts = {}) {
    const o = { ...DEFAULTS, timeoutMs: 45000, ...opts };
    const t0 = Date.now();
    const startY = bot.entity.position.y;
    const oxygenStart = oxygen(bot);

    const done = (reason) => {
        setMode(bot, 'auto');
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        const y = bot.entity.position.y;
        return {
            reached: reason === 'reached',
            y,
            descended: startY - y,
            ms: Date.now() - t0,
            reason,
            oxygenStart,
            oxygenEnd: oxygen(bot),
        };
    };

    if (!inWater(bot)) return done('not_in_water');
    if (inLava(bot)) return done('lava');

    let best = startY;
    let lastProgress = Date.now();

    // Look straight down. Cosmetic for movement, but it is what the bot digs along if asked.
    await bot.look(bot.entity.yaw, Math.PI / 2, true);
    setMode(bot, 'sink');

    while (true) {
        if (bot.interrupt_code) return done('interrupted');
        if (Date.now() - t0 > o.timeoutMs) return done('timeout');
        if (inLava(bot)) return done('lava');

        const p = bot.entity.position;
        if (p.y <= targetY + 0.5) return done('reached');
        if (!inWater(bot)) return done('left_water');

        // Hit the bottom, or a ledge.
        if (p.y < best - 0.25) { best = p.y; lastProgress = Date.now(); }
        else if (Date.now() - lastProgress > o.stallMs) return done('bottom');

        await sleep(o.tickMs);
    }
}

/**
 * Get the head into air.
 *
 * Five ordered phases, each checked against the same deadline. The failure that must not happen
 * is a silent hang - a bot under an ice sheet with no route up must come back with a reason, not
 * keep swimming into the ceiling until something else kills it.
 *
 * @returns {Promise<{surfaced:boolean, y:number, rose:number, ms:number, reason:string,
 *                    blocker:string|null, oxygenStart:number, oxygenEnd:number}>}
 */
export async function surface(bot, opts = {}) {
    const o = { ...DEFAULTS, timeoutMs: DEFAULTS.surfaceTimeoutMs, ...opts };
    const t0 = Date.now();
    const startY = bot.entity.position.y;
    const oxygenStart = oxygen(bot);
    let blocker = null;

    const done = (reason) => {
        releaseControls(bot);
        const y = bot.entity.position.y;
        return {
            surfaced: !isSubmerged(bot),
            y,
            rose: y - startY,
            ms: Date.now() - t0,
            reason,
            blocker,
            oxygenStart,
            oxygenEnd: oxygen(bot),
        };
    };
    const outOfTime = () => Date.now() - t0 > o.timeoutMs;

    if (!isSubmerged(bot)) return done('already_surfaced');
    if (inLava(bot)) return done('lava');

    // Phase 1: rise in our own column, if it is open.
    const p0 = bot.entity.position.floored();
    let air = airPocketAbove(bot, p0.x, p0.z, p0.y, o.maxRise);
    blocker = air.blocker;
    if (!air.blocked) {
        if (await riseUntilBreathing(bot, o, t0)) return done('rose');
        if (outOfTime()) return done('timeout');
    }

    // Phase 2: our column is capped - find a neighbouring one that is not, and swim there.
    // Radius 8, not 6: under a continuous ice sheet the nearest lead can easily be further
    // than six blocks, and this scan is the only phase that does not require breaking anything.
    const open = nearestOpenColumn(bot, o.surfaceSearchRadius ?? 8, o.maxRise);
    if (open && !outOfTime()) {
        const r = await swimTo(bot, open.pos, {
            arrive: 1.2,
            timeoutMs: Math.max(1500, o.timeoutMs - (Date.now() - t0)),
            sprint: false,
        });
        if (r.arrived || r.reason === 'beached') {
            if (await riseUntilBreathing(bot, o, t0)) return done('moved_and_rose');
        }
        if (outOfTime()) return done('timeout');
    }

    // Phase 3: cut through a soft ceiling. Breaking ice yields WATER, not air, so re-scan after
    // every block instead of assuming one dig finished the job.
    for (let i = 0; i < 4 && !outOfTime(); i++) {
        const p = bot.entity.position.floored();
        air = airPocketAbove(bot, p.x, p.z, p.y, o.maxRise);
        blocker = air.blocker;
        if (!air.blocked) {
            if (await riseUntilBreathing(bot, o, t0)) return done('dug_through');
            // The column reads OPEN yet we cannot climb it, so the bot is wedged: its 0.6-wide
            // hitbox is caught on the lip of a neighbouring block that the straight-up scan
            // never looks at. Giving up here is what left a bot pinned at y=53.55 with 0/20 air
            // for minutes, reporting "no_air_pocket" with no blocker to name.
            // Shove off the obstruction and try again rather than treating open-but-unclimbable
            // as unreachable.
            if (!await unwedge(bot, o)) break;
            continue;
        }
        const ceiling = firstCeilingBlock(bot, p, o.maxRise);
        if (!ceiling || !isDiggableCeiling(bot, ceiling)) break;
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        if (!await digWithTool(bot, ceiling)) break;
        await sleep(200);
    }

    return done(outOfTime() ? 'timeout' : 'no_air_pocket');
}

/**
 * Free a bot whose column reads clear but which cannot actually climb it.
 *
 * Swims toward the centre of a neighbouring open-column cell for a moment, which is enough to
 * slide the hitbox off whatever lip it is caught on. Deliberately short: this runs inside
 * `surface()`'s deadline while the bot is already out of air.
 *
 * @returns {Promise<boolean>} false if there is nowhere to go, so the caller can stop trying
 */
async function unwedge(bot, o) {
    const p = bot.entity.position;
    const here = p.floored();

    // Prefer a neighbouring cell that is both swimmable and open to the sky.
    const candidates = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = here.x + dx, z = here.z + dz;
        if (!isSwimmable(nameAt(bot, new Vec3(x, here.y, z)))) continue;
        const open = !airPocketAbove(bot, x, z, here.y, o.maxRise).blocked;
        candidates.push({ pos: new Vec3(x + 0.5, p.y, z + 0.5), open });
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => Number(b.open) - Number(a.open));
    const target = candidates[0].pos;

    setMode(bot, 'climb'); // keep pushing up while we slide sideways
    try {
        await aimAt(bot, target, true);
        bot.setControlState('forward', true);
        await sleep(700);
    } finally {
        bot.setControlState('forward', false);
        setMode(bot, 'auto');
    }
    return true;
}

/**
 * Hold 'climb' until the head is out of water, the deadline passes, or the bot stops rising.
 *
 * The stall check is the important part, and it is the same lesson this codebase already
 * learned for walking: TRUST MEASURED PROGRESS OVER THE BLOCK SCAN. `airPocketAbove` looks
 * straight up from the floored position, so a bot wedged under an overhang - its hitbox
 * straddling two columns, only one of which is clear - reads as "column open" while being
 * physically unable to ascend. Observed live in a frozen ocean: jump held, air 0/20, y pinned
 * at 53.59 for minutes, taking drowning damage, because this loop had no way to notice it was
 * pressed against a ceiling and kept waiting for a rise that could never happen.
 *
 * Returning false hands over to the phases that CAN help - move to another column, or dig.
 */
async function riseUntilBreathing(bot, o, t0) {
    setMode(bot, 'climb');
    const stuckMs = o.riseStuckMs ?? 1500;
    let bestY = bot.entity.position.y;
    let lastGain = Date.now();
    try {
        while (Date.now() - t0 <= o.timeoutMs) {
            if (bot.interrupt_code) return false;
            if (!isSubmerged(bot)) return true;

            const y = bot.entity.position.y;
            if (y > bestY + 0.1) { bestY = y; lastGain = Date.now(); }
            else if (Date.now() - lastGain > stuckMs) return false; // pressed against something

            await sleep(o.tickMs);
        }
        return false;
    } finally {
        // Always hand the jump key back, including on the interrupt path - leaving the assist
        // in 'climb' meant it kept shoving the bot into the ceiling after we gave up.
        setMode(bot, 'auto');
    }
}

/**
 * The thing between us and air.
 *
 * Checks straight up first, then the neighbouring columns at head height. The bot's hitbox is
 * 0.6 wide and rarely centred in its cell, so when it is wedged under an overhang the block
 * actually stopping it is often above the NEIGHBOURING column - a straight-up scan finds
 * nothing, reports "no ceiling", and the dig phase gives up on a bot that is plainly stuck.
 */
function firstCeilingBlock(bot, from, maxRise) {
    const straight = scanColumnForCeiling(bot, from.x, from.z, from.y, maxRise);
    if (straight) return straight;

    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = bot.blockAt(new Vec3(from.x + dx, from.y + 2, from.z + dz));
        if (!b || isSwimmable(b.name)) continue;
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
        if (b.boundingBox === 'block') return b;
    }
    return null;
}

function scanColumnForCeiling(bot, x, z, fromY, maxRise) {
    for (let i = 1; i <= maxRise; i++) {
        const b = bot.blockAt(new Vec3(x, fromY + i, z));
        if (!b) return null;
        if (isSwimmable(b.name)) continue;
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return null;
        return b;
    }
    return null;
}

/** Only cut through a ceiling that is safe and close enough to reach. */
function isDiggableCeiling(bot, block) {
    if (!block) return false;
    if (block.name === 'bedrock' || isLavaName(block.name)) return false;
    if (block.position.distanceTo(bot.entity.position) > 4.5) return false;
    // Never open a hole with lava behind it.
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        if (isLavaName(nameAt(bot, block.position.offset(d[0], d[1], d[2])))) return false;
    }
    return true;
}

/**
 * Low-level: swim in a compass direction for a fixed time. Mirrors `hopForward`, but holds a
 * steady heading instead of pulsing jump - in water, jump is buoyancy, not propulsion.
 * @returns {Promise<number>} blocks covered along (dx,dz).
 */
export async function swimForward(bot, dx, dz, ms, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const start = bot.entity.position.clone();
    const t0 = Date.now();

    const target = start.offset(ux * 64, 0, uz * 64);
    await aimAt(bot, target, true);
    bot.setControlState('forward', true);
    setMode(bot, 'hold', start.y);

    while (Date.now() - t0 < ms) {
        if (bot.interrupt_code || inLava(bot)) break;
        bot.setControlState('sprint', !!o.sprint && isSubmerged(bot));
        await sleep(o.tickMs);
    }

    releaseControls(bot);
    const p = bot.entity.position;
    return (p.x - start.x) * ux + (p.z - start.z) * uz; // axial progress, not total distance
}
