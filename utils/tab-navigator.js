/**
 * Tab Navigator
 *
 * Helper utilities for Chrome tab management.
 * Used by AutomationEngine for navigation actions.
 *
 * Provides centralized tab operations:
 * - Navigation to URLs (with tab reuse)
 * - Tab lifecycle management (create, close, switch)
 * - Page load waiting with timeout
 * - History navigation (back/forward)
 * - Tab state queries
 */

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_LOAD_TIMEOUT = 30000; // 30 seconds
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'file://'
];

// =============================================================================
// TabNavigator Class
// =============================================================================

class TabNavigator {
  /**
   * Navigate to URL (reuse existing tab if found, otherwise create new)
   * @param {string} url - The URL to navigate to
   * @param {Object} options - Navigation options
   * @param {boolean} options.reuseExisting - Whether to reuse existing tab with same URL (default: true)
   * @param {boolean} options.waitForLoad - Whether to wait for page load (default: true)
   * @param {number} options.timeout - Load timeout in ms (default: 30000)
   * @returns {Promise<chrome.tabs.Tab>} The navigated tab
   */
  async navigateToUrl(url, options = {}) {
    const {
      reuseExisting = true,
      waitForLoad = true,
      timeout = DEFAULT_LOAD_TIMEOUT
    } = options;

    // Validate URL
    if (!url || typeof url !== 'string') {
      throw new Error('URL must be a non-empty string');
    }

    // Normalize URL (add https if no protocol)
    const normalizedUrl = this._normalizeUrl(url);

    // Check for restricted URLs
    if (this._isRestrictedUrl(normalizedUrl)) {
      throw new Error(`Cannot navigate to restricted URL: ${normalizedUrl}`);
    }

    // Check if tab with URL already exists
    if (reuseExisting) {
      try {
        const tabs = await chrome.tabs.query({ url: this._buildUrlPattern(normalizedUrl) });

        if (tabs.length > 0) {
          // Switch to existing tab
          console.log('[TabNavigator] Reusing existing tab:', tabs[0].id);
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          return tabs[0];
        }
      } catch (error) {
        // URL pattern may not be valid for query, continue to create new tab
        console.warn('[TabNavigator] Could not query for existing tabs:', error.message);
      }
    }

    // Create new tab
    console.log('[TabNavigator] Creating new tab for:', normalizedUrl);
    const tab = await chrome.tabs.create({ url: normalizedUrl, active: true });

    // Wait for page to load
    if (waitForLoad) {
      await this.waitForLoad(tab.id, timeout);
    }

    return tab;
  }

