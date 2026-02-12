/**
 * Settings Manager - Centralized settings management for Chrome Extension
 *
 * Provides:
 * - Cross-device sync via chrome.storage.sync
 * - Schema validation for all settings
 * - Change listeners for reactive updates
 * - Export/import for backup and migration
 * - Default values for all settings
 *
 * Storage limits for chrome.storage.sync:
 * - 100KB total storage
 * - 8KB max per item
 * - 512 items max
 */

// =============================================================================
// Settings Schema Definition
// =============================================================================

/**
 * Default settings values - defines the complete settings structure
 * All properties here are the canonical schema definition
 */
const DEFAULT_SETTINGS = {
  // Provider configuration
  provider: 'anthropic', // 'anthropic' | 'openrouter' | 'custom'

  // API keys for different providers
  apiKeys: {
    anthropic: '',
    openrouter: '',
    custom: ''
  },

  // Custom endpoint for self-hosted or alternative APIs
  customEndpoint: '',
  customModel: '',

  // Model selection per provider
  models: {
    anthropic: 'claude-sonnet-4-5-20250929',
    openrouter: 'mistralai/mistral-large-2411',
    custom: ''
  },

  // Active model (based on current provider)
  model: 'claude-sonnet-4-5-20250929',

  // System prompt for AI interactions
  systemPrompt: '',

  // Site access control using Chrome match patterns
  allowedSites: ['*://*/*'], // Allow all sites by default
  disallowedSites: [],

  // Per-site rule overrides
  siteRules: {
    // Example structure:
    // 'github.com': {
    //   systemPrompt: 'You are helping with GitHub code review.',
    //   autoAnalyze: true,
    //   model: 'claude-sonnet-4-20250514'
    // }
  },

  // Appearance settings
  appearance: {
    theme: 'system', // 'system' | 'light' | 'dark'
    compactMode: false,
    fontSize: 'medium' // 'small' | 'medium' | 'large'
  },

  // Behavior settings
  behavior: {
    autoAnalyzeOnLoad: false,
    streamResponses: true,
    saveConversationHistory: true,
    maxHistoryLength: 50
  },

  // DOM extraction settings
  domExtraction: {
    maxTokens: 100000,
    includeHiddenElements: false,
    pruningLevel: 'balanced' // 'minimal' | 'balanced' | 'aggressive'
  },

  // Metadata
  _version: 1,
  _lastModified: null
};

/**
 * Valid provider values
 * @type {Set<string>}
 */
const VALID_PROVIDERS = new Set(['anthropic', 'openrouter', 'custom']);

/**
 * Valid theme values
 * @type {Set<string>}
 */
const VALID_THEMES = new Set(['system', 'light', 'dark']);

/**
 * Valid font size values
 * @type {Set<string>}
 */
const VALID_FONT_SIZES = new Set(['small', 'medium', 'large']);

/**
 * Valid pruning level values
 * @type {Set<string>}
 */
const VALID_PRUNING_LEVELS = new Set(['minimal', 'balanced', 'aggressive']);

/**
 * Maximum system prompt size in bytes (10KB)
 * @type {number}
 */
const MAX_SYSTEM_PROMPT_SIZE = 10 * 1024;

/**
 * Maximum number of site rules
 * @type {number}
 */
const MAX_SITE_RULES = 100;

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate a Chrome match pattern
 * Match patterns: scheme://host/path
 * Valid schemes: *, http, https, file, ftp
 *
 * @param {string} pattern - The match pattern to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateMatchPattern(pattern) {
  if (typeof pattern !== 'string') {
    return { valid: false, error: 'Pattern must be a string' };
  }

  // Special case for <all_urls>
  if (pattern === '<all_urls>') {
    return { valid: true };
  }

  // Match pattern regex based on Chrome's specification
  // https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
  const matchPatternRegex = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)?$/;

  if (!matchPatternRegex.test(pattern)) {
    return {
      valid: false,
      error: `Invalid match pattern: ${pattern}. Expected format: scheme://host/path`
    };
  }

  return { valid: true };
}

/**
 * Validate an API key format (non-empty string, reasonable length)
 * @param {string} key - The API key to validate
 * @param {string} provider - The provider name for error messages
 * @returns {{valid: boolean, error?: string}}
 */
