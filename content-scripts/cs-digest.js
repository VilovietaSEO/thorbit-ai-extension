/**
 * Content Script: Digest, Signatures, State Snapshots
 *
 * Provides:
 * - djb2 hash for fast change detection
 * - Interactables digest computation
 * - Element signature building and matching
 * - Before/after state snapshots and diff
 * - Toast detection
 * - Modal detection
 */
(function () {
  'use strict';

  const T = window.__thorbit;

  // =========================================================================
  // Hash
  // =========================================================================

  /**
   * Compute a fast djb2 hash. Not cryptographic — for change detection only.
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
   * Compute a digest from interactive elements.
   * Any meaningful UI change produces a different digest.
   * @param {Array} elements
   * @returns {string} e.g. "djb2:a1b2c3d4"
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

  // =========================================================================
  // Element Signatures
  // =========================================================================

  /**
   * Build a lightweight signature for an interactive element.
   * @param {Element} element
   * @returns {Object}
   */
  function buildElementSignature(element) {
    return {
      tag: element.tagName,
      role: element.getAttribute('role') || '',
      name: element.getAttribute('name') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      type: element.getAttribute('type') || '',
      text: (element.textContent || '').trim().slice(0, 60),
    };
  }

  /**
   * Check whether a resolved element matches the expected signature.
   * @param {Element} element
   * @param {Object} signature
   * @returns {boolean}
   */
  function signatureMatches(element, signature) {
    if (!element || !signature) return false;
    if (element.tagName !== signature.tag) return false;
    if (signature.role && (element.getAttribute('role') || '') !== signature.role) return false;
    if (signature.name && (element.getAttribute('name') || '') !== signature.name) return false;
    return true;
  }

  // =========================================================================
  // State Snapshots & Diff
  // =========================================================================

  /**
   * Capture a lightweight state snapshot for diff computation.
   * @returns {Object}
   */
  function captureStateSnapshot() {
    const digest = T.lastExtraction
      ? computeInteractablesDigest(T.lastExtraction.interactiveElements)
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
   * @param {Object} before
   * @param {Object} after
   * @returns {Object}
   */
  function computeStateDiff(before, after) {
    return {
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      uiChanged: before.digest !== after.digest,
      scrollChanged: before.scrollY !== after.scrollY,
    };
  }

  // =========================================================================
  // Toast Detection
  // =========================================================================

  /**
   * Detect visible toasts/alerts.
   * @returns {string[]}
   */
  function detectToasts() {
    const toasts = [];
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

  // =========================================================================
  // Modal Detection
  // =========================================================================

  /**
   * Detect if a modal/dialog is likely open.
   * @returns {{ isModalLikelyOpen: boolean, modalSummary: Object|null }}
   */
  function detectModal() {
    const dialogs = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    );
    for (const el of dialogs) {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
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
            },
          };
        }
      }
    }
    // Heuristic: large fixed overlay covering most of viewport
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (!(el instanceof HTMLElement)) continue;
      const style = window.getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'absolute') &&
          style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5 &&
            parseFloat(style.zIndex) > 100) {
          return {
            isModalLikelyOpen: true,
            modalSummary: { title: null, hasCloseButton: false, closeButtonText: null },
          };
        }
      }
    }
    return { isModalLikelyOpen: false, modalSummary: null };
  }

  // =========================================================================
  // Exports
  // =========================================================================

  T.djb2Hash = djb2Hash;
  T.computeInteractablesDigest = computeInteractablesDigest;
  T.buildElementSignature = buildElementSignature;
  T.signatureMatches = signatureMatches;
  T.captureStateSnapshot = captureStateSnapshot;
  T.computeStateDiff = computeStateDiff;
  T.detectToasts = detectToasts;
  T.detectModal = detectModal;
})();
