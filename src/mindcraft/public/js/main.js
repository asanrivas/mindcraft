/**
 * Main Application Logic for Mindcraft UI
 * Socket.io connection, agent management, and event handlers
 */

// Global state
const socket = io();
const agentsDiv = document.getElementById('agents');
let settingsSpec = {};
let profileData = null;
const agentSettings = {};
const agentLastMessage = {};
const agentMessageHistory = {}; // Store message history per agent
const inventoryOpen = {};
const messageHistoryOpen = {};
let currentAgents = [];

// Initialize State Manager
const stateManager = new StateManager();

// Status badge element
const statusEl = document.getElementById('msStatus');

/**
 * Update connection status badge
 */
function updateStatus(connected) {
    if (!statusEl) return;
    if (connected) {
        statusEl.textContent = 'MindServer online';
        statusEl.classList.remove('badge-offline', 'offline');
        statusEl.classList.add('badge-online', 'online');
    } else {
        statusEl.textContent = 'MindServer offline';
        statusEl.classList.remove('badge-online', 'online');
        statusEl.classList.add('badge-offline', 'offline');
    }
}

/**
 * Subscribe to agent state updates
 */
function subscribeToState() {
    socket.emit('listen-to-agents');
}

// Initial status
updateStatus(false);

// Socket.io event handlers
socket.on('connect', () => {
    updateStatus(true);
    subscribeToState();
    // Clear all cached settings on reconnect
    Object.keys(agentSettings).forEach(name => delete agentSettings[name]);
});

socket.on('disconnect', () => {
    updateStatus(false);
});

socket.on('connect_error', () => {
    updateStatus(false);
});

// Load settings spec
fetch('/settings_spec.json')
    .then(r => r.json())
    .then(spec => {
        settingsSpec = spec;
        buildSettingsForm();
    });

/**
 * Build settings form for agent creation
 */
function buildSettingsForm() {
    const form = document.getElementById('settingsForm');
    if (!form) return;

    form.innerHTML = '';
    form.className = 'settings-form';

    Object.keys(settingsSpec).forEach(key => {
        if (key === 'profile') return; // profile handled via upload

        const cfg = settingsSpec[key];
        const wrapper = Utils.createElement('div', { className: 'setting-wrapper' });

        const label = Utils.createElement('label', {
            title: cfg.description || ''
        }, key);

        let input;
        switch (cfg.type) {
            case 'boolean':
                input = Utils.createElement('input', {
                    type: 'checkbox',
                    checked: cfg.default === true,
                    id: `setting-${key}`,
                    title: cfg.description || ''
                });
                break;
            case 'number':
                input = Utils.createElement('input', {
                    type: 'number',
                    value: cfg.default,
                    id: `setting-${key}`,
                    title: cfg.description || ''
                });
                break;
            default:
                input = Utils.createElement('input', {
                    type: 'text',
                    value: typeof cfg.default === 'object' ? JSON.stringify(cfg.default) : cfg.default,
                    id: `setting-${key}`,
                    title: cfg.description || ''
                });
        }

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        form.appendChild(wrapper);
    });
}

// Profile upload handlers
document.getElementById('uploadProfileBtn')?.addEventListener('click', () => {
    document.getElementById('profileFileInput').click();
});

