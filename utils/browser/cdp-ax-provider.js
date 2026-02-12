/**
 * CDPAXProvider — Day 2 Browser Provider
 *
 * Uses Chrome DevTools Protocol to:
 * - Scan the accessibility tree (Accessibility.getFullAXTree)
 * - Get layout bounds via DOMSnapshot.captureSnapshot
 * - Execute actions via Input.dispatchMouseEvent / Input.dispatchKeyEvent
 *
 * Falls back to DOMProvider on errors.
 */

import { BrowserProvider } from './browser-provider.js';
import { getCDPSession } from './cdp-session.js';

// =============================================================================
// Constants
// =============================================================================

/** AX roles considered interactable */
const INTERACTABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'menuitem',
  'tab', 'checkbox', 'radio', 'option', 'switch', 'slider', 'spinbutton',
  'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'listbox',
]);

/** Role priority for ranking (lower = higher priority) */
const ROLE_PRIORITY = {
  searchbox: 0, textbox: 1, combobox: 2,
  button: 3, link: 4, tab: 5,
  menuitem: 6, checkbox: 7, radio: 8, switch: 9,
  option: 10, slider: 11, spinbutton: 12,
};

// =============================================================================
// CDPAXProvider
// =============================================================================

class CDPAXProvider extends BrowserProvider {
  constructor() {
    super('cdp_ax');
    this.cdp = getCDPSession();

    /** @type {Map<number, Object>} tabId → last scan result */
    this._lastScans = new Map();

    /** @type {Map<number, Map<number, Object>>} tabId → backendNodeId → bounds */
    this._boundsCache = new Map();
  }

  // ===========================================================================
  // AX Tree Scanning
  // ===========================================================================

