/**
 * Base AI Provider Interface
 *
 * Abstract base class for AI providers supporting multi-AI architecture.
 * Implements common patterns for streaming, error handling, and retry logic.
 *
 * Supports: Anthropic, OpenRouter, custom endpoints (BYOK)
 */

// =============================================================================
// Error Types
// =============================================================================

/**
 * Base error class for provider-specific errors
 */
class ProviderError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} provider - Provider name
   * @param {number} [statusCode] - HTTP status code
   * @param {boolean} [retryable=false] - Whether error is retryable
   * @param {Object} [details] - Additional error details
   */
  constructor(message, provider, statusCode = null, retryable = false, details = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
    this.timestamp = Date.now();
  }

  /**
   * Convert error to serializable object
   * @returns {Object}
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      statusCode: this.statusCode,
      retryable: this.retryable,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

/**
 * Error thrown when provider configuration is invalid
 */
class ConfigurationError extends ProviderError {
  constructor(message, provider, details = {}) {
    super(message, provider, null, false, details);
    this.name = 'ConfigurationError';
  }
}

/**
 * Error thrown on rate limiting (429)
 */
class RateLimitError extends ProviderError {
  /**
   * @param {string} message - Error message
   * @param {string} provider - Provider name
   * @param {number} [retryAfter] - Seconds until retry allowed
   */
  constructor(message, provider, retryAfter = null) {
    super(message, provider, 429, true, { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Error thrown on authentication failure
 */
class AuthenticationError extends ProviderError {
  constructor(message, provider) {
    super(message, provider, 401, false, {});
    this.name = 'AuthenticationError';
  }
}

// =============================================================================
// Message Format
// =============================================================================

/**
 * Provider-agnostic message format
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role - Message role
 * @property {string|Array<ContentBlock>} content - Message content
 */

/**
 * Content block for structured messages
 * @typedef {Object} ContentBlock
 * @property {'text'|'image'} type - Block type
 * @property {string} [text] - Text content
 * @property {Object} [source] - Image source for image blocks
 */

/**
 * Provider-agnostic options for AI requests
 * @typedef {Object} RequestOptions
 * @property {number} [maxTokens=4096] - Maximum tokens in response
 * @property {number} [temperature=1.0] - Sampling temperature
 * @property {string} [model] - Override default model
 * @property {boolean} [stream=false] - Enable streaming
 * @property {Object} [systemPrompt] - System prompt with optional cache control
 * @property {AbortSignal} [signal] - Abort signal for cancellation
 */

/**
 * Streaming chunk from provider
 * @typedef {Object} StreamChunk
 * @property {'text'|'error'|'done'|'usage'} type - Chunk type
 * @property {string} [text] - Text content for text chunks
 * @property {string} [error] - Error message for error chunks
 * @property {Object} [usage] - Token usage for usage chunks
 */

// =============================================================================
// Base Provider Class
// =============================================================================

/**
 * Abstract base class for AI providers
 *
 * Subclasses must implement:
 * - sendMessage(messages, options) - Non-streaming request
 * - streamMessage(messages, options) - Streaming request (async generator)
 * - validateConfig() - Configuration validation
 * - getRequiredHeaders() - Provider-specific headers
 *
 * @abstract
 */
class AIProvider {
  /**
   * @param {Object} config - Provider configuration
   * @param {string} config.name - Provider identifier (e.g., 'anthropic', 'openrouter')
   * @param {string} config.apiEndpoint - API endpoint URL
   * @param {string} config.defaultModel - Default model to use
   * @param {string} [config.apiKey] - API key (can also use keySource)
   * @param {string} [config.keySource='storage'] - Where to get API key ('storage', 'config')
   * @param {string} [config.keyStorageKey] - Storage key for API key lookup
   * @param {Object} [config.retry] - Retry configuration
   */
  constructor(config) {
    if (new.target === AIProvider) {
      throw new Error('AIProvider is abstract and cannot be instantiated directly');
    }

    this.name = config.name || 'unknown';
    this.apiEndpoint = config.apiEndpoint;
    this.defaultModel = config.defaultModel;
    this.apiKey = config.apiKey || null;
    this.keySource = config.keySource || 'storage';
    this.keyStorageKey = config.keyStorageKey || null;

    // Retry configuration with defaults
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      initialDelay: config.retry?.initialDelay ?? 1000,
      maxDelay: config.retry?.maxDelay ?? 30000,
      backoffMultiplier: config.retry?.backoffMultiplier ?? 2
    };

    // Request tracking for debugging
    this.lastRequest = null;
    this.lastError = null;
  }

  // ---------------------------------------------------------------------------
  // Abstract Methods (must be implemented by subclasses)
  // ---------------------------------------------------------------------------

  /**
   * Send a non-streaming message request
   * @abstract
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @returns {Promise<Object>} Response with content and usage
   */
  async sendMessage(messages, options = {}) {
    throw new Error('sendMessage must be implemented by subclass');
  }

  /**
   * Send a streaming message request
   * @abstract
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @yields {StreamChunk} Streaming chunks
   */
  async *streamMessage(messages, options = {}) {
    throw new Error('streamMessage must be implemented by subclass');
  }

  /**
   * Validate provider configuration
   * @abstract
   * @returns {{valid: boolean, errors: string[]}} Validation result
   */
  validateConfig() {
    throw new Error('validateConfig must be implemented by subclass');
  }

  /**
   * Get provider-specific headers for API requests
   * @abstract
   * @param {string} apiKey - API key to include
   * @returns {Object} Headers object
   */
  getRequiredHeaders(apiKey) {
    throw new Error('getRequiredHeaders must be implemented by subclass');
  }

  // ---------------------------------------------------------------------------
  // Common Methods (shared by all providers)
  // ---------------------------------------------------------------------------

  /**
   * Get API key from configured source
   * @returns {Promise<string|null>} API key or null
   */
  async getApiKey() {
    // If key is directly configured, use it
    if (this.apiKey) {
      return this.apiKey;
    }

    // Get from chrome.storage based on keySource
    if (this.keySource === 'storage' && this.keyStorageKey) {
      try {
        const result = await chrome.storage.local.get(this.keyStorageKey);
        return result[this.keyStorageKey] || null;
      } catch (error) {
        console.error(`[${this.name}] Failed to get API key from storage:`, error);
        return null;
      }
    }

    return null;
  }

  /**
   * Calculate backoff delay for retry
   * @param {number} attempt - Current attempt number (0-indexed)
   * @returns {number} Delay in milliseconds
   */
  getBackoffDelay(attempt) {
    const { initialDelay, backoffMultiplier, maxDelay } = this.retryConfig;
    const baseDelay = initialDelay * Math.pow(backoffMultiplier, attempt);
    const jitter = Math.random() * 1000; // Add jitter
    return Math.min(baseDelay + jitter, maxDelay);
  }

  /**
   * Determine if an error should trigger a retry
   * @param {number} statusCode - HTTP status code
   * @param {Error} error - Error object
   * @returns {boolean} Whether to retry
   */
  shouldRetry(statusCode, error) {
    // Retry on rate limit (429) or server errors (5xx)
    if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
      return true;
    }
    // Retry on network errors
    if (error && (error.name === 'TypeError' || error.message?.includes('network'))) {
      return true;
    }
    return false;
  }

  /**
   * Execute request with retry logic
   * @param {Function} requestFn - Async function that makes the request
   * @returns {Promise<Object>} Request result
   */
  async executeWithRetry(requestFn) {
    let lastError = null;

    for (let attempt = 0; attempt < this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await requestFn();
        return result;
      } catch (error) {
        lastError = error;
        const statusCode = error.statusCode || error.status;

        if (this.shouldRetry(statusCode, error) && attempt < this.retryConfig.maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt);
          console.log(`[${this.name}] Retry ${attempt + 1}/${this.retryConfig.maxRetries} after ${delay}ms`);
          await this.sleep(delay);
          continue;
        }

        // Not retryable or max retries reached
        throw error;
      }
    }

    throw lastError || new ProviderError('Max retries exceeded', this.name, null, false);
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Normalize messages to provider-agnostic format
   * @param {Message[]} messages - Messages to normalize
   * @returns {Message[]} Normalized messages
   */
  normalizeMessages(messages) {
    return messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : msg.content
    }));
  }

  /**
   * Create a standardized error from HTTP response
   * @param {Response} response - Fetch Response object
   * @param {Object} [errorData] - Parsed error data
   * @returns {ProviderError} Appropriate error type
   */
  createErrorFromResponse(response, errorData = {}) {
    const message = errorData.error?.message || `API error: ${response.status}`;

    if (response.status === 401) {
      return new AuthenticationError(message, this.name);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      return new RateLimitError(
        message,
        this.name,
        retryAfter ? parseInt(retryAfter, 10) : null
      );
    }

    const retryable = this.shouldRetry(response.status, null);
    return new ProviderError(message, this.name, response.status, retryable, errorData);
  }

  /**
   * Get provider info for debugging/display
   * @returns {Object} Provider metadata
   */
  getInfo() {
    return {
      name: this.name,
      endpoint: this.apiEndpoint,
      defaultModel: this.defaultModel,
      retryConfig: this.retryConfig
    };
  }

  /**
   * Check if provider is properly configured
   * @returns {Promise<{ready: boolean, error?: string}>}
   */
  async isReady() {
    const validation = this.validateConfig();
    if (!validation.valid) {
      return { ready: false, error: validation.errors.join(', ') };
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ready: false, error: 'API key not configured' };
    }

    return { ready: true };
  }
}

// =============================================================================
// Exports
// =============================================================================

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AIProvider,
    ProviderError,
    ConfigurationError,
    RateLimitError,
    AuthenticationError
  };
}

// Export for ES modules (Chrome extension context)
export {
  AIProvider,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  AuthenticationError
};
