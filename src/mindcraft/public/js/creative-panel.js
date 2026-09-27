/**
 * Creative inventory panel - a real item picker for the web UI.
 *
 * WHY IT NEEDS NO SERVER CHANGES
 * ------------------------------
 * MindServer already relays arbitrary text to an agent via `send-message`, and the agent already
 * parses `!command(args)` out of that text. So this panel is a *composer*: it turns clicks into
 * the same `!creativeGive` / `!creativeKit` / `!creativeClear` commands you would type, and lets
 * the existing command layer do the work. No new socket event, no new trust boundary.
 *
 * WHERE THE ITEM LIST COMES FROM
 * ------------------------------
 * The browser has no minecraft-data, and shipping the full 1505-item table to a phone over
 * Twingate for a picker is wasteful. So the list is CURATED (below) rather than exhaustive, and
 * a free-text box handles anything not on it - typing an unknown name gets a clean
 * `unknown item "..."` back from the bot rather than silence.
 *
 * The counts are capped at 2304 (36 slots x 64) because that is the most an inventory can hold;
 * asking for more is guaranteed partial and reads as a bug.
 */

const CATEGORIES = {
    'Building': [
        'cobblestone', 'stone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'glass',
        'sandstone', 'bricks', 'deepslate_bricks', 'quartz_block', 'white_concrete',
        'oak_log', 'oak_stairs', 'oak_slab', 'oak_fence', 'oak_door', 'ladder', 'scaffolding',
    ],
    'Tools & Combat': [
        'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_sword',
        'netherite_hoe', 'diamond_pickaxe', 'diamond_sword', 'bow', 'crossbow', 'arrow',
        'shield', 'trident', 'fishing_rod', 'flint_and_steel', 'shears',
    ],
    'Armour': [
        'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
        'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'elytra',
    ],
    'Utility': [
        'torch', 'chest', 'ender_chest', 'crafting_table', 'furnace', 'blast_furnace',
        'anvil', 'enchanting_table', 'white_bed', 'barrel', 'hopper', 'water_bucket',
        'lava_bucket', 'bucket', 'boat', 'oak_boat', 'minecart', 'rail', 'lantern',
    ],
    'Food': [
        'cooked_beef', 'cooked_porkchop', 'bread', 'golden_apple', 'enchanted_golden_apple',
        'cooked_salmon', 'carrot', 'potato', 'cake', 'honey_bottle',
    ],
    'Valuables': [
        'diamond', 'diamond_block', 'emerald', 'gold_ingot', 'iron_ingot', 'netherite_ingot',
        'ancient_debris', 'redstone', 'lapis_lazuli', 'coal', 'copper_ingot', 'amethyst_shard',
    ],
};

const KITS = ['building', 'mining', 'survival', 'all'];
const MAX_COUNT = 2304; // 36 slots x 64: the most an inventory can physically hold

/** Quote-safe: item names are [a-z0-9_] by construction, but never build a command from raw input. */
function sanitizeItemName(raw) {
    return String(raw || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[^a-z0-9_ ]/g, '').replace(/\s+/g, '_');
}

function clampCount(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_COUNT);
}

