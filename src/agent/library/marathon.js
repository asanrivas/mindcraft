import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';
import * as skills from './skills.js';
import * as nav from './nav.js';

/**
 * A checkpoint marathon: a fixed ring of waypoints the bot runs on foot, in order, and a
 * ledger of what each leg actually cost.
 *
 * Why a module and not "just send !travel six times". Driving long journeys from chat was
 * measured at 97 minutes of a driver re-sending `!travel` on a timer and interrupting its own
 * in-flight leg (see CLAUDE.md, "Driving long journeys"). The fix is to make ONE action own
 * the whole route: it knows when a leg has finished because it checks the bot's position, not
 * a clock, and it writes its progress to disk after every checkpoint so a crash or a restart
 * resumes at checkpoint 4 instead of at the start.
 *
 * Nothing here teleports. `!serverTp` is a rescue hatch that deletes its own arming marker;
 * the marathon must never touch it, or the numbers below stop meaning anything.
 */

/** XZ distance that counts as standing on a checkpoint. */
export const ARRIVE_DIST = 4;

/**
 * Lay out `count` checkpoints on a ring around `center` and return them in running order.
 *
 * The route is: center -> v0 -> v1 -> ... -> v(count-1). That is one radius plus `count-1`
 * polygon sides, so
 *
 *     total = R + (count - 1) * 2R * sin(pi / count)
 *
 * and the radius that exactly spends a budget is that solved for R. `slack` keeps a little
 * back, because the bot walks around hills rather than through them and the real path is
 * always longer than the straight-line plan.
 *
 * `startAngleDeg` rotates the whole ring. It exists because terrain is not isotropic: on this
 * world the ring at R=160 around (3402, 4889) is land everywhere except a 30-45 degree sector
 * of ocean, and rotating the start is how you keep six checkpoints on dry ground without
 * pretending the planner can see chunks that are not loaded.
 */
export function planLoop(center, opts = {}) {
    const count = Math.max(2, Math.floor(opts.count ?? 6));
    const maxTotal = Number(opts.maxTotal ?? 1000);
    const slack = Number(opts.slack ?? 0.96);
    const startAngleDeg = Number(opts.startAngleDeg ?? 0);

    const sideFactor = (count - 1) * 2 * Math.sin(Math.PI / count);
    const radius = opts.radius != null
        ? Number(opts.radius)
        : (maxTotal * slack) / (1 + sideFactor);

    const a0 = (startAngleDeg * Math.PI) / 180;
    const checkpoints = [];
    for (let i = 0; i < count; i++) {
        const a = a0 + (2 * Math.PI * i) / count;
        checkpoints.push({
            n: i + 1,
            x: Math.round(center.x + radius * Math.cos(a)),
            z: Math.round(center.z + radius * Math.sin(a)),
            bearingDeg: Math.round(((startAngleDeg + (360 * i) / count) % 360 + 360) % 360),
            reachedAt: null, y: null, tookMs: null, dug: 0, legs: 0, attempts: 0,
        });
    }
    return { radius, checkpoints };
}

/**
 * Build a route from explicit checkpoints, e.g. "4412,4934 4362,5021 ...".
 *
 * `planLoop` draws a regular ring, which is convenient and often wrong: terrain is not
 * isotropic, and around (4312, 4934) on this world NO rotation of a hexagon at radius 100 or
 * 120 puts all six vertices on dry ground - there are two separate lakes in the way. Surveying
 * the ring and hand-picking six land bearings takes a minute and produces a route the bot can
 * actually run, so the runner has to accept one.
 *
 * @returns {{checkpoints:Array}|{error:string}}
 */
