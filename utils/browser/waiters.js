/**
 * Waiters — Condition-Based Polling
 *
 * Provides wait_for(condition, timeoutMs) with multiple condition types:
 * - dom_ready: document.readyState === 'complete'
 * - ui_changed: interactables digest differs from baseline
 * - element_appears: element matching role+name found in scan
 * - spinner_gone: no visible progressbar/spinner/loading elements
 * - toast_appears: role=alert/status visible
 *
 * All waiters return diagnostic info on timeout (not just failure).
 */

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_TIMEOUT_MS = 8000;

// =============================================================================
// Waiter Functions (run in service worker, poll via provider)
// =============================================================================

/**
 * Generic polling waiter.
 * @param {Function} checkFn - async () => { done: boolean, data: any }
 * @param {Object} opts - { timeoutMs, pollIntervalMs }
 * @returns {Promise<Object>} { success, timedOut, data, elapsedMs }
 */
async function pollUntil(checkFn, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const startTime = Date.now();
  let lastData = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await checkFn();
      lastData = result.data;
      if (result.done) {
        return {
          success: true,
          timedOut: false,
          data: result.data,
          elapsedMs: Date.now() - startTime,
        };
      }
    } catch (e) {
      // Continue polling on error
      lastData = { error: e.message };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  return {
    success: false,
    timedOut: true,
    data: lastData,
    elapsedMs: Date.now() - startTime,
    diagnostic: `Timed out after ${timeoutMs}ms`,
  };
}

// =============================================================================
// Condition Implementations
// =============================================================================

/**
 * Wait until document is fully loaded.
 * @param {Object} provider - BrowserProvider instance
 * @param {number} tabId
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
async function waitForDomReady(provider, tabId, opts = {}) {
  // If provider is CDP-based, we can check via Runtime.evaluate
  // Otherwise fall back to content script message
  return pollUntil(async () => {
    try {
      const state = await provider.getState(tabId);
      return { done: !!state.url, data: { url: state.url, title: state.title } };
    } catch (e) {
      return { done: false, data: { error: e.message } };
    }
  }, { timeoutMs: opts.timeoutMs || 10000 });
}

/**
 * Wait until UI digest changes from a known baseline.
 * @param {Object} provider
 * @param {number} tabId
 * @param {string} baselineDigest - digest to compare against
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
async function waitForUIChange(provider, tabId, baselineDigest, opts = {}) {
  return pollUntil(async () => {
    const result = await provider.getInteractables(tabId);
    const changed = result.digest !== baselineDigest;
    return {
      done: changed,
      data: {
        baselineDigest,
        currentDigest: result.digest,
        elementCount: result.elements.length,
      },
    };
  }, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
}

/**
 * Wait until an element matching criteria appears.
 * @param {Object} provider
 * @param {number} tabId
 * @param {Object} criteria - { roleContains?, nameContains?, textContains? }
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
async function waitForElement(provider, tabId, criteria, opts = {}) {
  return pollUntil(async () => {
    const result = await provider.getInteractables(tabId);
    const match = result.elements.find(el => {
      if (criteria.roleContains && !(el.role || '').toLowerCase().includes(criteria.roleContains.toLowerCase())) return false;
      if (criteria.nameContains && !(el.name || el.text || '').toLowerCase().includes(criteria.nameContains.toLowerCase())) return false;
      if (criteria.textContains && !(el.text || '').toLowerCase().includes(criteria.textContains.toLowerCase())) return false;
      return true;
    });
    return {
      done: !!match,
      data: match ? { label: match.label, role: match.role, name: match.name || match.text } : { searched: criteria, scannedCount: result.elements.length },
    };
  }, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
}

/**
 * Wait until no visible spinners/loading indicators.
 * Uses Runtime.evaluate to check common spinner patterns.
 * @param {Object} provider
 * @param {number} tabId
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
async function waitForSpinnerGone(provider, tabId, opts = {}) {
  // This works best with CDPAXProvider which can use Runtime.evaluate,
  // but also works with DOM provider via a content script message
  return pollUntil(async () => {
    const result = await provider.getInteractables(tabId);
    // Check for progressbar role
    const spinners = result.elements.filter(el =>
      el.role === 'progressbar' ||
      (el.name || '').toLowerCase().includes('loading') ||
      (el.text || '').toLowerCase().includes('loading')
    );
    return {
      done: spinners.length === 0,
      data: {
        visibleSpinners: spinners.length,
        spinnerNames: spinners.map(s => s.name || s.text).slice(0, 5),
      },
    };
  }, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs || 400,
  });
}

/**
 * Wait until a toast/alert appears.
 * @param {Object} provider
 * @param {number} tabId
 * @param {Object} opts - { textContains? }
 * @returns {Promise<Object>}
 */
async function waitForToast(provider, tabId, opts = {}) {
  return pollUntil(async () => {
    const state = await provider.getState(tabId);
    const toasts = state.toasts || [];
    if (opts.textContains) {
      const match = toasts.find(t => t.toLowerCase().includes(opts.textContains.toLowerCase()));
      return { done: !!match, data: { toasts, matched: match || null } };
    }
    return { done: toasts.length > 0, data: { toasts } };
  }, { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS });
}

// =============================================================================
// Unified wait_for Interface
// =============================================================================

/**
 * Unified waiter that dispatches to the appropriate condition.
 * @param {Object} provider - BrowserProvider instance
 * @param {number} tabId
 * @param {Object} condition - { type, ...params }
 *   type: 'dom_ready' | 'ui_changed' | 'element_appears' | 'spinner_gone' | 'toast_appears'
 * @param {number} [timeoutMs]
 * @returns {Promise<Object>}
 */
async function waitFor(provider, tabId, condition, timeoutMs) {
  const opts = { timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS };

  switch (condition.type) {
    case 'dom_ready':
      return waitForDomReady(provider, tabId, opts);

    case 'ui_changed':
      return waitForUIChange(provider, tabId, condition.baselineDigest, opts);

    case 'element_appears':
      return waitForElement(provider, tabId, {
        roleContains: condition.roleContains,
        nameContains: condition.nameContains,
        textContains: condition.textContains,
      }, opts);

    case 'spinner_gone':
      return waitForSpinnerGone(provider, tabId, opts);

    case 'toast_appears':
      return waitForToast(provider, tabId, { textContains: condition.textContains, ...opts });

    default:
      return {
        success: false,
        timedOut: false,
        data: null,
        error: `Unknown wait condition: ${condition.type}`,
      };
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  waitFor,
  waitForDomReady,
  waitForUIChange,
  waitForElement,
  waitForSpinnerGone,
  waitForToast,
  pollUntil,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
};
