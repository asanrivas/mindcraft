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

    // Yield a real macrotask before anything can return. Every exit below this point is
    // reachable with only microtask awaits - the lava refusals await nothing at all, and the
    // `arrived` exit awaits only `bot.look(..., force)`, which resolves without a timer or any
    // I/O. A caller that loops on swimTo would then spin without ever letting the event loop
    // service the socket, and the server drops the client with "Timed out". followPlayer did
    // exactly that; this makes the primitive safe for any caller, not just the fixed one.
    await sleep(o.tickMs);

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
            // Bounded to a SHARE of the deadline, not all of it. `nearestOpenColumn` finds a
            // column by block scan, and a bot wedged under an overhang cannot necessarily reach
            // the one it finds - so this leg would swim into a wall for the entire budget and
            // phase 3, the one that actually cuts through the ceiling, never ran at all.
            // Observed: `surface()` returning `timeout` with `rose -0.2` while a single
            // diggable stone block sat directly overhead.
            timeoutMs: Math.max(1500, Math.min(4000, o.timeoutMs - (Date.now() - t0))),
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
/**
 * Climb out of the water onto the bank ahead.
 *
 * The gap this closes: SwimAssist's default `auto` mode holds the bot at the WATER SURFACE -
 * head just clear, feet still wet - and a bank's top face is a block ABOVE that surface.
 * Swimming forward from there presses the bot's chest into the bank and it never rises over
 * the lip. AutoJump, which clears exactly this step on land, deliberately early-returns in
 * water, because the jump key there is buoyancy and not a hop. So nothing in the stack owned
 * "get out of the water onto the shore in front of me".
 *
 * Observed live on a marathon leg: four consecutive travel legs at (4264, 62, 4931) covering
 * 0.0, 0.5, 2.0 and 0.0 blocks against a ONE-block bank, mining three blocks of it in the
 * process. The bot could see the land and could not stand on it.
 *
 * Vanilla players do this by holding forward AND jump at the same time; `climb` mode is the
 * jump half of that, and it is the one mode that keeps rising past the surface instead of
 * levelling off at it.
 *
 * @param {number} dx integer heading, -1..1
 * @param {number} dz integer heading, -1..1
 * @returns {Promise<{out:boolean, gained:number, target:Vec3|null}>}
 */
/**
 * The nearest dry standing spot `reach` blocks ahead that the bot could climb onto.
 *
 * Nearest first, then lowest, so the bot takes the shallowest step onto shore rather than
 * trying to scale the tallest thing it can see. Split out from `climbBank` because this is
 * the half worth testing: it is pure block reads, and getting it wrong sends the bot swimming
 * at a cliff face.
 *
 * @returns {Vec3|null} the FOOT cell to stand in (not the block below it)
 */
export function bankTargetAhead(bot, dx, dz, opts = {}) {
    // maxRise 1, not 3. A floating bot rises only while its feet are still in water, so the
    // highest foot cell it can ever enter is one whose floor is at the water surface - a
    // ONE-block bank. A two-block bank needs a jump, and `onGround` is unusable on this server,
    // so there is no jump to be had. Searching higher just buys six seconds of swimming into a
    // wall per attempt; the traveller's dig/detour ladder is the right answer for those.
    const o = { reach: 3, maxRise: 1, cone: true, ...opts };
    const solid = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'block'; };
    const clear = (v) => {
        const b = bot.blockAt(v);
        // An unloaded chunk is NOT clear. Treating unknown as air is how a bot swims
        // confidently into a ceiling it cannot see.
        return !!b && (b.name === 'air' || b.name === 'cave_air');
    };
    const p = bot.entity.position.floored();

    // RISE FIRST, then distance, then straightness. A bot floating at the water surface can
    // only climb what it can swim up to, and the water surface is the ceiling of that: a bank
    // two blocks above it needs a jump, and `onGround` is unusable on this server so there is
    // no jump to be had. Observed live at (4279, 62, 4934): the bank due east was a two-block
    // step and unclimbable, while the SAME shore one block to the south was a one-block step.
    // Searching only the exact heading declared that shoreline impassable and the bot ground
    // against it for four legs.
    for (let dy = 0; dy <= o.maxRise; dy++) {
        for (let n = 1; n <= o.reach; n++) {
            for (const [ax, az] of (o.cone ? forwardCone(dx, dz) : [[Math.sign(dx), Math.sign(dz)]])) {
                const foot = new Vec3(p.x + ax * n, p.y + dy, p.z + az * n);
                if (!solid(foot.offset(0, -1, 0))) continue;                  // nothing to stand ON
                if (!clear(foot) || !clear(foot.offset(0, 1, 0))) continue;   // no room for the body
                // ...and we have to be able to GET there. A standable cell behind a wall is not
                // a bank. Observed: from (4280, 62, 4935) this picked (4283, 63, 4935) - a real
                // ledge, three blocks east, with two solid blocks in between - then swam into
                // the wall for eight seconds and reported "still wet, gained 0.00".
                if (!corridorClear(bot, p, ax, az, n, dy)) continue;
                return foot;
            }
        }
    }
    return null;
}