export function routeFromPairs(text) {
    const pairs = String(text ?? '').trim().split(/[;\s]+/).filter(Boolean);
    if (pairs.length < 2) return { error: 'Give me at least two checkpoints, as "x,z x,z ...".' };
    if (pairs.length > 12) return { error: `${pairs.length} checkpoints is more than the 12 I will run.` };
    const checkpoints = [];
    const seen = new Set();
    for (const [i, pair] of pairs.entries()) {
        const m = pair.match(/^(-?\d+)\s*,\s*(-?\d+)$/);
        if (!m) return { error: `Checkpoint ${i + 1} ("${pair}") is not "x,z".` };
        const x = Number(m[1]), z = Number(m[2]);
        const key = `${x},${z}`;
        // A repeated checkpoint is instantly "reached" the moment the previous one is, which
        // silently shortens the route rather than failing.
        if (seen.has(key)) return { error: `Checkpoint ${i + 1} (${key}) repeats an earlier one.` };
        seen.add(key);
        checkpoints.push({
            n: i + 1, x, z, bearingDeg: null,
            reachedAt: null, y: null, tookMs: null, dug: 0, legs: 0, attempts: 0,
        });
    }
    return { checkpoints };
}

/** Straight-line length of `center -> cp1 -> cp2 -> ...`, the number the budget is checked against. */
export function routeLength(center, checkpoints) {
    let total = 0;
    let px = center.x, pz = center.z;
    for (const c of checkpoints) {
        total += Math.hypot(c.x - px, c.z - pz);
        px = c.x; pz = c.z;
    }
    return total;
}

function stateFile(name) { return path.join('bots', name, 'marathon.json'); }

export function loadState(name) {
    try {
        const s = JSON.parse(fs.readFileSync(stateFile(name), 'utf8'));
        if (s && Array.isArray(s.checkpoints)) return s;
    } catch { /* absent or unreadable: there is no marathon, which is not an error */ }
    return null;
}

export function saveState(name, state) {
    try {
        fs.mkdirSync(path.dirname(stateFile(name)), { recursive: true });
        fs.writeFileSync(stateFile(name), JSON.stringify(state, null, 2));
    } catch (err) {
        console.error('Could not save marathon state:', err.message);
    }
}

export function clearState(name) {
    try { fs.unlinkSync(stateFile(name)); return true; } catch { return false; }
}

/** One-line human summary of where the run has got to. */
export function describe(state, bot = null) {
    if (!state) return 'No marathon planned. Use !marathonPlan first.';
    const done = state.checkpoints.filter(c => c.reachedAt).length;
    const total = state.checkpoints.length;
    const walked = state.checkpoints.reduce((s, c) => s + (c.walked ?? 0), 0);
    const dug = state.checkpoints.reduce((s, c) => s + (c.dug ?? 0), 0);
    const lines = [
        `Marathon: ${done}/${total} checkpoints, planned route ${Math.round(state.plannedLength)} blocks, `
        + `walked ${Math.round(walked)}, mined ${dug}.`,
    ];
    for (const c of state.checkpoints) {
        const here = bot ? Math.hypot(c.x - bot.entity.position.x, c.z - bot.entity.position.z) : null;
        lines.push(
            `  #${c.n} (${c.x}, ${c.z})`
            + (c.reachedAt
                ? ` DONE at y=${c.y} in ${Math.round(c.tookMs / 1000)}s, ${c.legs} legs, ${c.dug} mined`
                : ` pending${here !== null ? `, ${here.toFixed(0)} blocks away` : ''}`)
        );
    }
    return lines.join('\n');
}

/**
 * Run (or resume) the marathon. Returns when every checkpoint is reached, the deadline
 * expires, or the action is interrupted.
 *
 * Each checkpoint gets several attempts, because `travelToward` returns as soon as its own
 * recovery ladder is out of ideas for the moment - a fresh attempt re-plans from a position
 * the previous one improved, and that alone clears most stalls. Arrival is judged on the
 * bot's XZ distance to the checkpoint, never on what the traveller claims: the checkpoint's Y
 * is unknown when the route is drawn, because the chunk is not loaded yet.
 */
