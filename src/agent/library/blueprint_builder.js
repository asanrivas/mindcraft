import { Vec3 } from 'vec3';
import * as mc from '../../utils/mcdata.js';
import fs from 'fs';

/**
 * Native in-game blueprint builder: the bot flies (creative) to each block position and
 * places the block itself with the correct look angle and click face - no server /setblock.
 *
 * Angle model ("auto angle"): the server derives a placed block's orientation from the
 * placing player's yaw/pitch and the clicked face+cursor, so we invert that mapping:
 *   - stairs/doors/beds/fence gates: blockstate facing == player's look direction
 *   - chests/furnaces/barrels/looms/lecterns: facing == OPPOSITE of look (front toward player)
 *   - wall signs/buttons/wall torches: orientation comes from the clicked face, so the
 *     reference block is the support block behind (P - facingVec) and the face is facingVec
 *   - axis blocks (logs/pillars): axis == normal of the clicked face, so pick the reference
 *     block along the desired axis
 *   - standing signs/banners: rotation quantised from yaw; look opposite the sign's front
 *   - half=top stairs/trapdoors: click the upper half of a side face (cursor option), or the
 *     underside of the block above
 * Look is set explicitly (bot.lookAt) before the place packet, and _placeBlockWithOptions is
 * called with forceLook:'ignore' so it cannot overwrite our computed angle.
 */

const FACE = {
    north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0),
    up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0),
};
const SIDE_FACES = ['north', 'south', 'west', 'east'];

// facing == player look direction when placed
const LOOK_ALIGNED = /(_stairs|_door|_bed|fence_gate|campfire)$/;
// facing == opposite of player look (block front toward player)
const LOOK_OPPOSED = /^(chest|trapped_chest|ender_chest|furnace|smoker|blast_furnace|barrel|loom|lectern|chiseled_bookshelf|anvil|chipped_anvil|damaged_anvil)$/;
// support-attached: reference block is behind, orientation from clicked face
const WALL_ATTACHED = /(_wall_sign|_wall_hanging_sign|wall_torch|_wall_banner|_wall_head|_wall_skull|_wall_fan|_button|ladder|tripwire_hook)$/;

const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass',
    'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'seagrass', 'tall_seagrass', 'water']);
const NATURAL_TERRAIN = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol',
    'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'sand', 'red_sand', 'gravel',
    'sandstone', 'clay', 'moss_block', 'mud', 'short_grass', 'grass', 'tall_grass', 'fern',
    'large_fern', 'dead_bush', 'snow', 'poppy', 'dandelion', 'cornflower', 'oxeye_daisy', 'azure_bluet']);

function itemNameFor(blockName) {
    return blockName
        .replace(/_wall_hanging_sign$/, '_hanging_sign')
        .replace(/_wall_sign$/, '_sign')
        .replace(/^wall_torch$/, 'torch')
        .replace(/^redstone_wall_torch$/, 'redstone_torch')
        .replace(/^soul_wall_torch$/, 'soul_torch')
        .replace(/_wall_banner$/, '_banner')
        .replace(/_wall_fan$/, '_fan')
        .replace(/_wall_head$/, '_head')
        .replace(/_wall_skull$/, '_skull');
}

// Should this placement entry be skipped because a sibling entry places it implicitly?
function isImplicitHalf(p) {
    const props = p.properties || {};
    if (props.part === 'head') return true;          // bed item places both halves
    if (props.half === 'upper') return true;         // door / tall plant upper half
    if (props.type === 'double' && p.name.endsWith('_slab')) return false; // needs 2 placements; place once, flag
    return false;
}

function rotationToFacingVec(rot) {
    const theta = (Number(rot) * 22.5) * Math.PI / 180;
    return new Vec3(-Math.sin(theta), 0, Math.cos(theta)); // rotation 0 = south
}

