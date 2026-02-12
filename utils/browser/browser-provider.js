/**
 * BrowserProvider Interface
 *
 * Abstract base class for browser interaction providers.
 * This is DISTINCT from AIProvider (which wraps AI model APIs).
 *
 * Implementations:
 * - DOMProvider: Day 1 content-script-based extraction and actions
 * - CDPAXProvider: Day 2 CDP-based AX tree extraction and Input dispatch
 *
 * All methods receive a tabId and operate on that tab.
 */

// =============================================================================
// BrowserProvider (Abstract)
// =============================================================================

class BrowserProvider {
  constructor(name) {
    if (new.target === BrowserProvider) {
      throw new Error('BrowserProvider is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  /**
   * Get the current page state (url, title, digest, modal, toasts).
   * @param {number} tabId
   * @returns {Promise<Object>} state object
   */
  async getState(tabId) {
    throw new Error('getState must be implemented by subclass');
  }

  /**
   * Get interactable elements on the page.
   * @param {number} tabId
   * @param {Object} [options] - { scope: 'viewport'|'full', maxElements: number }
   * @returns {Promise<Object>} { elements[], digest, provider, stats, frameSummary? }
   */
  async getInteractables(tabId, options = {}) {
    throw new Error('getInteractables must be implemented by subclass');
  }

  /**
   * Get visible text from the viewport (for AI context).
   * @param {number} tabId
   * @param {number} [maxChars=5000]
   * @returns {Promise<string>}
   */
  async getViewportText(tabId, maxChars = 5000) {
    throw new Error('getViewportText must be implemented by subclass');
  }

  /**
   * Execute an action (click, type, scroll, etc.).
   * Returns structured result with before/after diff.
   * @param {number} tabId
   * @param {Object} action - { type, label?, value?, direction?, x?, y? }
   * @returns {Promise<Object>} action result with diff
   */
  async act(tabId, action) {
    throw new Error('act must be implemented by subclass');
  }

  /**
   * Check if this provider is available for a given tab.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async isAvailable(tabId) {
    throw new Error('isAvailable must be implemented by subclass');
  }
}

// =============================================================================
// Exports
// =============================================================================

export { BrowserProvider };