export async function runMarathon(bot, state, opts = {}) {
    const {
        name,
        arrive = ARRIVE_DIST,
        attemptsPerCheckpoint = 6,
        legTimeoutMs = 6 * 60 * 1000,
        deadlineMs = 90 * 60 * 1000,
        onProgress = () => {},
        onDetail = () => {},
    } = opts;

    const deadline = Date.now() + deadlineMs;
    const persist = () => { if (name) saveState(name, state); };

    for (const cp of state.checkpoints) {
        if (cp.reachedAt) continue;
        if (bot.interrupt_code) return { finished: false, reason: 'interrupted', state };
        if (Date.now() > deadline) return { finished: false, reason: 'deadline', state };

        const t0 = Date.now();
        const from = bot.entity.position.clone();
        cp.walked = cp.walked ?? 0;
        onProgress(`Heading for checkpoint #${cp.n} at (${cp.x}, ${cp.z}).`);

        let last = null;
        for (let attempt = 1; attempt <= attemptsPerCheckpoint; attempt++) {
            if (bot.interrupt_code) break;
            if (Date.now() > deadline) break;

            const before = bot.entity.position.clone();
            cp.attempts = attempt;
            last = await skills.travelToward(bot, cp.x, cp.z, {
                arrive,
                timeoutMs: Math.min(legTimeoutMs, Math.max(0, deadline - Date.now())),
                announce: attempt === 1,
                // Land-only planning. See `swimEnabled` in skills.travelToward: this bot cannot
                // climb out of water, so a cheap pond is a route it can enter and not leave.
                swimEnabled: false,
                // `navMoved`, not `moved`: this is what the NAVIGATOR leg covered. Whatever the
                // recovery ladder afterwards manages - digging out of a bank, swimming a
                // crossing - lands in the NEXT leg's starting position, so a leg can honestly
                // report navMoved 0.0 while `to go` drops by four. Calling it "moved" made the
                // run look frozen when it was making progress by mining.
                onLeg: (l) => onDetail(
                    `#${cp.n} leg ${l.leg}: navMoved ${l.moved.toFixed(1)}, `
                    + `${l.remaining.toFixed(0)} to go, ${l.dug} mined, ${l.stalls} stall(s), `
                    + `at (${l.pos.x.toFixed(0)}, ${l.pos.y.toFixed(0)}, ${l.pos.z.toFixed(0)})`),
            });
            cp.dug += last.dug;
            cp.legs += last.legs;
            cp.walked += bot.entity.position.distanceTo(before);

            const p = bot.entity.position;
            if (Math.hypot(cp.x - p.x, cp.z - p.z) <= arrive) break;

            // An interrupt is not a stall. travelToward returns immediately when
            // `interrupt_code` is set, so its `covered` reads as zero - and shoving the bot
            // sideways in response would move it away from the checkpoint for a reason that
            // has nothing to do with the terrain.
            if (bot.interrupt_code) break;

            // No forward progress at all means the ladder inside travelToward is genuinely out
            // of moves here rather than merely mid-recovery. Shove sideways to change the
            // geometry before re-planning - the planner is deterministic, so re-planning from
            // the same block yields the same refused route.
            if (last.covered < 1.0) {
                onProgress(`Checkpoint #${cp.n}: stalled ${last.remaining.toFixed(0)} blocks out (attempt ${attempt}); breaking out sideways.`);
                try { await skills.moveAway(bot, 6); } catch { /* keep trying */ }
            }
            persist();
        }

        const p = bot.entity.position;
        const remaining = Math.hypot(cp.x - p.x, cp.z - p.z);
        if (remaining <= arrive) {
            cp.reachedAt = new Date().toISOString();
            cp.y = Math.round(p.y);
            cp.tookMs = Date.now() - t0;
            persist();
            onProgress(`Checkpoint #${cp.n} reached at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) `
                + `in ${Math.round(cp.tookMs / 1000)}s over ${cp.legs} legs, ${cp.dug} block(s) mined.`);
            continue;
        }

        cp.tookMs = Date.now() - t0;
        persist();
        return {
            finished: false,
            reason: bot.interrupt_code ? 'interrupted' : 'stuck',
            stuckAt: cp.n,
            remaining,
            from,
            state,
        };
    }

    const finished = state.checkpoints.every(c => c.reachedAt);
    if (finished && !state.finishedAt) { state.finishedAt = new Date().toISOString(); persist(); }
    return { finished, reason: finished ? 'done' : 'incomplete', state };
}