// The horizontal direction the bot must LOOK so the block lands with the desired facing.
function lookVecFor(p) {
    const props = p.properties || {};
    if (props.rotation !== undefined) return rotationToFacingVec(props.rotation).scaled(-1);
    const f = props.facing;
    if (!f || !FACE[f] || f === 'up' || f === 'down') return null;
    if (LOOK_ALIGNED.test(p.name)) return FACE[f];
    if (LOOK_OPPOSED.test(p.name)) return FACE[f].scaled(-1);
    if (p.name.endsWith('_trapdoor')) return FACE[f].scaled(-1); // floor/ceiling fallback path
    return null;
}

function isPassable(block) {
    return block && (block.boundingBox === 'empty') && block.name !== 'lava';
}
function isSolidRef(block) {
    return block && block.boundingBox === 'block';
}

// Pick a hover position (feet) from which the clicked point is reachable and the bot
// does not occupy the destination cell.
function findHover(bot, P, faceName) {
    const candidates = [];
    const n = FACE[faceName] || FACE.up;
    if (faceName === 'down') {
        candidates.push(P.offset(0, -3, 0), P.offset(0, -2, 0), P.offset(1, -2, 0), P.offset(-1, -2, 0));
    } else if (faceName === 'up') {
        candidates.push(P.offset(0, 2, 0), P.offset(0, 3, 0), P.offset(1, 2, 0), P.offset(-1, 2, 0),
            P.offset(0, 2, 1), P.offset(0, 2, -1), P.offset(2, 1, 0), P.offset(-2, 1, 0),
            P.offset(0, 1, 2), P.offset(0, 1, -2));
    } else {
        const s = n.scaled(2), s3 = n.scaled(3);
        candidates.push(P.plus(s), P.plus(s).offset(0, 1, 0), P.plus(s3), P.plus(s).offset(0, -1, 0),
            P.plus(s3).offset(0, 1, 0), P.offset(0, 2, 0), P.offset(0, 3, 0));
    }
    for (const feet of candidates) {
        if (feet.equals(P)) continue;
        const head = feet.offset(0, 1, 0);
        if (head.equals(P)) continue;
        if (isPassable(bot.blockAt(feet)) && isPassable(bot.blockAt(head))) return feet;
    }
    return null;
}

// Own flight loop instead of bot.creative.flyTo: that one cannot be cancelled, so racing
// it against a timeout leaks a background loop that keeps steering the bot toward a stale
// destination forever. This version is bounded and leaves no orphan.
//
// Server agreement is NOT guaranteed: this mutates the client's belief, and a server that
// rejects the moves (e.g. the bot is embedded in blocks it dug) silently pins the player
// while the client "flies" away - every later placement then fails with a blockUpdate
// timeout because it is issued from 100+ blocks off. Hence: declare flying via the
// abilities packet (mineflayer never sends it, making hover technically illegal), keep the
// step under ~7 m/s, and let forcedMove corrections stand (d is recomputed from
// bot.entity.position each tick, which a correction overwrites).
let declaredFlying = false;
async function flyToWithTimeout(bot, dest, ms = 12000) {
    bot.creative.startFlying();
    if (!declaredFlying) {
        try { bot._client.write('abilities', { flags: 2 }); declaredFlying = true; } catch (e) { /* older proto */ }
    }
    const start = Date.now();
    while (Date.now() - start < ms) {
        const d = dest.minus(bot.entity.position);
        const mag = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
        if (mag < 0.6) break;
        bot.physics.gravity = 0;
        bot.entity.velocity.set(0, 0, 0);
        bot.entity.position.add(d.scaled(Math.min(0.35, mag) / mag));
        await new Promise(r => setTimeout(r, 50));
    }
}

// Chunks stream in slower than creative flight moves, so a blockAt right after arriving
// reads null. Poll instead of failing - null here means "not received yet", not "no block".
async function waitForBlock(bot, P, ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        const b = bot.blockAt(P);
        if (b) return b;
        await new Promise(r => setTimeout(r, 250));
    }
    return null;
}

