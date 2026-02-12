/**
 * CDP Session Manager
 *
 * Manages Chrome DevTools Protocol sessions via chrome.debugger.
 * Provides attach/detach lifecycle, command sending, and domain management.
 *
 * Key design decisions:
 * - Only one debugger can attach to a tab at a time (Chrome limitation)
 * - Attach when needed, detach when idle (avoids "being debugged" bar lingering)
 * - All CDP commands go through send() which handles the attached check
 * - Domain enablement is tracked per-tab to avoid redundant enable calls
 */

// =============================================================================
// Constants
// =============================================================================

const CDP_VERSION = '1.3';
const IDLE_DETACH_MS = 5 * 60 * 1000; // 5 minutes idle → auto-detach
const REQUIRED_DOMAINS = ['Accessibility', 'DOM', 'DOMSnapshot', 'Page', 'Runtime', 'Input'];

// =============================================================================
// CDPSession Class
// =============================================================================

class CDPSession {
  constructor() {
    /** @type {Map<number, { attached: boolean, enabledDomains: Set<string>, lastUsed: number }>} */
    this.sessions = new Map();

    /** @type {Map<number, number>} tabId → idle timer id */
    this.idleTimers = new Map();

    // Listen for tab removal to clean up
    chrome.tabs.onRemoved.addListener((tabId) => {
      this._cleanup(tabId);
    });

    // Listen for debugger detach events (user may close devtools etc.)
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId) {
        console.log(`[CDPSession] Debugger detached from tab ${source.tabId}, reason: ${reason}`);
        this._cleanup(source.tabId);
      }
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Ensure the debugger is attached to a tab and required domains are enabled.
   * Idempotent — safe to call multiple times.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async ensureAttached(tabId) {
    let session = this.sessions.get(tabId);

    if (session && session.attached) {
      // Already attached — refresh idle timer
      this._resetIdleTimer(tabId);
      // Ensure required domains are enabled
      await this._enableDomains(tabId, session);
      return;
    }

    // Attach
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      console.log(`[CDPSession] Attached to tab ${tabId}`);
    } catch (error) {
      // Already attached is not an error
      if (error.message && error.message.includes('Already attached')) {
        console.log(`[CDPSession] Already attached to tab ${tabId}`);
      } else {
        throw new Error(`CDP attach failed: ${error.message}`);
      }
    }

    session = {
      attached: true,
      enabledDomains: new Set(),
      lastUsed: Date.now(),
    };
    this.sessions.set(tabId, session);

    // Enable required domains
    await this._enableDomains(tabId, session);

    // Set idle timer
    this._resetIdleTimer(tabId);
  }

  /**
   * Send a CDP command to a tab.
   * Auto-attaches if not already attached.
   * @param {number} tabId
   * @param {string} method - CDP method (e.g. 'Accessibility.getFullAXTree')
   * @param {Object} [params={}] - CDP method parameters
   * @returns {Promise<Object>} CDP response
   */
  async send(tabId, method, params = {}) {
    await this.ensureAttached(tabId);

    const session = this.sessions.get(tabId);
    if (session) session.lastUsed = Date.now();
    this._resetIdleTimer(tabId);

    try {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result;
    } catch (error) {
      // If detached mid-call, try re-attaching once
      if (error.message && error.message.includes('not attached')) {
        console.warn(`[CDPSession] Re-attaching to tab ${tabId} after detach`);
        this._cleanup(tabId);
        await this.ensureAttached(tabId);
        return chrome.debugger.sendCommand({ tabId }, method, params);
      }
      throw error;
    }
  }

  /**
   * Detach the debugger from a tab.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async detach(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || !session.attached) return;

    try {
      await chrome.debugger.detach({ tabId });
      console.log(`[CDPSession] Detached from tab ${tabId}`);
    } catch (error) {
      // Already detached is fine
      console.warn(`[CDPSession] Detach warning for tab ${tabId}:`, error.message);
    }

    this._cleanup(tabId);
  }

  /**
   * Check if debugger is attached to a tab.
   * @param {number} tabId
   * @returns {boolean}
   */
  isAttached(tabId) {
    const session = this.sessions.get(tabId);
    return !!(session && session.attached);
  }

  /**
   * Get session info for debugging/display.
   * @param {number} tabId
   * @returns {Object|null}
   */
  getSessionInfo(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return null;
    return {
      attached: session.attached,
      enabledDomains: Array.from(session.enabledDomains),
      lastUsed: session.lastUsed,
      idleMs: Date.now() - session.lastUsed,
    };
  }

  /**
   * Detach all sessions (e.g., on extension unload).
   * @returns {Promise<void>}
   */
  async detachAll() {
    const tabIds = Array.from(this.sessions.keys());
    await Promise.allSettled(tabIds.map(tabId => this.detach(tabId)));
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Enable required CDP domains for a session.
   * @param {number} tabId
   * @param {Object} session
   */
  async _enableDomains(tabId, session) {
    for (const domain of REQUIRED_DOMAINS) {
      if (!session.enabledDomains.has(domain)) {
        try {
          await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
          session.enabledDomains.add(domain);
        } catch (error) {
          // Some domains may not be available on all pages
          console.warn(`[CDPSession] Failed to enable ${domain} on tab ${tabId}:`, error.message);
        }
      }
    }
  }

  /**
   * Reset the idle detach timer for a tab.
   * @param {number} tabId
   */
  _resetIdleTimer(tabId) {
    const existingTimer = this.idleTimers.get(tabId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      console.log(`[CDPSession] Idle timeout for tab ${tabId}, detaching`);
      this.detach(tabId);
    }, IDLE_DETACH_MS);

    this.idleTimers.set(tabId, timer);
  }

  /**
   * Clean up session state for a tab.
   * @param {number} tabId
   */
  _cleanup(tabId) {
    this.sessions.delete(tabId);
    const timer = this.idleTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(tabId);
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let cdpSessionInstance = null;

/**
 * Get the singleton CDPSession instance.
 * @returns {CDPSession}
 */
function getCDPSession() {
  if (!cdpSessionInstance) {
    cdpSessionInstance = new CDPSession();
  }
  return cdpSessionInstance;
}

// =============================================================================
// Exports
// =============================================================================

export { CDPSession, getCDPSession };
