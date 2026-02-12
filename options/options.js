/**
 * Options Page JavaScript - Settings page functionality for Chrome Extension
 *
 * Provides:
 * - Settings load/save with SettingsManager
 * - API key visibility toggles
 * - Character counter for system prompt
 * - Site rule management (add/remove)
 * - Import/export settings as JSON
 * - Reset to defaults with confirmation
 * - Real-time validation feedback
 * - Toast notifications
 * - Confirmation modal
 */

import { settingsManager } from '../utils/settings-manager.js';

// =============================================================================
// DOM Elements
// =============================================================================

const elements = {
  // Provider settings
  providerSelect: document.getElementById('provider-select'),
  providerStatus: document.getElementById('provider-status'),

  // Provider-specific settings containers
  anthropicSettings: document.getElementById('anthropic-settings'),
  openrouterSettings: document.getElementById('openrouter-settings'),
  customSettings: document.getElementById('custom-settings'),

  // API keys
  anthropicKey: document.getElementById('anthropic-key'),
  openrouterKey: document.getElementById('openrouter-key'),
  customEndpoint: document.getElementById('custom-endpoint'),
  customKey: document.getElementById('custom-key'),
  customModel: document.getElementById('custom-model'),

  // Model selects (separate for each provider)
  anthropicModelSelect: document.getElementById('anthropic-model-select'),
  openrouterModelSelect: document.getElementById('openrouter-model-select'),

  // System prompt
  systemPrompt: document.getElementById('system-prompt'),
  promptChars: document.getElementById('prompt-chars'),
  promptWarning: document.getElementById('prompt-warning'),

  // Site rules
  allowedSitesList: document.getElementById('allowed-sites-list'),
  blockedSitesList: document.getElementById('blocked-sites-list'),
  addAllowedSite: document.getElementById('add-allowed-site'),
  addBlockedSite: document.getElementById('add-blocked-site'),
  addAllowedBtn: document.getElementById('add-allowed-btn'),
  addBlockedBtn: document.getElementById('add-blocked-btn'),

  // Behavior settings
  autoAnalyze: document.getElementById('auto-analyze'),
  streamResponses: document.getElementById('stream-responses'),
  saveHistory: document.getElementById('save-history'),
  maxHistory: document.getElementById('max-history'),
  maxHistoryValue: document.getElementById('max-history-value'),

  // DOM extraction settings
  maxTokens: document.getElementById('max-tokens'),
  maxTokensValue: document.getElementById('max-tokens-value'),
  includeHidden: document.getElementById('include-hidden'),
  pruningLevel: document.getElementById('pruning-level'),

  // Appearance settings
  themeSelect: document.getElementById('theme-select'),
  fontSize: document.getElementById('font-size'),
  compactMode: document.getElementById('compact-mode'),

  // Backup & restore
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  resetBtn: document.getElementById('reset-btn'),
  importFile: document.getElementById('import-file'),
  exportIncludeKeys: document.getElementById('export-include-keys'),

  // Status & notifications
  saveStatus: document.getElementById('save-status'),
  statusText: document.querySelector('.status-text'),

  // Modal
  confirmModal: document.getElementById('confirm-modal'),
  modalTitle: document.getElementById('modal-title'),
  modalMessage: document.getElementById('modal-message'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm'),

  // Toast
  toast: document.getElementById('toast'),
  toastMessage: document.querySelector('.toast-message')
};

// =============================================================================
// Constants
// =============================================================================

const MAX_SYSTEM_PROMPT_CHARS = 10000;
const SYSTEM_PROMPT_WARNING_THRESHOLD = 9000;
const SAVE_DEBOUNCE_MS = 500;

// =============================================================================
// State
// =============================================================================

let saveTimeout = null;
let currentModalCallback = null;

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  updateProviderVisibility();
});

// =============================================================================
// Settings Load/Save
// =============================================================================

/**
 * Load settings from storage and populate UI
 */
