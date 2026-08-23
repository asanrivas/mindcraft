import { Vec3 } from 'vec3';
import * as mc from '../../utils/mcdata.js';
import * as nav from './nav.js';
import { pillarUp } from './skills.js';
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

// GROUND-BASED movement. Client-driven creative flight is dead on this server: measured
// 1,870 forcedMove corrections in one run - the server rejects every flown movement packet
// and pins the player, after which all placements fail from range. Walking is the one
// movement mode with a 1,000-block proven record here (see NAVIGATION_REBUILD.md), so the
// builder walks: to each column via the A* navigator, standing on the structure's own
// lower layers as they rise. Cells out of reach fail into the retry pass and usually
// become reachable as later layers add floor to stand on.
async function goNear(bot, P, reach = 3.0) {
    const eyeDist = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(P.offset(0.5, 0.5, 0.5));
    if (eyeDist() <= reach + 1.2) return true;
    await nav.navigateTo(bot, { x: P.x, y: P.y, z: P.z },
        { arriveDist: reach, arriveY: 3, maxReplans: 3 });
    return eyeDist() <= 4.6;
}

// ---- scaffolding: vertical access for work above walking reach ----
// The navigator only paths over existing blocks, so anything above ~2 blocks is
// unreachable until something exists to stand on (measured: 3,138 of 3,648 blocks failed
// exactly this way). Classic player solution: pillar-jump a dirt column next to the work,
// build what is in reach, then dig back down through the pillar before moving on - so the
// scaffold never outlives its use.
async function pillarDown(bot, ctx) {
    while (ctx.pillar.length) {
        const under = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (!under || under.name !== 'dirt') { ctx.pillar.length = 0; break; }
        try { await bot.dig(under, true); } catch (e) { ctx.pillar.length = 0; break; }
        await new Promise(r => setTimeout(r, 350)); // fall into the gap
        ctx.pillar.pop();
    }
}

async function scaffoldTo(bot, P, ctx) {
    // heartbeat before the slow part: one scaffold (nav + pillar) can take minutes, and a
    // silent stretch that long reads as "dead" to the watchdog
    if (ctx.agent) writeStatus(ctx.agent, { phase: 'scaffold', target: `${P.x},${P.y},${P.z}` });
    // choose a support column adjacent to P that the blueprint never occupies
    const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dz] of candidates) {
        const cx = P.x + dx, cz = P.z + dz;
        // must be blueprint-free all the way up, and open in the world
        let clash = false;
        for (let y = P.y - 12; y <= P.y + 1; y++) {
            if (ctx.occupied.has(`${cx - ctx.origin.x},${y - ctx.origin.y},${cz - ctx.origin.z}`)) { clash = true; break; }
        }
        if (clash) continue;
        // find ground in this column
        let groundTop = null;
        for (let y = P.y; y > P.y - 16; y--) {
            const b = bot.blockAt(new Vec3(cx, y, cz));
            if (b && b.boundingBox === 'block') { groundTop = y; break; }
        }
        if (groundTop === null) continue;
        const res = await nav.navigateTo(bot, { x: cx, y: groundTop + 1, z: cz }, { arriveDist: 0.6, arriveY: 2, maxReplans: 2 });
        if (!res.arrived) continue;
        const targetFeet = P.y - 1;
        const need = targetFeet - Math.floor(bot.entity.position.y);
        if (need <= 0) return true;
        const before = Math.floor(bot.entity.position.y);
        const gained = await pillarUp(bot, need);
        for (let i = 0; i < Math.round(gained); i++) ctx.pillar.push({ x: cx, y: before + i, z: cz });
        return bot.entity.position.y >= targetFeet - 0.6;
    }
    return false;
}