document.getElementById('profileFileInput')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = ev => {
        try {
            profileData = JSON.parse(ev.target.result);
            document.getElementById('submitCreateAgentBtn').disabled = false;
            document.getElementById('profileStatus').textContent = `Profile: ${profileData.name || 'Uploaded'}`;
            document.getElementById('createError').textContent = '';
        } catch (err) {
            document.getElementById('createError').textContent = 'Invalid profile JSON: ' + err.message;
            profileData = null;
            document.getElementById('submitCreateAgentBtn').disabled = true;
            document.getElementById('profileStatus').textContent = 'Profile: Not uploaded';
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// Create agent handler
document.getElementById('submitCreateAgentBtn')?.addEventListener('click', () => {
    if (!profileData) return;

    const settings = { profile: profileData };

    Object.keys(settingsSpec).forEach(key => {
        if (key === 'profile') return;

        const input = document.getElementById(`setting-${key}`);
        if (!input) return;

        const type = settingsSpec[key].type;
        let val;

        if (type === 'boolean') val = input.checked;
        else if (type === 'number') val = Number(input.value);
        else if (type === 'array' || type === 'object') {
            try {
                val = JSON.parse(input.value);
            } catch {
                val = input.value;
            }
        } else val = input.value;

        settings[key] = val;
    });

    socket.emit('create-agent', settings, res => {
        if (!res.success) {
            document.getElementById('createError').textContent = res.error || 'Unknown error';
        } else {
            // Reset on success
            profileData = null;
            document.getElementById('submitCreateAgentBtn').disabled = true;
            document.getElementById('profileStatus').textContent = 'Profile: Not uploaded';
            document.getElementById('createError').textContent = '';
            hideCreateAgentModal();
            Utils.showToast('Agent created successfully', 'success');
        }
    });
});

// Modal handlers
const modalBackdrop = document.getElementById('createAgentModal');
document.getElementById('openCreateAgentBtn')?.addEventListener('click', () => {
    buildSettingsForm();
    modalBackdrop.style.display = 'flex';
});

function hideCreateAgentModal() {
    modalBackdrop.style.display = 'none';
}

document.getElementById('closeCreateAgentBtn')?.addEventListener('click', hideCreateAgentModal);

// Bot output handler
socket.on('bot-output', (agentName, message) => {
    agentLastMessage[agentName] = message;

    // Store in message history (keep last 100 messages)
    if (!agentMessageHistory[agentName]) {
        agentMessageHistory[agentName] = [];
    }
    agentMessageHistory[agentName].push({
        timestamp: Date.now(),
        message: message
    });
    if (agentMessageHistory[agentName].length > 100) {
        agentMessageHistory[agentName].shift();
    }

    // Update last message display
    const messageDiv = document.getElementById(`lastMessage-${agentName}`);
    if (messageDiv) {
        messageDiv.innerHTML = `<strong>Last Message:</strong> ${Utils.truncate(message, 100)}`;
    }

    // Update message history panel if open
    updateMessageHistoryPanel(agentName);
});

// State update handler
socket.on('state-update', (states) => {
    window.lastStates = states;
    stateManager.processStateUpdate(states);
});

/**
 * Fetch agent settings
 */
function fetchAgentSettings(name) {
    return new Promise((resolve) => {
        if (agentSettings[name]) {
            resolve(agentSettings[name]);
            return;
        }

        socket.emit('get-settings', name, res => {
            if (res.settings) {
                agentSettings[name] = res.settings;
                resolve(res.settings);
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Update agent viewer iframe
 */
function updateAgentViewer(name) {
    const agentEl = document.getElementById(`agent-${name}`);
    if (!agentEl) return;

    const settings = agentSettings[name];
    const viewerContainer = agentEl.querySelector('.viewer-container');
    if (!viewerContainer) return;

    const agentState = currentAgents.find(a => a.name === name);
    const shouldShow = agentState?.in_game && settings?.render_bot_view === true;

    if (viewerContainer.parentElement) {
        viewerContainer.parentElement.style.display = shouldShow ? '' : 'none';
    }
}

/**
 * Update agent control states (input/buttons enabled/disabled)
 */
function updateAgentControls(name, inGame, socketConnected) {
    const input = document.getElementById(`messageInput-${name}`);
    const stopBtn = document.getElementById(`stopBtn-${name}`);
    const stayBtn = document.getElementById(`stayBtn-${name}`);
    const restartBtn = document.getElementById(`restartBtn-${name}`);
    const connectBtn = document.getElementById(`connectBtn-${name}`);

    if (input) {
        input.disabled = !inGame;
        if (!inGame) {
            // Also disable send button when agent goes offline
            const sendBtn = document.getElementById(`sendBtn-${name}`);
            if (sendBtn) sendBtn.disabled = true;
        }
    }

    // Update action buttons
    [stopBtn, stayBtn, restartBtn].forEach(btn => {
        if (btn) btn.disabled = !inGame;
    });

    // Update connect button
    if (connectBtn) {
        // Connect button should be:
        // - Enabled when offline (!socketConnected && !inGame) - user can click to connect
        // - Disabled when connecting (socketConnected && !inGame) - wait for connection
        // - Enabled when connected (inGame) - user can click to disconnect
        connectBtn.disabled = socketConnected && !inGame;

        if (inGame) {
            connectBtn.textContent = 'Disconnect';
        } else if (socketConnected) {
            connectBtn.textContent = 'Connecting...';
        } else {
            connectBtn.textContent = 'Connect';
        }
    }
}

// Agent Settings Modal
const agentSettingsModal = document.getElementById('agentSettingsModal');
const agentSettingsForm = document.getElementById('agentSettingsForm');
const applyBtn = document.getElementById('applyAgentSettingsBtn');
const discardBtn = document.getElementById('discardAgentSettingsBtn');
const closeAgentSettingsBtn = document.getElementById('closeAgentSettingsBtn');
const agentSettingsTitle = document.getElementById('agentSettingsTitle');
let currentAgentName = null;
let originalAgentSettings = null;

/**
 * Build agent settings form
 */
function buildAgentSettingsForm(settings) {
    agentSettingsForm.innerHTML = '';
    agentSettingsForm.className = 'settings-form';

    Object.keys(settingsSpec).forEach(key => {
        if (key === 'profile') return;

        const cfg = settingsSpec[key];
        const wrapper = Utils.createElement('div', { className: 'setting-wrapper' });

        const label = Utils.createElement('label', {
            title: cfg.description || ''
        }, key);

        let input;
        switch (cfg.type) {
            case 'boolean':
                input = Utils.createElement('input', {
                    type: 'checkbox',
                    checked: Boolean(settings[key]),
                    id: `agent-setting-${key}`
                });
                input.addEventListener('change', onAgentSettingsChanged);
                break;
            case 'number':
                input = Utils.createElement('input', {
                    type: 'number',
                    value: settings[key] ?? cfg.default ?? 0,
                    id: `agent-setting-${key}`
                });
                input.addEventListener('input', onAgentSettingsChanged);
                break;
            default:
                const defVal = settings[key] ?? cfg.default ?? '';
                input = Utils.createElement('input', {
                    type: 'text',
                    value: typeof defVal === 'object' ? JSON.stringify(defVal) : defVal,
                    id: `agent-setting-${key}`
                });
                input.addEventListener('input', onAgentSettingsChanged);
        }

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        agentSettingsForm.appendChild(wrapper);
    });

    onAgentSettingsChanged();
}

/**
 * Open agent settings modal
 */
function openAgentSettings(name) {
    currentAgentName = name;
    agentSettingsTitle.textContent = `${name} Settings`;

    fetchAgentSettings(name).then(settings => {
        originalAgentSettings = Utils.deepClone(settings || {});
        buildAgentSettingsForm(settings || {});
        agentSettingsModal.style.display = 'flex';
    });
}

window.openAgentSettings = openAgentSettings;

/**
 * Get edited agent settings
 */
function getEditedAgentSettings() {
    const newSettings = {
        profile: (originalAgentSettings && originalAgentSettings.profile) || {}
    };

    Object.keys(settingsSpec).forEach(key => {
        if (key === 'profile') return;

        const cfg = settingsSpec[key];
        const input = document.getElementById(`agent-setting-${key}`);
        if (!input) return;

        let val;
        if (cfg.type === 'boolean') val = input.checked;
        else if (cfg.type === 'number') val = Number(input.value);
        else if (cfg.type === 'array' || cfg.type === 'object') {
            try {
                val = JSON.parse(input.value);
            } catch {
                val = input.value;
            }
        } else val = input.value;

        newSettings[key] = val;
    });

    return newSettings;
}

/**
 * Check if settings changed
 */
function onAgentSettingsChanged() {
    if (!originalAgentSettings) {
        applyBtn.disabled = true;
        return;
    }

    const edited = getEditedAgentSettings();
    applyBtn.disabled = Utils.shallowEqual(edited, originalAgentSettings);
}

/**
 * Close agent settings modal
 */
function closeAgentSettings() {
    agentSettingsModal.style.display = 'none';
    currentAgentName = null;
    originalAgentSettings = null;
}

discardBtn?.addEventListener('click', () => {
    if (!currentAgentName || !originalAgentSettings) return;
    buildAgentSettingsForm(originalAgentSettings);
});

applyBtn?.addEventListener('click', () => {
    if (!currentAgentName) return;

    const edited = getEditedAgentSettings();
    socket.emit('set-agent-settings', currentAgentName, edited);

    // Update local settings immediately
    agentSettings[currentAgentName] = { ...edited, fetched: true };
    updateAgentViewer(currentAgentName);
    closeAgentSettings();

    Utils.showToast('Settings applied, agent restarting', 'success');
});

closeAgentSettingsBtn?.addEventListener('click', closeAgentSettings);

/**
 * Render agent cards
 */
async function renderAgents(agents) {
    if (!agents.length) {
        agentsDiv.innerHTML = '<div class="agent-card">No agents connected</div>';
        return;
    }

    // Fetch settings for all agents
    const needSettings = agents.filter(a => !agentSettings[a.name]);
    if (needSettings.length > 0) {
        await Promise.all(needSettings.map(async (a) => {
            const settings = await fetchAgentSettings(a.name);
            if (settings) {
                agentSettings[a.name] = settings;
            }
        }));
    }

    // If agentsDiv is empty, do a full render
    if (!agentsDiv.children.length) {
        agentsDiv.innerHTML = '';
        agentsDiv.className = 'agents-grid';

        agents.forEach(agent => {
            const card = renderAgentCard(agent);
            agentsDiv.appendChild(card);

            // Initialize charts when collapsible is opened
            const chartTrigger = card.querySelector('.collapsible-trigger');
            if (chartTrigger) {
                chartTrigger.addEventListener('click', () => {
                    const expanded = chartTrigger.getAttribute('aria-expanded') === 'true';
                    stateManager.onChartSectionToggle(agent.name, expanded);
                });
            }
        });

        return;
    }

    // Update existing cards or add new ones
    const prevAgents = currentAgents.reduce((acc, a) => ({ ...acc, [a.name]: a }), {});

    agents.forEach(agent => {
        const prev = prevAgents[agent.name];
        const changed = !prev ||
                       prev.in_game !== agent.in_game ||
                       prev.viewerPort !== agent.viewerPort ||
                       prev.socket_connected !== agent.socket_connected;

        const el = document.getElementById(`agent-${agent.name}`);
        if (el && changed) {
            // Update existing card
            const newCard = renderAgentCard(agent);
            el.replaceWith(newCard);

            // Re-attach chart trigger
            const chartTrigger = newCard.querySelector('.collapsible-trigger');
            if (chartTrigger) {
                chartTrigger.addEventListener('click', () => {
                    const expanded = chartTrigger.getAttribute('aria-expanded') === 'true';
                    stateManager.onChartSectionToggle(agent.name, expanded);
                });
            }
        } else if (!el) {
            // Add new card
            const newCard = renderAgentCard(agent);
            agentsDiv.appendChild(newCard);

            // Attach chart trigger
            const chartTrigger = newCard.querySelector('.collapsible-trigger');
            if (chartTrigger) {
                chartTrigger.addEventListener('click', () => {
                    const expanded = chartTrigger.getAttribute('aria-expanded') === 'true';
                    stateManager.onChartSectionToggle(agent.name, expanded);
                });
            }
        }
    });

    // Remove cards for agents that no longer exist
    Array.from(agentsDiv.children).forEach(el => {
        const name = el.id.replace('agent-', '');
        if (!agents.find(a => a.name === name)) {
            el.remove();
            delete inventoryOpen[name];
            stateManager.clearAgent(name);
        }
    });
}

/**
 * Render a single agent card
 */
function renderAgentCard(agent) {
    const cfg = agentSettings[agent.name] || {};
    const lastMessage = agentLastMessage[agent.name] || '(no messages yet)';

    return Components.AgentCard({
        agent,
        settings: cfg,
        lastMessage,
        inventoryOpen: inventoryOpen[agent.name] || false
    });
}

// Agents status handler
socket.on('agents-status', async (agents) => {
    currentAgents = agents;
    await renderAgents(agents);

    // Update control states for all agents
    agents.forEach(agent => {
        updateAgentControls(agent.name, agent.in_game, agent.socket_connected);
    });
});

// Agent control functions
function restartAgent(n) {
    socket.emit('restart-agent', n);
}

function disconnectAgent(n) {
    socket.emit('stop-agent', n);
}

function startAgent(n) {
    socket.emit('start-agent', n);

    const btn = document.getElementById(`connectBtn-${n}`);
    if (btn) {
        btn.textContent = 'Connecting...';
        btn.disabled = true;

        // Timeout fallback if connection doesn't complete
        setTimeout(() => {
            const agentState = currentAgents.find(a => a.name === n);
            if (agentState && !agentState.in_game && !agentState.socket_connected) {
                const retryBtn = document.getElementById(`connectBtn-${n}`);
                if (retryBtn) {
                    retryBtn.disabled = false;
                    retryBtn.textContent = 'Connect';
                }
            }
        }, 10000);
    }
}

function destroyAgent(n) {
    if (confirm(`Are you sure you want to remove agent "${n}"?`)) {
        socket.emit('destroy-agent', n);
        stateManager.clearAgent(n);
    }
}

function disconnectAllAgents() {
    socket.emit('stop-all-agents');
}

function confirmShutdown() {
    if (confirm('Are you sure you want to perform a full shutdown?\nThis will stop all agents and close the server.')) {
        socket.emit('shutdown');
    }
}

function sendMessage(n, m) {
    if (!m || !m.trim()) return;

    socket.emit('send-message', n, { from: 'ADMIN', message: m });

    const input = document.getElementById(`messageInput-${n}`);
    const btn = document.getElementById(`sendBtn-${n}`);
    if (input) input.value = '';
    if (btn) btn.disabled = true;
}

function onMsgInputChange(name) {
    const input = document.getElementById(`messageInput-${name}`);
    const btn = document.getElementById(`sendBtn-${name}`);
    if (btn && input) {
        btn.disabled = !(input.value && input.value.trim().length > 0);
    }
}

function toggleDetails(name) {
    const invSection = document.getElementById(`inventorySection-${name}`);
    if (!invSection) return;

    const content = invSection.querySelector('.collapsible-content');
    const trigger = invSection.querySelector('.collapsible-trigger');
    if (!content || !trigger) return;

    const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', (!isExpanded).toString());
    Utils.toggleCollapsible(content, !isExpanded);
    inventoryOpen[name] = !isExpanded;
}

function toggleMessageHistory(name) {
    const historySection = document.getElementById(`messageHistorySection-${name}`);
    if (!historySection) return;

    const visible = historySection.style.display !== 'none';
    const newVisible = !visible;
    historySection.style.display = newVisible ? 'block' : 'none';
    messageHistoryOpen[name] = newVisible;

    if (newVisible) {
        // Populate history when opened
        updateMessageHistoryPanel(name);
        // Scroll to bottom
        setTimeout(() => {
            const container = document.getElementById(`messageHistoryContainer-${name}`);
            if (container) container.scrollTop = container.scrollHeight;
        }, 100);
    }
}

function updateMessageHistoryPanel(agentName) {
    const container = document.getElementById(`messageHistoryContainer-${agentName}`);
    if (!container) return;

    const history = agentMessageHistory[agentName] || [];

    if (history.length === 0) {
        container.innerHTML = '<div class="message-history-empty">No messages yet</div>';
        return;
    }

    const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

    container.innerHTML = history.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString();
        return `
            <div class="message-history-item">
                <span class="message-time">${time}</span>
                <span class="message-content">${Utils.escapeHtml(item.message)}</span>
            </div>
        `;
    }).join('');

    // Auto-scroll to bottom if was already at bottom
    if (wasAtBottom) {
        setTimeout(() => container.scrollTop = container.scrollHeight, 0);
    }
}

// Expose functions to window
window.restartAgent = restartAgent;
window.disconnectAgent = disconnectAgent;
window.startAgent = startAgent;
window.destroyAgent = destroyAgent;
window.disconnectAllAgents = disconnectAllAgents;
window.confirmShutdown = confirmShutdown;
window.sendMessage = sendMessage;
window.onMsgInputChange = onMsgInputChange;
window.toggleDetails = toggleDetails;
window.toggleMessageHistory = toggleMessageHistory;

// Debug: Expose stateManager to window for debugging
window.stateManager = stateManager;