async function loadSettings() {
  try {
    const settings = await settingsManager.getSettings();

    // Provider settings
    elements.providerSelect.value = settings.provider;
    elements.anthropicKey.value = settings.apiKeys.anthropic || '';
    elements.openrouterKey.value = settings.apiKeys.openrouter || '';
    elements.customEndpoint.value = settings.customEndpoint || '';
    elements.customKey.value = settings.apiKeys.custom || '';
    elements.customModel.value = settings.customModel || '';

    // Set model for each provider
    if (settings.models) {
      if (settings.models.anthropic) {
        elements.anthropicModelSelect.value = settings.models.anthropic;
      }
      if (settings.models.openrouter) {
        elements.openrouterModelSelect.value = settings.models.openrouter;
      }
    } else if (settings.model) {
      // Legacy: single model field - try to set the appropriate dropdown
      if (settings.model.startsWith('claude-')) {
        elements.anthropicModelSelect.value = settings.model;
      } else {
        elements.openrouterModelSelect.value = settings.model;
      }
    }

    // System prompt
    elements.systemPrompt.value = settings.systemPrompt || '';
    updateCharCounter();

    // Site rules
    renderSiteList(elements.allowedSitesList, settings.allowedSites, 'allowed');
    renderSiteList(elements.blockedSitesList, settings.disallowedSites, 'blocked');

    // Behavior settings
    elements.autoAnalyze.checked = settings.behavior.autoAnalyzeOnLoad;
    elements.streamResponses.checked = settings.behavior.streamResponses;
    elements.saveHistory.checked = settings.behavior.saveConversationHistory;
    elements.maxHistory.value = settings.behavior.maxHistoryLength;
    elements.maxHistoryValue.textContent = settings.behavior.maxHistoryLength;

    // DOM extraction settings
    elements.maxTokens.value = settings.domExtraction.maxTokens;
    elements.maxTokensValue.textContent = settings.domExtraction.maxTokens.toLocaleString();
    elements.includeHidden.checked = settings.domExtraction.includeHiddenElements;
    elements.pruningLevel.value = settings.domExtraction.pruningLevel;

    // Appearance settings
    elements.themeSelect.value = settings.appearance.theme;
    elements.fontSize.value = settings.appearance.fontSize;
    elements.compactMode.checked = settings.appearance.compactMode;

    updateProviderVisibility();
    showSaveStatus('saved');
  } catch (error) {
    console.error('[Options] Error loading settings:', error);
    showToast('Failed to load settings', 'error');
  }
}

/**
 * Save settings with debounce
 */
