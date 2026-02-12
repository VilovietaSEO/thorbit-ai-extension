/**
 * Content Script: Action Executor
 *
 * Executes click/type/hover/focus/scroll actions on elements.
 * Uses signature verification and captures before/after diffs.
 */
(function () {
  'use strict';

  const T = window.__thorbit;

  // =========================================================================
  // Element Resolution with Signature Verification
  // =========================================================================

  /**
   * Find an interactive element by label, with signature verification.
   * @param {number} label
   * @param {Array} interactiveElements
   * @returns {{ element: Element|null, status: string, reacquiredLabel?: number }}
   */
  function findElementByLabel(label, interactiveElements) {
    const info = interactiveElements.find(el => el.label === label);
    if (!info) return { element: null, status: 'not_found' };

    let element = null;
    try {
      element = document.querySelector(info.selector);
    } catch (e) {
      console.error('Failed to find element by selector:', info.selector, e);
    }

    if (!element) {
      if (info.signature) {
        const reacquired = attemptReacquire(info.signature, interactiveElements);
        if (reacquired) return { element: reacquired.element, status: 'reacquired', reacquiredLabel: reacquired.label };
      }
      return { element: null, status: 'not_found' };
    }

    // Verify signature
    if (info.signature && !T.signatureMatches(element, info.signature)) {
      console.warn('[ContentScript] Stale element at label', label, '— signature mismatch');
      const reacquired = attemptReacquire(info.signature, interactiveElements);
      if (reacquired) return { element: reacquired.element, status: 'reacquired', reacquiredLabel: reacquired.label };
      return { element: null, status: 'stale' };
    }

    return { element, status: 'ok' };
  }

  /**
   * Attempt to find an element matching a signature for reacquisition.
   * @param {Object} signature
   * @param {Array} interactiveElements
   * @returns {{ element: Element, label: number }|null}
   */
  function attemptReacquire(signature, interactiveElements) {
    for (const info of interactiveElements) {
      try {
        const el = document.querySelector(info.selector);
        if (el && T.signatureMatches(el, signature)) {
          const elText = (el.textContent || '').trim().slice(0, 30);
          const sigText = (signature.text || '').slice(0, 30);
          if (!sigText || elText.includes(sigText) || sigText.includes(elText)) {
            console.log('[ContentScript] Reacquired element at label', info.label);
            return { element: el, label: info.label };
          }
        }
      } catch (e) { /* skip invalid selectors */ }
    }
    return null;
  }

  // =========================================================================
  // Action Execution
  // =========================================================================

  /**
   * Execute an action on an element by label.
   * Returns structured result with before/after diff and toast/modal signals.
   * @param {string} action
   * @param {number} label
   * @param {any} value
   * @param {Array} interactiveElements
   * @returns {Object}
   */
  function executeAction(action, label, value, interactiveElements) {
    const beforeState = T.captureStateSnapshot();
    const beforeToasts = T.detectToasts();

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
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
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
          element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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
      const afterState = T.captureStateSnapshot();
      const diff = T.computeStateDiff(beforeState, afterState);
      const afterToasts = T.detectToasts();
      const newToasts = afterToasts.filter(t => !beforeToasts.includes(t));
      const modal = T.detectModal();

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

  // =========================================================================
  // Exports
  // =========================================================================

  T.findElementByLabel = findElementByLabel;
  T.executeAction = executeAction;
})();