function validateApiKey(key, provider) {
  if (key === '') {
    return { valid: true }; // Empty keys are valid (not configured)
  }

  if (typeof key !== 'string') {
    return { valid: false, error: `${provider} API key must be a string` };
  }

  if (key.length < 10) {
    return { valid: false, error: `${provider} API key appears too short` };
  }

  if (key.length > 500) {
    return { valid: false, error: `${provider} API key appears too long` };
  }

  // Basic format checks for known providers
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    return {
      valid: false,
      error: 'Anthropic API key should start with "sk-ant-"'
    };
  }

  return { valid: true };
}

/**
 * Validate URL format
 * @param {string} url - The URL to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateUrl(url) {
  if (url === '') {
    return { valid: true }; // Empty URL is valid (not configured)
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'URL must use http or https protocol' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate a site rule object
 * @param {string} domain - The domain the rule applies to
 * @param {Object} rule - The rule object
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateSiteRule(domain, rule) {
  const errors = [];

  if (typeof domain !== 'string' || domain.length === 0) {
    errors.push('Site rule domain must be a non-empty string');
  }

  if (typeof rule !== 'object' || rule === null) {
    errors.push('Site rule must be an object');
    return { valid: false, errors };
  }

  // Validate optional systemPrompt
  if (rule.systemPrompt !== undefined) {
    if (typeof rule.systemPrompt !== 'string') {
      errors.push(`Site rule for ${domain}: systemPrompt must be a string`);
    } else if (new TextEncoder().encode(rule.systemPrompt).length > MAX_SYSTEM_PROMPT_SIZE) {
      errors.push(`Site rule for ${domain}: systemPrompt exceeds ${MAX_SYSTEM_PROMPT_SIZE / 1024}KB limit`);
    }
  }

  // Validate optional autoAnalyze
  if (rule.autoAnalyze !== undefined && typeof rule.autoAnalyze !== 'boolean') {
    errors.push(`Site rule for ${domain}: autoAnalyze must be a boolean`);
  }

  // Validate optional model
  if (rule.model !== undefined && typeof rule.model !== 'string') {
    errors.push(`Site rule for ${domain}: model must be a string`);
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// SettingsManager Class
// =============================================================================

/**
 * SettingsManager - Main class for managing extension settings
 *
 * Uses chrome.storage.sync for cross-device synchronization.
 * Provides validation, change detection, and export/import functionality.
 */
class SettingsManager {
  /**
   * Create a new SettingsManager instance
   */
  constructor() {
    /** @type {Set<Function>} Change listeners */
    this.listeners = new Set();

    /** @type {Object|null} Cached settings for performance */
    this.cache = null;

    /** @type {boolean} Whether storage listener is installed */
    this.listenerInstalled = false;
  }

