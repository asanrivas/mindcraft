/**
 * Chart Management System for Mindcraft UI
 * Handles Chart.js instances and historical data tracking
 */

class ChartManager {
    constructor() {
        this.charts = new Map(); // chartId -> Chart instance
        this.threeDMaps = new Set(); // Set of Three.js map div IDs
        this.historicalData = new Map(); // agentName -> historical data
        this.maxDataPoints = 1000; // Increase history to 1000 points
        this.colors = {
            health: '#4CAF50',
            hunger: '#FF9800',
            primary: '#10b981', // Emerald Green
            secondary: '#9C27B0',
            success: '#4CAF50',
            warning: '#FF9800',
            danger: '#f44336',
            info: '#00BCD4',
            chart: [
                '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#f44336',
                '#00BCD4', '#FFEB3B', '#795548', '#607D8B', '#E91E63'
            ]
        };
    }

    /**
     * Initialize or update historical data for an agent
     * @param {string} agentName
     * @param {Object} state - Full agent state from server
     */
    updateAgentData(agentName, state) {
        if (!state || state.error) return;

        if (!this.historicalData.has(agentName)) {
            this.historicalData.set(agentName, {
                timestamps: [],
                health: [],
                hunger: [],
                position: [],
                inventory: [],
                actions: []
            });
        }

        const data = this.historicalData.get(agentName);
        const now = Date.now();

        // Add new data point
        data.timestamps.push(now);
        data.health.push(state.gameplay?.health ?? 0);
        data.hunger.push(state.gameplay?.hunger ?? 0);
        data.position.push(state.gameplay?.position || null);
        data.inventory.push(state.inventory?.stacksUsed ?? 0);
        data.actions.push(state.action?.current || 'Idle');

        // Trim to max data points
        if (data.timestamps.length > this.maxDataPoints) {
            data.timestamps.shift();
            data.health.shift();
            data.hunger.shift();
            data.position.shift();
            data.inventory.shift();
            data.actions.shift();
        }
    }

