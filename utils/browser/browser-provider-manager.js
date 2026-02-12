/**
 * BrowserProviderManager
 *
 * Manages the selection between DOMProvider and CDPAXProvider.
 * Default: CDPAXProvider when debugger can attach.
 * Fallback: DOMProvider on attach failure, restricted pages, CDP errors.
 *
 * Also provides:
 * - attach/detach control for the UI toggle
 * - provider status reporting
 * - unified waitFor interface
 */

import { getDOMProvider } from './dom-provider.js';
import { getCDPAXProvider } from './cdp-ax-provider.js';
import { getCDPSession } from './cdp-session.js';
import { waitFor } from './waiters.js';

// =============================================================================
// BrowserProviderManager
// =============================================================================

class BrowserProviderManager {
  constructor() {
    this.domProvider = getDOMProvider();
    this.cdpProvider = getCDPAXProvider();
    this.cdpSession = getCDPSession();

    /** @type {'auto'|'dom'|'cdp_ax'} User preference */
    this.preferredProvider = 'auto';

    /** @type {Map<number, string>} tabId → last provider used */
    this._providerHistory = new Map();

    /** @type {Map<number, { provider: string, scanTimeMs: number, elementsCount: number, staleCount: number, reacquireCount: number, actCount: number, uiChangeCount: number }>} */
    this._metrics = new Map();
  }

  // ===========================================================================
  // Provider Selection
  // ===========================================================================

  /**
   * Get the best available provider for a tab.
   * @param {number} tabId
   * @returns {Promise<import('./browser-provider.js').BrowserProvider>}
   */
  async getProvider(tabId) {
    // If user forced a specific provider
    if (this.preferredProvider === 'dom') {
      this._providerHistory.set(tabId, 'dom');
      return this.domProvider;
    }
    if (this.preferredProvider === 'cdp_ax') {
      // User wants CDP — try to attach
      const available = await this.cdpProvider.isAvailable(tabId);
      if (available) {
        this._providerHistory.set(tabId, 'cdp_ax');
        return this.cdpProvider;
      }
      console.warn('[BrowserProviderManager] CDP requested but unavailable, falling back to DOM');
    }

    // Auto mode: prefer CDP, fall back to DOM
    try {
      const cdpAvailable = await this.cdpProvider.isAvailable(tabId);
      if (cdpAvailable) {
        this._providerHistory.set(tabId, 'cdp_ax');
        return this.cdpProvider;
      }
    } catch (e) {
      console.warn('[BrowserProviderManager] CDP check failed:', e.message);
    }

    this._providerHistory.set(tabId, 'dom');
    return this.domProvider;
  }

  /**
   * Get the active provider name for a tab.
   * @param {number} tabId
   * @returns {string} 'dom' | 'cdp_ax' | 'unknown'
   */
  getActiveProviderName(tabId) {
    return this._providerHistory.get(tabId) || 'unknown';
  }

  /**
   * Set user's preferred provider.
   * @param {'auto'|'dom'|'cdp_ax'} preference
   */
  setPreference(preference) {
    this.preferredProvider = preference;
    console.log('[BrowserProviderManager] Preference set to:', preference);
  }

  // ===========================================================================
  // Delegated Interface (convenience methods)
  // ===========================================================================

  /**
   * Get page state through the best provider.
   * @param {number} tabId
   * @returns {Promise<Object>}
   */
  async getState(tabId) {
    const provider = await this.getProvider(tabId);
    try {
      const state = await provider.getState(tabId);
      return { ...state, provider: provider.name };
    } catch (e) {
      // If CDP failed, try DOM fallback
      if (provider.name === 'cdp_ax') {
        console.warn('[BrowserProviderManager] CDP getState failed, falling back to DOM:', e.message);
        this._providerHistory.set(tabId, 'dom');
        const state = await this.domProvider.getState(tabId);
        return { ...state, provider: 'dom', fallback: true };
      }
      throw e;
    }
  }

  /**
   * Get interactables through the best provider.
   * @param {number} tabId
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async getInteractables(tabId, options = {}) {
    const startTime = Date.now();
    const provider = await this.getProvider(tabId);
    try {
      const result = await provider.getInteractables(tabId, options);
      this._recordMetric(tabId, 'scan', {
        provider: provider.name,
        scanTimeMs: Date.now() - startTime,
        elementsCount: result.elements?.length || 0,
      });
      return { ...result, provider: provider.name };
    } catch (e) {
      if (provider.name === 'cdp_ax') {
        console.warn('[BrowserProviderManager] CDP getInteractables failed, falling back:', e.message);
        this._providerHistory.set(tabId, 'dom');
        const result = await this.domProvider.getInteractables(tabId, options);
        this._recordMetric(tabId, 'scan', {
          provider: 'dom',
          scanTimeMs: Date.now() - startTime,
          elementsCount: result.elements?.length || 0,
          fallback: true,
        });
        return { ...result, provider: 'dom', fallback: true };
      }
      throw e;
    }
  }

  /**
   * Execute an action through the best provider.
   * @param {number} tabId
   * @param {Object} action
   * @returns {Promise<Object>}
   */
  async act(tabId, action) {
    const startTime = Date.now();
    const provider = await this.getProvider(tabId);
    try {
      const result = await provider.act(tabId, action);
      this._recordMetric(tabId, 'act', {
        provider: provider.name,
        actTimeMs: Date.now() - startTime,
        action: action.type,
        success: result.success,
        uiChanged: result.diff?.uiChanged || false,
        stale: result.elementStatus === 'stale',
        reacquired: result.reacquiredTarget || false,
      });
      return { ...result, provider: provider.name };
    } catch (e) {
      if (provider.name === 'cdp_ax') {
        console.warn('[BrowserProviderManager] CDP act failed, falling back:', e.message);
        this._providerHistory.set(tabId, 'dom');
        const result = await this.domProvider.act(tabId, action);
        return { ...result, provider: 'dom', fallback: true };
      }
      throw e;
    }
  }