  /**
   * Get current settings, merged with defaults for any missing values
   * @returns {Promise<Object>} Current settings object
   */
  async getSettings() {
    try {
      const stored = await chrome.storage.sync.get('settings');
      const settings = this._mergeWithDefaults(stored.settings || {});

      // Update cache
      this.cache = settings;

      return settings;
    } catch (error) {
      console.error('[SettingsManager] Error getting settings:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Update settings with partial updates (deep merge)
   * @param {Object} partial - Partial settings object to merge
   * @returns {Promise<{success: boolean, errors?: string[]}>}
   */
  async updateSettings(partial) {
    try {
      // Get current settings
      const current = await this.getSettings();

      // Deep merge partial updates
      const updated = this._deepMerge(current, partial);

      // Update metadata
      updated._lastModified = new Date().toISOString();

      // Validate before saving
      const validation = await this.validateSettings(updated);
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      // Save to storage
      await chrome.storage.sync.set({ settings: updated });

      // Update cache
      this.cache = updated;

      console.log('[SettingsManager] Settings updated successfully');
      return { success: true };
    } catch (error) {
      console.error('[SettingsManager] Error updating settings:', error);
      return { success: false, errors: [error.message] };
    }
  }

  /**
   * Reset all settings to default values
   * @returns {Promise<{success: boolean}>}
   */
  async resetToDefaults() {
    try {
      const defaults = {
        ...DEFAULT_SETTINGS,
        _lastModified: new Date().toISOString()
      };

      await chrome.storage.sync.set({ settings: defaults });
      this.cache = defaults;

      console.log('[SettingsManager] Settings reset to defaults');
      return { success: true };
    } catch (error) {
      console.error('[SettingsManager] Error resetting settings:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Validate a settings object
   * @param {Object} settings - Settings object to validate
   * @returns {Promise<{valid: boolean, errors: string[]}>}
   */
  async validateSettings(settings) {
    const errors = [];

    // Validate provider
    if (!VALID_PROVIDERS.has(settings.provider)) {
      errors.push(`Invalid provider: ${settings.provider}. Must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
    }

    // Validate API keys
    if (settings.apiKeys) {
      for (const [provider, key] of Object.entries(settings.apiKeys)) {
        const result = validateApiKey(key, provider);
        if (!result.valid) {
          errors.push(result.error);
        }
      }
    }

    // Validate custom endpoint
    if (settings.customEndpoint) {
      const result = validateUrl(settings.customEndpoint);
      if (!result.valid) {
        errors.push(`Custom endpoint: ${result.error}`);
      }
    }

    // Validate system prompt size
    if (settings.systemPrompt) {
      const size = new TextEncoder().encode(settings.systemPrompt).length;
      if (size > MAX_SYSTEM_PROMPT_SIZE) {
        errors.push(`System prompt exceeds ${MAX_SYSTEM_PROMPT_SIZE / 1024}KB limit (current: ${(size / 1024).toFixed(2)}KB)`);
      }
    }

    // Validate allowed sites
    if (Array.isArray(settings.allowedSites)) {
      for (const pattern of settings.allowedSites) {
        const result = validateMatchPattern(pattern);
        if (!result.valid) {
          errors.push(`Allowed sites: ${result.error}`);
        }
      }
    }

    // Validate disallowed sites
    if (Array.isArray(settings.disallowedSites)) {
      for (const pattern of settings.disallowedSites) {
        const result = validateMatchPattern(pattern);
        if (!result.valid) {
          errors.push(`Disallowed sites: ${result.error}`);
        }
      }
    }

    // Validate site rules
    if (settings.siteRules && typeof settings.siteRules === 'object') {
      const ruleCount = Object.keys(settings.siteRules).length;
      if (ruleCount > MAX_SITE_RULES) {
        errors.push(`Too many site rules (${ruleCount}). Maximum is ${MAX_SITE_RULES}`);
      }

      for (const [domain, rule] of Object.entries(settings.siteRules)) {
        const result = validateSiteRule(domain, rule);
        if (!result.valid) {
          errors.push(...result.errors);
        }
      }
    }

    // Validate appearance settings
    if (settings.appearance) {
      if (!VALID_THEMES.has(settings.appearance.theme)) {
        errors.push(`Invalid theme: ${settings.appearance.theme}. Must be one of: ${[...VALID_THEMES].join(', ')}`);
      }
      if (!VALID_FONT_SIZES.has(settings.appearance.fontSize)) {
        errors.push(`Invalid fontSize: ${settings.appearance.fontSize}. Must be one of: ${[...VALID_FONT_SIZES].join(', ')}`);
      }
      if (typeof settings.appearance.compactMode !== 'boolean') {
        errors.push('compactMode must be a boolean');
      }
    }

    // Validate behavior settings
    if (settings.behavior) {
      if (typeof settings.behavior.autoAnalyzeOnLoad !== 'boolean') {
        errors.push('autoAnalyzeOnLoad must be a boolean');
      }
      if (typeof settings.behavior.streamResponses !== 'boolean') {
        errors.push('streamResponses must be a boolean');
      }
      if (typeof settings.behavior.saveConversationHistory !== 'boolean') {
        errors.push('saveConversationHistory must be a boolean');
      }
      if (typeof settings.behavior.maxHistoryLength !== 'number' ||
          settings.behavior.maxHistoryLength < 1 ||
          settings.behavior.maxHistoryLength > 1000) {
        errors.push('maxHistoryLength must be a number between 1 and 1000');
      }
    }

    // Validate DOM extraction settings
    if (settings.domExtraction) {
      if (typeof settings.domExtraction.maxTokens !== 'number' ||
          settings.domExtraction.maxTokens < 1000 ||
          settings.domExtraction.maxTokens > 500000) {
        errors.push('maxTokens must be a number between 1000 and 500000');
      }
      if (typeof settings.domExtraction.includeHiddenElements !== 'boolean') {
        errors.push('includeHiddenElements must be a boolean');
      }
      if (!VALID_PRUNING_LEVELS.has(settings.domExtraction.pruningLevel)) {
        errors.push(`Invalid pruningLevel: ${settings.domExtraction.pruningLevel}. Must be one of: ${[...VALID_PRUNING_LEVELS].join(', ')}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Export settings as JSON string for backup
   * Excludes sensitive data (API keys) by default
   * @param {Object} options - Export options
   * @param {boolean} options.includeApiKeys - Whether to include API keys
   * @returns {Promise<string>} JSON string of settings
   */
  async exportSettings(options = { includeApiKeys: false }) {
    const settings = await this.getSettings();

    // Create export object
    const exportData = {
      version: settings._version,
      exportedAt: new Date().toISOString(),
      settings: { ...settings }
    };

    // Remove API keys if not explicitly included
    if (!options.includeApiKeys) {
      exportData.settings.apiKeys = {
        anthropic: '',
        openrouter: '',
        custom: ''
      };
    }

    // Remove internal metadata
    delete exportData.settings._version;
    delete exportData.settings._lastModified;

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import settings from JSON string
   * @param {string} json - JSON string of settings to import
   * @param {Object} options - Import options
   * @param {boolean} options.merge - Whether to merge with existing settings (true) or replace (false)
   * @returns {Promise<{success: boolean, errors?: string[]}>}
   */
  async importSettings(json, options = { merge: true }) {
    try {
      // Parse JSON
      let importData;
      try {
        importData = JSON.parse(json);
      } catch {
        return { success: false, errors: ['Invalid JSON format'] };
      }

      // Validate import structure
      if (!importData.settings || typeof importData.settings !== 'object') {
        return { success: false, errors: ['Invalid import format: missing settings object'] };
      }

      // Get settings to import
      let newSettings;
      if (options.merge) {
        // Merge with current settings
        const current = await this.getSettings();
        newSettings = this._deepMerge(current, importData.settings);
      } else {
        // Replace entirely, but merge with defaults for missing values
        newSettings = this._mergeWithDefaults(importData.settings);
      }

      // Validate before importing
      const validation = await this.validateSettings(newSettings);
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      // Save imported settings
      return await this.updateSettings(newSettings);
    } catch (error) {
      console.error('[SettingsManager] Error importing settings:', error);
      return { success: false, errors: [error.message] };
    }
  }

  /**
   * Register a callback for settings changes
   * @param {Function} callback - Function to call when settings change
   * @returns {Function} Unsubscribe function
   */
  onSettingsChanged(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }

    this.listeners.add(callback);

    // Install storage listener on first subscriber
    if (!this.listenerInstalled) {
      this._installStorageListener();
    }

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Get settings for a specific site, merging site rules with global settings
   * @param {string} url - The URL to get settings for
   * @returns {Promise<Object>} Merged settings for the site
   */
  async getSettingsForSite(url) {
    const settings = await this.getSettings();

    try {
      const { hostname } = new URL(url);

      // Check if site is allowed
      const isAllowed = this._matchesSitePattern(url, settings.allowedSites);
      const isDisallowed = this._matchesSitePattern(url, settings.disallowedSites);

      if (isDisallowed || !isAllowed) {
        return {
          ...settings,
          _siteAccess: {
            allowed: false,
            reason: isDisallowed ? 'disallowed' : 'not_matched'
          }
        };
      }

      // Get site-specific rules
      const siteRule = settings.siteRules[hostname] || {};

      // Merge site rules with global settings
      return {
        ...settings,
        systemPrompt: siteRule.systemPrompt || settings.systemPrompt,
        model: siteRule.model || settings.model,
        _siteAccess: {
          allowed: true,
          hasCustomRules: Object.keys(siteRule).length > 0
        },
        _siteRule: siteRule
      };
    } catch {
      // Invalid URL, return default settings
      return {
        ...settings,
        _siteAccess: {
          allowed: false,
          reason: 'invalid_url'
        }
      };
    }
  }

  /**
   * Add or update a site rule
   * @param {string} domain - The domain to add/update rule for
   * @param {Object} rule - The rule object
   * @returns {Promise<{success: boolean, errors?: string[]}>}
   */
  async setSiteRule(domain, rule) {
    const validation = validateSiteRule(domain, rule);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    const settings = await this.getSettings();

    // Check rule count
    if (!settings.siteRules[domain] && Object.keys(settings.siteRules).length >= MAX_SITE_RULES) {
      return { success: false, errors: [`Maximum site rules (${MAX_SITE_RULES}) reached`] };
    }

    return this.updateSettings({
      siteRules: {
        ...settings.siteRules,
        [domain]: rule
      }
    });
  }

  /**
   * Remove a site rule
   * @param {string} domain - The domain to remove rule for
   * @returns {Promise<{success: boolean}>}
   */
  async removeSiteRule(domain) {
    const settings = await this.getSettings();
    const { [domain]: removed, ...remaining } = settings.siteRules;

    if (!removed) {
      return { success: true }; // Already doesn't exist
    }

    return this.updateSettings({
      siteRules: remaining
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Merge stored settings with defaults for any missing values
   * @private
   * @param {Object} stored - Stored settings
   * @returns {Object} Merged settings
   */
  _mergeWithDefaults(stored) {
    return this._deepMerge(DEFAULT_SETTINGS, stored);
  }

  /**
   * Deep merge two objects
   * @private
   * @param {Object} target - Target object
   * @param {Object} source - Source object
   * @returns {Object} Merged object
   */
  _deepMerge(target, source) {
    const output = { ...target };

    for (const key of Object.keys(source)) {
      if (source[key] === null || source[key] === undefined) {
        continue; // Skip null/undefined values
      }

      if (
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        source[key] !== null &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key]) &&
        target[key] !== null
      ) {
        // Deep merge nested objects (but not arrays)
        output[key] = this._deepMerge(target[key], source[key]);
      } else {
        // Direct assignment for primitives and arrays
        output[key] = source[key];
      }
    }

    return output;
  }

  /**
   * Check if a URL matches any of the given patterns
   * @private
   * @param {string} url - URL to check
   * @param {string[]} patterns - Match patterns to check against
   * @returns {boolean} Whether the URL matches any pattern
   */
  _matchesSitePattern(url, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return false;
    }

    for (const pattern of patterns) {
      if (pattern === '<all_urls>') {
        return true;
      }

      // Convert match pattern to regex
      const regex = this._matchPatternToRegex(pattern);
      if (regex && regex.test(url)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convert a Chrome match pattern to a RegExp
   * @private
   * @param {string} pattern - Match pattern
   * @returns {RegExp|null} Compiled regex or null if invalid
   */
  _matchPatternToRegex(pattern) {
    try {
      // Escape special regex characters except * which we'll handle specially
      let regex = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
        .replace(/\*/g, '.*'); // Convert * to .*

      return new RegExp(`^${regex}$`);
    } catch {
      return null;
    }
  }

  /**
   * Install Chrome storage change listener
   * @private
   */
  _installStorageListener() {
    if (typeof chrome === 'undefined' || !chrome.storage?.sync?.onChanged) {
      console.warn('[SettingsManager] Chrome storage not available');
      return;
    }

    chrome.storage.sync.onChanged.addListener((changes) => {
      if (changes.settings) {
        const newSettings = changes.settings.newValue;
        const oldSettings = changes.settings.oldValue;

        // Update cache
        this.cache = newSettings;

        // Notify listeners
        for (const callback of this.listeners) {
          try {
            callback(newSettings, oldSettings);
          } catch (error) {
            console.error('[SettingsManager] Listener error:', error);
          }
        }
      }
    });

    this.listenerInstalled = true;
    console.log('[SettingsManager] Storage listener installed');
  }
}

// =============================================================================
// Singleton Instance & Exports
// =============================================================================

/**
 * Singleton instance of SettingsManager
 * @type {SettingsManager}
 */
const settingsManager = new SettingsManager();

// Export both the class and singleton instance
export { SettingsManager, settingsManager, DEFAULT_SETTINGS };
export default settingsManager;
