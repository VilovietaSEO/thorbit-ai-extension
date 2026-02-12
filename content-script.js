/**
 * Content Script for AI Page Assistant
 *
 * This script extracts DOM content from web pages with intelligent pruning
 * optimized for AI consumption. It implements:
 * - Viewport filtering (skip elements >1000px away)
 * - Interactive element detection (buttons, links, inputs, ARIA roles)
 * - Unique labeling for interactive elements [0], [1], etc.
 * - Message listener for EXTRACT_DOM action
 * - Site rules checking (allowed/blocked sites, per-site settings)
 *
 * Based on browser-use patterns for 60-80% token reduction.
 */

(function () {
  'use strict';

  // =============================================================================
  // Site Rules Checking
  // =============================================================================

  /** @type {Object|null} Site-specific settings for current hostname */
  let siteSettings = null;

  /** @type {boolean} Whether the current site is allowed for DOM extraction */
  let isSiteAllowed = true;

  /** @type {string|null} Reason if site is blocked */
  let blockReason = null;

  /**
   * Check if a URL matches a Chrome match pattern
   * Supports patterns like: *://*.example.com/*, https://example.com/path/*
   * @param {string} pattern - Chrome match pattern
   * @param {string} url - URL to check
   * @returns {boolean} - True if URL matches pattern
   */
  function matchPattern(pattern, url) {
    // Special case for <all_urls>
    if (pattern === '<all_urls>') {
      return true;
    }

    // Special case for wildcard all
    if (pattern === '*://*/*') {
      return true;
    }

    try {
      // Convert Chrome match pattern to regex
      // Match patterns: scheme://host/path
      // Valid schemes: *, http, https, file, ftp
      // Host can include * as wildcard
      // Path always starts with /
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
        .replace(/\*/g, '.*'); // Convert * to .*

      return new RegExp(`^${regexPattern}$`).test(url);
    } catch (error) {
      console.warn('[ContentScript] Invalid match pattern:', pattern, error);
      return false;
    }
  }

  /**
   * Check site permissions and load site-specific settings
   * This is called once when the content script loads
   * @returns {Promise<void>}
   */
  async function checkSiteRules() {
    try {
      // Get stored settings from chrome.storage.sync
      const result = await chrome.storage.sync.get('settings');
      const settings = result.settings || {};

      const currentUrl = window.location.href;
      const currentHost = window.location.hostname;

      // Get site lists with defaults
      const blockedSites = settings.disallowedSites || [];
      const allowedSites = settings.allowedSites || ['*://*/*']; // Default allows all
      const siteRules = settings.siteRules || {};

      // Priority 1: Check if site is explicitly blocked
      for (const pattern of blockedSites) {
        if (matchPattern(pattern, currentUrl)) {
          isSiteAllowed = false;
          blockReason = 'blocked_by_disallowed_list';
          console.log('[ContentScript] Site is blocked by disallowed list:', pattern);
          return;
        }
      }

      // Priority 2: Check if site is in allowed list
      // If allowedSites is empty or contains only wildcards, all sites are allowed
      // Otherwise, site must match at least one pattern
      const hasRestrictiveAllowList = allowedSites.length > 0 &&
        !allowedSites.some(p => p === '*://*/*' || p === '<all_urls>');

      if (hasRestrictiveAllowList) {
        const isInAllowList = allowedSites.some(pattern => matchPattern(pattern, currentUrl));
        if (!isInAllowList) {
          isSiteAllowed = false;
          blockReason = 'not_in_allowed_list';
          console.log('[ContentScript] Site not in allowed list');
          return;
        }
      }

      // Site is allowed - load site-specific settings if available
      siteSettings = siteRules[currentHost] || null;

      if (siteSettings) {
        console.log('[ContentScript] Loaded site-specific settings for:', currentHost, siteSettings);
      } else {
        console.log('[ContentScript] No site-specific settings for:', currentHost);
      }
    } catch (error) {
      console.error('[ContentScript] Failed to check site rules:', error);
      // Default to allowed on error to not break functionality
      isSiteAllowed = true;
      blockReason = null;
    }
  }

  /**
   * Listen for settings changes and re-check site rules
   * This allows real-time updates when user changes settings
   */
  function setupSettingsListener() {
    if (typeof chrome !== 'undefined' && chrome.storage?.sync?.onChanged) {
      chrome.storage.sync.onChanged.addListener((changes) => {
        if (changes.settings) {
          console.log('[ContentScript] Settings changed, re-checking site rules');
          checkSiteRules();
        }
      });
    }
  }

  // Check rules on load (async, doesn't block script execution)
  checkSiteRules();

  // Listen for settings changes
  setupSettingsListener();

  // Default threshold for viewport filtering (pixels from viewport)
  const DEFAULT_VIEWPORT_THRESHOLD = 1000;

  // Maximum recursion depth to prevent deep nesting issues
  const MAX_DEPTH = 20;

  // Tags to skip during DOM traversal
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'PATH',
    'META',
    'LINK',
    'HEAD',
    'BR',
    'HR',
  ]);

  // Tags considered interactive by default
  const INTERACTIVE_TAGS = new Set([
    'A',
    'BUTTON',
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'LABEL',
    'SUMMARY',
    'DETAILS',
  ]);

  // ARIA roles that indicate interactivity
  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'menu',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'tab',
    'treeitem',
    'slider',
    'spinbutton',
    'searchbox',
    'gridcell',
  ]);

  // Attributes to preserve in the pruned DOM
  const RELEVANT_ATTRIBUTES = [
    'id',
    'name',
    'type',
    'href',
    'src',
    'alt',
    'placeholder',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'title',
    'value',
    'role',
    'data-testid',
    'for',
  ];

  /**
   * Check if an element is interactive (clickable, focusable, or has input capability)
   * @param {Element} element - DOM element to check
   * @returns {boolean} - True if element is interactive
   */
  function isInteractive(element) {
    // Check tag name
    if (INTERACTIVE_TAGS.has(element.tagName)) {
      return true;
    }

    // Check ARIA role
    const role = element.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) {
      return true;
    }

    // Check for onclick handler
    if (element.onclick !== null || element.hasAttribute('onclick')) {
      return true;
    }

    // Check for event listeners via data attributes (common pattern)
    if (
      element.hasAttribute('data-action') ||
      element.hasAttribute('data-onclick')
    ) {
      return true;
    }

    // Check contenteditable
    if (element.isContentEditable) {
      return true;
    }

    // Check tabIndex (focusable elements, excluding body)
    if (element.tabIndex >= 0 && element.tagName !== 'BODY') {
      return true;
    }

    // Check for cursor pointer style (indicates clickability)
    try {
      const style = window.getComputedStyle(element);
      if (style.cursor === 'pointer') {
        return true;
      }
    } catch (e) {
      // Ignore style computation errors
    }

    return false;
  }

  /**
   * Check if an element is visible and within viewport threshold
   * @param {Element} element - DOM element to check
   * @param {number} viewportThreshold - Maximum distance from viewport in pixels
   * @returns {boolean} - True if element is visible and within threshold
   */
  function isVisible(element, viewportThreshold) {
    // Check computed styles
    try {
      const style = window.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) {
        return false;
      }
    } catch (e) {
      // If we can't compute style, assume visible
    }

    // Check element dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    // Viewport filtering: calculate distance from viewport
    const distanceFromViewport = Math.max(
      rect.top - window.innerHeight, // Below viewport
      -rect.bottom, // Above viewport
      rect.left - window.innerWidth, // Right of viewport
      -rect.right // Left of viewport
    );

    // Element is visible if within threshold (negative means inside viewport)
    return distanceFromViewport < viewportThreshold;
  }

  /**
   * Generate a CSS selector for an element
   * Priority: ID > name attribute > path-based selector
   * @param {Element} element - DOM element
   * @returns {string} - CSS selector that uniquely identifies the element
   */
  function generateSelector(element) {
    // If element has ID, use it (most reliable)
    if (element.id) {
      // Escape special characters in ID
      const escapedId = CSS.escape(element.id);
      return `#${escapedId}`;
    }

    // If element has name, use it
    if (element.name) {
      const escapedName = CSS.escape(element.name);
      return `[name="${escapedName}"]`;
    }

    // Generate path-based selector
    const path = [];
    let current = element;

    while (current && current !== document.body && current.parentElement) {
      let selector = current.tagName.toLowerCase();

      // If this element has an ID, use it and stop
      if (current.id) {
        const escapedId = CSS.escape(current.id);
        selector = `#${escapedId}`;
        path.unshift(selector);
        break;
      }

      // Add nth-of-type for disambiguation among siblings
      const siblings = Array.from(current.parentElement.children);
      const sameTagSiblings = siblings.filter(
        (s) => s.tagName === current.tagName
      );

      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current);
        selector += `:nth-of-type(${index + 1})`;
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }

  /**
   * Get text content of an element, excluding child elements
   * @param {Element} element - DOM element
   * @returns {string} - Direct text content
   */
  function getDirectTextContent(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text.trim().slice(0, 200);
  }

  /**
   * Process a DOM element recursively, building a pruned tree
   * @param {Element} element - DOM element to process
   * @param {number} depth - Current recursion depth
   * @param {number} viewportThreshold - Viewport threshold for visibility
   * @param {Array} interactiveElements - Array to collect interactive elements
   * @param {Object} labelCounter - Counter object for label indexing
   * @returns {Object|null} - Pruned element representation or null if filtered
   */
  function processElement(
    element,
    depth,
    viewportThreshold,
    interactiveElements,
    labelCounter
  ) {
    // Prevent deep recursion
    if (depth > MAX_DEPTH) {
      return null;
    }

    // Skip certain tags
    if (SKIP_TAGS.has(element.tagName)) {
      return null;
    }

    // Check visibility
    if (!isVisible(element, viewportThreshold)) {
      return null;
    }

    // Build result object
    const result = {
      tag: element.tagName.toLowerCase(),
    };

    // Get text content
    const textContent = getDirectTextContent(element);
    if (textContent) {
      result.text = textContent;
    }

    // Check if interactive and add label
    if (isInteractive(element)) {
      const label = labelCounter.value;
      result.label = `[${label}]`;

      // Get bounding rect for interactive element
      const rect = element.getBoundingClientRect();

      interactiveElements.push({
        label: label,
        tag: element.tagName,
        text: textContent || element.textContent?.trim().slice(0, 100) || '',
        selector: generateSelector(element),
        attributes: getRelevantAttributes(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
        },
      });

      labelCounter.value++;
    }

    // Add relevant attributes
    const attrs = getRelevantAttributes(element);
    if (Object.keys(attrs).length > 0) {
      Object.assign(result, attrs);
    }

    // Process children
    const children = [];
    for (const child of element.children) {
      const processed = processElement(
        child,
        depth + 1,
        viewportThreshold,
        interactiveElements,
        labelCounter
      );
      if (processed) {
        children.push(processed);
      }
    }

    if (children.length > 0) {
      result.children = children;
    }

    // Don't return empty containers without content
    if (
      !result.text &&
      !result.label &&
      (!result.children || result.children.length === 0)
    ) {
      // Check if it has any useful attributes
      const hasUsefulAttrs = Object.keys(attrs).some((key) =>
        ['id', 'name', 'role', 'aria-label'].includes(key)
      );
      if (!hasUsefulAttrs) {
        return null;
      }
    }

    return result;
  }

  /**
   * Get relevant attributes from an element
   * @param {Element} element - DOM element
   * @returns {Object} - Object with relevant attributes
   */
  function getRelevantAttributes(element) {
    const attrs = {};
    for (const attr of RELEVANT_ATTRIBUTES) {
      const value = element.getAttribute(attr);
      if (value) {
        // Truncate long values
        attrs[attr] = value.slice(0, 200);
      }
    }
    return attrs;
  }

  /**
   * Extract pruned DOM tree optimized for AI consumption
   * @param {number} viewportThreshold - Maximum distance from viewport in pixels
   * @returns {Object} - Extracted DOM data with interactive elements
   */
  function extractPrunedDom(viewportThreshold = DEFAULT_VIEWPORT_THRESHOLD) {
    const interactiveElements = [];
    const labelCounter = { value: 0 };

    // Get document metadata
    const metadata = {
      url: window.location.href,
      title: document.title,
      favicon:
        document.querySelector('link[rel~="icon"]')?.href ||
        `${window.location.origin}/favicon.ico`,
    };

    // Process the DOM tree
    const tree = document.body
      ? processElement(
          document.body,
          0,
          viewportThreshold,
          interactiveElements,
          labelCounter
        )
      : null;

    // Get viewport information
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
    };

    return {
      ...metadata,
      tree,
      interactiveElements,
      viewport,
      extractedAt: new Date().toISOString(),
      stats: {
        interactiveCount: interactiveElements.length,
        viewportThreshold,
      },
    };
  }

  /**
   * Find a specific interactive element by its label
   * @param {number} label - The label index of the element
   * @param {Array} interactiveElements - Array of interactive elements from extraction
   * @returns {Element|null} - The DOM element or null if not found
   */
  function findElementByLabel(label, interactiveElements) {
    const info = interactiveElements.find((el) => el.label === label);
    if (!info) {
      return null;
    }

    try {
      return document.querySelector(info.selector);
    } catch (e) {
      console.error('Failed to find element by selector:', info.selector, e);
      return null;
    }
  }

  /**
   * Execute an action on an element by label
   * @param {string} action - The action to perform (click, type, scroll)
   * @param {number} label - The label index of the target element
   * @param {any} value - Optional value for the action (e.g., text to type)
   * @param {Array} interactiveElements - Array of interactive elements
   * @returns {Object} - Result of the action
   */
  function executeAction(action, label, value, interactiveElements) {
    const element = findElementByLabel(label, interactiveElements);

    if (!element) {
      return {
        success: false,
        error: `Element with label [${label}] not found`,
      };
    }

    try {
      switch (action) {
        case 'click':
          element.click();
          return { success: true, action: 'click', label };

        case 'type':
          if (
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.isContentEditable
          ) {
            element.focus();
            element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, action: 'type', label, value };
          }
          return { success: false, error: 'Element is not typeable' };

        case 'focus':
          element.focus();
          return { success: true, action: 'focus', label };

        case 'hover':
          element.dispatchEvent(
            new MouseEvent('mouseenter', { bubbles: true })
          );
          element.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true })
          );
          return { success: true, action: 'hover', label };

        case 'scroll_to':
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { success: true, action: 'scroll_to', label };

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Store last extraction for action execution
  let lastExtraction = null;

  /**
   * Wait for DOM to be ready (document.body exists)
   * @returns {Promise<boolean>} True when DOM is ready
   */
  function waitForDomReady(timeout = 5000) {
    return new Promise((resolve) => {
      if (document.body) {
        resolve(true);
        return;
      }

      const startTime = Date.now();
      const checkBody = () => {
        if (document.body) {
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          resolve(false);
        } else {
          requestAnimationFrame(checkBody);
        }
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => resolve(true), { once: true });
      } else {
        checkBody();
      }
    });
  }

  /**
   * Message listener for communication with service worker
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle DOM extraction request
    if (message.type === 'EXTRACT_DOM') {
      // Check if site is allowed before extracting
      if (!isSiteAllowed) {
        sendResponse({
          success: false,
          blocked: true,
          reason: blockReason,
          error: `DOM extraction blocked: ${blockReason}`,
        });
        return true;
      }

      // Wait for DOM to be ready before extracting (async)
      waitForDomReady().then((ready) => {
        if (!ready) {
          sendResponse({
            success: false,
            error: 'DOM not ready - page may still be loading',
          });
          return;
        }

        try {
          const threshold = message.viewportThreshold || DEFAULT_VIEWPORT_THRESHOLD;
          lastExtraction = extractPrunedDom(threshold);

          // Include site context in response
          sendResponse({
            success: true,
            data: lastExtraction,
            siteContext: {
              hostname: window.location.hostname,
              siteSettings: siteSettings,
              hasCustomSettings: siteSettings !== null,
            },
          });
        } catch (error) {
          console.error('DOM extraction error:', error);
          sendResponse({
            success: false,
            error: error.message,
          });
        }
      });

      return true; // Keep channel open for async response
    }

    // Handle action execution request
    if (message.type === 'EXECUTE_ACTION') {
      try {
        const { action, label, value } = message;

        if (!lastExtraction) {
          sendResponse({
            success: false,
            error: 'No DOM extraction available. Extract DOM first.',
          });
          return true;
        }

        const result = executeAction(
          action,
          label,
          value,
          lastExtraction.interactiveElements
        );
        sendResponse(result);
      } catch (error) {
        console.error('Action execution error:', error);
        sendResponse({
          success: false,
          error: error.message,
        });
      }
      return true;
    }

    // Handle scroll request
    if (message.type === 'SCROLL_PAGE') {
      try {
        const { direction, amount } = message;
        const scrollAmount = amount || window.innerHeight * 0.8;

        if (direction === 'down') {
          window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        } else if (direction === 'up') {
          window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        } else if (direction === 'top') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (direction === 'bottom') {
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'smooth',
          });
        }

        sendResponse({ success: true, action: 'scroll', direction });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      return true;
    }

    // Handle ping (health check)
    if (message.type === 'PING') {
      sendResponse({ success: true, ready: true });
      return true;
    }

    // Handle site status check
    if (message.type === 'GET_SITE_STATUS') {
      sendResponse({
        success: true,
        allowed: isSiteAllowed,
        blockReason: blockReason,
        hostname: window.location.hostname,
        url: window.location.href,
        siteSettings: siteSettings,
        hasCustomSettings: siteSettings !== null,
      });
      return true;
    }

    // Handle force re-check of site rules (useful after settings change)
    if (message.type === 'RECHECK_SITE_RULES') {
      checkSiteRules().then(() => {
        sendResponse({
          success: true,
          allowed: isSiteAllowed,
          blockReason: blockReason,
          siteSettings: siteSettings,
        });
      }).catch((error) => {
        sendResponse({
          success: false,
          error: error.message,
        });
      });
      return true; // Keep channel open for async response
    }

    return false;
  });

  // Notify that content script is ready
  console.log('[AI Page Assistant] Content script loaded and ready');
})();
