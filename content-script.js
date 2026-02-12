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

  // =============================================================================
  // Digest / Hash Computation for UI Change Detection
  // =============================================================================

  /**
   * Compute a fast hash (djb2) of a string.
   * Not cryptographic — used only for change detection.
   * @param {string} str
   * @returns {string} hex hash
   */
  function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * Compute a digest string from an array of interactive elements.
   * The digest captures role/tag, name/text, and visibility so that
   * any meaningful UI change produces a different digest.
   * @param {Array} elements - interactiveElements from extractPrunedDom
   * @returns {string} digest like "djb2:<hex>"
   */
  function computeInteractablesDigest(elements) {
    if (!elements || elements.length === 0) return 'djb2:empty';
    const canonical = elements.map(el => {
      const tag = (el.tag || '').toLowerCase();
      const text = (el.text || '').trim().slice(0, 40);
      const role = el.attributes?.role || '';
      const ariaLabel = el.attributes?.['aria-label'] || '';
      const name = el.attributes?.name || '';
      return `${tag}|${role}|${name}|${ariaLabel}|${text}`;
    }).join('\n');
    return 'djb2:' + djb2Hash(canonical);
  }

  // =============================================================================
  // Element Signature for Staleness Detection
  // =============================================================================

  /**
   * Build a lightweight signature for an interactive element.
   * Used to verify that a resolved element is still the "same" element
   * and hasn't been replaced by a different one at the same CSS path.
   * @param {Element} element - DOM element
   * @returns {Object} signature { tag, role, name, ariaLabel, type, text }
   */
  function buildElementSignature(element) {
    return {
      tag: element.tagName,
      role: element.getAttribute('role') || '',
      name: element.getAttribute('name') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      type: element.getAttribute('type') || '',
      text: (element.textContent || '').trim().slice(0, 60)
    };
  }

  /**
   * Check whether a resolved element matches the expected signature.
   * Returns true if it looks like the same element.
   * @param {Element} element - resolved DOM element
   * @param {Object} signature - expected signature
   * @returns {boolean}
   */
  function signatureMatches(element, signature) {
    if (!element || !signature) return false;
    // Tag must match exactly
    if (element.tagName !== signature.tag) return false;
    // Role must match if the original had one
    if (signature.role && (element.getAttribute('role') || '') !== signature.role) return false;
    // Name must match if the original had one
    if (signature.name && (element.getAttribute('name') || '') !== signature.name) return false;
    return true;
  }

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
        signature: buildElementSignature(element),
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

    // Compute digest for UI change detection
    const digest = computeInteractablesDigest(interactiveElements);

    return {
      ...metadata,
      tree,
      interactiveElements,
      viewport,
      digest,
      extractedAt: new Date().toISOString(),
      stats: {
        interactiveCount: interactiveElements.length,
        viewportThreshold,
      },
    };
  }

  /**
   * Find a specific interactive element by its label, with signature verification.
   * Returns { element, status } where status is 'ok', 'stale', or 'not_found'.
   * On 'stale', attempts reacquisition by signature match.
   * @param {number} label - The label index of the element
   * @param {Array} interactiveElements - Array of interactive elements from extraction
   * @returns {{ element: Element|null, status: string, reacquiredLabel?: number }}
   */
  function findElementByLabel(label, interactiveElements) {
    const info = interactiveElements.find((el) => el.label === label);
    if (!info) {
      return { element: null, status: 'not_found' };
    }

    let element = null;
    try {
      element = document.querySelector(info.selector);
    } catch (e) {
      console.error('Failed to find element by selector:', info.selector, e);
    }

    if (!element) {
      // Element gone — attempt reacquisition by signature
      if (info.signature) {
        const reacquired = attemptReacquire(info.signature, interactiveElements);
        if (reacquired) {
          return { element: reacquired.element, status: 'reacquired', reacquiredLabel: reacquired.label };
        }
      }
      return { element: null, status: 'not_found' };
    }

    // Verify signature
    if (info.signature && !signatureMatches(element, info.signature)) {
      // Selector resolved to a DIFFERENT element — this is stale
      console.warn('[ContentScript] Stale element at label', label, '— signature mismatch');
      const reacquired = attemptReacquire(info.signature, interactiveElements);
      if (reacquired) {
        return { element: reacquired.element, status: 'reacquired', reacquiredLabel: reacquired.label };
      }
      return { element: null, status: 'stale' };
    }

    return { element, status: 'ok' };
  }

  /**
   * Attempt to find an element matching a signature anywhere in the current DOM.
   * Used for reacquisition when the original selector fails or resolves wrong.
   * @param {Object} signature - Expected element signature
   * @param {Array} interactiveElements - Current interactive elements list
   * @returns {{ element: Element, label: number }|null}
   */
  function attemptReacquire(signature, interactiveElements) {
    for (const info of interactiveElements) {
      try {
        const el = document.querySelector(info.selector);
        if (el && signatureMatches(el, signature)) {
          // Check text similarity (fuzzy — first 30 chars)
          const elText = (el.textContent || '').trim().slice(0, 30);
          const sigText = (signature.text || '').slice(0, 30);
          if (!sigText || elText.includes(sigText) || sigText.includes(elText)) {
            console.log('[ContentScript] Reacquired element at label', info.label);
            return { element: el, label: info.label };
          }
        }
      } catch (e) {
        // Skip invalid selectors
      }
    }
    return null;
  }

  /**
   * Capture a lightweight before/after state snapshot for diff computation.
   * @returns {Object} snapshot { url, title, digest, scrollY }
   */
  function captureStateSnapshot() {
    const digest = lastExtraction
      ? computeInteractablesDigest(lastExtraction.interactiveElements)
      : 'djb2:no_extraction';
    return {
      url: window.location.href,
      title: document.title,
      digest,
      scrollY: window.scrollY,
    };
  }

  /**
   * Compute diff between two state snapshots.
   * @param {Object} before - snapshot before action
   * @param {Object} after - snapshot after action
   * @returns {Object} diff flags
   */
  function computeStateDiff(before, after) {
    return {
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      uiChanged: before.digest !== after.digest,
      scrollChanged: before.scrollY !== after.scrollY,
    };
  }

  /**
   * Detect visible toasts/alerts (role=alert, role=status, common class patterns).
   * @returns {string[]} array of toast text strings
   */
  function detectToasts() {
    const toasts = [];
    // ARIA roles
    const alertEls = document.querySelectorAll('[role="alert"], [role="status"]');
    alertEls.forEach(el => {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          const text = (el.textContent || '').trim().slice(0, 200);
          if (text) toasts.push(text);
        }
      }
    });
    // Common class patterns
    const classPatterns = document.querySelectorAll(
      '.toast, .snackbar, .notification, [class*="toast"], [class*="snackbar"], [class*="Toastify"]'
    );
    classPatterns.forEach(el => {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const text = (el.textContent || '').trim().slice(0, 200);
          if (text && !toasts.includes(text)) toasts.push(text);
        }
      }
    });
    return toasts;
  }

  /**
   * Detect if a modal/dialog is likely open.
   * @returns {{ isModalLikelyOpen: boolean, modalSummary: Object|null }}
   */
  function detectModal() {
    // Check for dialog elements
    const dialogs = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    );
    for (const el of dialogs) {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          // Found a visible modal
          const title = el.querySelector('h1, h2, h3, [class*="title"], [class*="header"]');
          const closeBtn = el.querySelector(
            'button[aria-label*="close" i], button[aria-label*="dismiss" i], button[class*="close" i], button:last-of-type'
          );
          return {
            isModalLikelyOpen: true,
            modalSummary: {
              title: title ? (title.textContent || '').trim().slice(0, 100) : null,
              hasCloseButton: !!closeBtn,
              closeButtonText: closeBtn ? (closeBtn.textContent || '').trim().slice(0, 40) : null,
            }
          };
        }
      }
    }
    // Heuristic: large fixed/absolute overlay covering most of viewport
    const allFixed = document.querySelectorAll('*');
    for (const el of allFixed) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'absolute') &&
          style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5 &&
            parseFloat(style.zIndex) > 100) {
          return {
            isModalLikelyOpen: true,
            modalSummary: { title: null, hasCloseButton: false, closeButtonText: null }
          };
        }
      }
    }
    return { isModalLikelyOpen: false, modalSummary: null };
  }

  /**
   * Execute an action on an element by label.
   * Returns structured result with before/after diff and toast/modal signals.
   * @param {string} action - The action to perform (click, type, scroll)
   * @param {number} label - The label index of the target element
   * @param {any} value - Optional value for the action (e.g., text to type)
   * @param {Array} interactiveElements - Array of interactive elements
   * @returns {Object} - Result of the action including diff
   */
  function executeAction(action, label, value, interactiveElements) {
    // Capture before-state
    const beforeState = captureStateSnapshot();
    const beforeToasts = detectToasts();

    const found = findElementByLabel(label, interactiveElements);

    if (found.status === 'not_found' || found.status === 'stale') {
      return {
        success: false,
        error: found.status === 'stale'
          ? `ELEMENT_STALE: Element [${label}] selector resolved to a different element`
          : `Element with label [${label}] not found`,
        elementStatus: found.status,
      };
    }

    const element = found.element;
    const reacquiredInfo = found.status === 'reacquired'
      ? { reacquiredTarget: true, newLabel: found.reacquiredLabel }
      : {};

    try {
      let actionResult;
      switch (action) {
        case 'click':
          element.click();
          actionResult = { success: true, action: 'click', label };
          break;

        case 'type':
          if (
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA'
          ) {
            element.focus();
            element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            actionResult = { success: true, action: 'type', label, value };
          } else if (element.isContentEditable) {
            element.focus();
            element.textContent = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            actionResult = { success: true, action: 'type', label, value };
          } else {
            return { success: false, error: 'Element is not typeable' };
          }
          break;

        case 'focus':
          element.focus();
          actionResult = { success: true, action: 'focus', label };
          break;

        case 'hover':
          element.dispatchEvent(
            new MouseEvent('mouseenter', { bubbles: true })
          );
          element.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true })
          );
          actionResult = { success: true, action: 'hover', label };
          break;

        case 'scroll_to':
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          actionResult = { success: true, action: 'scroll_to', label };
          break;

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }

      // Capture after-state and compute diff
      const afterState = captureStateSnapshot();
      const diff = computeStateDiff(beforeState, afterState);
      const afterToasts = detectToasts();
      const newToasts = afterToasts.filter(t => !beforeToasts.includes(t));
      const modal = detectModal();

      return {
        ...actionResult,
        ...reacquiredInfo,
        diff: {
          ...diff,
          newToasts,
          modalOpened: modal.isModalLikelyOpen,
        },
        modal: modal.isModalLikelyOpen ? modal.modalSummary : undefined,
      };

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