function saveSettings() {
  clearTimeout(saveTimeout);
  showSaveStatus('saving');

  saveTimeout = setTimeout(async () => {
    try {
      const settings = gatherSettingsFromUI();
      const result = await settingsManager.updateSettings(settings);

      if (result.success) {
        showSaveStatus('saved');
      } else {
        showSaveStatus('error');
        showToast(`Failed to save: ${result.errors?.join(', ')}`, 'error');
      }
    } catch (error) {
      console.error('[Options] Error saving settings:', error);
      showSaveStatus('error');
      showToast('Failed to save settings', 'error');
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Gather current UI values into a settings object
 * @returns {Object} Settings object
 */
function gatherSettingsFromUI() {
  const provider = elements.providerSelect.value;

  // Get the active model based on current provider
  let activeModel;
  switch (provider) {
    case 'anthropic':
      activeModel = elements.anthropicModelSelect.value;
      break;
    case 'openrouter':
      activeModel = elements.openrouterModelSelect.value;
      break;
    case 'custom':
      activeModel = elements.customModel.value;
      break;
    default:
      activeModel = elements.anthropicModelSelect.value;
  }

  return {
    provider: provider,
    apiKeys: {
      anthropic: elements.anthropicKey.value,
      openrouter: elements.openrouterKey.value,
      custom: elements.customKey.value
    },
    customEndpoint: elements.customEndpoint.value,
    customModel: elements.customModel.value,
    // Store models per provider for easy switching
    models: {
      anthropic: elements.anthropicModelSelect.value,
      openrouter: elements.openrouterModelSelect.value,
      custom: elements.customModel.value
    },
    // Active model (based on current provider)
    model: activeModel,
    systemPrompt: elements.systemPrompt.value,
    behavior: {
      autoAnalyzeOnLoad: elements.autoAnalyze.checked,
      streamResponses: elements.streamResponses.checked,
      saveConversationHistory: elements.saveHistory.checked,
      maxHistoryLength: parseInt(elements.maxHistory.value, 10)
    },
    domExtraction: {
      maxTokens: parseInt(elements.maxTokens.value, 10),
      includeHiddenElements: elements.includeHidden.checked,
      pruningLevel: elements.pruningLevel.value
    },
    appearance: {
      theme: elements.themeSelect.value,
      fontSize: elements.fontSize.value,
      compactMode: elements.compactMode.checked
    }
  };
}

// =============================================================================
// Event Listeners Setup
// =============================================================================

function setupEventListeners() {
  // Provider change - update visibility and save
  elements.providerSelect.addEventListener('change', () => {
    updateProviderVisibility();
    saveSettings();
  });

  // API keys - auto-save with validation feedback
  elements.anthropicKey.addEventListener('input', () => {
    validateApiKeyInput(elements.anthropicKey, 'anthropic');
    saveSettings();
  });
  elements.openrouterKey.addEventListener('input', () => {
    validateApiKeyInput(elements.openrouterKey, 'openrouter');
    saveSettings();
  });
  elements.customKey.addEventListener('input', () => {
    validateApiKeyInput(elements.customKey, 'custom');
    saveSettings();
  });
  elements.customEndpoint.addEventListener('input', () => {
    validateUrlInput(elements.customEndpoint);
    saveSettings();
  });

  // Model selects (one per provider)
  elements.anthropicModelSelect.addEventListener('change', saveSettings);
  elements.openrouterModelSelect.addEventListener('change', saveSettings);
  if (elements.customModel) {
    elements.customModel.addEventListener('input', saveSettings);
  }

  // System prompt
  elements.systemPrompt.addEventListener('input', () => {
    updateCharCounter();
    saveSettings();
  });

  // API key visibility toggles
  document.querySelectorAll('.toggle-visibility').forEach(btn => {
    btn.addEventListener('click', togglePasswordVisibility);
  });

  // Site rule buttons
  elements.addAllowedBtn.addEventListener('click', () => addSiteRule('allowed'));
  elements.addBlockedBtn.addEventListener('click', () => addSiteRule('blocked'));

  // Enter key on site rule inputs
  elements.addAllowedSite.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSiteRule('allowed');
    }
  });
  elements.addBlockedSite.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSiteRule('blocked');
    }
  });

  // Behavior settings
  elements.autoAnalyze.addEventListener('change', saveSettings);
  elements.streamResponses.addEventListener('change', saveSettings);
  elements.saveHistory.addEventListener('change', saveSettings);
  elements.maxHistory.addEventListener('input', () => {
    elements.maxHistoryValue.textContent = elements.maxHistory.value;
    saveSettings();
  });

  // DOM extraction settings
  elements.maxTokens.addEventListener('input', () => {
    elements.maxTokensValue.textContent = parseInt(elements.maxTokens.value, 10).toLocaleString();
    saveSettings();
  });
  elements.includeHidden.addEventListener('change', saveSettings);
  elements.pruningLevel.addEventListener('change', saveSettings);

  // Appearance settings
  elements.themeSelect.addEventListener('change', saveSettings);
  elements.fontSize.addEventListener('change', saveSettings);
  elements.compactMode.addEventListener('change', saveSettings);

  // Backup & restore
  elements.exportBtn.addEventListener('click', exportSettings);
  elements.importBtn.addEventListener('click', () => elements.importFile.click());
  elements.importFile.addEventListener('change', importSettings);
  elements.resetBtn.addEventListener('click', resetSettings);

  // Modal
  elements.modalCancel.addEventListener('click', closeModal);
  elements.confirmModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

  // Escape key to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elements.confirmModal.getAttribute('aria-hidden') === 'false') {
      closeModal();
    }
  });
}