    /**
     * Get chart configuration defaults
     * @private
     */
    getChartDefaults() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#e0e0e0',
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    borderColor: '#3a3a3a',
                    borderWidth: 1
                }
            }
        };
    }

    /**
     * Create health/hunger trend chart
     * @param {string} canvasId
     * @param {string} agentName
     * @returns {Chart|null}
     */
    createVitalsChart(canvasId, agentName) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.error(`Canvas not found: ${canvasId}`);
            return null;
        }

        const data = this.historicalData.get(agentName);
        if (!data) {
            console.warn(`No data for agent: ${agentName}`);
            return null;
        }

        const ctx = canvas.getContext('2d');

        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.timestamps.map((t, i) => i), // Relative time
                datasets: [
                    {
                        label: 'Health',
                        data: data.health,
                        borderColor: this.colors.health,
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        tension: 0.4,
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4
                    },
                    {
                        label: 'Hunger',
                        data: data.hunger,
                        borderColor: this.colors.hunger,
                        backgroundColor: 'rgba(255, 152, 0, 0.1)',
                        tension: 0.4,
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4
                    }
                ]
            },
            options: {
                ...this.getChartDefaults(),
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 20,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#aaa',
                            font: { size: 10 }
                        }
                    },
                    x: {
                        display: false
                    }
                },
                plugins: {
                    ...this.getChartDefaults().plugins,
                    legend: {
                        ...this.getChartDefaults().plugins.legend,
                        position: 'top'
                    }
                }
            }
        });

        this.charts.set(canvasId, chart);
        return chart;
    }

    /**
     * Create inventory composition pie chart
     * @param {string} canvasId
     * @param {Object} inventoryCounts - { itemName: count }
     * @returns {Chart|null}
     */
    createInventoryChart(canvasId, inventoryCounts) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.error(`Canvas not found: ${canvasId}`);
            return null;
        }

        const ctx = canvas.getContext('2d');

        // Get top 10 items
        const items = Object.entries(inventoryCounts || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (items.length === 0) {
            // No items, show empty message
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#aaa';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('No items in inventory', canvas.width / 2, canvas.height / 2);
            return null;
        }

        const labels = items.map(([name]) => Utils.formatItemName(name));
        const data = items.map(([, count]) => count);

        const chart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: this.colors.chart,
                    borderColor: '#2d2d2d',
                    borderWidth: 2
                }]
            },
            options: {
                ...this.getChartDefaults(),
                plugins: {
                    ...this.getChartDefaults().plugins,
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#e0e0e0',
                            font: { size: 10 },
                            boxWidth: 12,
                            padding: 8
                        }
                    }
                }
            }
        });

        this.charts.set(canvasId, chart);
        return chart;
    }

    /**
     * Create 3D position movement map using Three.js
     * @param {string} divId - ID of the div element
     * @param {string} agentName
     * @returns {boolean} - Success status
     */
    createPositionMap(divId, agentName) {
        const container = document.getElementById(divId);
        if (!container) {
            console.error(`Container not found: ${divId}`);
            return false;
        }

        const data = this.historicalData.get(agentName);
        if (!data) {
            console.warn(`No data for agent: ${agentName}`);
            return false;
        }

        const positions = data.position.filter(p => p !== null);

        // Create ThreeDMap instance
        const map = new ThreeDMap(divId);
        window.threeMaps.set(divId, map);
        
        if (positions.length > 0) {
            map.update(positions);
        }

        this.threeDMaps.add(divId); // Keep the set for tracking
        return true;
    }

    /**
     * Update vitals chart with new data
     * @param {string} canvasId
     * @param {string} agentName
     */
    updateVitalsChart(canvasId, agentName) {
        const chart = this.charts.get(canvasId);
        if (!chart) return;

        const data = this.historicalData.get(agentName);
        if (!data) return;

        // Update chart data
        chart.data.labels = data.timestamps.map((t, i) => i);
        chart.data.datasets[0].data = data.health;
        chart.data.datasets[1].data = data.hunger;

        // Update without animation for performance
        chart.update('none');
    }

    /**
     * Update inventory chart with new data
     * @param {string} canvasId
     * @param {Object} inventoryCounts
     */
    updateInventoryChart(canvasId, inventoryCounts) {
        const chart = this.charts.get(canvasId);
        if (!chart) return;

        // Get top 10 items
        const items = Object.entries(inventoryCounts || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (items.length === 0) {
            this.destroyChart(canvasId);
            return;
        }

        const labels = items.map(([name]) => Utils.formatItemName(name));
        const data = items.map(([, count]) => count);

        // Update chart data
        chart.data.labels = labels;
        chart.data.datasets[0].data = data;

        chart.update('none');
    }

    /**
     * Update 3D position map with new data using Three.js
     * @param {string} divId
     * @param {string} agentName
     */
    updatePositionMap(divId, agentName) {
        const container = document.getElementById(divId);
        if (!container) return;

        let map = window.threeMaps.get(divId);
        
        // If map exists but for a different container (re-render happened), dispose it
        if (map && map.container !== container) {
            map.dispose();
            window.threeMaps.delete(divId);
            this.threeDMaps.delete(divId);
            map = null;
        }

        // If chart doesn't exist yet, create it
        if (!this.threeDMaps.has(divId)) {
            this.createPositionMap(divId, agentName);
            return;
        }

        const data = this.historicalData.get(agentName);
        if (!data) return;

        const positions = data.position.filter(p => p !== null);
        if (positions.length === 0) return;

        if (map) {
            map.update(positions);
        }
    }

    /**
     * Create all charts for an agent
     * @param {string} agentName
     * @param {Object} inventoryCounts
     */
    createAgentCharts(agentName, inventoryCounts = {}) {
        // Wait a bit for DOM to be ready
        setTimeout(() => {
            this.createVitalsChart(`vitals-chart-${agentName}`, agentName);
            this.createInventoryChart(`inventory-chart-${agentName}`, inventoryCounts);
            this.createPositionMap(`position-chart-${agentName}`, agentName);
        }, 100);
    }

    /**
     * Update all charts for an agent
     * @param {string} agentName
     * @param {Object} inventoryCounts
     */
    updateAgentCharts(agentName, inventoryCounts = {}) {
        this.updateVitalsChart(`vitals-chart-${agentName}`, agentName);
        this.updateInventoryChart(`inventory-chart-${agentName}`, inventoryCounts);
        this.updatePositionMap(`position-chart-${agentName}`, agentName);
    }

    /**
     * Destroy a chart instance (Chart.js or Three.js)
     * @param {string} chartId
     */
    destroyChart(chartId) {
        // Handle Chart.js charts
        const chart = this.charts.get(chartId);
        if (chart) {
            chart.destroy();
            this.charts.delete(chartId);
        }

        // Handle Three.js maps
        if (this.threeDMaps.has(chartId)) {
            const map = window.threeMaps.get(chartId);
            if (map) {
                map.dispose();
                window.threeMaps.delete(chartId);
            }
            this.threeDMaps.delete(chartId);
        }
    }

    /**
     * Destroy all charts for an agent
     * @param {string} agentName
     */
    destroyAgentCharts(agentName) {
        this.destroyChart(`vitals-chart-${agentName}`);
        this.destroyChart(`inventory-chart-${agentName}`);
        this.destroyChart(`position-chart-${agentName}`);
    }

    /**
     * Clear historical data for an agent
     * @param {string} agentName
     */
    clearAgentData(agentName) {
        this.historicalData.delete(agentName);
        this.destroyAgentCharts(agentName);
    }

    /**
     * Clear all data and charts
     */
    clearAll() {
        this.historicalData.clear();

        // Destroy Chart.js charts
        this.charts.forEach((chart, id) => {
            chart.destroy();
        });
        this.charts.clear();

        // Destroy Three.js maps
        this.threeDMaps.forEach(chartId => {
            const map = window.threeMaps.get(chartId);
            if (map) {
                map.dispose();
                window.threeMaps.delete(chartId);
            }
        });
        this.threeDMaps.clear();
    }

    /**
     * Get agent historical data
     * @param {string} agentName
     * @returns {Object|null}
     */
    getAgentData(agentName) {
        return this.historicalData.get(agentName) || null;
    }

    /**
     * Check if agent has charts created
     * @param {string} agentName
     * @returns {boolean}
     */
    hasAgentCharts(agentName) {
        return this.charts.has(`vitals-chart-${agentName}`);
    }

    /**
     * Get number of data points for an agent
     * @param {string} agentName
     * @returns {number}
     */
    getDataPointCount(agentName) {
        const data = this.historicalData.get(agentName);
        return data ? data.timestamps.length : 0;
    }
}
