/**
 * Content Script: Message Handler
 *
 * Listens for messages from the service worker and dispatches
 * to the appropriate module (extractor, action executor, etc.).
 * This is the last file loaded — all other modules are ready.
 */
(function () {
  'use strict';

  const T = window.__thorbit;

  /** Store last extraction for action execution */
  T.lastExtraction = null;

  // =========================================================================
  // Message Listener
  // =========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // --- DOM Extraction ---
    if (message.type === 'EXTRACT_DOM') {
      if (!T.isSiteAllowed) {
        sendResponse({
          success: false,
          blocked: true,
          reason: T.blockReason,
          error: `DOM extraction blocked: ${T.blockReason}`,
        });
        return true;
      }

      T.waitForDomReady().then((ready) => {
        if (!ready) {
          sendResponse({ success: false, error: 'DOM not ready - page may still be loading' });
          return;
        }
        try {
          const threshold = message.viewportThreshold || T.DEFAULT_VIEWPORT_THRESHOLD;
          T.lastExtraction = T.extractPrunedDom(threshold);
          sendResponse({
            success: true,
            data: T.lastExtraction,
            siteContext: {
              hostname: window.location.hostname,
              siteSettings: T.siteSettings,
              hasCustomSettings: T.siteSettings !== null,
            },
          });
        } catch (error) {
          console.error('DOM extraction error:', error);
          sendResponse({ success: false, error: error.message });
        }
      });
      return true;
    }

    // --- Action Execution ---
    if (message.type === 'EXECUTE_ACTION') {
      try {
        const { action, label, value } = message;
        if (!T.lastExtraction) {
          sendResponse({ success: false, error: 'No DOM extraction available. Extract DOM first.' });
          return true;
        }
        const result = T.executeAction(action, label, value, T.lastExtraction.interactiveElements);
        sendResponse(result);
      } catch (error) {
        console.error('Action execution error:', error);
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // --- Scroll ---
    if (message.type === 'SCROLL_PAGE') {
      try {
        const { direction, amount } = message;
        const scrollAmount = amount || window.innerHeight * 0.8;

        const beforeState = T.captureStateSnapshot();

        if (direction === 'down') window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        else if (direction === 'up') window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

        // Brief delay to let scroll settle, then diff
        setTimeout(() => {
          const afterState = T.captureStateSnapshot();
          const diff = T.computeStateDiff(beforeState, afterState);
          sendResponse({ success: true, action: 'scroll', direction, diff });
        }, 300);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // --- Ping ---
    if (message.type === 'PING') {
      sendResponse({ success: true, ready: true, provider: 'dom' });
      return true;
    }

    // --- Site Status ---
    if (message.type === 'GET_SITE_STATUS') {
      sendResponse({
        success: true,
        allowed: T.isSiteAllowed,
        blockReason: T.blockReason,
        hostname: window.location.hostname,
        url: window.location.href,
        siteSettings: T.siteSettings,
        hasCustomSettings: T.siteSettings !== null,
      });
      return true;
    }

    // --- Re-check Site Rules ---
    if (message.type === 'RECHECK_SITE_RULES') {
      T.checkSiteRules().then(() => {
        sendResponse({
          success: true,
          allowed: T.isSiteAllowed,
          blockReason: T.blockReason,
          siteSettings: T.siteSettings,
        });
      }).catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
      return true;
    }

    // --- Get Digest (for waiters) ---
    if (message.type === 'GET_DIGEST') {
      const digest = T.lastExtraction
        ? T.computeInteractablesDigest(T.lastExtraction.interactiveElements)
        : 'djb2:no_extraction';
      sendResponse({ success: true, digest });
      return true;
    }

    // --- Detect Toasts ---
    if (message.type === 'GET_TOASTS') {
      sendResponse({ success: true, toasts: T.detectToasts() });
      return true;
    }

    // --- Detect Modal ---
    if (message.type === 'GET_MODAL') {
      const modal = T.detectModal();
      sendResponse({ success: true, ...modal });
      return true;
    }

    return false;
  });

  // =========================================================================
  // Ready
  // =========================================================================

  console.log('[AI Page Assistant] Content scripts loaded and ready');
})();