async function equip(bot, itemName) {
    if (bot.heldItem?.name === itemName) return true;
    const item = mc.makeItem(itemName, 1);
    if (!item) return false;
    try {
        await bot.creative.setInventorySlot(36, item);
        await bot.setQuickBarSlot(0);
        return true;
    } catch (e) {
        console.log(`[builder] equip ${itemName} failed: ${e.message}`);
        return false;
    }
}

// Choose (referenceBlock, faceVector, faceName, halfOpt) for a placement.
function chooseFace(bot, P, p) {
    const props = p.properties || {};

    if (WALL_ATTACHED.test(p.name) && props.face !== 'floor' && props.face !== 'ceiling') {
        const f = props.facing;
        if (f && FACE[f]) {
            const ref = bot.blockAt(P.minus(FACE[f]));
            if (isSolidRef(ref)) return { ref, faceVec: FACE[f], faceName: f, half: null };
        }
    }
    if (props.face === 'floor') {
        const ref = bot.blockAt(P.offset(0, -1, 0));
        if (isSolidRef(ref)) return { ref, faceVec: FACE.up, faceName: 'up', half: null };
    }
    if (props.face === 'ceiling' || props.hanging === 'true') {
        const ref = bot.blockAt(P.offset(0, 1, 0));
        if (isSolidRef(ref)) return { ref, faceVec: FACE.down, faceName: 'down', half: null };
    }

    // trapdoors: prefer side-attach to the support behind (deterministic facing)
    if (p.name.endsWith('_trapdoor') && props.facing) {
        const ref = bot.blockAt(P.minus(FACE[props.facing]));
        if (isSolidRef(ref)) {
            return { ref, faceVec: FACE[props.facing], faceName: props.facing,
                     half: props.half === 'top' ? 'top' : 'bottom' };
        }
    }

    // axis blocks: clicked-face normal defines the axis
    if (props.axis) {
        const axisFaces = { x: ['east', 'west'], y: ['up', 'down'], z: ['south', 'north'] }[props.axis] || [];
        for (const fname of axisFaces) {
            const ref = bot.blockAt(P.minus(FACE[fname]));
            if (isSolidRef(ref)) return { ref, faceVec: FACE[fname], faceName: fname, half: null };
        }
    }

    const wantTop = props.half === 'top' || props.type === 'top';
    const order = wantTop
        ? ['down', ...SIDE_FACES, 'up']   // 'down' face of block above -> half=top
        : ['up', ...SIDE_FACES, 'down'];
    for (const fname of order) {
        const ref = bot.blockAt(P.minus(FACE[fname]));
        if (isSolidRef(ref)) {
            let half = null;
            if (SIDE_FACES.includes(fname) && (props.half || props.type === 'top' || props.type === 'bottom'))
                half = wantTop ? 'top' : 'bottom';
            return { ref, faceVec: FACE[fname], faceName: fname, half };
        }
    }
    return null;
}

