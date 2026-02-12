/**
 * Day 2 Developer Tools Panel
 *
 * Provides UI for:
 * - Provider toggle (Auto/DOM/CDP-AX) with attach state
 * - Interactables viewer (filterable, grouped by role)
 * - Toast / Modal display
 * - Waiter controls
 * - Performance metrics
 * - Target reacquisition notices
 *
 * Communicates with service worker via chrome.runtime.sendMessage.
 */

// =============================================================================
// State
// =============================================================================

const devtoolsState = {
  isOpen: false,
  providerStatus: null,
  interactables: null,
  pageState: null,
  metrics: null,
  isScanning: false,
  isWaiting: false,
  waitResult: null,
  filter: '',
  roleFilter: 'all',
  reacquireNotice: null,
};

// =============================================================================
// Data Fetching
// =============================================================================

async function fetchProviderStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_PROVIDER_STATUS' });
    if (result.success) devtoolsState.providerStatus = result.status;
    if (result.metrics) devtoolsState.metrics = result.metrics;
  } catch (e) {
    console.warn('[DevTools] Failed to fetch provider status:', e);
  }
}

async function fetchPageState() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_PAGE_STATE' });
    if (result.success) devtoolsState.pageState = result;
  } catch (e) {
    console.warn('[DevTools] Failed to fetch page state:', e);
  }
}

async function scanInteractables() {
  devtoolsState.isScanning = true;
  renderDevtoolsPanel();
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SCAN_INTERACTABLES',
      scope: 'viewport',
      maxElements: 100,
    });
    if (result.success) {
      devtoolsState.interactables = result;
    }
  } catch (e) {
    console.warn('[DevTools] Scan failed:', e);
  }
  devtoolsState.isScanning = false;
  renderDevtoolsPanel();
}

async function setProviderPreference(preference) {
  try {
    await chrome.runtime.sendMessage({ type: 'SET_PROVIDER_PREFERENCE', preference });
    await fetchProviderStatus();
    renderDevtoolsPanel();
  } catch (e) {
    console.warn('[DevTools] Failed to set preference:', e);
  }
}

async function toggleCDP(attach) {
  try {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_CDP', attach });
    await fetchProviderStatus();
    renderDevtoolsPanel();
  } catch (e) {
    console.warn('[DevTools] Failed to toggle CDP:', e);
  }
}

async function triggerWaiter(condition) {
  devtoolsState.isWaiting = true;
  devtoolsState.waitResult = null;
  renderDevtoolsPanel();
  try {
    const params = { type: 'WAIT_FOR', condition: condition.type, timeoutMs: 8000 };
    if (condition.type === 'ui_changed' && devtoolsState.interactables?.digest) {
      params.baselineDigest = devtoolsState.interactables.digest;
    }
    if (condition.nameContains) params.nameContains = condition.nameContains;
    if (condition.textContains) params.textContains = condition.textContains;

    const result = await chrome.runtime.sendMessage(params);
    devtoolsState.waitResult = result;
  } catch (e) {
    devtoolsState.waitResult = { success: false, error: e.message };
  }
  devtoolsState.isWaiting = false;
  renderDevtoolsPanel();
}

// =============================================================================
// Rendering
// =============================================================================

