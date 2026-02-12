/**
 * Content Script: DOM Extractor
 *
 * Extracts a pruned DOM tree optimized for AI consumption.
 * Detects interactive elements, computes digests, builds signatures.
 */
(function () {
  'use strict';

  const T = window.__thorbit;

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Check if an element is interactive
   * @param {Element} element
   * @returns {boolean}
   */
  function isInteractive(element) {
    if (T.INTERACTIVE_TAGS.has(element.tagName)) return true;
    const role = element.getAttribute('role');
    if (role && T.INTERACTIVE_ROLES.has(role)) return true;
    if (element.onclick !== null || element.hasAttribute('onclick')) return true;
    if (element.hasAttribute('data-action') || element.hasAttribute('data-onclick')) return true;
    if (element.isContentEditable) return true;
    if (element.tabIndex >= 0 && element.tagName !== 'BODY') return true;
    try {
      if (window.getComputedStyle(element).cursor === 'pointer') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * Check if an element is visible and within viewport threshold
   * @param {Element} element
   * @param {number} viewportThreshold
   * @returns {boolean}
   */
  function isVisible(element, viewportThreshold) {
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    } catch (e) { /* assume visible */ }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    const distanceFromViewport = Math.max(
      rect.top - window.innerHeight,
      -rect.bottom,
      rect.left - window.innerWidth,
      -rect.right
    );
    return distanceFromViewport < viewportThreshold;
  }

  /**
   * Generate a CSS selector for an element
   * @param {Element} element
   * @returns {string}
   */
  function generateSelector(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    if (element.name) return `[name="${CSS.escape(element.name)}"]`;

    const path = [];
    let current = element;
    while (current && current !== document.body && current.parentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = Array.from(current.parentElement.children);
      const sameTagSiblings = siblings.filter(s => s.tagName === current.tagName);
      if (sameTagSiblings.length > 1) {
        selector += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  /**
   * Get direct text content of an element (excluding child elements)
   * @param {Element} element
   * @returns {string}
   */
  function getDirectTextContent(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim().slice(0, 200);
  }

  /**
   * Get relevant attributes from an element
   * @param {Element} element
   * @returns {Object}
   */
  function getRelevantAttributes(element) {
    const attrs = {};
    for (const attr of T.RELEVANT_ATTRIBUTES) {
      const value = element.getAttribute(attr);
      if (value) attrs[attr] = value.slice(0, 200);
    }
    return attrs;
  }

  // =========================================================================
  // Recursive DOM Processing
  // =========================================================================

  /**
   * Process a DOM element recursively, building a pruned tree
   * @param {Element} element
   * @param {number} depth
   * @param {number} viewportThreshold
   * @param {Array} interactiveElements
   * @param {Object} labelCounter
   * @returns {Object|null}
   */
  function processElement(element, depth, viewportThreshold, interactiveElements, labelCounter) {
    if (depth > T.MAX_DEPTH) return null;
    if (T.SKIP_TAGS.has(element.tagName)) return null;
    if (!isVisible(element, viewportThreshold)) return null;

    const result = { tag: element.tagName.toLowerCase() };
    const textContent = getDirectTextContent(element);
    if (textContent) result.text = textContent;

    if (isInteractive(element)) {
      const label = labelCounter.value;
      result.label = `[${label}]`;
      const rect = element.getBoundingClientRect();

      interactiveElements.push({
        label,
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
        signature: T.buildElementSignature(element),
      });
      labelCounter.value++;
    }

    const attrs = getRelevantAttributes(element);
    if (Object.keys(attrs).length > 0) Object.assign(result, attrs);

    const children = [];
    for (const child of element.children) {
      const processed = processElement(child, depth + 1, viewportThreshold, interactiveElements, labelCounter);
      if (processed) children.push(processed);
    }
    if (children.length > 0) result.children = children;

    if (!result.text && !result.label && (!result.children || result.children.length === 0)) {
      const hasUsefulAttrs = Object.keys(attrs).some(key =>
        ['id', 'name', 'role', 'aria-label'].includes(key)
      );
      if (!hasUsefulAttrs) return null;
    }
    return result;
  }

  // =========================================================================
  // Main Extraction
  // =========================================================================

  /**
   * Extract pruned DOM tree optimized for AI consumption.
   * @param {number} viewportThreshold
   * @returns {Object}
   */
  function extractPrunedDom(viewportThreshold) {
    viewportThreshold = viewportThreshold || T.DEFAULT_VIEWPORT_THRESHOLD;
    const startTime = performance.now();
    const interactiveElements = [];
    const labelCounter = { value: 0 };

    const metadata = {
      url: window.location.href,
      title: document.title,
      favicon: document.querySelector('link[rel~="icon"]')?.href || `${window.location.origin}/favicon.ico`,
    };

    const tree = document.body
      ? processElement(document.body, 0, viewportThreshold, interactiveElements, labelCounter)
      : null;

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
    };

    const digest = T.computeInteractablesDigest(interactiveElements);
    const modal = T.detectModal();
    const toasts = T.detectToasts();
    const scanTimeMs = Math.round(performance.now() - startTime);

    return {
      ...metadata,
      tree,
      interactiveElements,
      viewport,
      digest,
      modal,
      toasts,
      extractedAt: new Date().toISOString(),
      stats: {
        interactiveCount: interactiveElements.length,
        viewportThreshold,
        scanTimeMs,
      },
      provider: 'dom',
    };
  }

  /**
   * Wait for DOM to be ready (document.body exists)
   * @returns {Promise<boolean>}
   */
  function waitForDomReady(timeout) {
    timeout = timeout || 5000;
    return new Promise((resolve) => {
      if (document.body) { resolve(true); return; }
      const startTime = Date.now();
      const checkBody = () => {
        if (document.body) resolve(true);
        else if (Date.now() - startTime > timeout) resolve(false);
        else requestAnimationFrame(checkBody);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => resolve(true), { once: true });
      } else {
        checkBody();
      }
    });
  }

  // =========================================================================
  // Exports
  // =========================================================================

  T.isInteractive = isInteractive;
  T.isVisible = isVisible;
  T.generateSelector = generateSelector;
  T.extractPrunedDom = extractPrunedDom;
  T.waitForDomReady = waitForDomReady;
})();
