/**
 * Pure tech-tree state machine: wood -> stone -> iron -> diamond.
 *
 * Everything here is a function of an inventory COUNT MAP ({ itemName: count }) plus
 * explicitly injected dependencies - no bot, no network, no filesystem, no clock, and no
 * import of live minecraft-data. This is `progression.js` from
 * docs/gaps/resource-progression.exec.md, Task 5 only: the resolver + its tests. The
 * `progressTo` executor, the `!progressTo` command, and any bot-touching code are later tasks
 * and are deliberately NOT here.
 *
 * Consistency with tools.js's harvest guard (tools.js:16 `TIERS`, tools.js:60-67 `canBreak`):
 * `TIERS` there is a private, unexported const and this module may only create/edit this file,
 * so it cannot be imported directly. `TOOL_GATES` below reproduces just its ORDERING (four
 * pickaxe names, worst to best) as a small, readable, explicitly-commented table rather than
 * silently drifting from it - and `resolveProgression`'s `deps.toolGates` lets a live caller
 * (the Task 8 executor) inject `[...tools.TIERS].reverse()`-derived names at call time instead
 * of trusting this copy, which is the "inject rather than import" shape the design rules ask
 * for. `canBreak` additionally asks minecraft-data's per-block `canHarvest`, which is not a
 * pure, importable table at all (it needs a live block/registry instance) - reproducing that
 * would mean importing live mcdata, which the design rules forbid. So the tier *order* is kept
 * consistent by construction; the per-block harvest predicate stays live-only, same split the
 * exec plan draws between `pickDescentDirection`'s pure scoring core and its live wrapper.
 *
 * Requirements are DATA, in the tables below, not buried in code - correct a recipe by editing
 * a table entry, not by re-reading the resolver.
 */

// ---------------------------------------------------------------------------------------------
// Tables (defaults; every one of these can be extended/overridden per-call via `deps`, so a
// test - or a future caller - can inject a fixture without this module ever importing mcdata).
// ---------------------------------------------------------------------------------------------

/** Pickaxe tiers, worst first. Mirrors tools.js `TIERS` (reversed, pickaxe family only). */
export const TOOL_GATES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'];

const TIER_NAMES = ['wood', 'stone', 'iron', 'diamond'];

/**
 * Deep-mined ores, keyed by the EXACT drop item name (never the block/ore name - those are
 * different items, e.g. `iron_ore` the block vs `raw_iron` the drop this bot actually holds).
 * `targetY` is clamped to >= MAX_MINE_DEPTH on every emitted step: bedrock noise starts near
 * -60 and the 2026-08-29 incident (docs/CLAUDE.md "Movement") was the model oscillating in
 * exactly that band, so no plan produced here may aim a dig below it.
 */
export const MAX_MINE_DEPTH = -53;

export const ORES = {
    coal:     { blocks: ['coal_ore', 'deepslate_coal_ore'],       targetY: 44,  tool: 'wooden_pickaxe' },
    raw_iron: { blocks: ['iron_ore', 'deepslate_iron_ore'],       targetY: 16,  tool: 'stone_pickaxe'  },
    raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore'],       targetY: -12, tool: 'iron_pickaxe'   },
    diamond:  { blocks: ['diamond_ore', 'deepslate_diamond_ore'], targetY: MAX_MINE_DEPTH, tool: 'iron_pickaxe' },
};

/** Shallow/surface materials that still gate on a tool tier but are not "ores" (no smelting). */
const DEFAULT_MATERIAL_SOURCES = {
    cobblestone: { blocks: ['stone'], targetY: null, tool: 'wooden_pickaxe' },
};

/** Raw ore drop -> the ingot a furnace turns it into. Exact names both ways. */
const DEFAULT_SMELT_RECIPES = {
    iron_ingot: { input: 'raw_iron', fuel: 'coal', fuelPerItem: 1 },
    gold_ingot: { input: 'raw_gold', fuel: 'coal', fuelPerItem: 1 },
};

/** Plain crafting-table recipes for the non-tool intermediates this chain needs. */
const DEFAULT_CRAFT_RECIPES = {
    oak_planks:     { yields: 4, ingredients: { oak_log: 1 } },
    stick:          { yields: 4, ingredients: { oak_planks: 2 } },
    crafting_table: { yields: 1, ingredients: { oak_planks: 4 } },
};

/**
 * Pickaxe recipes. `gate` is the tool that must already be in hand to go mine `material` -
 * this is the tool-tier gating table: it is what stops `resolveProgression('diamond_pickaxe', ...)`
 * from ever proposing a diamond mine step before an iron_pickaxe exists to mine it with.
 */