async function placeOne(bot, P, p) {
    let existing = bot.blockAt(P);
    if (!existing) {
        await flyToWithTimeout(bot, P.offset(0.5, 3, 0.5));
        existing = await waitForBlock(bot, P);
        if (!existing) return { ok: false, why: 'chunk not loaded' };
    }
    if (existing.name === p.name) return { ok: true, skipped: true };
    if (!REPLACEABLE.has(existing.name)) {
        // clear whatever occupies the cell first (instant in creative)
        const feet = findHover(bot, P, 'up');
        if (feet) await flyToWithTimeout(bot, feet.offset(0.5, 0, 0.5));
        try { await bot.dig(existing, true); } catch (e) { /* keep going; place may still fail */ }
    }

    const choice = chooseFace(bot, P, p);
    if (!choice) {
        const nb = (dx, dy, dz) => { const b = bot.blockAt(P.offset(dx, dy, dz)); return b ? `${b.name}/${b.boundingBox}` : 'NULL'; };
        return { ok: false, why: `no solid neighbor (self=${bot.blockAt(P)?.name} below=${nb(0,-1,0)} above=${nb(0,1,0)} n=${nb(0,0,-1)} s=${nb(0,0,1)} w=${nb(-1,0,0)} e=${nb(1,0,0)})` };
    }

    const feet = findHover(bot, P, choice.faceName);
    if (!feet) return { ok: false, why: 'no hover spot' };
    await flyToWithTimeout(bot, feet.offset(0.5, 0, 0.5));

    const itemName = itemNameFor(p.name);
    if (!(await equip(bot, itemName))) return { ok: false, why: `no item ${itemName}` };

    // ---- auto angle ----
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const look = lookVecFor(p);
    const props = p.properties || {};
    if (look) {
        let pitchY = 0;
        await bot.lookAt(eye.plus(look.scaled(4)).offset(0, pitchY, 0), true);
    } else if (props.facing === 'up') {
        await bot.lookAt(eye.offset(0, -3, 0.01), true);   // steep down -> facing=up (barrels)
    } else if (props.facing === 'down') {
        await bot.lookAt(eye.offset(0, 3, 0.01), true);
    } else {
        const clickPoint = choice.ref.position.offset(
            0.5 + choice.faceVec.x * 0.5, 0.5 + choice.faceVec.y * 0.5, 0.5 + choice.faceVec.z * 0.5);
        await bot.lookAt(clickPoint, true);
    }

    try {
        const opts = { forceLook: 'ignore', swingArm: 'right' };
        if (choice.half) opts.half = choice.half;
        await bot._placeBlockWithOptions(choice.ref, choice.faceVec, opts);
    } catch (e) {
        const now = bot.blockAt(P);
        if (!now || now.name !== p.name) return { ok: false, why: e.message };
    }

    // interactive states the place packet cannot express
    if (props.open === 'true') {
        const placed = bot.blockAt(P);
        if (placed && placed.name === p.name && placed.getProperties?.().open === false) {
            try { await bot.activateBlock(placed); } catch (e) { /* cosmetic */ }
        }
    }
    const finalBlock = bot.blockAt(P);
    return { ok: !!finalBlock && finalBlock.name === p.name, why: finalBlock ? `got ${finalBlock.name}` : 'unloaded' };
}

// Orientation props worth showing the LLM; connection/auto-computed states (shape,
// waterlogged, powered, occupied...) are noise it can neither set nor fix.
const REPORTABLE_PROPS = ['facing', 'half', 'axis', 'hanging', 'open', 'rotation'];

function propSummary(p) {
    const props = p.properties || {};
    const parts = REPORTABLE_PROPS.filter(k => props[k] !== undefined).map(k => `${k}=${props[k]}`);
    return parts.length ? ` [${parts.join(',')}]` : '';
}

/**
 * Diff the world against a placements JSON: the LLM-friendly view of a build.
 * Instead of a voxel dump (which a small model cannot reason over), returns a short
 * imperative fix-list of the nearest mismatches, plus an honest total. Same output
 * philosophy as construction_tasks.js explainLevelDifference.
 */
export function blueprintStatus(agent, filePath, origin, limit = 10) {
    const bot = agent.bot;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const all = (raw.placements || raw).filter(p => !isImplicitHalf(p));

    let match = 0, unloaded = 0;
    const mismatches = [];
    const here = bot.entity.position;
    for (const p of all) {
        const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
        const b = bot.blockAt(P);
        if (!b) { unloaded++; continue; }
        if (b.name === p.name) { match++; continue; }
        mismatches.push({ p, P, existing: b.name, d: here.distanceTo(P) });
    }
    mismatches.sort((a, b) => a.d - b.d);

    const checked = all.length - unloaded;
    const pct = checked > 0 ? ((match / checked) * 100).toFixed(1) : '0.0';
    let out = `BUILD STATUS (${filePath} at ${origin.x},${origin.y},${origin.z}):\n`;
    out += `${match}/${checked} checked blocks correct (${pct}%).`;
    if (unloaded) out += ` ${unloaded} cells unloaded - move closer to check those.`;
    if (mismatches.length === 0) {
        out += unloaded ? '' : '\nBuild is COMPLETE.';
        return out;
    }
    out += `\n${mismatches.length} blocks need fixing. Nearest ${Math.min(limit, mismatches.length)}:`;
    for (const m of mismatches.slice(0, limit)) {
        const what = `${m.p.name}${propSummary(m.p)}`;
        if (m.existing === 'air' || REPLACEABLE.has(m.existing)) {
            out += `\n- Place ${what} at (${m.P.x}, ${m.P.y}, ${m.P.z})`;
        } else {
            out += `\n- Replace the ${m.existing} with ${what} at (${m.P.x}, ${m.P.y}, ${m.P.z})`;
        }
    }
    return out;
}

