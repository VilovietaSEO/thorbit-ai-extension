/**
 * Provider Manager
 *
 * Centralized management for AI providers with support for:
 * - Provider registration and discovery
 * - Active provider switching
 * - Configuration persistence
 * - Health checks and fallback
 */

// =============================================================================
// Provider Manager
// =============================================================================

/**
 * Manager for AI providers
 *
 * Usage:
 * ```javascript
 * const manager = new ProviderManager();
 * manager.registerProvider('anthropic', new AnthropicProvider(config));
 * await manager.setActiveProvider('anthropic');
 * const response = await manager.sendMessage(messages);
 * ```
 */
class ProviderManager {
  constructor() {
    /**
     * @type {Map<string, AIProvider>}
     */
    this.providers = new Map();

    /**
     * @type {string|null}
     */
    this.activeProviderName = null;

    /**
     * @type {string}
     */
    this.storageKey = 'ai_provider_config';

    /**
     * Provider event listeners
     * @type {Map<string, Function[]>}
     */
    this.listeners = new Map();
  }

  // ---------------------------------------------------------------------------
  // Provider Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a new provider
   * @param {string} name - Provider identifier
   * @param {AIProvider} provider - Provider instance
   * @throws {Error} If provider with name already exists
   */
  registerProvider(name, provider) {
    if (this.providers.has(name)) {
      console.warn(`[ProviderManager] Provider '${name}' already registered, replacing`);
    }

    // Validate provider implements required interface
    const requiredMethods = ['sendMessage', 'streamMessage', 'validateConfig', 'getRequiredHeaders'];
    for (const method of requiredMethods) {
      if (typeof provider[method] !== 'function') {
        throw new Error(`Provider '${name}' missing required method: ${method}`);
      }
    }

    this.providers.set(name, provider);
    console.log(`[ProviderManager] Registered provider: ${name}`);
    this.emit('providerRegistered', { name, provider });
  }

  /**
   * Unregister a provider
   * @param {string} name - Provider identifier
   * @returns {boolean} True if provider was removed
   */
  unregisterProvider(name) {
    if (this.activeProviderName === name) {
      console.warn(`[ProviderManager] Unregistering active provider '${name}'`);
      this.activeProviderName = null;
    }

    const removed = this.providers.delete(name);
    if (removed) {
      console.log(`[ProviderManager] Unregistered provider: ${name}`);
      this.emit('providerUnregistered', { name });
    }
    return removed;
  }

  /**
   * Check if a provider is registered
   * @param {string} name - Provider identifier
   * @returns {boolean}
   */
  hasProvider(name) {
    return this.providers.has(name);
  }

  /**
   * Get a registered provider by name
   * @param {string} name - Provider identifier
   * @returns {AIProvider|null}
   */
  getProvider(name) {
    return this.providers.get(name) || null;
  }

  /**
   * Get all registered provider names
   * @returns {string[]}
   */
  getProviderNames() {
    return Array.from(this.providers.keys());
  }