const DEFAULT_PICKAXE_RECIPES = {
    wooden_pickaxe:  { material: 'oak_planks', materialCount: 3, sticks: 2, gate: null },
    stone_pickaxe:   { material: 'cobblestone', materialCount: 3, sticks: 2, gate: 'wooden_pickaxe' },
    iron_pickaxe:    { material: 'iron_ingot',  materialCount: 3, sticks: 2, gate: 'stone_pickaxe' },
    diamond_pickaxe: { material: 'diamond',     materialCount: 3, sticks: 2, gate: 'iron_pickaxe' },
};

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Exact-name lookup only. NEVER substring-match: `wooden_pickaxe`/`stone_pickaxe`/
 * `iron_pickaxe`/`diamond_pickaxe` all contain "pickaxe", and `iron_ingot`/`iron_ore`/
 * `raw_iron` are three different items - a `.includes()` here would be the exact
 * `"sandstone".includes("sand")` mistake CLAUDE.md documents (it made a mode fire every tick
 * in a desert). `inv[name]` is an exact object-key read; no partial or case-folded match.
 */
function countOf(inv, name) {
    if (!inv || typeof inv !== 'object') return 0;
    const n = inv[name];
    return typeof n === 'number' && n > 0 ? n : 0;
}

/** Highest tool tier actually present (best-of, not merely "any pickaxe"). -1 = none. */
function bestToolIndex(inv, toolGates) {
    for (let i = toolGates.length - 1; i >= 0; i--) {
        if (countOf(inv, toolGates[i]) > 0) return i;
    }
    return -1;
}

/**
 * 'bare' | 'wood' | 'stone' | 'iron' | 'diamond' from an inventory count map alone.
 * Best-of: a bot holding both a wooden_pickaxe and a diamond_pickaxe is at diamond tier.
 */
export function progressionTier(inv, toolGates = TOOL_GATES) {
    const idx = bestToolIndex(inv, toolGates);
    return idx === -1 ? 'bare' : TIER_NAMES[idx] ?? 'bare';
}

function mergeTables(deps) {
    return {
        toolGates: deps.toolGates || TOOL_GATES,
        pickaxeRecipes: { ...DEFAULT_PICKAXE_RECIPES, ...(deps.pickaxeRecipes || {}) },
        ores: { ...ORES, ...(deps.ores || {}) },
        materialSources: { ...DEFAULT_MATERIAL_SOURCES, ...(deps.materialSources || {}) },
        smeltRecipes: { ...DEFAULT_SMELT_RECIPES, ...(deps.smeltRecipes || {}) },
        craftRecipes: { ...DEFAULT_CRAFT_RECIPES, ...(deps.craftRecipes || {}) },
    };
}

function isKnown(item, tables) {
    return !!(tables.pickaxeRecipes[item] || tables.ores[item] || tables.materialSources[item] ||
        tables.smeltRecipes[item] || tables.craftRecipes[item]);
}