/**
 * Can the bot actually swim from `from` to the cell `n` steps along (ax, az) at rise `dy`?
 *
 * Checks the whole corridor between here and there, over the full height the body will occupy
 * on the way - from the feet we start at to the head we finish with. Water counts as passable;
 * only solid blocks block. Cheap and deliberately conservative: a false negative costs one
 * candidate, a false positive costs eight seconds of swimming into a wall.
 */
function corridorClear(bot, from, ax, az, n, dy) {
    const yLo = Math.min(from.y, from.y + dy);
    const yHi = Math.max(from.y, from.y + dy) + 1;   // +1 for the head
    for (let k = 1; k < n; k++) {
        for (let y = yLo; y <= yHi; y++) {
            const b = bot.blockAt(new Vec3(from.x + ax * k, y, from.z + az * k));
            if (!b || b.boundingBox === 'block') return false;   // unloaded counts as blocked
        }
    }
    return true;
}

// Vanilla's jump impulse. Applied by hand because `onGround` is unreliable here, so the physics
// engine never fires the jump itself - see climbBank.
const JUMP_IMPULSE = 0.42;

// climbBank standoff geometry, in `gapTo` units (distance to the target block's CENTRE).
// The face is 0.5 from the centre and the bot's hitbox half-width is 0.3, so the AABB is flush
// at 0.80 - and flush is the state in which collision resolution cancels the entire move,
// vertical included, leaving vel=(0.000, 0.000, 0.000) with forward held.
const FACE_GAP = 0.80;
const STANDOFF = FACE_GAP + 0.30;   // 1.10 - the clearance measured at 0.8s out vs 22s stuck

// How far ABOVE the bank's top face the feet must be before walking in is worth trying.
//
// This used to be -0.05 - i.e. "close enough to the lip counts as over it" - and that tolerance
// is a trap on both sides. Captured on gym lane 7 (the one run in ten that took 20s):
//
//   t=2.0s pos=(4508.36, 111.05) wet=false   <- above the lip, so `forward` went on
//   t=3.0s pos=(4508.68, 110.97) wet=true    <- fell back in; STILL counted as "over"
//   t=4.1s pos=(4508.70, 110.97) vel=(0.000, -0.078, 0.000)  -> flush, jammed
//
// Two separate mistakes, both from the same number. At 111.05 the bot was 0.05 above the face
// and standing over WATER, and the walk-in is ~0.55 blocks at ~0.1 b/tick - six ticks, in which
// an unsupported body falls the best part of a block. It could never have made it. And once it
// had dropped to 110.97 the tolerance still read "over", so `forward` stayed on and drove it
// flush into the face, while the rise impulse - gated on `y < target.y - 0.05` - was switched
// off by the very same threshold. A 0.05-block dead band in which the bot may not climb and
// must not stop pressing.
//
// So the two decisions get their own thresholds. Walking in needs real clearance (the impulse
// lifts about a block, so this is affordable), and the impulse keeps firing right up to it.
const LIP_CLEAR = 0.25;

