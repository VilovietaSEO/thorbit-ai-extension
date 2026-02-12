/**
 * DOMProvider — Day 1 Browser Provider
 *
 * Wraps the existing content-script-based DOM extraction and action execution
 * behind the BrowserProvider interface. This is the fallback when CDP is
 * unavailable (restricted pages, attach failures, etc.).
 *
 * All communication goes through chrome.tabs.sendMessage → content scripts.
 */

import { BrowserProvider } from './browser-provider.js';

// =============================================================================
// Constants
// =============================================================================

const MESSAGE_RETRY_MAX = 5;
const MESSAGE_RETRY_BASE_DELAY = 200; // ms

// =============================================================================
// DOMProvider
// =============================================================================

class DOMProvider extends BrowserProvider {
  constructor() {
    super('dom');
  }

  /**
   * Send message to content script with retry + exponential backoff.
   * @param {number} tabId
   * @param {Object} message
   * @returns {Promise<Object>}
   */
  async _send(tabId, message) {
    let lastError;
    for (let attempt = 0; attempt < MESSAGE_RETRY_MAX; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        return response;
      } catch (error) {
        lastError = error;
        if (error.message?.includes('Cannot automate') ||
            error.message?.includes('Tab does not exist')) {
          throw error;
        }
        if (attempt < MESSAGE_RETRY_MAX - 1) {
          await new Promise(r => setTimeout(r, MESSAGE_RETRY_BASE_DELAY * Math.pow(2, attempt)));
        }
      }
    }
    throw new Error(`DOMProvider: Failed after ${MESSAGE_RETRY_MAX} attempts. ${lastError?.message || ''}`);
  }

  /**
   * Ensure content scripts are loaded in the tab.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async _ensureContentScripts(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (response?.success || response?.ready) return true;
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [
            'content-scripts/cs-constants.js',
            'content-scripts/cs-site-rules.js',
            'content-scripts/cs-digest.js',
            'content-scripts/cs-dom-extractor.js',
            'content-scripts/cs-action-executor.js',
            'content-scripts/cs-message-handler.js',
          ],
        });
        await new Promise(r => setTimeout(r, 100));
        return true;
      } catch (injectError) {
        console.error('[DOMProvider] Failed to inject content scripts:', injectError.message);
        return false;
      }
    }
    return false;
  }

  // ===========================================================================
  // BrowserProvider Interface
  // ===========================================================================

  async getState(tabId) {
    await this._ensureContentScripts(tabId);
    const response = await this._send(tabId, { type: 'EXTRACT_DOM', viewportThreshold: 1000 });
    if (!response || !response.success) {
      throw new Error(response?.error || 'DOM extraction failed');
    }
    const data = response.data;
    return {
      url: data.url,
      title: data.title,
      digest: data.digest,
      modal: data.modal,
      toasts: data.toasts,
      viewport: data.viewport,
      provider: 'dom',
      stats: data.stats,
    };
  }

  async getInteractables(tabId, options = {}) {
    await this._ensureContentScripts(tabId);
    const threshold = options.scope === 'full' ? 99999 : 1000;
    const response = await this._send(tabId, { type: 'EXTRACT_DOM', viewportThreshold: threshold });
    if (!response || !response.success) {
      throw new Error(response?.error || 'DOM extraction failed');
    }
    const data = response.data;
    const elements = data.interactiveElements || [];
    const maxElements = options.maxElements || 100;

    return {
      scope: options.scope || 'viewport',
      provider: 'dom',
      elements: elements.slice(0, maxElements),
      digest: data.digest,
      stats: data.stats,
      frameSummary: { frames: 1, unsupportedFrames: 0 },
    };
  }

  async getViewportText(tabId, maxChars = 5000) {
    await this._ensureContentScripts(tabId);
    const response = await this._send(tabId, { type: 'EXTRACT_DOM', viewportThreshold: 1000 });
    if (!response || !response.success) return '';
    const data = response.data;
    // Build text from tree (simplified: just interactive elements text)
    const parts = (data.interactiveElements || []).map(el => {
      const tag = (el.tag || '').toLowerCase();
      const text = el.text || '';
      const role = el.attributes?.role || '';
      return `[${el.label}] ${tag}${role ? `(${role})` : ''} ${text}`.trim();
    });
    return parts.join('\n').slice(0, maxChars);
  }

  async act(tabId, action) {
    await this._ensureContentScripts(tabId);

    switch (action.type) {
      case 'click':
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        return this._send(tabId, { type: 'EXECUTE_ACTION', action: 'click', label: action.label });

      case 'type':
        if (action.label === undefined || !action.value) return { success: false, error: 'Label and value required' };
        return this._send(tabId, { type: 'EXECUTE_ACTION', action: 'type', label: action.label, value: action.value });

      case 'scroll':
        return this._send(tabId, { type: 'SCROLL_PAGE', direction: action.direction || 'down', amount: action.amount || 500 });

      case 'hover':
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        return this._send(tabId, { type: 'EXECUTE_ACTION', action: 'hover', label: action.label });

      case 'focus':
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        return this._send(tabId, { type: 'EXECUTE_ACTION', action: 'focus', label: action.label });

      case 'scroll_to':
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        return this._send(tabId, { type: 'EXECUTE_ACTION', action: 'scroll_to', label: action.label });

      case 'navigate':
        if (!action.url) return { success: false, error: 'No URL provided' };
        let url = action.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        await chrome.tabs.update(tabId, { url });
        await new Promise(r => setTimeout(r, 1500));
        await this._ensureContentScripts(tabId);
        return { success: true, action: 'navigate', url };

      case 'back':
        await chrome.tabs.goBack(tabId);
        await new Promise(r => setTimeout(r, 1000));
        return { success: true, action: 'back' };

      case 'refresh':
        await chrome.tabs.reload(tabId);
        await new Promise(r => setTimeout(r, 1500));
        return { success: true, action: 'refresh' };

      case 'wait':
        await new Promise(r => setTimeout(r, action.ms || 1000));
        return { success: true, action: 'wait', ms: action.ms || 1000 };

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }

  async isAvailable(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
          url.startsWith('about:') || url.startsWith('data:') || !url) {
        return false;
      }
      return await this._ensureContentScripts(tabId);
    } catch (e) {
      return false;
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let domProviderInstance = null;

function getDOMProvider() {
  if (!domProviderInstance) domProviderInstance = new DOMProvider();
  return domProviderInstance;
}

// =============================================================================
// Exports
// =============================================================================

export { DOMProvider, getDOMProvider };