/** Dedup by (kind, item), keeping the largest count and first-seen order. */
function mergeSteps(steps) {
    const order = [];
    const byKey = new Map();
    for (const s of steps) {
        const key = `${s.kind}:${s.item}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.count = Math.max(existing.count, s.count);
        } else {
            byKey.set(key, { ...s });
            order.push(key);
        }
    }
    return order.map((k) => byKey.get(k));
}

function clampTargetY(y) {
    return typeof y === 'number' ? Math.max(y, MAX_MINE_DEPTH) : y;
}

/**
 * Recursive requirement walk. `path` is the set of items on the CURRENT call stack (cycle
 * guard for a maliciously- or mistakenly-injected `deps` table) - not a global "already
 * resolved" set, so the same intermediate (e.g. oak_planks, needed both directly by a pickaxe
 * recipe and again via sticks) is correctly considered from each branch that needs it.
 */
function resolve(item, needCount, inv, tables, steps, path) {
    if (countOf(inv, item) >= needCount) return;
    if (path.has(item)) return; // cyclic dependency in (possibly injected) tables; refuse to loop
    const nextPath = new Set(path);
    nextPath.add(item);

    if (tables.pickaxeRecipes[item]) {
        resolvePickaxe(item, needCount, inv, tables, steps, nextPath);
    } else if (tables.smeltRecipes[item]) {
        resolveSmelt(item, needCount, inv, tables, steps, nextPath);
    } else if (tables.ores[item]) {
        resolveOre(item, needCount, inv, tables, steps, nextPath);
    } else if (tables.materialSources[item]) {
        resolveMined(item, needCount, inv, tables, steps, nextPath);
    } else if (tables.craftRecipes[item]) {
        resolveCraft(item, needCount, inv, tables, steps, nextPath);
    } else {
        // Unknown leaf: a raw, hand-collectible item (e.g. oak_log). Not in any table because
        // nothing needs to be crafted, smelted or tool-gated to pick it up.
        steps.push({ kind: 'collect', item, count: needCount });
    }
}

function resolvePickaxe(item, needCount, inv, tables, steps, path) {
    const recipe = tables.pickaxeRecipes[item];
    if (recipe.gate && countOf(inv, recipe.gate) < 1) {
        resolve(recipe.gate, 1, inv, tables, steps, path);
    }
    resolve(recipe.material, recipe.materialCount * needCount, inv, tables, steps, path);
    resolve('stick', recipe.sticks * needCount, inv, tables, steps, path);
    if (countOf(inv, 'crafting_table') < 1) {
        resolve('crafting_table', 1, inv, tables, steps, path);
    }
    steps.push({ kind: 'craft', item, count: needCount });
}

function resolveSmelt(item, needCount, inv, tables, steps, path) {
    const recipe = tables.smeltRecipes[item];
    resolve(recipe.input, needCount, inv, tables, steps, path);
    steps.push({
        kind: 'smelt',
        item,
        count: needCount,
        input: recipe.input,
        fuel: { name: recipe.fuel, count: needCount * (recipe.fuelPerItem || 1) },
    });
}

/** Tool-tier gate shared by ores and gated surface materials (e.g. cobblestone). */
function gateOnTool(requiredTool, inv, tables, steps, path) {
    if (!requiredTool) return;
    const gateIdx = tables.toolGates.indexOf(requiredTool);
    if (gateIdx >= 0 && bestToolIndex(inv, tables.toolGates) < gateIdx) {
        resolve(requiredTool, 1, inv, tables, steps, path);
    }
}

function resolveOre(item, needCount, inv, tables, steps, path) {
    const ore = tables.ores[item];
    gateOnTool(ore.tool, inv, tables, steps, path);
    steps.push({
        kind: 'mine',
        item,
        count: needCount,
        blocks: ore.blocks,
        targetY: clampTargetY(ore.targetY),
        requiredTool: ore.tool,
    });
}

function resolveMined(item, needCount, inv, tables, steps, path) {
    const src = tables.materialSources[item];
    gateOnTool(src.tool, inv, tables, steps, path);
    steps.push({
        kind: 'mine',
        item,
        count: needCount,
        blocks: src.blocks,
        targetY: clampTargetY(src.targetY ?? null),
        requiredTool: src.tool,
    });
}

function resolveCraft(item, needCount, inv, tables, steps, path) {
    const recipe = tables.craftRecipes[item];
    const have = countOf(inv, item);
    const missing = needCount - have;
    const batches = Math.max(1, Math.ceil(missing / recipe.yields));
    for (const [ingredient, perBatch] of Object.entries(recipe.ingredients)) {
        resolve(ingredient, perBatch * batches, inv, tables, steps, path);
    }
    steps.push({ kind: 'craft', item, count: batches * recipe.yields });
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Resolve `targetItem` -> an ordered list of acquisition steps against an inventory count map.
 *
 * @param {string} targetItem   e.g. 'iron_pickaxe', 'diamond', 'iron_ingot'
 * @param {number} [count=1]
 * @param {Object<string,number>} [inv={}]  world.getInventoryCounts shape: { itemName: count }
 * @param {object} [deps={}] optional table overrides/extensions, all merged over the defaults
 *   above so a caller (or a test) can inject a fixture without this module importing mcdata:
 *   toolGates, pickaxeRecipes, ores, materialSources, smeltRecipes, craftRecipes.
 * @returns {{ steps: Array<object>, satisfied: boolean, error?: string }}
 *   Step shapes: { kind:'collect', item, count }
 *              | { kind:'craft', item, count }
 *              | { kind:'smelt', item, count, input, fuel:{name,count} }
 *              | { kind:'mine', item, count, blocks, targetY, requiredTool }
 */
export function resolveProgression(targetItem, count = 1, inv = {}, deps = {}) {
    if (typeof targetItem !== 'string' || targetItem.length === 0) {
        return { steps: [], satisfied: false, error: 'no target item given' };
    }
    const need = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
    const tables = mergeTables(deps || {});

    if (!isKnown(targetItem, tables)) {
        return { steps: [], satisfied: false, error: `unknown item: ${targetItem}` };
    }
    if (countOf(inv, targetItem) >= need) {
        return { steps: [], satisfied: true };
    }

    const steps = [];
    resolve(targetItem, need, inv, tables, steps, new Set());
    const merged = mergeSteps(steps);
    return { steps: merged, satisfied: merged.length === 0 };
}

/**
 * First step in an already-resolved plan that the inventory does not (yet) satisfy.
 * `null` means every step's item/count is already met - the plan is satisfied.
 *
 * Note: "satisfied" is judged by exact current counts, so a step whose item has since been
 * consumed as an ingredient for a LATER step (e.g. planks spent on sticks) can read
 * unsatisfied again after being done once - that is intentional: this function answers "what
 * does the inventory show right now", it does not simulate consumption. The Task 8 executor is
 * expected to re-resolve the whole plan each iteration rather than replay a stale one, exactly
 * as docs/gaps/resource-progression.exec.md section 4 specifies ("re-plan every iteration").
 */
export function firstUnsatisfied(steps, inv) {
    if (!Array.isArray(steps)) return null;
    for (const step of steps) {
        if (countOf(inv, step.item) < step.count) return step;
    }
    return null;
}
