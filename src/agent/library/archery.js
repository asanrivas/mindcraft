/**
 * Projectile ballistics for bow and crossbow. Pure - no bot, no imports.
 *
 * mineflayer does not model bow charge or arrow flight at all; minecrafthawkeye is not
 * installed, and porting it would drag version-correct physics assumptions into a
 * protocol-mismatched stack. The maths we need is small: vanilla arrows leave at ~3.0
 * blocks/tick fully charged (crossbow ~3.15), fall at 0.05 b/t^2, and lose 1% velocity per
 * tick to drag. Those constants are DEFAULTS to be corrected by !bowProbe on the live
 * server - this codebase's rule is measure, then trust.
 */

export const ARROW = { speed: 3.0, gravity: 0.05, drag: 0.99 };
export const CROSSBOW_ARROW = { speed: 3.15, gravity: 0.05, drag: 0.99 };

/** Vanilla charge behaviour: full power at 20 ticks. Release earlier and the arrow flops. */
export const FULL_CHARGE_MS = 1100;   // 20 ticks plus margin for latency
export const CROSSBOW_CHARGE_MS = 1300; // 25 ticks plus margin

/**
 * Integrate one shot tick-by-tick.
 *
 * @param {number} pitchRad positive = aiming up
 * @param {number} speed    initial speed, blocks/tick
 * @param {object} [opts]   { gravity, drag, targetDist, maxTicks }
 * @returns {{ dropAt: (d:number)=>number|null, range: number, ticksTo: (d:number)=>number|null }}
 *   dropAt(d): vertical offset (blocks, negative = below launch height) when the arrow's
 *   horizontal travel first reaches d, or null if it never does.
 */
export function simulateShot(pitchRad, speed, opts = {}) {
    const g = opts.gravity ?? ARROW.gravity;
    const drag = opts.drag ?? ARROW.drag;
    const maxTicks = opts.maxTicks ?? 200;

    let vx = Math.cos(pitchRad) * speed;
    let vy = Math.sin(pitchRad) * speed;
    let x = 0, y = 0;
    const path = [{ x: 0, y: 0, t: 0 }];

    for (let t = 1; t <= maxTicks; t++) {
        x += vx;
        y += vy;
        vx *= drag;
        vy = vy * drag - g;
        path.push({ x, y, t });
        if (y < -64) break; // fell far below launch height; nothing sane is further out
    }

    const at = (d) => {
        for (let i = 1; i < path.length; i++) {
            if (path[i].x >= d) {
                // linear interpolation between the straddling ticks
                const a = path[i - 1], b = path[i];
                const f = (d - a.x) / Math.max(b.x - a.x, 1e-9);
                return { y: a.y + (b.y - a.y) * f, t: a.t + f };
            }
        }
        return null;
    };

    return {
        range: x,
        dropAt: (d) => at(d)?.y ?? null,
        ticksTo: (d) => at(d)?.t ?? null,
    };
}

/**
 * Pitch to hit a point `dist` blocks out and `dy` blocks up/down, low arc.
 *
 * Closed-form vacuum solution as the seed, then a few secant iterations against the dragged
 * simulation. Engagement is clamped to where drag error stays small; beyond ~40 blocks the
 * vanilla-drag model diverges from whatever this server really does, and !bowProbe's measured
 * correction table is the authority.
 *
 * @returns {{pitch:number, ticks:number}|null} null when out of range
 */
export function solvePitch({ dist, dy = 0, speed = ARROW.speed, gravity = ARROW.gravity, drag = ARROW.drag }) {
    if (dist <= 0.5) return { pitch: Math.atan2(dy, dist), ticks: 1 };

    // Vacuum low-arc: tan(p) = (v^2 - sqrt(v^4 - g(g d^2 + 2 dy v^2))) / (g d)
    const v2 = speed * speed;
    const disc = v2 * v2 - gravity * (gravity * dist * dist + 2 * dy * v2);
    let pitch = disc >= 0
        ? Math.atan((v2 - Math.sqrt(disc)) / (gravity * dist))
        : Math.PI / 4; // out of vacuum range: start from 45 deg and let the sim decide

    // Refine against the dragged trajectory.
    let prevPitch = pitch + 0.05;
    let prevErr = errAt(prevPitch);
    for (let i = 0; i < 12; i++) {
        const err = errAt(pitch);
        if (err === null) return null;
        if (Math.abs(err) < 0.05) break;
        const dErr = err - (prevErr ?? err);
        const dP = pitch - prevPitch;
        prevPitch = pitch; prevErr = err;
        pitch -= Math.abs(dErr) > 1e-9 ? err * (dP / dErr) : Math.sign(err) * 0.02;
        if (pitch > Math.PI / 3) return null;   // needing >60 deg means effectively out of range
        if (pitch < -Math.PI / 2) pitch = -Math.PI / 2 + 0.01;
    }

    const sim = simulateShot(pitch, speed, { gravity, drag, maxTicks: 300 });
    const ticks = sim.ticksTo(dist);
    if (ticks === null) return null;
    return { pitch, ticks };

    function errAt(p) {
        const s = simulateShot(p, speed, { gravity, drag, maxTicks: 300 });
        const drop = s.dropAt(dist);
        if (drop === null) return null;
        return drop - dy; // positive = hitting above the mark
    }
}

/**
 * Where to aim for a moving target: one-iteration lead along its current velocity.
 * Good enough for walking mobs; nothing here pretends to predict pathing.
 */
export function leadPoint(targetPos, targetVel, flightTicks) {
    if (!targetVel || !Number.isFinite(flightTicks)) return { ...targetPos };
    return {
        x: targetPos.x + targetVel.x * flightTicks,
        y: targetPos.y + targetVel.y * flightTicks,
        z: targetPos.z + targetVel.z * flightTicks,
    };
}

/**
 * Should this shot be refused because something friendly stands in the corridor?
 * Pure: caller supplies entity snapshots {x, z, dist} relative to the shooter.
 *
 * @param {number} targetDist
 * @param {number} targetYaw   bearing to the target, radians
 * @param {Array<{yaw:number, dist:number}>} friendlies bearings/distances of protected entities
 * @param {number} [coneRad]   half-angle of the danger cone
 */
export function friendlyInCorridor(targetDist, targetYaw, friendlies, coneRad = 0.18) {
    for (const f of friendlies) {
        if (f.dist > targetDist + 2) continue;      // behind the target: arrow stops first
        let d = Math.abs(f.yaw - targetYaw) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d <= coneRad) return true;
    }
    return false;
}
