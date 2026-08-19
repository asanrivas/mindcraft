/**
 * Shadcn-inspired Component Factory for Mindcraft UI
 * Reusable UI component builders
 */

const Components = {
    /**
     * Create a Card component
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Card({ title, children, className = '', id = '' }) {
        const card = Utils.createElement('div', {
            className: `agent-card ${className}`,
            id
        });

        if (title) {
            const header = this.CardHeader({ children: title });
            card.appendChild(header);
        }

        if (children) {
            if (Array.isArray(children)) {
                children.forEach(child => {
                    if (child instanceof HTMLElement) {
                        card.appendChild(child);
                    }
                });
            } else if (typeof children === 'string') {
                const body = this.CardBody({ children });
                card.appendChild(body);
            } else if (children instanceof HTMLElement) {
                card.appendChild(children);
            }
        }

        return card;
    },

    /**
     * Create a Card Header
     * @param {Object} options
     * @returns {HTMLElement}
     */
    CardHeader({ children, className = '' }) {
        return Utils.createElement('div', {
            className: `agent-card-header ${className}`
        }, children);
    },

    /**
     * Create a Card Body
     * @param {Object} options
     * @returns {HTMLElement}
     */
    CardBody({ children, className = '' }) {
        return Utils.createElement('div', {
            className: `agent-card-body ${className}`
        }, children);
    },

    /**
     * Create a Card Footer
     * @param {Object} options
     * @returns {HTMLElement}
     */
    CardFooter({ children, className = '' }) {
        return Utils.createElement('div', {
            className: `agent-card-footer ${className}`
        }, children);
    },

    /**
     * Create a Button component
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Button({ text, variant = 'primary', size = 'md', onClick, disabled = false, icon = null, className = '', id = '' }) {
        const classes = ['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ');

        const button = Utils.createElement('button', {
            className: classes,
            disabled,
            onClick,
            id
        });

        if (icon) {
            const iconEl = Utils.createElement('span', { className: 'btn-icon' }, icon);
            button.appendChild(iconEl);
        }

        if (text) {
            const textEl = Utils.createElement('span', {}, text);
            button.appendChild(textEl);
        }

        return button;
    },

    /**
     * Create a Badge component
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Badge({ text, variant = 'default', className = '' }) {
        return Utils.createElement('span', {
            className: `badge badge-${variant} ${className}`
        }, text);
    },

    /**
     * Create a Status Indicator
     * @param {Object} options
     * @returns {HTMLElement}
     */
    StatusIndicator({ online = false, joining = false, className = '' }) {
        const status = joining ? 'joining' : (online ? 'online' : 'offline');
        return Utils.createElement('span', {
            className: `status-indicator ${status} ${className}`,
            'aria-label': status
        }, '●');
    },

    /**
     * Create a Progress Bar
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Progress({ value, max, showLabel = true, className = '' }) {
        const percentage = (value / max) * 100;
        const statusClass = percentage > 66 ? 'health-high' :
                          percentage > 33 ? 'health-medium' :
                          'health-low';

        const container = Utils.createElement('div', {
            className: `progress ${className}`
        });

        const fill = Utils.createElement('div', {
            className: `progress-fill ${statusClass}`,
            style: { width: `${percentage}%` }
        });

        container.appendChild(fill);

        if (showLabel) {
            const label = Utils.createElement('div', {
                className: 'progress-label'
            }, `${value}/${max}`);
            container.appendChild(label);
        }

        return container;
    },

    /**
     * Create an Input component
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Input({ type = 'text', value = '', placeholder = '', disabled = false, onInput, onKeyDown, className = '', id = '' }) {
        return Utils.createElement('input', {
            type,
            value,
            placeholder,
            disabled,
            className: `input ${className}`,
            onInput,
            onKeyDown,
            id
        });
    },

    /**
     * Create a Collapsible Section
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Collapsible({ title, children, defaultExpanded = false, id = '', className = '', onToggle = null }) {
        const container = Utils.createElement('div', {
            className: `collapsible ${className}`
        });

        const trigger = Utils.createElement('button', {
            className: 'collapsible-trigger',
            'aria-expanded': defaultExpanded.toString(),
            onClick: () => {
                const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
                trigger.setAttribute('aria-expanded', (!isExpanded).toString());
                Utils.toggleCollapsible(content, !isExpanded);
                if (onToggle) onToggle(!isExpanded);
            }
        });

        const titleSpan = Utils.createElement('span', {}, title);
        const icon = Utils.createElement('span', {
            className: 'collapsible-icon'
        }, '▼');

        trigger.appendChild(titleSpan);
        trigger.appendChild(icon);

        const content = Utils.createElement('div', {
            className: `collapsible-content ${defaultExpanded ? 'expanded' : ''}`,
            id
        });

        if (Array.isArray(children)) {
            children.forEach(child => {
                if (child instanceof HTMLElement) {
                    content.appendChild(child);
                }
            });
        } else if (children instanceof HTMLElement) {
            content.appendChild(children);
        }

        container.appendChild(trigger);
        container.appendChild(content);

        return container;
    },

    /**
     * Create a Stats Item
     * @param {Object} options
     * @returns {HTMLElement}
     */
    StatItem({ label, value, className = '' }) {
        const container = Utils.createElement('div', {
            className: `stat-item ${className}`
        });

        const labelEl = Utils.createElement('div', {
            className: 'stat-label'
        }, label);

        const valueEl = Utils.createElement('div', {
            className: 'stat-value'
        }, value);

        container.appendChild(labelEl);
        container.appendChild(valueEl);

        return container;
    },

    /**
     * Create a Modal
     * @param {Object} options
     * @returns {Object} - { backdrop, modal, open, close }
     */
    Modal({ title, body, footer, onClose, id = '' }) {
        const backdrop = Utils.createElement('div', {
            className: 'modal-backdrop',
            id,
            onClick: (e) => {
                if (e.target === backdrop) {
                    this.close();
                }
            }
        });

        const modal = Utils.createElement('div', {
            className: 'modal',
            onClick: (e) => e.stopPropagation()
        });

        // Header
        const header = Utils.createElement('div', {
            className: 'modal-header'
        });

        const titleEl = Utils.createElement('h2', {
            className: 'modal-title'
        }, title);

        const closeBtn = this.Button({
            text: 'Close',
            variant: 'destructive',
            size: 'sm',
            onClick: () => {
                if (onClose) onClose();
                backdrop.style.display = 'none';
            }
        });

        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        // Body
        const bodyEl = Utils.createElement('div', {
            className: 'modal-body'
        });

        if (body instanceof HTMLElement) {
            bodyEl.appendChild(body);
        } else if (typeof body === 'string') {
            bodyEl.innerHTML = body;
        }

        // Footer
        const footerEl = Utils.createElement('div', {
            className: 'modal-footer'
        });

        if (footer) {
            if (footer instanceof HTMLElement) {
                footerEl.appendChild(footer);
            } else if (typeof footer === 'string') {
                footerEl.innerHTML = footer;
            }
        }

        modal.appendChild(header);
        modal.appendChild(bodyEl);
        modal.appendChild(footerEl);
        backdrop.appendChild(modal);

        return {
            backdrop,
            modal,
            open: () => {
                backdrop.classList.add('open');
                backdrop.style.display = 'flex';
            },
            close: () => {
                backdrop.classList.remove('open');
                backdrop.style.display = 'none';
                if (onClose) onClose();
            }
        };
    },

    /**
     * Create a Chart Container
     * @param {Object} options
     * @returns {HTMLElement}
     */
    ChartContainer({ title, canvasId, height = '200px', className = '', useDiv = false }) {
        const container = Utils.createElement('div', {
            className: `chart-container ${className}`
        });

        if (title) {
            const titleEl = Utils.createElement('h4', {
                className: 'chart-title'
            }, title);
            container.appendChild(titleEl);
        }

        const wrapper = Utils.createElement('div', {
            style: { height, position: 'relative' }
        });

        if (useDiv) {
            // For Plotly charts - use a div
            const chartDiv = Utils.createElement('div', {
                id: canvasId,
                className: 'chart-div',
                style: { width: '100%', height: '100%' }
            });
            wrapper.appendChild(chartDiv);
        } else {
            // For Chart.js - use a canvas
            const canvas = Utils.createElement('canvas', {
                id: canvasId,
                className: 'chart-canvas'
            });
            wrapper.appendChild(canvas);
        }

        container.appendChild(wrapper);

        return container;
    },

    /**
     * Create a Loading Skeleton
     * @param {Object} options
     * @returns {HTMLElement}
     */
    Skeleton({ width = '100%', height = '20px', className = '' }) {
        return Utils.createElement('div', {
            className: `chart-skeleton ${className}`,
            style: { width, height }
        });
    },

    /**
     * Create an Agent Card (complex component)
     * This is the main agent card with all sections
     * @param {Object} options
     * @returns {HTMLElement}
     */
    AgentCard({ agent, settings = {}, lastMessage = '', inventoryOpen = false }) {
        const card = Utils.createElement('div', {
            className: 'agent-card',
            id: `agent-${agent.name}`
        });

        // Header
        const header = this.CardHeader({
            children: this.createAgentHeader(agent, settings)
        });

        card.appendChild(header);

        // Viewer (if enabled)
        if (agent.in_game && settings.render_bot_view) {
            const viewerSection = this.createViewerSection(agent);
            card.appendChild(viewerSection);
        }

        // Stats Grid
        const statsSection = this.createStatsSection(agent);
        card.appendChild(statsSection);

        // Charts Section (collapsible)
        const chartsSection = this.createChartsSection(agent);
        card.appendChild(chartsSection);

        // Inventory Section (collapsible)
        const inventorySection = this.createInventorySection(agent, inventoryOpen);
        card.appendChild(inventorySection);

        // Chat Section (History + Input)
        const chatSection = this.createChatSection(agent);
        card.appendChild(chatSection);

        // Controls (Buttons only)
        const controls = this.createControlsSection(agent);
        card.appendChild(controls);

        // Trigger history load after append (microtask) to ensure it's in DOM if needed, 
        // though strictly speaking we can just call the window function if it doesn't depend on DOM visibility.
        // But the previous implementation had it on expand. Now it is always visible.
        setTimeout(() => {
             if (window.toggleMessageHistory) window.toggleMessageHistory(agent.name);
        }, 0);

        return card;
    },

    /**
     * Create agent header section
     * @private
     */
    createAgentHeader(agent, settings) {
        const container = Utils.createElement('div', {
            className: 'agent-card-title'
        });

        const statusIndicator = this.StatusIndicator({
            online: agent.in_game,
            joining: agent.socket_connected && !agent.in_game
        });

        const name = Utils.createElement('span', {}, agent.name);

        const joiningText = agent.socket_connected && !agent.in_game ?
            Utils.createElement('span', { style: { marginLeft: '6px', color: '#f0ad4e', fontSize: '0.85em' } }, 'joining...') :
            null;

        const actions = Utils.createElement('div', {
            className: 'flex gap-md'
        });

        const settingsBtn = this.Button({
            text: '⚙',
            variant: 'ghost',
            size: 'sm',
            onClick: () => window.openAgentSettings(agent.name),
            className: 'gear-btn'
        });

        actions.appendChild(settingsBtn);

        container.appendChild(statusIndicator);
        container.appendChild(name);
        if (joiningText) container.appendChild(joiningText);
        container.appendChild(actions);

        return container;
    },

    /**
     * Create viewer section
     * @private
     */
    createViewerSection(agent) {
        const viewerPort = agent.viewerPort;
        const viewerURL = `${window.location.protocol}//${window.location.hostname}:${viewerPort}`;

        const container = Utils.createElement('div', {
            className: 'viewer-container',
            id: `viewer-container-${agent.name}`
        });

        const iframe = Utils.createElement('iframe', {
            className: 'viewer-iframe',
            id: `viewer-${agent.name}`,
            src: viewerURL,
            style: { border: 'none', width: '100%', height: '100%' }
        });

        container.appendChild(iframe);

        return this.Collapsible({
            title: 'Camera View',
            defaultExpanded: false,
            children: container,
            id: `viewerSection-${agent.name}`,
            onToggle: (expanded) => {
                if (expanded) {
                    // Trigger resize to ensure viewer renders correctly
                    setTimeout(() => {
                        if (iframe.contentWindow) {
                            iframe.contentWindow.dispatchEvent(new Event('resize'));
                        }
                    }, 50);
                    // Trigger again just in case of transition delay
                    setTimeout(() => {
                        if (iframe.contentWindow) {
                            iframe.contentWindow.dispatchEvent(new Event('resize'));
                        }
                    }, 300);
                }
            }
        });
    },

    /**
     * Create stats section
     * @private
     */
    createStatsSection(agent) {
        const container = Utils.createElement('div', {
            className: 'agent-card-body'
        });

        const grid = Utils.createElement('div', {
            className: 'stats-grid agent-grid'
        });

        // Create stat items
        const stats = [
            { id: `action-${agent.name}`, label: 'Action', value: '-' },
            { id: `mode-${agent.name}`, label: 'Gamemode', value: '-' },
            { id: `health-${agent.name}`, label: 'Health', value: '-' },
            { id: `hunger-${agent.name}`, label: 'Hunger', value: '-' },
            { id: `pos-${agent.name}`, label: 'Position', value: '-' },
            { id: `biome-${agent.name}`, label: 'Biome', value: '-' },
            { id: `items-${agent.name}`, label: 'Inventory', value: '-' },
            { id: `equipped-${agent.name}`, label: 'Equipped', value: '-' }
        ];

        stats.forEach(stat => {
            const statEl = Utils.createElement('div', {
                className: 'stat-item',
                id: stat.id
            }, `${stat.label}: ${stat.value}`);
            grid.appendChild(statEl);
        });

        container.appendChild(grid);

        return container;
    },


    /**
     * Create charts section
     * @private
     */
    createChartsSection(agent) {
        const section = this.Collapsible({
            title: 'Charts & Analytics',
            defaultExpanded: false,
            children: this.createChartsGrid(agent)
        });

        return section;
    },

    /**
     * Create charts grid
     * @private
     */
    createChartsGrid(agent) {
        const grid = Utils.createElement('div', {
            className: 'charts-grid'
        });

        // Vitals Chart
        const vitalsChart = this.ChartContainer({
            title: 'Health & Hunger Trends',
            canvasId: `vitals-chart-${agent.name}`,
            height: '192px'
        });

        // Inventory Chart
        const inventoryChart = this.ChartContainer({
            title: 'Inventory Composition',
            canvasId: `inventory-chart-${agent.name}`,
            height: '192px'
        });

        // Position Map (3D using Plotly)
        const positionChart = this.ChartContainer({
            title: '3D Movement Map',
            canvasId: `position-chart-${agent.name}`,
            height: '320px',
            className: 'chart-full-width',
            useDiv: true
        });

        grid.appendChild(vitalsChart);
        grid.appendChild(inventoryChart);
        grid.appendChild(positionChart);

        return grid;
    },

    /**
     * Create inventory section
     * @private
     */
    createInventorySection(agent, inventoryOpen) {
        const inventoryContent = Utils.createElement('div', {
            className: 'inventory-section-content'
        });

        const armorDiv = Utils.createElement('div', {
            id: `armor-${agent.name}`,
            className: 'stat-item',
            style: { marginBottom: '8px' }
        }, 'armor: -');

        const inventoryGrid = Utils.createElement('div', {
            id: `inventory-${agent.name}`,
            className: 'inventory-grid'
        });

        inventoryContent.appendChild(armorDiv);
        inventoryContent.appendChild(inventoryGrid);

        return this.Collapsible({
            title: 'Inventory',
            defaultExpanded: inventoryOpen || false,
            id: `inventorySection-${agent.name}`,
            children: inventoryContent
        });
    },

    /**
     * Create chat section (History + Input)
     * @private
     */
    createChatSection(agent) {
        const container = Utils.createElement('div', {
            className: 'chat-section',
            style: {
                display: 'flex',
                flexDirection: 'column',
                height: '400px', // Fixed height for chat area like ChatGPT
                borderTop: '2px solid var(--mc-shadow)',
                borderBottom: '2px solid var(--mc-highlight)',
                background: '#000'
            }
        });

        // 1. Message History Container (Scrollable)
        const historyContainer = Utils.createElement('div', {
            id: `messageHistoryContainer-${agent.name}`,
            className: 'message-history-container',
            style: {
                flex: '1',
                overflowY: 'auto',
                padding: 'var(--space-md)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
            }
        });

        const emptyMessage = Utils.createElement('div', {
            className: 'message-history-empty',
            style: { margin: 'auto' }
        }, 'No messages yet.');

        historyContainer.appendChild(emptyMessage);
        
        // 2. Input Area (Fixed at bottom)
        const inputArea = Utils.createElement('div', {
            className: 'chat-input-area',
            style: {
                padding: 'var(--space-md)',
                background: 'var(--mc-bg)',
                borderTop: '2px solid var(--mc-highlight)',
                display: 'flex',
                gap: 'var(--space-sm)'
            }
        });

        const input = this.Input({
            type: 'text',
            id: `messageInput-${agent.name}`,
            placeholder: 'Enter message...',
            disabled: !agent.in_game,
            onInput: () => window.onMsgInputChange(agent.name),
            onKeyDown: (e) => {
                if (e.key === 'Enter') {
                    document.getElementById(`sendBtn-${agent.name}`).click();
                }
            },
            className: 'controls-input'
        });

        const sendBtn = this.Button({
            text: 'Send',
            id: `sendBtn-${agent.name}`,
            disabled: true,
            variant: 'accent',
            onClick: () => {
                const msg = document.getElementById(`messageInput-${agent.name}`).value;
                window.sendMessage(agent.name, msg);
            }
        });

        inputArea.appendChild(input);
        inputArea.appendChild(sendBtn);

        container.appendChild(historyContainer);
        container.appendChild(inputArea);

        return container;
    },

    /**
     * Create controls section (Buttons only)
     * @private
     */
    createControlsSection(agent) {
        const container = Utils.createElement('div', {
            className: 'agent-card-footer'
        });

        // Control buttons
        const controlsButtons = Utils.createElement('div', {
            className: 'controls-buttons',
            style: { justifyContent: 'center' }
        });

        const stopBtn = this.Button({
            text: 'Stop',
            variant: 'muted',
            size: 'sm',
            id: `stopBtn-${agent.name}`,
            disabled: !agent.in_game,
            onClick: () => window.sendMessage(agent.name, '!stop')
        });

        const stayBtn = this.Button({
            text: 'Stay',
            variant: 'muted',
            size: 'sm',
            id: `stayBtn-${agent.name}`,
            disabled: !agent.in_game,
            onClick: () => window.sendMessage(agent.name, '!stay(-1)')
        });

        const restartBtn = this.Button({
            text: 'Restart',
            variant: 'muted',
            size: 'sm',
            id: `restartBtn-${agent.name}`,
            disabled: !agent.in_game,
            onClick: () => window.restartAgent(agent.name)
        });

        const connectBtn = this.Button({
            text: agent.in_game ? 'Disconnect' :
                 (agent.socket_connected ? 'Connecting...' : 'Connect'),
            variant: 'muted',
            size: 'sm',
            id: `connectBtn-${agent.name}`,
            disabled: agent.socket_connected && !agent.in_game,
            onClick: () => {
                if (agent.in_game) {
                    window.disconnectAgent(agent.name);
                } else if (!agent.socket_connected) {
                    window.startAgent(agent.name);
                }
            }
        });

        const removeBtn = this.Button({
            text: 'Remove',
            variant: 'destructive',
            size: 'sm',
            onClick: () => window.destroyAgent(agent.name)
        });

        controlsButtons.appendChild(stopBtn);
        controlsButtons.appendChild(stayBtn);
        controlsButtons.appendChild(restartBtn);
        controlsButtons.appendChild(connectBtn);
        controlsButtons.appendChild(removeBtn);

        container.appendChild(controlsButtons);

        return container;
    },
};