const CreativePanel = {
    /** Currently open agent name, or null. */
    _agent: null,

    open(agentName) {
        this._agent = agentName;
        this._ensureRoot();
        document.getElementById('creative-overlay').style.display = 'flex';
        document.getElementById('creative-title').textContent = `Creative inventory - ${agentName}`;
        const search = document.getElementById('creative-search');
        search.value = '';
        this._renderItems('');
        search.focus();
    },

    close() {
        const el = document.getElementById('creative-overlay');
        if (el) el.style.display = 'none';
        this._agent = null;
    },

    _send(command) {
        if (!this._agent || !window.sendMessage) return;
        window.sendMessage(this._agent, command);
        this._flash(command);
    },

    give(item, count) {
        const name = sanitizeItemName(item);
        if (!name) return;
        this._send(`!creativeGive("${name}", ${clampCount(count)})`);
    },

    _flash(text) {
        const el = document.getElementById('creative-status');
        if (!el) return;
        el.textContent = `sent: ${text}`;
        el.style.opacity = '1';
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => { el.style.opacity = '0.45'; }, 1800);
    },

    _renderItems(filter) {
        const wrap = document.getElementById('creative-items');
        if (!wrap) return;
        wrap.innerHTML = '';
        const q = String(filter || '').trim().toLowerCase().replace(/\s+/g, '_');

        let shown = 0;
        for (const [category, items] of Object.entries(CATEGORIES)) {
            const matches = q ? items.filter(i => i.includes(q)) : items;
            if (!matches.length) continue;
            shown += matches.length;

            const heading = document.createElement('div');
            heading.className = 'creative-category';
            heading.textContent = category;
            wrap.appendChild(heading);

            const grid = document.createElement('div');
            grid.className = 'creative-grid';
            for (const item of matches) {
                const btn = document.createElement('button');
                btn.className = 'creative-item';
                btn.textContent = item.replace(/_/g, ' ');
                btn.title = `Give ${item}`;
                btn.onclick = () => {
                    const count = document.getElementById('creative-count').value;
                    this.give(item, count);
                };
                grid.appendChild(btn);
            }
            wrap.appendChild(grid);
        }

        if (!shown) {
            const none = document.createElement('div');
            none.className = 'creative-empty';
            // The curated list is not the whole game - say so, and offer the escape hatch.
            none.textContent = q
                ? `Nothing in the quick list matches "${filter}". Use "Give by name" below - any valid item id works.`
                : 'No items.';
            wrap.appendChild(none);
        }
    },

    _ensureRoot() {
        if (document.getElementById('creative-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'creative-overlay';
        overlay.className = 'creative-overlay';
        // Click the backdrop to dismiss, but never when the click started inside the dialog.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });

        overlay.innerHTML = `
          <div class="creative-dialog" role="dialog" aria-modal="true" aria-labelledby="creative-title">
            <div class="creative-header">
              <h3 id="creative-title">Creative inventory</h3>
              <button class="creative-close" id="creative-close" aria-label="Close">&times;</button>
            </div>

            <div class="creative-toolbar">
              <input type="search" id="creative-search" placeholder="Search items..." autocomplete="off" />
              <label class="creative-count-label">
                Count
                <input type="number" id="creative-count" value="64" min="1" max="${MAX_COUNT}" />
              </label>
            </div>

            <div class="creative-kits" id="creative-kits"></div>
            <div class="creative-items" id="creative-items"></div>

            <div class="creative-footer">
              <input type="text" id="creative-custom" placeholder="Give by name, e.g. blaze_spawn_egg" autocomplete="off" />
              <button class="creative-btn accent" id="creative-custom-btn">Give</button>
              <button class="creative-btn danger" id="creative-clear-btn">Clear inventory</button>
            </div>
            <div class="creative-status" id="creative-status"></div>
          </div>`;

        document.body.appendChild(overlay);

        document.getElementById('creative-close').onclick = () => this.close();
        document.getElementById('creative-search').oninput = (e) => this._renderItems(e.target.value);

        const custom = document.getElementById('creative-custom');
        const submitCustom = () => {
            const v = custom.value;
            if (!sanitizeItemName(v)) return;
            this.give(v, document.getElementById('creative-count').value);
            custom.value = '';
        };
        document.getElementById('creative-custom-btn').onclick = submitCustom;
        custom.onkeydown = (e) => { if (e.key === 'Enter') submitCustom(); };

        document.getElementById('creative-clear-btn').onclick = () => {
            // Destructive and not undoable - the bot's whole bag goes. Ask first.
            if (window.confirm(`Empty ${this._agent}'s entire inventory?`)) this._send('!creativeClear');
        };

        const kits = document.getElementById('creative-kits');
        for (const kit of KITS) {
            const b = document.createElement('button');
            b.className = 'creative-btn kit';
            b.textContent = `${kit} kit`;
            b.onclick = () => this._send(`!creativeKit("${kit}")`);
            kits.appendChild(b);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._agent) this.close();
        });
    },
};

window.CreativePanel = CreativePanel;
window.openCreativePanel = (agentName) => CreativePanel.open(agentName);