// =============================================================================
// Provider Visibility
// =============================================================================

/**
 * Update visibility of provider-specific fields
 */
function updateProviderVisibility() {
  const provider = elements.providerSelect.value;

  // Hide all provider settings first
  elements.anthropicSettings.style.display = 'none';
  elements.openrouterSettings.style.display = 'none';
  elements.customSettings.style.display = 'none';

  // Show the selected provider's settings
  switch (provider) {
    case 'anthropic':
      elements.anthropicSettings.style.display = 'block';
      break;
    case 'openrouter':
      elements.openrouterSettings.style.display = 'block';
      break;
    case 'custom':
      elements.customSettings.style.display = 'block';
      break;
  }

  // Update status indicator
  const statusText = elements.providerStatus.querySelector('.status-text');
  if (statusText) {
    statusText.textContent = `${provider.charAt(0).toUpperCase() + provider.slice(1)} Active`;
  }
}

// =============================================================================
// Character Counter
// =============================================================================

/**
 * Update character counter for system prompt
 */
function updateCharCounter() {
  const count = elements.systemPrompt.value.length;
  elements.promptChars.textContent = count.toLocaleString();

  // Show warning when approaching limit
  if (count >= SYSTEM_PROMPT_WARNING_THRESHOLD) {
    elements.promptWarning.style.display = 'inline';
    elements.systemPrompt.classList.add('warning');
  } else {
    elements.promptWarning.style.display = 'none';
    elements.systemPrompt.classList.remove('warning');
  }

  // Error state when exceeding limit
  if (count > MAX_SYSTEM_PROMPT_CHARS) {
    elements.systemPrompt.classList.add('error');
  } else {
    elements.systemPrompt.classList.remove('error');
  }
}

// =============================================================================
// API Key Visibility Toggle
// =============================================================================

/**
 * Toggle password visibility for API key inputs
 * @param {Event} e - Click event
 */
function togglePasswordVisibility(e) {
  const btn = e.currentTarget;
  const targetId = btn.dataset.target;
  const input = document.getElementById(targetId);

  if (!input) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';

  // Toggle icon visibility
  const showIcon = btn.querySelector('.icon-show');
  const hideIcon = btn.querySelector('.icon-hide');
  if (showIcon && hideIcon) {
    showIcon.style.display = isPassword ? 'none' : 'block';
    hideIcon.style.display = isPassword ? 'block' : 'none';
  }

  // Update aria-label
  btn.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');
}

// =============================================================================
// Site Rules Management
// =============================================================================

/**
 * Render a list of site patterns
 * @param {HTMLElement} container - The list container
 * @param {string[]} sites - Array of site patterns
 * @param {string} type - 'allowed' or 'blocked'
 */
