/**
 * State Manager for Mindcraft UI
 * Coordinates state updates, historical data, and DOM updates
 */

class StateManager {
    constructor() {
        this.chartManager = new ChartManager();
        this.agentStates = new Map(); // agentName -> latest state
        this.activityTracker = new Map(); // agentName -> activity time tracking
        this.chartsInitialized = new Set(); // Track which agents have charts created
    }

    /**
     * Process state update from socket
     * @param {Object} states - { agentName: state }
     */
    processStateUpdate(states) {
        if (!states) return;

        Object.entries(states).forEach(([agentName, state]) => {
            if (state && !state.error) {
                // Update historical data for charts
                this.chartManager.updateAgentData(agentName, state);

                // Track activity
                this.trackActivity(agentName, state.action?.current);

                // Store latest state
                this.agentStates.set(agentName, state);

                // Update DOM elements
                this.updateAgentDOM(agentName, state);

                // Update charts if they exist
                if (this.chartsInitialized.has(agentName)) {
                    this.updateAgentCharts(agentName, state);
                }
            }
        });
    }

    /**
     * Update DOM elements for an agent
     * @param {string} agentName
     * @param {Object} state
     */
    updateAgentDOM(agentName, state) {
        const gp = state.gameplay || {};

        // Update health
        const healthEl = document.getElementById(`health-${agentName}`);
        if (healthEl && typeof gp.health === 'number') {
            const hMax = typeof gp.healthMax === 'number' ? gp.healthMax : 20;
            healthEl.textContent = `health: ${gp.health}/${hMax}`;
        }

        // Update position
        const posEl = document.getElementById(`pos-${agentName}`);
        if (posEl && gp.position) {
            posEl.textContent = `position: ${Utils.formatPosition(gp.position)}`;
        }

        // Update hunger
        const hunEl = document.getElementById(`hunger-${agentName}`);
        if (hunEl && typeof gp.hunger === 'number') {
            const fMax = typeof gp.hungerMax === 'number' ? gp.hungerMax : 20;
            hunEl.textContent = `hunger: ${gp.hunger}/${fMax}`;
        }

        // Update biome
        const bioEl = document.getElementById(`biome-${agentName}`);
        if (bioEl && gp.biome) {
            bioEl.textContent = `biome: ${gp.biome}`;
        }

        // Update gamemode
        const modeEl = document.getElementById(`mode-${agentName}`);
        if (modeEl && gp.gamemode) {
            modeEl.textContent = `gamemode: ${gp.gamemode}`;
        }

        // Update inventory slots
        const itemsEl = document.getElementById(`items-${agentName}`);
        if (itemsEl && state.inventory) {
            const used = state.inventory.stacksUsed ?? 0;
            const total = state.inventory.totalSlots ?? 0;
            itemsEl.textContent = `inventory slots: ${used}/${total}`;
        }

        // Update equipped item
        const equippedEl = document.getElementById(`equipped-${agentName}`);
        if (equippedEl && state.inventory?.equipment) {
            const e = state.inventory.equipment;
            equippedEl.textContent = `equipped: ${e.mainHand || 'none'}`;
        }

        // Update armor
        const armorEl = document.getElementById(`armor-${agentName}`);
        if (armorEl && state.inventory?.equipment) {
            const e = state.inventory.equipment;
            const armor = [];
            if (e.helmet) armor.push(`head: ${e.helmet}`);
            if (e.chestplate) armor.push(`chest: ${e.chestplate}`);
            if (e.leggings) armor.push(`legs: ${e.leggings}`);
            if (e.boots) armor.push(`feet: ${e.boots}`);
            armorEl.textContent = `armor: ${armor.length ? armor.join(', ') : 'none'}`;
        }

        // Update action
        const actionEl = document.getElementById(`action-${agentName}`);
        if (actionEl && state.action) {
            actionEl.textContent = `action: ${state.action.current || 'Idle'}`;
            const _statusColors = { acting: '#4CAF50', chatting: '#42a5f5', thinking: '#9e9e9e', stopped: '#f44336', idle: '#888' };
            actionEl.style.color = _statusColors[state.action.kind] || '';
        }

        // Update inventory grid
        const invGrid = document.getElementById(`inventory-${agentName}`);
        if (invGrid && state.inventory?.counts) {
            const counts = state.inventory.counts;
            const entries = Object.entries(counts);

            // Render items as a grid of at least 27 slots (3 rows)
            const minSlots = 27;
            const filledSlots = entries.length;
            const totalSlots = Math.max(minSlots, Math.ceil(filledSlots / 9) * 9);

            let html = entries.map(([name, count]) => {
                const displayName = Utils.formatItemName(name);
                const safeName = name.replace('minecraft:', '').toLowerCase();
                // Using 1.21.1 as it is a recent stable version for assets
                const imageUrl = `https://mc.nerothe.com/img/1.21.11/minecraft_${safeName}.png`;

                return `<div class="inventory-item" data-tooltip="${displayName}">
                    <img src="${imageUrl}" onerror="this.style.display='none'; this.parentNode.innerText='${displayName}'" alt="${displayName}">
                    ${count > 1 ? `<span class="count">${count}</span>` : ''}
                </div>`;
            }).join('');

            // Fill remaining slots with empty boxes
            const remaining = totalSlots - filledSlots;
            if (remaining > 0) {
                html += Array(remaining).fill('<div class="inventory-item"></div>').join('');
            }

            invGrid.innerHTML = html;
        }
    }