// Horizontal speed, in blocks/tick, supplied by hand for the step in over the lip.
//
// Same reason as JUMP_IMPULSE, one axis over: `onGround` reads false here permanently, so
// prismarine-physics grants the bot AIRBORNE acceleration (a fraction of the ground figure)
// for the one moment it most needs to run. Over the lip the bot is above the water and above
// nothing - the column beneath it is still the pool - so it has about a third of a second of
// fall in which to cover the last half block, and drifting at 0.02 b/tick does not do it.
// The traces are unambiguous: it reached y=111.46 with `forward` held and moved 0.04 blocks
// horizontally before falling back in, over and over, five times in one lane.
//
// 0.14 is a vanilla walk. This is not a speed boost - it is the run-up the broken ground flag
// denies us, applied only while over the lip and only until the bot is over the target cell.
const STEP_IN_SPEED = 0.14;

/** Is there a full block directly beneath the feet? Then the water is stand-deep, not swim-deep. */
function standingOnSolid(bot) {
    // The block BELOW THE FEET CELL, not 0.2 below the eye-position. A bot floating a third of
    // a block above the boundary (y=110.32) still floors into its own water cell, so the naive
    // offset reported "not standing" and sent a stand-deep bot into a pointless sink phase.
    const b = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    return !!b && b.boundingBox === 'block';
}

/** The eight integer headings, in rotational order, so neighbours are +-1 apart. */
const RING8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * The heading and its two 45-degree neighbours, straightest first.
 *
 * Leaving the water at 45 degrees off the bearing is still forward progress, and it is what a
 * person does at a shoreline rather than scaling the one spot directly in front of them.
 */
function forwardCone(dx, dz) {
    const i = RING8.findIndex(([x, z]) => x === Math.sign(dx) && z === Math.sign(dz));
    if (i < 0) return [[Math.sign(dx) || 1, Math.sign(dz)]];
    return [RING8[i], RING8[(i + 1) % 8], RING8[(i + 7) % 8]];
}