// Placement fails server-side if the bot's body occupies OR nearly touches the destination
// cell (skills.placeBlock's 1.1-block rule, learned the hard way) - step aside.
async function stepOff(bot, P) {
    const feet = bot.entity.position.floored();
    const center = P.offset(0.5, 0.5, 0.5);
    const tooClose = bot.entity.position.distanceTo(center) < 1.1
        || bot.entity.position.offset(0, 1, 0).distanceTo(center) < 1.1;
    if (!feet.equals(P) && !feet.offset(0, 1, 0).equals(P) && !tooClose) return;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const t = feet.offset(dx, 0, dz);
        const b = bot.blockAt(t), head = bot.blockAt(t.offset(0, 1, 0)), below = bot.blockAt(t.offset(0, -1, 0));
        if (b?.boundingBox === 'empty' && head?.boundingBox === 'empty' && below?.boundingBox === 'block') {
            await nav.navigateTo(bot, { x: t.x, y: t.y, z: t.z }, { arriveDist: 0.5, maxReplans: 1 });
            return;
        }
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

// Rotates when a slot's busy-flag leaks: mineflayer's setInventorySlot can permanently
// brick a slot for the life of the process after an overlapping/cancelled write (see
// CLAUDE.md creative notes - it once bricked all 37 slots). Observed live as a mid-run
// cliff: ~80% success until one interrupted equip, then every "no item X" after.
// Slots 36-43 rotate; 44 is reserved for scaffold dirt.
let equipSlot = 36;
async function equip(bot, itemName) {
    if (bot.heldItem?.name === itemName) return true;
    let item = bot.inventory.findInventoryItem(itemName);
    for (let attempt = 0; attempt < 4 && !item; attempt++) {
        try {
            await bot.creative.setInventorySlot(equipSlot, mc.makeItem(itemName, 1));
        } catch (e) {
            if (/cancelled|again/i.test(e.message)) {
                await new Promise(r => setTimeout(r, 400));
                if (attempt >= 1) equipSlot = 36 + ((equipSlot - 36 + 1) % 8); // slot may be bricked - move on
                continue;
            }
            console.log(`[builder] equip ${itemName} failed: ${e.message}`);
            return false;
        }
        item = bot.inventory.findInventoryItem(itemName);
    }
    if (!item) { console.log(`[builder] equip ${itemName}: item never appeared (slot ${equipSlot})`); return false; }
    try {
        // real equip so the SERVER's held-item state is synced - a raw hotbar write can
        // leave the server seeing an empty hand
        await bot.equip(item, 'hand');
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

async function placeOne(bot, P, p, ctx = null) {
    // leaving high work? dismantle the scaffold under our feet first
    if (ctx?.pillar?.length &&
        bot.entity.position.offset(0, 1.62, 0).distanceTo(P.offset(0.5, 0.5, 0.5)) > 4.6) {
        await pillarDown(bot, ctx);
    }
    let existing = bot.blockAt(P);
    if (!existing) {
        await goNear(bot, P);
        existing = await waitForBlock(bot, P);
        if (!existing) return { ok: false, why: 'chunk not loaded' };
    }
    if (existing.name === p.name) return { ok: true, skipped: true };
    if (!REPLACEABLE.has(existing.name)) {
        // clear whatever occupies the cell first (instant in creative)
        if (await goNear(bot, P)) {
            try { await bot.dig(existing, true); } catch (e) { /* keep going; place may still fail */ }
        }
    }

    const choice = chooseFace(bot, P, p);
    if (!choice) {
        const nb = (dx, dy, dz) => { const b = bot.blockAt(P.offset(dx, dy, dz)); return b ? `${b.name}/${b.boundingBox}` : 'NULL'; };
        return { ok: false, why: `no solid neighbor (self=${bot.blockAt(P)?.name} below=${nb(0,-1,0)} above=${nb(0,1,0)} n=${nb(0,0,-1)} s=${nb(0,0,1)} w=${nb(-1,0,0)} e=${nb(1,0,0)})` };
    }

    // ---- auto angle, by POSITION not by forced look ----
    // Modern servers (1.20.2+ interaction validation, which this one has) verify that the
    // click is plausible from the player's eye: a look ray that never intersects the
    // clicked face gets the placement silently rejected (observed: 94% blockUpdate
    // timeouts with a horizontal forced yaw). A human places east-facing stairs by
    // standing WEST of the cell and looking down-east at the click point - yaw comes from
    // where you stand. So: approach from the side opposite the desired look direction,
    // then genuinely look at the click point; orientation and validation both fall out.
    const look = lookVecFor(p);
    const props = p.properties || {};
    let approach = P;
    if (look) {
        approach = P.minus(new Vec3(Math.round(look.x * 2), 0, Math.round(look.z * 2)));
    } else if (SIDE_FACES.includes(choice.faceName)) {
        approach = P.plus(new Vec3(choice.faceVec.x * 2, 0, choice.faceVec.z * 2)); // in front of the clicked face
    }
    if (!(await goNear(bot, approach)) && !(await goNear(bot, P))) {
        // above walking reach: pillar a dirt scaffold next to the work
        if (!(ctx && P.y > bot.entity.position.y + 1.5 && await scaffoldTo(bot, P, ctx)))
            return { ok: false, why: 'out of reach (no walkable route)' };
    }
    await stepOff(bot, P);

    const itemName = itemNameFor(p.name);
    if (!(await equip(bot, itemName))) return { ok: false, why: `no item ${itemName}` };

    try {
        // default forceLook: the library looks at the (half-adjusted) click point itself,
        // which passes validation; our standing side supplies the yaw for orientation
        const opts = { swingArm: 'right' };
        if (choice.half) opts.half = choice.half;
        // PACE the packets. The server rate-limits interactions and silently DROPS the
        // excess (observed: bursts of placements time out en masse while slow stretches
        // succeed; a long chat reply got the bot kicked with disconnect.spam). A beat
        // before each place keeps us under the limiter.
        await new Promise(r => setTimeout(r, 250));
        await bot._placeBlockWithOptions(choice.ref, choice.faceVec, opts);
    } catch (e) {
        // the API can throw after a successful placement - re-read before believing it
        await new Promise(r => setTimeout(r, 200));
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

    // scaffold context: which cells the blueprint owns (never pillar there), and the live
    // dirt pillar under the bot (always dismantled before moving on)
    const ctx = {
        origin,
        agent,
        occupied: new Set(all.map(p => `${p.x},${p.y},${p.z}`)),
        pillar: [],
    };
    // dirt for scaffolding, in a non-hand slot so equips of build blocks don't evict it
    try { await bot.creative.setInventorySlot(44, mc.makeItem('dirt', 64)); } catch (e) { /* pillarUp will report */ }

    let placed = 0, skipped = 0;
    const failures = [];
    const started = Date.now();
    try {
        // walk to the site first so chunks stream in, then WAIT for them - a blockAt
        // against a not-yet-received column reads null
        await nav.navigateTo(bot, { x: origin.x + 16, y: origin.y, z: origin.z + 16 },
            { arriveDist: 12, arriveY: 8, maxReplans: 8 });
        const probe = await waitForBlock(bot, new Vec3(origin.x + 16, origin.y - 1, origin.z + 16), 20000);
        if (!probe) throw new Error('chunks at the build site never loaded');

        // clear natural terrain poking into the lower floors of the footprint
        if (meta.size) {
                        for (let y = 0; y < Math.min(6, meta.size.height); y++) {
                console.log(`[builder] clearing terrain layer ${y}`);
                for (let x = 0; x < meta.size.width; x++) {
                    // heartbeat per ROW, not per layer: a layer of digging can take
                    // minutes, and a stale heartbeat makes the watchdog re-send the
                    // command - which interrupts the very build it is guarding
                    writeStatus(agent, { phase: 'clear', layer: y, row: x, total: buildable.length });
                    for (let z = 0; z < meta.size.length; z++) {
                        if (ctx.occupied.has(`${x},${y},${z}`)) continue;
                        const P = new Vec3(origin.x + x, origin.y + y, origin.z + z);
                        const b = bot.blockAt(P);
                        if (b && NATURAL_TERRAIN.has(b.name)) {
                            if (!(await goNear(bot, P))) continue; // unreachable bump; skip
                            await new Promise(r => setTimeout(r, 120)); // stay under the packet limiter
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
                let res;
                try {
                    res = await placeOne(bot, new Vec3(top.x, y, top.z),
                        { name: 'cobblestone', properties: {} }, ctx);
                } catch (e) {
                    // one bad column must not abort the whole run - this exact leak
                    // silently killed runs for hours (pass loops caught, this one didn't)
                    console.log(`[builder] foundation threw at ${top.x},${y},${top.z}: ${e.message}`);
                    continue;
                }
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
                    res = await placeOne(bot, P, p, ctx);
                } catch (e) {
                    res = { ok: false, why: `threw: ${e.message}` };
                }
                if (res.ok) { res.skipped ? skipped++ : placed++; }
                else {
                    failures.push({ ...p, why: res.why });
                    if (failures.length <= 3) console.log(`[builder] FAIL ${p.name}@(${P.x},${P.y},${P.z}): ${res.why}`);
                }
                const done = placed + skipped + failures.length;
                // heartbeat EVERY block: a scaffolded placement can take a minute, and 25
                // of them outlasts the watchdog's staleness window - which then "rescues"
                // (interrupts) the live build. Same lesson as the per-dig heartbeat.
                writeStatus(agent, { phase: passName, done, total: buildable.length, placed, failed: failures.length });
                if (done % 200 === 0) {
                    const byWhy = new Map();
                    for (const f of failures) {
                        const k = (f.why || '?').slice(0, 45);
                        byWhy.set(k, (byWhy.get(k) || 0) + 1);
                    }
                    const top = [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
                        .map(([w, n]) => `${n}x"${w}"`).join(' ');
                    console.log(`[builder] ${done}/${buildable.length} (${placed} placed, ${skipped} pre-existing, ${failures.length} failed) [${passName}] ${top}`);
                }
            }
        }

        // retry failures once - supports placed later in pass1/pass2 may fix them.
        // But if MOST blocks failed the problem is systemic (bad chunks, wrong origin) and
        // retrying thousands of 20s fly-and-wait attempts would pin the agent for days.
        const retry = failures.length < buildable.length / 4 ? failures.splice(0, failures.length) : [];
        let retried = 0;
        for (const p of retry) {
            const P = new Vec3(origin.x + p.x, origin.y + p.y, origin.z + p.z);
            let res;
            try {
                res = await placeOne(bot, P, p, ctx);
            } catch (e) {
                res = { ok: false };
            }
            if (res.ok) placed++;
            else failures.push(p);
            if (++retried % 10 === 0) writeStatus(agent, { phase: 'retry', done: retried, total: retry.length });
        }
    } finally {
        try { bot.modes.unPauseAll(); } catch (e) { /* best effort */ }
        // NOTE: no stopFlying here - we never startFlying now, and calling stopFlying
        // without a prior startFlying sets bot.physics.gravity to null (creative.js
        // captures normalGravity lazily), which breaks walking physics entirely.
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
        // aggregate failure reasons so the report explains itself instead of needing a
        // log dive - the mass-failure runs each had ONE dominant cause worth naming
        const byWhy = new Map();
        for (const f of failures) {
            const key = (f.why || 'unknown').slice(0, 60);
            byWhy.set(key, (byWhy.get(key) || 0) + 1);
        }
        const top = [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([w, n]) => `${n}x "${w}"`).join('; ');
        out += ` Failure breakdown: ${top}.`;
        const sample = failures.slice(0, 3).map(f => `${f.name}@(${f.x},${f.y},${f.z})`).join('; ');
        out += ` E.g.: ${sample}`;
    }
    return out;
}