    /**
     * Update charts for an agent
     * @param {string} agentName
     * @param {Object} state
     */
    updateAgentCharts(agentName, state) {
        const inventoryCounts = state.inventory?.counts || {};
        this.chartManager.updateAgentCharts(agentName, inventoryCounts);
    }

    /**
     * Initialize charts for an agent
     * @param {string} agentName
     */
    initializeAgentCharts(agentName) {
        if (this.chartsInitialized.has(agentName)) return;

        const state = this.agentStates.get(agentName);
        const inventoryCounts = state?.inventory?.counts || {};

        this.chartManager.createAgentCharts(agentName, inventoryCounts);
        this.chartsInitialized.add(agentName);
    }

    /**
     * Track time spent in different activities
     * @param {string} agentName
     * @param {string} activity
     */
    trackActivity(agentName, activity) {
        if (!this.activityTracker.has(agentName)) {
            this.activityTracker.set(agentName, {
                idle: 0,
                mining: 0,
                crafting: 0,
                moving: 0,
                fighting: 0,
                building: 0,
                other: 0
            });
        }

        const tracker = this.activityTracker.get(agentName);

        // Categorize activity
        const category = this.categorizeActivity(activity);
        tracker[category] += 1; // Increment by 1 second (assuming 1Hz updates)
    }

    /**
     * Categorize an activity string
     * @param {string} activity
     * @returns {string}
     */
    categorizeActivity(activity) {
        if (!activity || activity === 'Idle') return 'idle';

        const lower = activity.toLowerCase();

        if (lower.includes('mine') || lower.includes('dig') || lower.includes('break')) {
            return 'mining';
        }
        if (lower.includes('craft')) {
            return 'crafting';
        }
        if (lower.includes('mov') || lower.includes('walk') || lower.includes('goto') || lower.includes('follow')) {
            return 'moving';
        }
        if (lower.includes('fight') || lower.includes('attack') || lower.includes('defend')) {
            return 'fighting';
        }
        if (lower.includes('plac') || lower.includes('build') || lower.includes('construct')) {
            return 'building';
        }

        return 'other';
    }

    /**
     * Get activity distribution for an agent
     * @param {string} agentName
     * @returns {Object}
     */
    getActivityData(agentName) {
        return this.activityTracker.get(agentName) || {};
    }

    /**
     * Get activity summary for an agent
     * @param {string} agentName
     * @returns {string}
     */
    getActivitySummary(agentName) {
        const data = this.getActivityData(agentName);
        const total = Object.values(data).reduce((sum, val) => sum + val, 0);

        if (total === 0) return 'No activity recorded';

        const percentages = Object.entries(data)
            .filter(([, value]) => value > 0)
            .map(([key, value]) => `${Utils.capitalize(key)}: ${Math.round((value / total) * 100)}%`)
            .join(', ');

        return percentages;
    }

    /**
     * Clear data for an agent
     * @param {string} agentName
     */
    clearAgent(agentName) {
        this.chartManager.clearAgentData(agentName);
        this.activityTracker.delete(agentName);
        this.agentStates.delete(agentName);
        this.chartsInitialized.delete(agentName);
    }

    /**
     * Clear all data
     */
    clearAll() {
        this.chartManager.clearAll();
        this.activityTracker.clear();
        this.agentStates.clear();
        this.chartsInitialized.clear();
    }

    /**
     * Get latest state for an agent
     * @param {string} agentName
     * @returns {Object|null}
     */
    getAgentState(agentName) {
        return this.agentStates.get(agentName) || null;
    }

    /**
     * Check if agent has data
     * @param {string} agentName
     * @returns {boolean}
     */
    hasAgentData(agentName) {
        return this.agentStates.has(agentName);
    }

    /**
     * Get all agent names with data
     * @returns {string[]}
     */
    getAgentNames() {
        return Array.from(this.agentStates.keys());
    }

    /**
     * Get statistics for all agents
     * @returns {Object}
     */
    getGlobalStatistics() {
        const agents = this.getAgentNames();
        const stats = {
            totalAgents: agents.length,
            totalDataPoints: 0,
            averageHealth: 0,
            averageHunger: 0,
            activityDistribution: {
                idle: 0,
                mining: 0,
                crafting: 0,
                moving: 0,
                fighting: 0,
                building: 0,
                other: 0
            }
        };

        if (agents.length === 0) return stats;

        let healthSum = 0;
        let hungerSum = 0;

        agents.forEach(name => {
            const state = this.getAgentState(name);
            if (state) {
                healthSum += state.gameplay?.health || 0;
                hungerSum += state.gameplay?.hunger || 0;
            }

            stats.totalDataPoints += this.chartManager.getDataPointCount(name);

            const activity = this.getActivityData(name);
            Object.keys(activity).forEach(key => {
                stats.activityDistribution[key] += activity[key];
            });
        });

        stats.averageHealth = healthSum / agents.length;
        stats.averageHunger = hungerSum / agents.length;

        return stats;
    }

    /**
     * Export agent data as JSON
     * @param {string} agentName
     * @returns {string}
     */
    exportAgentData(agentName) {
        const data = {
            state: this.getAgentState(agentName),
            historical: this.chartManager.getAgentData(agentName),
            activity: this.getActivityData(agentName),
            exported: new Date().toISOString()
        };

        return JSON.stringify(data, null, 2);
    }

    /**
     * Handle chart section expansion
     * @param {string} agentName
     * @param {boolean} expanded
     */
    onChartSectionToggle(agentName, expanded) {
        if (expanded && !this.chartsInitialized.has(agentName)) {
            // Charts section opened for the first time, initialize charts
            this.initializeAgentCharts(agentName);
        }
    }
}