  /**
   * Fetch and process the full AX tree + DOMSnapshot for bounds.
   * @param {number} tabId
   * @returns {Promise<Object>} processed scan { elements[], digest, frameSummary, stats }
   */
  async _scanAXTree(tabId) {
    const startTime = performance.now();

    // Fire AX tree and DOMSnapshot in parallel
    const [axResult, snapshotResult] = await Promise.all([
      this.cdp.send(tabId, 'Accessibility.getFullAXTree', {}),
      this.cdp.send(tabId, 'DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity'],
        includeDOMRects: true,
        includePaintOrder: false,
      }).catch(err => {
        console.warn('[CDPAXProvider] DOMSnapshot failed, continuing without bounds:', err.message);
        return null;
      }),
    ]);

    // Build backendNodeId → bounds map from snapshot
    const boundsMap = new Map();
    if (snapshotResult?.documents) {
      for (const doc of snapshotResult.documents) {
        const layout = doc.layout;
        if (!layout) continue;
        const nodeIndex = layout.nodeIndex || [];
        const bounds = layout.bounds || [];
        const backendNodeIds = doc.nodes?.backendNodeId || [];
        for (let i = 0; i < nodeIndex.length; i++) {
          const ni = nodeIndex[i];
          const bid = backendNodeIds[ni];
          const b = bounds[i];
          if (bid !== undefined && b) {
            boundsMap.set(bid, { x: b[0], y: b[1], w: b[2], h: b[3] });
          }
        }
      }
    }
    this._boundsCache.set(tabId, boundsMap);

    // Process AX nodes
    const axNodes = axResult?.nodes || [];
    const elements = [];
    let idCounter = 0;

    for (const node of axNodes) {
      if (node.ignored) continue;

      const role = node.role?.value || '';
      const name = node.name?.value || '';
      const backendNodeId = node.backendDOMNodeId;

      // Filter: keep interactable roles or nodes with focusable/editable properties
      const isInteractableRole = INTERACTABLE_ROLES.has(role);
      const properties = this._extractProperties(node.properties || []);
      const isFocusable = properties.focusable === true;
      const isEditable = properties.editable === true || role === 'textbox' || role === 'searchbox';

      if (!isInteractableRole && !isFocusable && !isEditable) continue;

      // Skip generic/unnamed elements (unless they're editable)
      if (role === 'generic' && !name && !isEditable) continue;

      // Get bounds
      let bounds = null;
      if (backendNodeId !== undefined && boundsMap.has(backendNodeId)) {
        bounds = boundsMap.get(backendNodeId);
      }

      // Visibility inference
      let isVisible = true;
      if (bounds) {
        // Check if bounds intersect with viewport (approximate — we don't have viewport info from CDP, use page coords)
        if (bounds.w <= 0 || bounds.h <= 0) isVisible = false;
      }

      if (!isVisible) continue;

      const targetId = `ax_${idCounter++}`;

      elements.push({
        id: targetId,
        axNodeId: node.nodeId,
        backendNodeId: backendNodeId || null,
        role,
        name,
        states: {
          focusable: properties.focusable || false,
          editable: isEditable,
          disabled: properties.disabled || false,
          expanded: properties.expanded ?? null,
          checked: properties.checked ?? null,
        },
        bounds: bounds ? [bounds.x, bounds.y, bounds.w, bounds.h] : null,
        frameId: null, // Day 2 pragmatic: top frame only
        isVisible,
        // Keep label for backward compat with DOM provider format
        label: elements.length,
        tag: role.toUpperCase(),
        text: name,
        selector: null, // AX targets don't use CSS selectors
        attributes: { role, 'aria-label': name },
        rect: bounds ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, top: bounds.y, left: bounds.x } : null,
        signature: { tag: role.toUpperCase(), role, name, ariaLabel: name, type: '', text: name },
      });
    }

    // Rank elements
    elements.sort((a, b) => {
      // Visible + enabled first
      if (a.states.disabled !== b.states.disabled) return a.states.disabled ? 1 : -1;
      // Role priority
      const aPri = ROLE_PRIORITY[a.role] ?? 99;
      const bPri = ROLE_PRIORITY[b.role] ?? 99;
      if (aPri !== bPri) return aPri - bPri;
      // Name quality
      const aHasName = a.name && a.name !== '...' && a.name !== 'More';
      const bHasName = b.name && b.name !== '...' && b.name !== 'More';
      if (aHasName !== bHasName) return aHasName ? -1 : 1;
      return 0;
    });

    // Re-assign labels after sort
    elements.forEach((el, i) => { el.label = i; });

    // Compute digest
    const digest = this._computeDigest(elements);
    const scanTimeMs = Math.round(performance.now() - startTime);

    const result = {
      elements,
      digest,
      frameSummary: { frames: 1, unsupportedFrames: 0 },
      stats: {
        interactiveCount: elements.length,
        scanTimeMs,
        axNodesTotal: axNodes.length,
        boundsAvailable: boundsMap.size,
      },
      provider: 'cdp_ax',
    };

    this._lastScans.set(tabId, result);
    return result;
  }

  /**
   * Extract properties from AX node property list.
   * @param {Array} properties
   * @returns {Object}
   */
  _extractProperties(properties) {
    const result = {};
    for (const prop of properties) {
      const name = prop.name;
      const value = prop.value?.value;
      if (name === 'focusable') result.focusable = value;
      else if (name === 'editable') result.editable = value;
      else if (name === 'disabled') result.disabled = value;
      else if (name === 'expanded') result.expanded = value;
      else if (name === 'checked') result.checked = value;
    }
    return result;
  }

  /**
   * Compute digest from AX-based elements.
   * @param {Array} elements
   * @returns {string}
   */
  _computeDigest(elements) {
    if (!elements || elements.length === 0) return 'djb2:empty';
    let hash = 5381;
    for (const el of elements) {
      const str = `${el.role}|${el.name}|${el.states.disabled}`;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
      }
    }
    return 'djb2:' + hash.toString(16).padStart(8, '0');
  }

  // ===========================================================================
  // CDP Input Actions
  // ===========================================================================

  /**
   * Execute a CDP coordinate click.
   * @param {number} tabId
   * @param {number} x - page x coordinate
   * @param {number} y - page y coordinate
   */
  async _cdpClick(tabId, x, y) {
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  }

  /**
   * Type text via CDP. First clicks to focus, then inserts text.
   * @param {number} tabId
   * @param {number} x - click x
   * @param {number} y - click y
   * @param {string} text
   */
  async _cdpType(tabId, x, y, text) {
    // Click to focus
    await this._cdpClick(tabId, x, y);
    await new Promise(r => setTimeout(r, 100));

    // Select all existing text (Ctrl+A) then type new text
    await this._cdpKeyCombo(tabId, 'a', ['control']);
    await new Promise(r => setTimeout(r, 50));

    // Use insertText for reliable input on SPAs
    await this.cdp.send(tabId, 'Input.insertText', { text });
  }

  /**
   * Press a single key via CDP.
   * @param {number} tabId
   * @param {string} key - key name (e.g. 'Enter', 'Tab', 'Escape')
   */
  async _cdpPressKey(tabId, key) {
    const keyDef = KEY_DEFINITIONS[key] || { key, code: `Key${key.toUpperCase()}` };
    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode || 0,
    });
    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode || 0,
    });
  }

  /**
   * Press a key combo (e.g. Ctrl+A).
   * @param {number} tabId
   * @param {string} key
   * @param {string[]} modifiers - ['control', 'alt', 'shift', 'meta']
   */
  async _cdpKeyCombo(tabId, key, modifiers = []) {
    const modBits = modifiers.reduce((acc, m) => acc | MODIFIER_MAP[m] || 0, 0);
    const keyDef = KEY_DEFINITIONS[key] || { key, code: `Key${key.toUpperCase()}` };
    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode || 0,
      modifiers: modBits,
    });
    await this.cdp.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode || 0,
      modifiers: modBits,
    });
  }

  /**
   * Scroll via CDP mouse wheel.
   * @param {number} tabId
   * @param {number} deltaY - positive = down, negative = up
   * @param {number} [x=400] - x coordinate for wheel event
   * @param {number} [y=300] - y coordinate for wheel event
   */
  async _cdpScroll(tabId, deltaY, x = 400, y = 300) {
    await this.cdp.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY,
    });
  }

  // ===========================================================================
  // Target Resolution
  // ===========================================================================

  /**
   * Resolve a target label to its click coordinates.
   * @param {number} tabId
   * @param {number} label
   * @returns {Promise<{ x: number, y: number, element: Object }|null>}
   */
  async _resolveTarget(tabId, label) {
    const lastScan = this._lastScans.get(tabId);
    if (!lastScan) return null;

    const element = lastScan.elements.find(el => el.label === label);
    if (!element) return null;

    if (element.bounds) {
      const [bx, by, bw, bh] = element.bounds;
      return {
        x: Math.round(bx + bw / 2),
        y: Math.round(by + bh / 2),
        element,
      };
    }

    // No bounds — attempt to get via DOM.getBoxModel using backendNodeId
    if (element.backendNodeId) {
      try {
        const boxModel = await this.cdp.send(tabId, 'DOM.getBoxModel', {
          backendNodeId: element.backendNodeId,
        });
        if (boxModel?.model?.content) {
          const content = boxModel.model.content;
          const cx = (content[0] + content[2] + content[4] + content[6]) / 4;
          const cy = (content[1] + content[3] + content[5] + content[7]) / 4;
          return { x: Math.round(cx), y: Math.round(cy), element };
        }
      } catch (e) {
        console.warn('[CDPAXProvider] getBoxModel failed for', element.backendNodeId, e.message);
      }
    }

    return null;
  }

  // ===========================================================================
  // Staleness & Reacquisition
  // ===========================================================================

  /**
   * Check if a target is stale and attempt reacquisition.
   * @param {number} tabId
   * @param {number} label
   * @returns {Promise<Object>} { target, status: 'ok'|'reacquired'|'stale' }
   */
  async _verifyTarget(tabId, label) {
    // Re-scan to get fresh state
    const freshScan = await this._scanAXTree(tabId);
    const original = this._lastScans.get(tabId)?.elements.find(el => el.label === label);

    if (!original) return { target: null, status: 'not_found' };

    // Try to find by axNodeId first
    let match = freshScan.elements.find(el => el.axNodeId === original.axNodeId);
    if (match) return { target: match, status: 'ok' };

    // Try by backendNodeId
    if (original.backendNodeId) {
      match = freshScan.elements.find(el => el.backendNodeId === original.backendNodeId);
      if (match) return { target: match, status: 'ok' };
    }

    // Reacquisition: find by role + name
    match = freshScan.elements.find(el =>
      el.role === original.role && el.name === original.name && !el.states.disabled
    );
    if (match) return { target: match, status: 'reacquired' };

    return { target: null, status: 'stale' };
  }

  // ===========================================================================
  // BrowserProvider Interface
  // ===========================================================================

  async getState(tabId) {
    await this.cdp.ensureAttached(tabId);

    // Get page info via Runtime.evaluate
    const evalResult = await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href, title: document.title })',
      returnByValue: true,
    });
    const pageInfo = JSON.parse(evalResult?.result?.value || '{}');

    // Quick scan for digest
    const scan = await this._scanAXTree(tabId);

    // Detect modal and toasts via Runtime.evaluate in page context
    const modalResult = await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: `(function() {
        const dialogs = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        for (const el of dialogs) {
          const s = getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden') {
            const t = el.querySelector('h1, h2, h3');
            return JSON.stringify({ isModalLikelyOpen: true, title: t ? t.textContent.trim().slice(0,100) : null });
          }
        }
        return JSON.stringify({ isModalLikelyOpen: false, title: null });
      })()`,
      returnByValue: true,
    });
    const modal = JSON.parse(modalResult?.result?.value || '{}');

    const toastsResult = await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: `(function() {
        const toasts = [];
        document.querySelectorAll('[role="alert"], [role="status"]').forEach(el => {
          const s = getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
            const t = (el.textContent || '').trim().slice(0,200);
            if (t) toasts.push(t);
          }
        });
        return JSON.stringify(toasts);
      })()`,
      returnByValue: true,
    });
    const toasts = JSON.parse(toastsResult?.result?.value || '[]');

    return {
      url: pageInfo.url || '',
      title: pageInfo.title || '',
      digest: scan.digest,
      modal: {
        isModalLikelyOpen: modal.isModalLikelyOpen || false,
        modalSummary: modal.isModalLikelyOpen ? { title: modal.title } : null,
      },
      toasts,
      viewport: null, // Could be fetched but not critical for state
      provider: 'cdp_ax',
      stats: scan.stats,
    };
  }

  async getInteractables(tabId, options = {}) {
    await this.cdp.ensureAttached(tabId);
    const scan = await this._scanAXTree(tabId);
    const maxElements = options.maxElements || 100;

    return {
      scope: options.scope || 'viewport',
      provider: 'cdp_ax',
      elements: scan.elements.slice(0, maxElements),
      digest: scan.digest,
      stats: scan.stats,
      frameSummary: scan.frameSummary,
    };
  }

  async getViewportText(tabId, maxChars = 5000) {
    await this.cdp.ensureAttached(tabId);
    const scan = await this._scanAXTree(tabId);
    const parts = scan.elements.map(el =>
      `[${el.label}] ${el.role}${el.name ? ` "${el.name}"` : ''}${el.states.disabled ? ' (disabled)' : ''}`
    );
    return parts.join('\n').slice(0, maxChars);
  }

  async act(tabId, action) {
    await this.cdp.ensureAttached(tabId);

    // Capture before state
    const beforeDigest = this._lastScans.get(tabId)?.digest || 'unknown';
    const beforeUrl = (await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'location.href', returnByValue: true
    }))?.result?.value || '';
    const beforeTitle = (await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'document.title', returnByValue: true
    }))?.result?.value || '';

    let result;

    switch (action.type) {
      case 'click': {
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        const target = await this._resolveTarget(tabId, action.label);
        if (!target) return { success: false, error: `Cannot resolve target [${action.label}]` };
        await this._cdpClick(tabId, target.x, target.y);
        result = { success: true, action: 'click', label: action.label };
        break;
      }

      case 'type': {
        if (action.label === undefined || !action.value) return { success: false, error: 'Label and value required' };
        const target = await this._resolveTarget(tabId, action.label);
        if (!target) return { success: false, error: `Cannot resolve target [${action.label}]` };
        await this._cdpType(tabId, target.x, target.y, action.value);
        result = { success: true, action: 'type', label: action.label, value: action.value };
        break;
      }

      case 'press_key': {
        if (!action.key) return { success: false, error: 'No key provided' };
        if (action.modifiers && action.modifiers.length > 0) {
          await this._cdpKeyCombo(tabId, action.key, action.modifiers);
        } else {
          await this._cdpPressKey(tabId, action.key);
        }
        result = { success: true, action: 'press_key', key: action.key };
        break;
      }

      case 'scroll': {
        const deltaY = (action.direction === 'up') ? -400 : 400;
        await this._cdpScroll(tabId, deltaY * (action.amount ? action.amount / 400 : 1));
        result = { success: true, action: 'scroll', direction: action.direction || 'down' };
        break;
      }

      case 'navigate': {
        if (!action.url) return { success: false, error: 'No URL provided' };
        let url = action.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        await this.cdp.send(tabId, 'Page.navigate', { url });
        await new Promise(r => setTimeout(r, 2000));
        result = { success: true, action: 'navigate', url };
        break;
      }

      case 'back':
        await this.cdp.send(tabId, 'Runtime.evaluate', {
          expression: 'history.back()', returnByValue: true
        });
        await new Promise(r => setTimeout(r, 1000));
        result = { success: true, action: 'back' };
        break;

      case 'refresh':
        await this.cdp.send(tabId, 'Page.reload', {});
        await new Promise(r => setTimeout(r, 1500));
        result = { success: true, action: 'refresh' };
        break;

      case 'wait':
        await new Promise(r => setTimeout(r, action.ms || 1000));
        result = { success: true, action: 'wait', ms: action.ms || 1000 };
        break;

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }

    // Compute after diff
    await new Promise(r => setTimeout(r, 200)); // Let page settle
    const afterScan = await this._scanAXTree(tabId);
    const afterUrl = (await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'location.href', returnByValue: true
    }))?.result?.value || '';
    const afterTitle = (await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: 'document.title', returnByValue: true
    }))?.result?.value || '';

    // Detect toasts
    const toastsResult = await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: `(function() {
        const toasts = [];
        document.querySelectorAll('[role="alert"], [role="status"]').forEach(el => {
          const s = getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') {
            const t = (el.textContent || '').trim().slice(0,200);
            if (t) toasts.push(t);
          }
        });
        return JSON.stringify(toasts);
      })()`,
      returnByValue: true,
    });
    const newToasts = JSON.parse(toastsResult?.result?.value || '[]');

    // Check modal
    const modalResult = await this.cdp.send(tabId, 'Runtime.evaluate', {
      expression: `(function() {
        const d = document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        if (d && getComputedStyle(d).display !== 'none') return 'true';
        return 'false';
      })()`,
      returnByValue: true,
    });
    const modalOpened = modalResult?.result?.value === 'true';

    result.diff = {
      urlChanged: beforeUrl !== afterUrl,
      titleChanged: beforeTitle !== afterTitle,
      uiChanged: beforeDigest !== afterScan.digest,
      newToasts,
      modalOpened,
    };

    return result;
  }

  async isAvailable(tabId) {
    try {
      await this.cdp.ensureAttached(tabId);
      // Quick test: can we evaluate?
      await this.cdp.send(tabId, 'Runtime.evaluate', {
        expression: '1+1', returnByValue: true
      });
      return true;
    } catch (e) {
      return false;
    }
  }
}

// =============================================================================
// Key Definitions
// =============================================================================

const KEY_DEFINITIONS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  a: { key: 'a', code: 'KeyA', keyCode: 65 },
  c: { key: 'c', code: 'KeyC', keyCode: 67 },
  v: { key: 'v', code: 'KeyV', keyCode: 86 },
  x: { key: 'x', code: 'KeyX', keyCode: 88 },
  l: { key: 'l', code: 'KeyL', keyCode: 76 },
  k: { key: 'k', code: 'KeyK', keyCode: 75 },
};

const MODIFIER_MAP = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
};

// =============================================================================
// Singleton
// =============================================================================

let cdpAxProviderInstance = null;

function getCDPAXProvider() {
  if (!cdpAxProviderInstance) cdpAxProviderInstance = new CDPAXProvider();
  return cdpAxProviderInstance;
}

// =============================================================================
// Exports
// =============================================================================

export { CDPAXProvider, getCDPAXProvider };