  /**
   * Get info for all registered providers
   * @returns {Object[]}
   */
  getProvidersInfo() {
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      ...provider.getInfo(),
      isActive: name === this.activeProviderName
    }));
  }

  // ---------------------------------------------------------------------------
  // Active Provider Management
  // ---------------------------------------------------------------------------

  /**
   * Get the currently active provider
   * @returns {AIProvider|null}
   */
  getActiveProvider() {
    if (!this.activeProviderName) {
      return null;
    }
    return this.providers.get(this.activeProviderName) || null;
  }

  /**
   * Get the name of the active provider
   * @returns {string|null}
   */
  getActiveProviderName() {
    return this.activeProviderName;
  }

  /**
   * Set the active provider
   * @param {string} name - Provider identifier
   * @param {boolean} [persist=true] - Whether to persist to storage
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setActiveProvider(name, persist = true) {
    const provider = this.providers.get(name);
    if (!provider) {
      return {
        success: false,
        error: `Provider '${name}' not registered`
      };
    }

    // Check if provider is ready
    const readyCheck = await provider.isReady();
    if (!readyCheck.ready) {
      return {
        success: false,
        error: `Provider '${name}' not ready: ${readyCheck.error}`
      };
    }

    const previousProvider = this.activeProviderName;
    this.activeProviderName = name;

    if (persist) {
      await this.persistConfig({ activeProvider: name });
    }

    console.log(`[ProviderManager] Active provider switched: ${previousProvider || 'none'} -> ${name}`);
    this.emit('providerSwitched', { from: previousProvider, to: name });

    return { success: true };
  }

  /**
   * Switch to a provider by name (alias for setActiveProvider)
   * @param {string} name - Provider identifier
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async switchProvider(name) {
    return this.setActiveProvider(name, true);
  }

  // ---------------------------------------------------------------------------
  // Request Proxying
  // ---------------------------------------------------------------------------

  /**
   * Send a message through the active provider
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @returns {Promise<Object>} Provider response
   * @throws {Error} If no active provider configured
   */
  async sendMessage(messages, options = {}) {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No active provider configured');
    }
    return provider.sendMessage(messages, options);
  }

  /**
   * Send a streaming message through the active provider
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @yields {StreamChunk} Streaming chunks
   */
  async *streamMessage(messages, options = {}) {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error('No active provider configured');
    }
    yield* provider.streamMessage(messages, options);
  }

  // ---------------------------------------------------------------------------
  // Health & Fallback
  // ---------------------------------------------------------------------------

  /**
   * Check health of all registered providers
   * @returns {Promise<Object>} Health status for each provider
   */
  async checkHealth() {
    const health = {};

    for (const [name, provider] of this.providers.entries()) {
      try {
        const readyCheck = await provider.isReady();
        health[name] = {
          ready: readyCheck.ready,
          error: readyCheck.error || null,
          isActive: name === this.activeProviderName
        };
      } catch (error) {
        health[name] = {
          ready: false,
          error: error.message,
          isActive: name === this.activeProviderName
        };
      }
    }

    return health;
  }

  /**
   * Find the first ready provider (for fallback)
   * @param {string[]} [preferenceOrder] - Ordered list of preferred providers
   * @returns {Promise<string|null>} Name of first ready provider
   */
  async findReadyProvider(preferenceOrder = null) {
    const order = preferenceOrder || this.getProviderNames();

    for (const name of order) {
      const provider = this.providers.get(name);
      if (provider) {
        const readyCheck = await provider.isReady();
        if (readyCheck.ready) {
          return name;
        }
      }
    }

    return null;
  }

  /**
   * Attempt to recover to a working provider
   * @param {string[]} [fallbackOrder] - Preferred fallback order
   * @returns {Promise<{recovered: boolean, provider?: string, error?: string}>}
   */
  async attemptRecovery(fallbackOrder = null) {
    const readyProvider = await this.findReadyProvider(fallbackOrder);

    if (readyProvider) {
      const result = await this.setActiveProvider(readyProvider);
      if (result.success) {
        return { recovered: true, provider: readyProvider };
      }
    }

    return {
      recovered: false,
      error: 'No ready providers available'
    };
  }

  // ---------------------------------------------------------------------------
  // Configuration Persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist configuration to chrome.storage
   * @param {Object} config - Configuration to persist
   */
  async persistConfig(config) {
    try {
      const existing = await this.loadConfig();
      const merged = { ...existing, ...config };
      await chrome.storage.local.set({ [this.storageKey]: merged });
      console.log('[ProviderManager] Configuration persisted');
    } catch (error) {
      console.error('[ProviderManager] Failed to persist config:', error);
    }
  }

  /**
   * Load configuration from chrome.storage
   * @returns {Promise<Object>} Stored configuration
   */
  async loadConfig() {
    try {
      const result = await chrome.storage.local.get(this.storageKey);
      return result[this.storageKey] || {};
    } catch (error) {
      console.error('[ProviderManager] Failed to load config:', error);
      return {};
    }
  }

  /**
   * Initialize manager from stored configuration
   * @returns {Promise<void>}
   */
  async initialize() {
    const config = await this.loadConfig();

    if (config.activeProvider && this.providers.has(config.activeProvider)) {
      const result = await this.setActiveProvider(config.activeProvider, false);
      if (!result.success) {
        console.warn(`[ProviderManager] Failed to restore active provider: ${result.error}`);
        // Attempt recovery to find another ready provider
        await this.attemptRecovery();
      }
    }

    console.log('[ProviderManager] Initialized');
    this.emit('initialized', { config });
  }

  // ---------------------------------------------------------------------------
  // Event Handling
  // ---------------------------------------------------------------------------

  /**
   * Register an event listener
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Remove an event listener
   * @param {string} event - Event name
   * @param {Function} callback - Event handler to remove
   */
  off(event, callback) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const index = handlers.indexOf(callback);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`[ProviderManager] Event handler error for '${event}':`, error);
        }
      }
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Default singleton instance of ProviderManager
 * Use this for most cases to ensure consistent state across the extension
 */
const providerManager = new ProviderManager();

// =============================================================================
// Exports
// =============================================================================

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ProviderManager,
    providerManager
  };
}

// Export for ES modules (Chrome extension context)
export {
  ProviderManager,
  providerManager
};