  /**
   * Wait for tab to finish loading
   * @param {number} tabId - The tab ID to wait for
   * @param {number} timeout - Timeout in milliseconds (default: 30000)
   * @returns {Promise<void>}
   */
  async waitForLoad(tabId, timeout = DEFAULT_LOAD_TIMEOUT) {
    // First check if already complete
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        return;
      }
    } catch (error) {
      throw new Error(`Tab ${tabId} does not exist`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`Page load timeout after ${timeout}ms`));
      }, timeout);

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  /**
   * Close tab by ID
   * @param {number} tabId - The tab ID to close
   * @returns {Promise<void>}
   */
  async closeTab(tabId) {
    if (typeof tabId !== 'number') {
      throw new Error('Tab ID must be a number');
    }

    try {
      await chrome.tabs.remove(tabId);
      console.log('[TabNavigator] Closed tab:', tabId);
    } catch (error) {
      // Tab may already be closed
      console.warn('[TabNavigator] Could not close tab:', error.message);
    }
  }

  /**
   * Get currently active tab
   * @returns {Promise<chrome.tabs.Tab|null>} The active tab or null if none
   */
  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  /**
   * Get tab by ID
   * @param {number} tabId - The tab ID
   * @returns {Promise<chrome.tabs.Tab|null>} The tab or null if not found
   */
  async getTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      return null;
    }
  }

  /**
   * Switch to tab by ID
   * @param {number} tabId - The tab ID to switch to
   * @returns {Promise<chrome.tabs.Tab>} The activated tab
   */
  async switchToTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    console.log('[TabNavigator] Switched to tab:', tabId);
    return tab;
  }

  /**
   * Reload a tab
   * @param {number} tabId - The tab ID to reload
   * @param {Object} options - Reload options
   * @param {boolean} options.bypassCache - Whether to bypass cache (default: false)
   * @param {boolean} options.waitForLoad - Whether to wait for reload (default: true)
   * @param {number} options.timeout - Load timeout in ms (default: 30000)
   * @returns {Promise<void>}
   */
  async reloadTab(tabId, options = {}) {
    const {
      bypassCache = false,
      waitForLoad = true,
      timeout = DEFAULT_LOAD_TIMEOUT
    } = options;

    await chrome.tabs.reload(tabId, { bypassCache });
    console.log('[TabNavigator] Reloading tab:', tabId);

    if (waitForLoad) {
      await this.waitForLoad(tabId, timeout);
    }
  }

  /**
   * Go back in history
   * @param {number} tabId - The tab ID
   * @param {Object} options - Navigation options
   * @param {boolean} options.waitForLoad - Whether to wait for load (default: true)
   * @param {number} options.timeout - Load timeout in ms (default: 30000)
   * @returns {Promise<void>}
   */
  async goBack(tabId, options = {}) {
    const {
      waitForLoad = true,
      timeout = DEFAULT_LOAD_TIMEOUT
    } = options;

    await chrome.tabs.goBack(tabId);
    console.log('[TabNavigator] Going back in tab:', tabId);

    if (waitForLoad) {
      await this.waitForLoad(tabId, timeout);
    }
  }

  /**
   * Go forward in history
   * @param {number} tabId - The tab ID
   * @param {Object} options - Navigation options
   * @param {boolean} options.waitForLoad - Whether to wait for load (default: true)
   * @param {number} options.timeout - Load timeout in ms (default: 30000)
   * @returns {Promise<void>}
   */
  async goForward(tabId, options = {}) {
    const {
      waitForLoad = true,
      timeout = DEFAULT_LOAD_TIMEOUT
    } = options;

    await chrome.tabs.goForward(tabId);
    console.log('[TabNavigator] Going forward in tab:', tabId);

    if (waitForLoad) {
      await this.waitForLoad(tabId, timeout);
    }
  }

  /**
   * Update tab URL (navigate within existing tab)
   * @param {number} tabId - The tab ID
   * @param {string} url - The new URL
   * @param {Object} options - Navigation options
   * @param {boolean} options.waitForLoad - Whether to wait for load (default: true)
   * @param {number} options.timeout - Load timeout in ms (default: 30000)
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async updateTabUrl(tabId, url, options = {}) {
    const {
      waitForLoad = true,
      timeout = DEFAULT_LOAD_TIMEOUT
    } = options;

    const normalizedUrl = this._normalizeUrl(url);

    if (this._isRestrictedUrl(normalizedUrl)) {
      throw new Error(`Cannot navigate to restricted URL: ${normalizedUrl}`);
    }

    const tab = await chrome.tabs.update(tabId, { url: normalizedUrl });
    console.log('[TabNavigator] Updated tab URL:', tabId, '->', normalizedUrl);

    if (waitForLoad) {
      await this.waitForLoad(tabId, timeout);
    }

    return tab;
  }

  /**
   * Query tabs matching criteria
   * @param {chrome.tabs.QueryInfo} queryInfo - Query parameters
   * @returns {Promise<chrome.tabs.Tab[]>}
   */
  async queryTabs(queryInfo) {
    return chrome.tabs.query(queryInfo);
  }

  /**
   * Get all tabs in current window
   * @returns {Promise<chrome.tabs.Tab[]>}
   */
  async getCurrentWindowTabs() {
    return chrome.tabs.query({ currentWindow: true });
  }

  /**
   * Check if a URL is a restricted/internal browser URL
   * @param {string} url - The URL to check
   * @returns {boolean}
   */
  isRestrictedUrl(url) {
    return this._isRestrictedUrl(url);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Normalize URL by adding protocol if missing
   * @private
   * @param {string} url - The URL to normalize
   * @returns {string} Normalized URL
   */
  _normalizeUrl(url) {
    if (!url.includes('://')) {
      return 'https://' + url;
    }
    return url;
  }

  /**
   * Check if URL is restricted
   * @private
   * @param {string} url - The URL to check
   * @returns {boolean}
   */
  _isRestrictedUrl(url) {
    return RESTRICTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
  }

  /**
   * Build URL pattern for tab query
   * @private
   * @param {string} url - The URL
   * @returns {string} URL pattern for chrome.tabs.query
   */
  _buildUrlPattern(url) {
    try {
      const parsed = new URL(url);
      // Return pattern matching the exact URL without query params
      return `${parsed.origin}${parsed.pathname}*`;
    } catch {
      // If URL parsing fails, return as-is
      return url + '*';
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let tabNavigatorInstance = null;

/**
 * Get the singleton TabNavigator instance
 * @returns {TabNavigator}
 */
export function getTabNavigator() {
  if (!tabNavigatorInstance) {
    tabNavigatorInstance = new TabNavigator();
  }
  return tabNavigatorInstance;
}

export { TabNavigator };
