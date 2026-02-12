/**
 * Content Script: Site Rules Checking
 *
 * Manages per-site allow/block lists and site-specific settings.
 * Exports results via window.__thorbit.
 */
(function () {
  'use strict';

  const T = window.__thorbit;

  /** @type {Object|null} Site-specific settings for current hostname */
  T.siteSettings = null;

  /** @type {boolean} Whether the current site is allowed for DOM extraction */
  T.isSiteAllowed = true;

  /** @type {string|null} Reason if site is blocked */
  T.blockReason = null;

  /**
   * Check if a URL matches a Chrome match pattern
   */
  function matchPattern(pattern, url) {
    if (pattern === '<all_urls>' || pattern === '*://*/*') return true;
    try {
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}$`).test(url);
    } catch (error) {
      console.warn('[ContentScript] Invalid match pattern:', pattern, error);
      return false;
    }
  }

  /**
   * Check site permissions and load site-specific settings
   */
  async function checkSiteRules() {
    try {
      const result = await chrome.storage.sync.get('settings');
      const settings = result.settings || {};
      const currentUrl = window.location.href;
      const currentHost = window.location.hostname;

      const blockedSites = settings.disallowedSites || [];
      const allowedSites = settings.allowedSites || ['*://*/*'];
      const siteRules = settings.siteRules || {};

      // Priority 1: Check if site is explicitly blocked
      for (const pattern of blockedSites) {
        if (matchPattern(pattern, currentUrl)) {
          T.isSiteAllowed = false;
          T.blockReason = 'blocked_by_disallowed_list';
          console.log('[ContentScript] Site is blocked by disallowed list:', pattern);
          return;
        }
      }

      // Priority 2: Check if site is in allowed list
      const hasRestrictiveAllowList = allowedSites.length > 0 &&
        !allowedSites.some(p => p === '*://*/*' || p === '<all_urls>');

      if (hasRestrictiveAllowList) {
        const isInAllowList = allowedSites.some(pattern => matchPattern(pattern, currentUrl));
        if (!isInAllowList) {
          T.isSiteAllowed = false;
          T.blockReason = 'not_in_allowed_list';
          console.log('[ContentScript] Site not in allowed list');
          return;
        }
      }

      T.siteSettings = siteRules[currentHost] || null;
      if (T.siteSettings) {
        console.log('[ContentScript] Loaded site-specific settings for:', currentHost, T.siteSettings);
      }
    } catch (error) {
      console.error('[ContentScript] Failed to check site rules:', error);
      T.isSiteAllowed = true;
      T.blockReason = null;
    }
  }

  // Listen for settings changes
  if (typeof chrome !== 'undefined' && chrome.storage?.sync?.onChanged) {
    chrome.storage.sync.onChanged.addListener((changes) => {
      if (changes.settings) {
        console.log('[ContentScript] Settings changed, re-checking site rules');
        checkSiteRules();
      }
    });
  }

  // Check rules on load
  checkSiteRules();

  // Export for re-check
  T.checkSiteRules = checkSiteRules;
})();