function renderDevtoolsPanel() {
  const container = document.getElementById('devtools-panel');
  if (!container) return;

  const s = devtoolsState;
  const arrowClass = s.isOpen ? 'arrow open' : 'arrow';

  let html = `
    <div class="devtools-toggle" id="devtools-toggle">
      <span>Dev Tools</span>
      <span class="${arrowClass}">&#9654;</span>
    </div>
  `;

  if (s.isOpen) {
    html += `<div class="devtools-body">`;

    // --- Provider Row ---
    const status = s.providerStatus || {};
    const attachedClass = status.attached ? 'attached' : 'detached';
    const attachedText = status.attached ? 'CDP Attached' : 'Detached';
    const pref = status.preference || 'auto';

    html += `
      <div class="devtools-provider-row">
        <label>Provider</label>
        <select id="devtools-provider-select">
          <option value="auto" ${pref === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="dom" ${pref === 'dom' ? 'selected' : ''}>DOM Only</option>
          <option value="cdp_ax" ${pref === 'cdp_ax' ? 'selected' : ''}>CDP/AX</option>
        </select>
        <span class="devtools-status ${attachedClass}">${attachedText}</span>
        <button class="devtools-scan-btn" id="devtools-scan-btn" ${s.isScanning ? 'disabled' : ''}>
          ${s.isScanning ? 'Scanning...' : 'Scan'}
        </button>
      </div>
    `;

    // --- Toast / Modal ---
    html += `<div class="devtools-section">`;
    html += `<div class="devtools-section-title">Toasts &amp; Modals</div>`;

    if (s.pageState?.modal?.isModalLikelyOpen) {
      const mt = s.pageState.modal.modalSummary?.title || 'Unknown';
      html += `<div class="devtools-modal-info">Modal OPEN: ${escapeHtmlDT(mt)}</div>`;
    }

    const toasts = s.pageState?.toasts || [];
    if (toasts.length > 0) {
      html += `<div class="devtools-toast-list">`;
      for (const t of toasts) {
        html += `<div class="devtools-toast-item">${escapeHtmlDT(t)}</div>`;
      }
      html += `</div>`;
    } else if (!s.pageState?.modal?.isModalLikelyOpen) {
      html += `<div class="devtools-none">No toasts or modals detected</div>`;
    }
    html += `</div>`;

    // --- Interactables ---
    if (s.interactables) {
      const elements = s.interactables.elements || [];
      const roles = [...new Set(elements.map(el => el.role || el.tag?.toLowerCase() || 'unknown'))].sort();

      html += `<div class="devtools-section">`;
      html += `<div class="devtools-section-title">Interactables (${elements.length}) — ${s.interactables.provider || 'unknown'}</div>`;

      html += `
        <div class="devtools-filter">
          <input type="text" id="devtools-filter-input" placeholder="Filter by name..." value="${escapeHtmlDT(s.filter)}">
          <select id="devtools-role-filter">
            <option value="all">All roles</option>
            ${roles.map(r => `<option value="${r}" ${s.roleFilter === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
        </div>
      `;

      const filtered = elements.filter(el => {
        const nameMatch = !s.filter || (el.name || el.text || '').toLowerCase().includes(s.filter.toLowerCase());
        const roleMatch = s.roleFilter === 'all' || (el.role || el.tag?.toLowerCase()) === s.roleFilter;
        return nameMatch && roleMatch;
      });

      html += `<div class="devtools-interactables">`;
      for (const el of filtered.slice(0, 80)) {
        const role = el.role || el.tag?.toLowerCase() || '?';
        const name = el.name || el.text || '';
        const disabledClass = el.states?.disabled ? 'devtools-interactable-disabled' : '';
        html += `<div class="devtools-interactable-item ${disabledClass}">`;
        html += `<span class="devtools-interactable-label">[${el.label}]</span> `;
        html += `<span class="devtools-interactable-role">${role}</span> `;
        if (name) html += `<span class="devtools-interactable-name">"${escapeHtmlDT(name.slice(0, 60))}"</span>`;
        if (el.states?.disabled) html += ` <small>(disabled)</small>`;
        html += `</div>`;
      }
      if (filtered.length > 80) html += `<div class="devtools-interactable-item">... and ${filtered.length - 80} more</div>`;
      html += `</div>`;
      html += `</div>`;
    }

    // --- Reacquire Notice ---
    if (s.reacquireNotice) {
      html += `<div class="devtools-reacquire-notice">Target reacquired: label [${s.reacquireNotice.oldLabel}] → [${s.reacquireNotice.newLabel}]</div>`;
    }

    // --- Waiters ---
    html += `<div class="devtools-section">`;
    html += `<div class="devtools-section-title">Waiters</div>`;
    html += `<div class="devtools-waiters">`;
    html += `<button class="devtools-waiter-btn" data-waiter="ui_changed" ${s.isWaiting ? 'disabled' : ''}>Wait: UI change</button>`;
    html += `<button class="devtools-waiter-btn" data-waiter="spinner_gone" ${s.isWaiting ? 'disabled' : ''}>Wait: Spinner gone</button>`;
    html += `<button class="devtools-waiter-btn" data-waiter="toast_appears" ${s.isWaiting ? 'disabled' : ''}>Wait: Toast</button>`;
    html += `<button class="devtools-waiter-btn" data-waiter="dom_ready" ${s.isWaiting ? 'disabled' : ''}>Wait: DOM ready</button>`;
    html += `</div>`;
    if (s.isWaiting) html += `<div class="devtools-none">Waiting...</div>`;
    if (s.waitResult) {
      const wr = s.waitResult;
      html += `<div class="devtools-toast-list">${wr.success ? 'OK' : 'Timeout'} (${wr.elapsedMs || 0}ms) — ${JSON.stringify(wr.data || {}).slice(0, 120)}</div>`;
    }
    html += `</div>`;

    // --- Metrics ---
    if (s.metrics) {
      html += `<div class="devtools-section">`;
      html += `<div class="devtools-section-title">Metrics</div>`;
      html += `<div class="devtools-metrics">`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">Scans:</span> <span class="devtools-metric-value">${s.metrics.scans || 0}</span></div>`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">Avg scan:</span> <span class="devtools-metric-value">${s.metrics.avgScanTimeMs || 0}ms</span></div>`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">Actions:</span> <span class="devtools-metric-value">${s.metrics.acts || 0}</span></div>`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">Stale rate:</span> <span class="devtools-metric-value">${s.metrics.staleRate || '0.000'}</span></div>`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">UI change:</span> <span class="devtools-metric-value">${s.metrics.uiChangeRate || '0.000'}</span></div>`;
      html += `<div class="devtools-metric"><span class="devtools-metric-label">Reacquire:</span> <span class="devtools-metric-value">${s.metrics.reacquireRate || 'N/A'}</span></div>`;
      html += `</div>`;
      html += `</div>`;
    }

    html += `</div>`; // devtools-body
  }

  container.innerHTML = html;
  bindDevtoolsEvents();
}

// =============================================================================
// Event Binding
// =============================================================================

function bindDevtoolsEvents() {
  const toggle = document.getElementById('devtools-toggle');
  if (toggle) {
    toggle.onclick = async () => {
      devtoolsState.isOpen = !devtoolsState.isOpen;
      if (devtoolsState.isOpen) {
        await Promise.all([fetchProviderStatus(), fetchPageState()]);
      }
      renderDevtoolsPanel();
    };
  }

  const providerSelect = document.getElementById('devtools-provider-select');
  if (providerSelect) {
    providerSelect.onchange = () => setProviderPreference(providerSelect.value);
  }

  const scanBtn = document.getElementById('devtools-scan-btn');
  if (scanBtn) {
    scanBtn.onclick = () => scanInteractables();
  }

  const filterInput = document.getElementById('devtools-filter-input');
  if (filterInput) {
    filterInput.oninput = () => {
      devtoolsState.filter = filterInput.value;
      renderDevtoolsPanel();
    };
  }

  const roleFilter = document.getElementById('devtools-role-filter');
  if (roleFilter) {
    roleFilter.onchange = () => {
      devtoolsState.roleFilter = roleFilter.value;
      renderDevtoolsPanel();
    };
  }

  document.querySelectorAll('.devtools-waiter-btn').forEach(btn => {
    btn.onclick = () => {
      const waiterType = btn.getAttribute('data-waiter');
      if (waiterType) triggerWaiter({ type: waiterType });
    };
  });
}

// =============================================================================
// Helpers
// =============================================================================

function escapeHtmlDT(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Listen for automation events that might include reacquire notices
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTOMATION_EVENT' && message.data?.reacquiredTarget) {
    devtoolsState.reacquireNotice = {
      oldLabel: message.data.originalLabel,
      newLabel: message.data.newLabel,
    };
    renderDevtoolsPanel();
    // Clear after 5 seconds
    setTimeout(() => {
      devtoolsState.reacquireNotice = null;
      renderDevtoolsPanel();
    }, 5000);
  }
});

// Auto-refresh when devtools is open and page navigates
chrome.runtime.onMessage.addListener((message) => {
  if (devtoolsState.isOpen && (message.type === 'STREAM_DONE' || message.type === 'AUTOMATION_EVENT')) {
    fetchPageState().then(() => renderDevtoolsPanel());
  }
});