const PAUSABLE_MODES = ['unstuck', 'cowardice', 'self_defense', 'night_safety', 'hunting',
    'item_collecting', 'torch_placing', 'elbow_room', 'idle_staring'];

// Heartbeat so an external watchdog can tell "build in progress" from "build died with the
// process" (the service gets restarted out from under us) and re-issue the command.
function writeStatus(agent, data) {
    try {
        fs.writeFileSync(`bots/${agent.name}/BUILD_STATUS.json`,
            JSON.stringify({ ts: Date.now(), ...data }));
    } catch (e) { /* status is best-effort */ }
}

export async function buildBlueprint(agent, filePath, origin) {
    const bot = agent.bot;
    if (bot.game.gameMode !== 'creative')
        return 'Blueprint building needs creative mode (for flight and instant block breaking). Ask an operator for /gamemode creative.';

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const all = raw.placements || raw;
    const meta = raw.meta || {};

    // pass 1: free-standing blocks bottom-up; pass 2: support-dependent blocks
    const needsSupport = (p) => WALL_ATTACHED.test(p.name) || (p.properties || {}).hanging === 'true'
        || p.name.endsWith('_carpet') || /(_torch|lantern)$/.test(p.name);
    const buildable = all.filter(p => !isImplicitHalf(p));
    const pass1 = buildable.filter(p => !needsSupport(p)).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
    const pass2 = buildable.filter(needsSupport).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);

    for (const m of PAUSABLE_MODES) { try { bot.modes.pause(m); } catch (e) { /* mode absent */ } }
    bot.creative.startFlying();

    let placed = 0, skipped = 0;
    const failures = [];
    const started = Date.now();
    try {
        // fly to site first so chunks stream in, then WAIT for them - flight outpaces
        // chunk packets, and a blockAt against a not-yet-received column reads null
        await flyToWithTimeout(bot, new Vec3(origin.x + 16, origin.y + 12, origin.z + 16), 60000);
        const probe = await waitForBlock(bot, new Vec3(origin.x + 16, origin.y - 1, origin.z + 16), 20000);
        if (!probe) throw new Error('chunks at the build site never loaded');

        // clear natural terrain poking into the lower floors of the footprint
        if (meta.size) {
            const occupied = new Set(all.map(p => `${p.x},${p.y},${p.z}`));
            for (let y = 0; y < Math.min(6, meta.size.height); y++) {
                console.log(`[builder] clearing terrain layer ${y}`);
                for (let x = 0; x < meta.size.width; x++) {
                    // heartbeat per ROW, not per layer: a layer of digging can take
                    // minutes, and a stale heartbeat makes the watchdog re-send the
                    // command - which interrupts the very build it is guarding
                    writeStatus(agent, { phase: 'clear', layer: y, row: x, total: buildable.length });
                    for (let z = 0; z < meta.size.length; z++) {
                        if (occupied.has(`${x},${y},${z}`)) continue;
                        const P = new Vec3(origin.x + x, origin.y + y, origin.z + z);
                        const b = bot.blockAt(P);
                        if (b && NATURAL_TERRAIN.has(b.name)) {
                            const feet = findHover(bot, P, 'up');
                            if (feet) await flyToWithTimeout(bot, feet.offset(0.5, 0, 0.5));
                            try { await bot.dig(b, true); } catch (e) { /* skip stubborn */ }
                            // heartbeat per DIG: a dig-dense row outlasts every staleness
                            // threshold, and a "stale" live build gets killed by its own watchdog
                            writeStatus(agent, { phase: 'clear', layer: y, row: x, digging: true, total: buildable.length });
                        }
                    }
                }
            }
        }

        // foundation: underpin every ground-layer cell down to real ground (max 8 deep) so
        // the base never floats - natural terrain is never flat enough for a 32x31 footprint
        let foundationPlaced = 0;
        for (const p of pass1.filter(q => q.y === 0)) {
            const top = new Vec3(origin.x + p.x, origin.y - 1, origin.z + p.z);
            let groundY = null;
            for (let depth = 0; depth < 8; depth++) {
                const b = bot.blockAt(top.offset(0, -depth, 0));
                if (!b) break;
                if (b.boundingBox === 'block') { groundY = top.y - depth; break; }
            }
            if (groundY === null || groundY === top.y) continue;
            for (let y = groundY + 1; y <= top.y; y++) {
                const res = await placeOne(bot, new Vec3(top.x, y, top.z),
                    { name: 'cobblestone', properties: {} });
                if (res.ok && !res.skipped) foundationPlaced++;
                if (foundationPlaced % 25 === 0)
                    writeStatus(agent, { phase: 'foundation', placed: foundationPlaced, total: buildable.length });
            }
        }
        if (foundationPlaced) console.log(`[builder] foundation: ${foundationPlaced} support blocks placed`);

        for (const [passName, list] of [['pass1', pass1], ['pass2', pass2]]) {
            for (const p of list) {
                if (bot.interrupt_code) throw new Error('interrupted');
                const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
                let res;
                try {
                    res = await placeOne(bot, P, p);
                } catch (e) {
                    res = { ok: false, why: `threw: ${e.message}` };
                }
                if (res.ok) { res.skipped ? skipped++ : placed++; }
                else {
                    failures.push({ ...p, why: res.why });
                    if (failures.length <= 3) console.log(`[builder] FAIL ${p.name}@(${P.x},${P.y},${P.z}): ${res.why}`);
                }
                const done = placed + skipped + failures.length;
                if (done % 25 === 0) writeStatus(agent, { phase: passName, done, total: buildable.length, placed, failed: failures.length });
                if (done % 200 === 0)
                    console.log(`[builder] ${done}/${buildable.length} (${placed} placed, ${skipped} pre-existing, ${failures.length} failed) [${passName}]`);
            }
        }

        // retry failures once - supports placed later in pass1/pass2 may fix them.
        // But if MOST blocks failed the problem is systemic (bad chunks, wrong origin) and
        // retrying thousands of 20s fly-and-wait attempts would pin the agent for days.
        const retry = failures.length < buildable.length / 4 ? failures.splice(0, failures.length) : [];
        let retried = 0;
        for (const p of retry) {
            const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
            const res = await placeOne(bot, P, p);
            if (res.ok) placed++;
            else failures.push(p);
            if (++retried % 10 === 0) writeStatus(agent, { phase: 'retry', done: retried, total: retry.length });
        }
    } finally {
        try { bot.modes.unPauseAll(); } catch (e) { /* best effort */ }
        // restore gravity or the bot floats forever after the action ends
        try { bot.creative.stopFlying(); } catch (e) { /* best effort */ }
    }

    // verification against the world, never against our own bookkeeping
    let match = 0;
    for (const p of buildable) {
        const b = bot.blockAt(new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z));
        if (b && b.name === p.name) match++;
    }
    const pct = ((match / buildable.length) * 100).toFixed(1);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    writeStatus(agent, { phase: 'done', verifiedPct: Number(pct), match, total: buildable.length });
    let out = `VERIFIED BUILD: ${match}/${buildable.length} blocks match (${pct}%) after ${mins} min. `
        + `${placed} placed, ${skipped} already correct, ${failures.length} failed.`;
    if (failures.length) {
        const sample = failures.slice(0, 5).map(f => `${f.name}@(${f.x},${f.y},${f.z}): ${f.why}`).join('; ');
        out += ` Failures e.g.: ${sample}`;
    }
    return out;
}
