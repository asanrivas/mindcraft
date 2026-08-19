/**
 * Utility Functions for Mindcraft UI
 * Helper functions for formatting, data manipulation, and DOM operations
 */

const Utils = {
    /**
     * Format a position object to a readable string
     * @param {Object} position - {x, y, z}
     * @returns {string}
     */
    formatPosition(position) {
        if (!position) return '-';
        return `x ${Math.round(position.x)}, y ${Math.round(position.y)}, z ${Math.round(position.z)}`;
    },

    /**
     * Format health/hunger as a ratio
     * @param {number} current
     * @param {number} max
     * @returns {string}
     */
    formatHealthRatio(current, max = 20) {
        if (typeof current !== 'number') return '-';
        return `${current}/${max}`;
    },

    /**
     * Get health percentage
     * @param {number} health
     * @param {number} maxHealth
     * @returns {number}
     */
    getHealthPercentage(health, maxHealth = 20) {
        if (typeof health !== 'number' || typeof maxHealth !== 'number') return 0;
        return (health / maxHealth) * 100;
    },

    /**
     * Get health status class based on percentage
     * @param {number} percentage
     * @returns {string}
     */
    getHealthStatusClass(percentage) {
        if (percentage > 66) return 'health-high';
        if (percentage > 33) return 'health-medium';
        return 'health-low';
    },

    /**
     * Format item name for display (replace underscores with spaces, capitalize)
     * @param {string} itemName
     * @returns {string}
     */
    formatItemName(itemName) {
        if (!itemName) return '';
        return itemName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    },

    /**
     * Truncate text to a maximum length
     * @param {string} text
     * @param {number} maxLength
     * @returns {string}
     */
    truncate(text, maxLength = 50) {
        if (!text || text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    },

    /**
     * Format timestamp to readable time
     * @param {number} timestamp
     * @returns {string}
     */
    formatTime(timestamp) {
        const date = new Date(timestamp);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const seconds = date.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    },

    /**
     * Format time elapsed (e.g., "2m 30s ago")
     * @param {number} timestamp
     * @returns {string}
     */
    formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    },

    /**
     * Debounce function
     * @param {Function} func
     * @param {number} wait
     * @returns {Function}
     */
    debounce(func, wait = 300) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Throttle function
     * @param {Function} func
     * @param {number} limit
     * @returns {Function}
     */
    throttle(func, limit = 300) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    },

    /**
     * Create a DOM element with optional properties
     * @param {string} tag
     * @param {Object} props
     * @param {Array|HTMLElement|string} children
     * @returns {HTMLElement}
     */
    createElement(tag, props = {}, children = null) {
        const element = document.createElement(tag);

        // Set properties
        Object.keys(props).forEach(key => {
            if (key === 'className') {
                element.className = props[key];
            } else if (key === 'style' && typeof props[key] === 'object') {
                Object.assign(element.style, props[key]);
            } else if (key.startsWith('on') && typeof props[key] === 'function') {
                const event = key.substring(2).toLowerCase();
                element.addEventListener(event, props[key]);
            } else if (key === 'dataset' && typeof props[key] === 'object') {
                Object.keys(props[key]).forEach(dataKey => {
                    element.dataset[dataKey] = props[key][dataKey];
                });
            } else if (key === 'disabled' || key === 'checked' || key === 'readonly' || key === 'required') {
                // Boolean attributes - use property instead of attribute
                element[key] = props[key];
            } else if (typeof props[key] === 'boolean') {
                // Other boolean attributes - only set if true
                if (props[key]) {
                    element.setAttribute(key, '');
                }
            } else {
                element.setAttribute(key, props[key]);
            }
        });

        // Add children
        if (children) {
            if (Array.isArray(children)) {
                children.forEach(child => {
                    if (typeof child === 'string') {
                        element.appendChild(document.createTextNode(child));
                    } else if (child instanceof HTMLElement) {
                        element.appendChild(child);
                    }
                });
            } else if (typeof children === 'string') {
                element.textContent = children;
            } else if (children instanceof HTMLElement) {
                element.appendChild(children);
            }
        }

        return element;
    },

    /**
     * Remove all children from an element
     * @param {HTMLElement} element
     */
    clearElement(element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    },

    /**
     * Toggle an element's visibility with animation
     * @param {HTMLElement} element
     * @param {boolean} show
     * @param {string} displayType
     */
    toggleElement(element, show, displayType = 'block') {
        if (show) {
            element.style.display = displayType;
            element.classList.remove('hidden');
            element.classList.add('visible');
        } else {
            element.style.display = 'none';
            element.classList.remove('visible');
            element.classList.add('hidden');
        }
    },

    /**
     * Expand/collapse a collapsible element
     * @param {HTMLElement} element
     * @param {boolean} expand
     */
    toggleCollapsible(element, expand) {
        if (expand) {
            element.classList.add('expanded');
        } else {
            element.classList.remove('expanded');
        }
    },

    /**
     * Show a toast notification (simple implementation)
     * @param {string} message
     * @param {string} type - 'success', 'error', 'info', 'warning'
     * @param {number} duration
     */
    showToast(message, type = 'info', duration = 3000) {
        const toast = this.createElement('div', {
            className: `toast toast-${type}`,
            style: {
                position: 'fixed',
                bottom: '100px',
                right: '20px',
                padding: '12px 20px',
                borderRadius: '6px',
                background: type === 'success' ? '#4CAF50' :
                           type === 'error' ? '#f44336' :
                           type === 'warning' ? '#FF9800' : '#2196F3',
                color: 'white',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                zIndex: '10000',
                animation: 'slideDown 0.3s ease-out',
                fontSize: '14px',
                fontWeight: '500',
                maxWidth: '300px'
            }
        }, message);

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease-out';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, duration);
    },

    /**
     * Deep clone an object
     * @param {Object} obj
     * @returns {Object}
     */
    deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    },

    /**
     * Check if two objects are equal (shallow comparison)
     * @param {Object} obj1
     * @param {Object} obj2
     * @returns {boolean}
     */
    shallowEqual(obj1, obj2) {
        if (!obj1 || !obj2) return obj1 === obj2;
        const keys1 = Object.keys(obj1);
        const keys2 = Object.keys(obj2);
        if (keys1.length !== keys2.length) return false;

        for (const key of keys1) {
            const val1 = obj1[key];
            const val2 = obj2[key];
            if (typeof val1 === 'object' || typeof val2 === 'object') {
                if (JSON.stringify(val1) !== JSON.stringify(val2)) return false;
            } else if (val1 !== val2) {
                return false;
            }
        }
        return true;
    },

    /**
     * Get query parameter from URL
     * @param {string} name
     * @returns {string|null}
     */
    getQueryParam(name) {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(name);
    },

    /**
     * Set query parameter in URL
     * @param {string} name
     * @param {string} value
     */
    setQueryParam(name, value) {
        const urlParams = new URLSearchParams(window.location.search);
        urlParams.set(name, value);
        const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
        window.history.replaceState({}, '', newUrl);
    },

    /**
     * Generate a unique ID
     * @returns {string}
     */
    generateId() {
        return `id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    },

    /**
     * Capitalize first letter of a string
     * @param {string} str
     * @returns {string}
     */
    capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Parse JSON safely
     * @param {string} jsonString
     * @param {*} defaultValue
     * @returns {*}
     */
    safeJSONParse(jsonString, defaultValue = null) {
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            console.error('JSON parse error:', e);
            return defaultValue;
        }
    },

    /**
     * Stringify JSON safely
     * @param {*} obj
     * @param {string} defaultValue
     * @returns {string}
     */
    safeJSONStringify(obj, defaultValue = '{}') {
        try {
            return JSON.stringify(obj);
        } catch (e) {
            console.error('JSON stringify error:', e);
            return defaultValue;
        }
    },

    /**
     * Check if element is in viewport
     * @param {HTMLElement} element
     * @returns {boolean}
     */
    isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    },

    /**
     * Smooth scroll to element
     * @param {HTMLElement} element
     * @param {Object} options
     */
    scrollToElement(element, options = {}) {
        element.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
            ...options
        });
    }
};

// Add fade out animation for toast
if (!document.querySelector('style#toast-animations')) {
    const style = document.createElement('style');
    style.id = 'toast-animations';
    style.textContent = `
        @keyframes fadeOut {
            from { opacity: 1; transform: translateY(0); }
            to { opacity: 0; transform: translateY(10px); }
        }
    `;
    document.head.appendChild(style);
}