export async function climbBank(bot, dx, dz, opts = {}) {
    const o = { timeoutMs: 8000, reach: 3, ...opts };
    const start = bot.entity.position.clone();
    const fail = (target = null) => ({ out: !inWater(bot), gained: bot.entity.position.y - start.y, target });

    if (!inWater(bot) || inLava(bot)) return fail();

    const target = bankTargetAhead(bot, dx, dz, o);
    const say = (msg) => console.log(`[${bot.username ?? '?'}] climbBank: ${msg}`);
    if (!target) {
        // Console only, deliberately: this fires on every stalled leg in open water and would
        // otherwise flood bot.output, which is budgeted and goes to the model.
        say(`no reachable bank in the forward cone heading (${dx},${dz}) `
            + `from ${bot.entity.position.floored()}`);
        return fail();
    }
    say(`target ${target} from ${bot.entity.position.floored()} heading (${dx},${dz})`);

    // DUCK, THEN CLIMB. A bot floating at the surface cannot rise at all: prismarine-physics
    // grants the swim impulse only while it counts the player as in water, and at the surface
    // it does not - while `onGround` is unusable on this server, so the land jump branch is dead
    // too. Measured at (4281, 62, 4935): jump=true, mode=climb, wet=true, sub=false, and
    // vel=(0.000, 0.000, 0.000) for eight seconds straight. The bot was in the one state where
    // neither half of the stack can lift it.
    //
    // So put the head back under for a moment. `sink` submerges, `climb` then gets the full
    // +0.175 b/t, and that momentum carries the hitbox up over the lip while `forward` walks it
    // inland. This is the duty cycle the whole vertical-control design is built on: rising is
    // seven times faster than sinking, so a short dip costs almost nothing.
    // BACK OFF THE WALL FIRST. Pressed flush against the bank face the bot cannot rise at all:
    // measured at x=4508.70 (hitbox edge exactly on the block boundary at 4509.0) it held y
    // 110.000 for 22 seconds with zero movement, while the identical attempt from x=4508.40 -
    // a 0.3 block gap - was out in 0.8s. The collision resolution appears to cancel the whole
    // move, vertical included, while the AABB is touching. So make a gap, then climb.
    await aimAt(bot, target.offset(0.5, 0, 0.5), true);
    const gapTo = (p) => Math.hypot(target.x + 0.5 - p.x, target.z + 0.5 - p.z);
    if (gapTo(bot.entity.position) < 1.05) {
        bot.setControlState('forward', false);
        bot.setControlState('back', true);
        const backOff = Date.now() + 400;
        while (Date.now() < backOff && !bot.interrupt_code) await sleep(DEFAULTS.tickMs);
        bot.setControlState('back', false);
    }
    setMode(bot, 'climb');
    let submergeUntil = 0;
    // The dip is ONE-SHOT. `submergeUntil` alone is not, and that made the whole routine
    // stochastic: reaching submersion clears it, the very next tick sees the bot still below
    // the lip, `!submergeUntil` is true again, and it arms another 1.5 seconds of SINKING. In
    // deep lanes the bot therefore dipped, rose, dipped again - measured on gym lane 5 falling
    // to y=109.20 from a start of 110.35, a whole block the wrong way - and the same lane that
    // cleared in 0.4s on one run took 18s on the next. Nothing about it was depth-specific;
    // it was whether a dip happened to submerge.
    let dipDone = false;
    let lastBoost = 0;
    // RISE FIRST, THEN STEP IN - the standoff is MAINTAINED, not a one-shot at entry.
    //
    // The back-off above used to be the whole fix, and it is not enough: `forward` was then
    // held for the entire climb, so the bot immediately walked back into the face it had just
    // backed away from. That makes the climb a RACE between two continuous processes - rising
    // (the JUMP_IMPULSE duty cycle) and closing (`forward` at ~0.1 b/t) - and whichever crosses
    // first decides the outcome. Captured at (4434, 62, 4682), same target, same heading, 4s
    // apart, one jam and one success:
    //
    //   t=0.0s fwd=true pos=(4434.76, 62.29) vel=(0.064, 0.405, -0.003)
    //   t=1.0s fwd=true pos=(4434.31, 62.42) vel=(0.000, 0.000, 0.000)  <- flush, ALL axes dead
    //   jammed - no measured progress in 2.5s
    //   [retry] t=1.0s pos=(4434.30, 62.72) vel=(0.000,-0.078, 0.001) -> OUT, gained 1.56
    //
    // The target block's face is x=4434.0 and the bot is 0.6 wide, so flush is x=4434.30. Both
    // runs arrived flush; the only difference was the HEIGHT at contact - 62.42 versus 62.72.
    // Three tenths of a block decided it. That is a race, and a race explains the retry counts
    // ("after 1 attempt(s)" / "after 2 attempt(s)") that looked like nondeterministic physics.
    //
    // So sequence it. Hold a gap while below the lip - the collision resolution cancels the
    // whole move, VERTICAL INCLUDED, while the AABB is touching, so closing early destroys the
    // rise it still needs - and press forward only once the hitbox is actually over the top.
    bot.setControlState('forward', false);
    // Never sprint here: the boost is a horizontal acceleration and it drives the bot INTO the
    // bank face harder, which is the opposite of what is needed.
    bot.setControlState('sprint', false);

    const t0 = Date.now();
    let sampled = 0;
    // Count real physics ticks. Everything above cannot distinguish "the simulation is not
    // running for this bot" from "it is running and computing zero", and those need completely
    // different fixes. vel=(0.000, 0.000, 0.000) with `forward` held is not a water problem at
    // all - `applyHeading` accelerates regardless of water - so it is worth one listener.
    let ticks = 0;
    const countTick = () => { ticks++; };
    bot.on('physicsTick', countTick);
    let bestProgress = 0;      // furthest we have got, as rise + horizontal closing
    let lastGain = Date.now();
    const startFlat = Math.hypot(target.x + 0.5 - start.x, target.z + 0.5 - start.z);
    try {
        while (Date.now() - t0 < o.timeoutMs) {
            if (bot.interrupt_code || inLava(bot)) break;

            const now2 = bot.entity.position;

            // Trust MEASURED progress over the block scan - the same invariant that
            // `riseUntilBreathing` had to learn. A bot whose 0.6-wide hitbox is jammed in a
            // corner reads as "open bank one block ahead" and cannot move a millimetre toward
            // it: observed at (4282, 62, 4935), walled east and south at feet level, holding
            // jump and forward for the full eight seconds at vel=(0,0,0). Bail in 1.5s instead.
            // SUBMERGE FIRST, THEN RISE - copied from what a real player actually does.
            //
            // A 20Hz trace of a human climbing out (recordings/trace-asanrivas-*.tsv) shows every
            // successful climb starting from BELOW the surface and rising at ~0.16 blocks/tick
            // with x pinned against the bank face, e.g. y 108.67 -> 110.90 over 683ms at a
            // constant x=4508.70, `onGround=0` throughout. The rise is the buoyancy impulse, and
            // it only exists while the player counts as submerged.
            //
            // The previous version dipped for a fixed 250ms and then climbed, which is not long
            // enough to actually get the head under - so it never earned the impulse and measured
            // `gained 0.00`. Sink until genuinely submerged (bounded), then hold the climb.
            const nowMs = Date.now();
            if (isSubmerged(bot)) {
                setMode(bot, 'climb');
                submergeUntil = 0;
                dipDone = true;
            }
            // The impulse is not only for stand-deep water. At two blocks deep the bot can
            // neither submerge (buoyancy holds it above y=110, so its head never goes under)
            // nor jump (`onGround` is false), and a controlled run measured it topping out at
            // y=110.34 against a bank whose face is 111.0 - 0.66 short, pinned at x=4508.70.
            // Whenever we are in water, below the target, and not already rising, supply the
            // impulse the broken ground flag denies us.
            if (inWater(bot) && bot.entity.position.y < target.y + LIP_CLEAR) {
                // A real player just jumps: the captured trace shows +0.75 in a single tick from
                // `onGround=1`. Our `onGround` reads false permanently (see CLAUDE.md), so
                // prismarine-physics never grants that impulse and buoyancy alone tops out ~0.2
                // blocks short of the lip. Supply it directly - the same thing SwimAssist does
                // in the other direction with `sinkAssist`. This one impulse covers both the
                // submerged and the stand-deep cases; they used to have separate branches.
                const v = bot.entity.velocity;
                if (v && v.y < 0.08 && Date.now() - lastBoost > 350) {
                    lastBoost = Date.now();
                    v.y += JUMP_IMPULSE;
                }
            }
            if (bot.entity.position.y < target.y - 0.15) {
                // Not under yet and not high enough: keep sinking, but never forever - a bot in
                // water too shallow to submerge in must fall through to the caller's other moves.
                if (dipDone) setMode(bot, 'climb');
                else if (!submergeUntil) { submergeUntil = nowMs + 1500; setMode(bot, 'sink'); }
                else if (nowMs < submergeUntil) setMode(bot, 'sink');
                else { dipDone = true; setMode(bot, 'climb'); }
            } else {
                setMode(bot, 'climb');
            }

            const flat = Math.hypot(target.x + 0.5 - now2.x, target.z + 0.5 - now2.z);

            // Standoff regulation. `flat` is measured to the target's CENTRE, so the face is
            // 0.5 away and the 0.3 hitbox half-width puts flush at 0.80. The measured-good
            // clearance is 0.3 blocks (x=4508.40 was out in 0.8s; x=4508.70, flush, held y
            // 110.000 for 22 seconds), hence a standoff of 1.10 and a nudge back below 0.92.
            // Over the lip, or already standing on the bank. `standingOnSolid` is the half that
            // matters: being dry and level with the top face is NOT the same as being supported -
            // on lane 7 the bot was dry at y=111.05 with nothing but water beneath it, walked in,
            // and fell straight back. A solid block under the feet is the only proof.
            const highEnough = now2.y >= target.y + LIP_CLEAR
                || (standingOnSolid(bot) && now2.y >= target.y - 0.05);
            if (highEnough) {
                // Over the lip: now walking in is the whole remaining job.
                bot.setControlState('back', false);
                bot.setControlState('forward', true);
                // ...and walking is exactly what this bot cannot do airborne. Drive it.
                if (flat > 0.55) {
                    const v = bot.entity.velocity;
                    const ux = (target.x + 0.5 - now2.x) / flat;
                    const uz = (target.z + 0.5 - now2.z) / flat;
                    const along = v.x * ux + v.z * uz;
                    if (along < STEP_IN_SPEED) {
                        v.x += (STEP_IN_SPEED - along) * ux;
                        v.z += (STEP_IN_SPEED - along) * uz;
                    }
                }
            } else if (flat < FACE_GAP + 0.12) {
                // Too close to rise. Back off rather than merely stopping: at this range the
                // bot is already touching and staying still keeps it touching.
                bot.setControlState('forward', false);
                bot.setControlState('back', true);
            } else if (flat < STANDOFF) {
                // In the band - hold position and let the impulse do the work.
                bot.setControlState('forward', false);
                bot.setControlState('back', false);
            } else {
                bot.setControlState('back', false);
                bot.setControlState('forward', true);
            }

            // Progress must follow the SEQUENCE, or the standoff looks like failure: backing
            // off increases `flat`, so the old combined metric scored a deliberate, correct
            // back-off as negative progress and could trip the 2.5s jam bail on the very move
            // that unsticks the bot. Below the lip the job is height; above it, closing.
            // A genuinely jammed bot - flush and not rising - still scores zero and still bails.
            const progress = highEnough
                ? (now2.y - start.y) + (startFlat - flat)
                : (now2.y - start.y);
            if (progress > bestProgress + 0.05) { bestProgress = progress; lastGain = Date.now(); }
            else if (Date.now() - lastGain > 2500) {   // > one dip(250ms)+rise cycle, with slack
                say(`jammed - no measured progress in 2.5s, giving up`);
                break;
            }
            // Success is measured, not assumed: out of the water and standing at or above the
            // bank. `onGround` is not usable on this server - it reads false for seconds while
            // the bot is provably standing.
            // Height alone is not success. Measured at both depths: the bot reaches exactly
            // y=111.003 - the bank's top face - but sits at x=4508.85, perched on the LIP with
            // its hitbox half over the edge, and slides back into the pool the moment the climb
            // stops. It has to end up actually over the target cell.
            const over = Math.abs(now2.x - (target.x + 0.5)) < 0.6
                && Math.abs(now2.z - (target.z + 0.5)) < 0.6;
            if (!inWater(bot) && bot.entity.position.y >= target.y - 0.2 && over) break;
            // Once a second, record the three numbers that separate "the key is not pressed"
            // from "the key is pressed and the physics does nothing" - the whole diagnosis of a
            // failed climb, and indistinguishable from outside without them.
            const elapsed = Date.now() - t0;
            if (elapsed >= sampled * 1000) {
                sampled = Math.floor(elapsed / 1000) + 1;
                const p2 = bot.entity.position, v = bot.entity.velocity;
                say(`  t=${(elapsed / 1000).toFixed(1)}s jump=${bot.controlState?.jump} `
                    + `fwd=${bot.controlState?.forward} mode=${assist(bot)?.mode} `
                    + `vel=(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}) `
                    + `pos=(${p2.x.toFixed(2)}, ${p2.y.toFixed(2)}, ${p2.z.toFixed(2)}) `
                    + `wet=${inWater(bot)} sub=${isSubmerged(bot)} `
                    + `ticks=${ticks} physOn=${bot.physicsEnabled} onGround=${bot.entity.onGround} `
                    + `liqAcc=${bot.physics?.liquidAcceleration} yaw=${bot.entity.yaw.toFixed(2)} `
                    + `chunk=${bot.blockAt(bot.entity.position)?.name}`);
            }
            await sleep(DEFAULTS.tickMs);
        }
    } finally {
        bot.removeListener('physicsTick', countTick);
        bot.setControlState('back', false);
        releaseControls(bot);   // forward off, sprint off, SwimAssist back to 'auto'
    }
    const r = fail(target);
    say(`${r.out ? 'OUT' : 'still wet'} after ${Date.now() - t0}ms, gained ${r.gained.toFixed(2)}, `
        + `now ${bot.entity.position.floored()}`);
    return r;
}

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