function renderSiteList(container, sites, type) {
  container.innerHTML = '';

  if (!sites || sites.length === 0) {
    const emptyMessage = document.createElement('div');
    emptyMessage.className = 'site-list-empty';
    emptyMessage.textContent = type === 'allowed' ? 'No allowed sites configured' : 'No blocked sites';
    container.appendChild(emptyMessage);
    return;
  }

  sites.forEach((site, index) => {
    const item = document.createElement('div');
    item.className = 'site-item';
    item.setAttribute('role', 'listitem');

    const pattern = document.createElement('span');
    pattern.className = 'site-pattern';
    pattern.textContent = site;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-icon btn-remove';
    removeBtn.setAttribute('aria-label', `Remove ${site}`);
    removeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
    removeBtn.addEventListener('click', () => removeSiteRule(type, index));

    item.appendChild(pattern);
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

/**
 * Add a new site rule
 * @param {string} type - 'allowed' or 'blocked'
 */
async function addSiteRule(type) {
  const input = type === 'allowed' ? elements.addAllowedSite : elements.addBlockedSite;
  const pattern = input.value.trim();

  if (!pattern) {
    showToast('Please enter a site pattern', 'error');
    input.focus();
    return;
  }

  // Validate pattern format
  if (!isValidMatchPattern(pattern)) {
    showToast('Invalid match pattern format', 'error');
    input.classList.add('error');
    input.focus();
    return;
  }

  try {
    const settings = await settingsManager.getSettings();
    const listKey = type === 'allowed' ? 'allowedSites' : 'disallowedSites';
    const currentList = settings[listKey] || [];

    // Check for duplicate
    if (currentList.includes(pattern)) {
      showToast('Pattern already exists', 'error');
      input.classList.add('error');
      return;
    }

    // Add to list
    const newList = [...currentList, pattern];
    const result = await settingsManager.updateSettings({ [listKey]: newList });

    if (result.success) {
      const container = type === 'allowed' ? elements.allowedSitesList : elements.blockedSitesList;
      renderSiteList(container, newList, type);
      input.value = '';
      input.classList.remove('error');
      showSaveStatus('saved');
      showToast(`Site pattern added`, 'success');
    } else {
      showToast(`Failed to add: ${result.errors?.join(', ')}`, 'error');
    }
  } catch (error) {
    console.error('[Options] Error adding site rule:', error);
    showToast('Failed to add site pattern', 'error');
  }
}

/**
 * Remove a site rule
 * @param {string} type - 'allowed' or 'blocked'
 * @param {number} index - Index of the rule to remove
 */
async function removeSiteRule(type, index) {
  try {
    const settings = await settingsManager.getSettings();
    const listKey = type === 'allowed' ? 'allowedSites' : 'disallowedSites';
    const currentList = settings[listKey] || [];

    // Remove from list
    const newList = currentList.filter((_, i) => i !== index);
    const result = await settingsManager.updateSettings({ [listKey]: newList });

    if (result.success) {
      const container = type === 'allowed' ? elements.allowedSitesList : elements.blockedSitesList;
      renderSiteList(container, newList, type);
      showSaveStatus('saved');
      showToast('Site pattern removed', 'success');
    } else {
      showToast(`Failed to remove: ${result.errors?.join(', ')}`, 'error');
    }
  } catch (error) {
    console.error('[Options] Error removing site rule:', error);
    showToast('Failed to remove site pattern', 'error');
  }
}

/**
 * Validate a Chrome match pattern
 * @param {string} pattern - The pattern to validate
 * @returns {boolean} Whether the pattern is valid
 */
function isValidMatchPattern(pattern) {
  if (pattern === '<all_urls>') return true;

  // Match pattern regex based on Chrome's specification
  const matchPatternRegex = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)?$/;
  return matchPatternRegex.test(pattern);
}

// =============================================================================
// Import/Export Settings
// =============================================================================

/**
 * Export settings to JSON file
 */
async function exportSettings() {
  try {
    const includeApiKeys = elements.exportIncludeKeys.checked;
    const json = await settingsManager.exportSettings({ includeApiKeys });

    // Create and download file
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-assistant-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Settings exported successfully', 'success');
  } catch (error) {
    console.error('[Options] Error exporting settings:', error);
    showToast('Failed to export settings', 'error');
  }
}

/**
 * Import settings from JSON file
 * @param {Event} e - Change event from file input
 */
async function importSettings(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const json = await file.text();
    const result = await settingsManager.importSettings(json, { merge: true });

    if (result.success) {
      await loadSettings(); // Reload UI
      showToast('Settings imported successfully', 'success');
    } else {
      showToast(`Import failed: ${result.errors?.join(', ')}`, 'error');
    }
  } catch (error) {
    console.error('[Options] Error importing settings:', error);
    showToast('Failed to import settings', 'error');
  }

  // Reset file input
  e.target.value = '';
}

/**
 * Reset settings to defaults with confirmation
 */
function resetSettings() {
  showModal(
    'Reset Settings',
    'Are you sure you want to reset all settings to defaults? This cannot be undone.',
    async () => {
      try {
        const result = await settingsManager.resetToDefaults();
        if (result.success) {
          await loadSettings();
          showToast('Settings reset to defaults', 'success');
        } else {
          showToast('Failed to reset settings', 'error');
        }
      } catch (error) {
        console.error('[Options] Error resetting settings:', error);
        showToast('Failed to reset settings', 'error');
      }
    }
  );
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate API key input and show feedback
 * @param {HTMLInputElement} input - The input element
 * @param {string} provider - The provider name
 */
function validateApiKeyInput(input, provider) {
  const value = input.value.trim();

  if (value === '') {
    input.classList.remove('error', 'valid');
    return;
  }

  // Basic validation
  let isValid = value.length >= 10 && value.length <= 500;

  // Provider-specific validation
  if (provider === 'anthropic' && value && !value.startsWith('sk-ant-')) {
    isValid = false;
  }

  if (isValid) {
    input.classList.remove('error');
    input.classList.add('valid');
  } else {
    input.classList.remove('valid');
    input.classList.add('error');
  }
}

/**
 * Validate URL input and show feedback
 * @param {HTMLInputElement} input - The input element
 */
function validateUrlInput(input) {
  const value = input.value.trim();

  if (value === '') {
    input.classList.remove('error', 'valid');
    return;
  }

  try {
    const url = new URL(value);
    const isValid = ['http:', 'https:'].includes(url.protocol);

    if (isValid) {
      input.classList.remove('error');
      input.classList.add('valid');
    } else {
      input.classList.remove('valid');
      input.classList.add('error');
    }
  } catch {
    input.classList.remove('valid');
    input.classList.add('error');
  }
}

// =============================================================================
// Status & Notifications
// =============================================================================

/**
 * Show save status in footer
 * @param {'saving' | 'saved' | 'error'} status - The status to show
 */
function showSaveStatus(status) {
  elements.saveStatus.className = 'save-status';

  switch (status) {
    case 'saving':
      elements.saveStatus.classList.add('status-saving');
      elements.statusText.textContent = 'Saving...';
      break;
    case 'saved':
      elements.saveStatus.classList.add('status-saved');
      elements.statusText.textContent = 'All changes saved';
      break;
    case 'error':
      elements.saveStatus.classList.add('status-error');
      elements.statusText.textContent = 'Error saving';
      break;
  }
}

/**
 * Show toast notification
 * @param {string} message - The message to show
 * @param {'success' | 'error'} type - The toast type
 */
function showToast(message, type = 'success') {
  elements.toast.className = `toast toast-${type}`;
  elements.toastMessage.textContent = message;
  elements.toast.setAttribute('aria-hidden', 'false');

  // Auto-hide after 3 seconds
  setTimeout(() => {
    elements.toast.setAttribute('aria-hidden', 'true');
  }, 3000);
}

// =============================================================================
// Modal
// =============================================================================

/**
 * Show confirmation modal
 * @param {string} title - Modal title
 * @param {string} message - Modal message
 * @param {Function} onConfirm - Callback when confirmed
 */
function showModal(title, message, onConfirm) {
  elements.modalTitle.textContent = title;
  elements.modalMessage.textContent = message;
  elements.confirmModal.setAttribute('aria-hidden', 'false');

  currentModalCallback = onConfirm;

  // One-time confirm handler
  const confirmHandler = () => {
    closeModal();
    if (currentModalCallback) {
      currentModalCallback();
    }
  };

  elements.modalConfirm.onclick = confirmHandler;
}

/**
 * Close the modal
 */
function closeModal() {
  elements.confirmModal.setAttribute('aria-hidden', 'true');
  currentModalCallback = null;
}