  /**
   * Wait for a condition.
   * @param {number} tabId
   * @param {Object} condition
   * @param {number} [timeoutMs]
   * @returns {Promise<Object>}
   */
  async waitFor(tabId, condition, timeoutMs) {
    const provider = await this.getProvider(tabId);
    const startTime = Date.now();
    const result = await waitFor(provider, tabId, condition, timeoutMs);
    this._recordMetric(tabId, 'wait', {
      provider: provider.name,
      waitTimeMs: Date.now() - startTime,
      condition: condition.type,
      success: result.success,
    });
    return result;
  }

  // ===========================================================================
  // CDP Session Management (for UI controls)
  // ===========================================================================

  /**
   * Manually attach CDP to a tab.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async attachCDP(tabId) {
    try {
      await this.cdpSession.ensureAttached(tabId);
      return true;
    } catch (e) {
      console.error('[BrowserProviderManager] Manual attach failed:', e.message);
      return false;
    }
  }

  /**
   * Manually detach CDP from a tab.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async detachCDP(tabId) {
    await this.cdpSession.detach(tabId);
    this._providerHistory.set(tabId, 'dom');
  }

  /**
   * Get CDP attach status for a tab.
   * @param {number} tabId
   * @returns {Object}
   */
  getCDPStatus(tabId) {
    const isAttached = this.cdpSession.isAttached(tabId);
    const sessionInfo = this.cdpSession.getSessionInfo(tabId);
    return {
      attached: isAttached,
      session: sessionInfo,
      activeProvider: this.getActiveProviderName(tabId),
      preference: this.preferredProvider,
    };
  }

  // ===========================================================================
  // Metrics
  // ===========================================================================

  /**
   * Record a metric event.
   * @param {number} tabId
   * @param {string} type - 'scan' | 'act' | 'wait'
   * @param {Object} data
   */
  _recordMetric(tabId, type, data) {
    if (!this._metrics.has(tabId)) {
      this._metrics.set(tabId, {
        provider: data.provider,
        scans: 0, scanTimeTotal: 0, elementsTotal: 0,
        acts: 0, actTimeTotal: 0,
        waits: 0, waitTimeTotal: 0,
        staleCount: 0, reacquireCount: 0, uiChangeCount: 0,
      });
    }
    const m = this._metrics.get(tabId);
    m.provider = data.provider;

    if (type === 'scan') {
      m.scans++;
      m.scanTimeTotal += data.scanTimeMs || 0;
      m.elementsTotal += data.elementsCount || 0;
    } else if (type === 'act') {
      m.acts++;
      m.actTimeTotal += data.actTimeMs || 0;
      if (data.stale) m.staleCount++;
      if (data.reacquired) m.reacquireCount++;
      if (data.uiChanged) m.uiChangeCount++;
    } else if (type === 'wait') {
      m.waits++;
      m.waitTimeTotal += data.waitTimeMs || 0;
    }
  }

  /**
   * Get performance metrics for a tab.
   * @param {number} tabId
   * @returns {Object}
   */
  getMetrics(tabId) {
    const m = this._metrics.get(tabId);
    if (!m) return { provider: 'none', scans: 0, acts: 0, waits: 0 };
    return {
      ...m,
      avgScanTimeMs: m.scans > 0 ? Math.round(m.scanTimeTotal / m.scans) : 0,
      avgActTimeMs: m.acts > 0 ? Math.round(m.actTimeTotal / m.acts) : 0,
      avgWaitTimeMs: m.waits > 0 ? Math.round(m.waitTimeTotal / m.waits) : 0,
      staleRate: m.acts > 0 ? (m.staleCount / m.acts).toFixed(3) : '0.000',
      reacquireRate: m.staleCount > 0 ? (m.reacquireCount / m.staleCount).toFixed(3) : 'N/A',
      uiChangeRate: m.acts > 0 ? (m.uiChangeCount / m.acts).toFixed(3) : '0.000',
    };
  }
}

// =============================================================================
// Singleton
// =============================================================================

let managerInstance = null;

function getBrowserProviderManager() {
  if (!managerInstance) managerInstance = new BrowserProviderManager();
  return managerInstance;
}

// =============================================================================
// Exports
// =============================================================================

export { BrowserProviderManager, getBrowserProviderManager };
