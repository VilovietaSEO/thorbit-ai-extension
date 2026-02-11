/**
 * Anthropic Provider - Claude API Integration
 *
 * Extends AIProvider base class with Anthropic-specific implementation.
 * Supports streaming, prompt caching, and proper error handling.
 *
 * Features:
 * - Claude claude-sonnet-4-5-20250929 and claude-opus-4-5-20250929 models
 * - Prompt caching for 90% cost reduction on system prompts
 * - SSE streaming with proper event parsing
 * - Rate limit handling with retry-after support
 * - Overload detection (529 status)
 */

import {
  AIProvider,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  AuthenticationError
} from './base-provider.js';

// =============================================================================
// Anthropic-Specific Error Types
// =============================================================================

/**
 * Error thrown when Anthropic API is overloaded (529)
 */
class OverloadedError extends ProviderError {
  constructor(message, retryAfter = null) {
    super(message, 'anthropic', 529, true, { retryAfter });
    this.name = 'OverloadedError';
    this.retryAfter = retryAfter;
  }
}

// =============================================================================
// Anthropic Provider Implementation
// =============================================================================

/**
 * Anthropic provider for Claude models
 *
 * @example
 * const provider = new AnthropicProvider({
 *   apiKey: 'sk-ant-...',
 *   defaultModel: 'claude-sonnet-4-5-20250929'
 * });
 *
 * // Non-streaming
 * const response = await provider.sendMessage(messages, { maxTokens: 4096 });
 *
 * // Streaming
 * for await (const chunk of provider.streamMessage(messages)) {
 *   console.log(chunk.text);
 * }
 */
class AnthropicProvider extends AIProvider {
  /**
   * @param {Object} config - Provider configuration
   * @param {string} [config.apiKey] - Anthropic API key (sk-ant-...)
   * @param {string} [config.baseUrl] - API base URL (default: https://api.anthropic.com/v1)
   * @param {string} [config.defaultModel] - Default model (default: claude-sonnet-4-5-20250929)
   * @param {string} [config.anthropicVersion] - API version (default: 2023-06-01)
   * @param {boolean} [config.enableCaching] - Enable prompt caching (default: true)
   */
  constructor(config = {}) {
    super({
      ...config,
      name: 'anthropic',
      apiEndpoint: config.baseUrl || 'https://api.anthropic.com/v1',
      defaultModel: config.defaultModel || 'claude-sonnet-4-5-20250929',
      keyStorageKey: config.keyStorageKey || 'anthropicApiKey'
    });

    this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';
    this.enableCaching = config.enableCaching !== false; // Default true

    // Available models
    this.availableModels = [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20250929',
      'claude-sonnet-4-20250514',
      'claude-3-5-haiku-20241022'
    ];
  }

  // ---------------------------------------------------------------------------
  // Configuration Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate provider configuration
   * @returns {{valid: boolean, errors: string[]}} Validation result
   */
  validateConfig() {
    const errors = [];

    // API key validation is done at request time via getApiKey()
    // Here we validate static config

    if (this.baseUrl && !this.baseUrl.startsWith('http')) {
      errors.push('baseUrl must be a valid HTTP(S) URL');
    }

    if (this.defaultModel && !this.availableModels.includes(this.defaultModel)) {
      // Allow custom models but warn
      console.warn(`[Anthropic] Model ${this.defaultModel} not in known list`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate API key format
   * @param {string} apiKey - API key to validate
   * @returns {boolean} Whether key format is valid
   */
  validateApiKeyFormat(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    // Anthropic keys start with sk-ant-
    return apiKey.startsWith('sk-ant-');
  }

  // ---------------------------------------------------------------------------
  // Header Generation
  // ---------------------------------------------------------------------------

  /**
   * Get required headers for Anthropic API requests
   * @param {string} apiKey - API key to include
   * @returns {Object} Headers object
   */
  getRequiredHeaders(apiKey) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': this.anthropicVersion
    };

    // Enable prompt caching beta if enabled
    if (this.enableCaching) {
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    return headers;
  }

  // ---------------------------------------------------------------------------
  // Request Building
  // ---------------------------------------------------------------------------

  /**
   * Build request payload for Anthropic API
   * @param {Array} messages - Conversation messages
   * @param {Object} options - Request options
   * @returns {Object} API request payload
   */
  buildRequestPayload(messages, options = {}) {
    const payload = {
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens || 4096,
      messages: this.formatMessages(messages)
    };

    // Add system prompt if provided
    if (options.systemPrompt) {
      payload.system = this.formatSystemPrompt(options.systemPrompt);
    }

    // Add temperature if specified (default is 1.0)
    if (typeof options.temperature === 'number') {
      payload.temperature = options.temperature;
    }

    // Add top_p if specified
    if (typeof options.topP === 'number') {
      payload.top_p = options.topP;
    }

    // Add stop sequences if provided
    if (options.stopSequences && Array.isArray(options.stopSequences)) {
      payload.stop_sequences = options.stopSequences;
    }

    return payload;
  }

  /**
   * Format messages for Anthropic API
   * @param {Array} messages - Messages in provider-agnostic format
   * @returns {Array} Messages in Anthropic format
   */
  formatMessages(messages) {
    return messages.map(msg => {
      // Skip system messages (handled separately)
      if (msg.role === 'system') {
        return null;
      }

      const formatted = {
        role: msg.role
      };

      // Handle content
      if (typeof msg.content === 'string') {
        formatted.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Already in content blocks format
        formatted.content = msg.content.map(block => this.formatContentBlock(block));
      } else {
        formatted.content = String(msg.content);
      }

      return formatted;
    }).filter(Boolean); // Remove null entries (system messages)
  }

  /**
   * Format a single content block
   * @param {Object} block - Content block
   * @returns {Object} Formatted block
   */
  formatContentBlock(block) {
    if (block.type === 'text') {
      return {
        type: 'text',
        text: block.text
      };
    }

    if (block.type === 'image') {
      return {
        type: 'image',
        source: block.source
      };
    }

    // Pass through unknown blocks
    return block;
  }

  /**
   * Format system prompt with optional caching
   * @param {string|Object|Array} systemPrompt - System prompt
   * @returns {Array} System prompt in Anthropic format
   */
  formatSystemPrompt(systemPrompt) {
    // Already in array format
    if (Array.isArray(systemPrompt)) {
      return systemPrompt.map(item => {
        if (typeof item === 'string') {
          return this.createCachedTextBlock(item);
        }
        return item;
      });
    }

    // Object format with text and optional cache_control
    if (typeof systemPrompt === 'object' && systemPrompt.text) {
      return [systemPrompt];
    }

    // String format - wrap in cached block
    if (typeof systemPrompt === 'string') {
      return [this.createCachedTextBlock(systemPrompt)];
    }

    return [];
  }

  /**
   * Create a text block with prompt caching enabled
   * @param {string} text - Text content
   * @returns {Object} Text block with cache_control
   */
  createCachedTextBlock(text) {
    const block = {
      type: 'text',
      text: text
    };

    if (this.enableCaching) {
      block.cache_control = { type: 'ephemeral' };
    }

    return block;
  }

  // ---------------------------------------------------------------------------
  // Non-Streaming Request
  // ---------------------------------------------------------------------------

  /**
   * Send a non-streaming message request
   * @param {Array} messages - Conversation messages
   * @param {Object} [options={}] - Request options
   * @returns {Promise<Object>} Response with content and usage
   */
  async sendMessage(messages, options = {}) {
    const apiKey = await this.getApiKey();

    if (!apiKey) {
      throw new ConfigurationError('API key not configured', 'anthropic');
    }

    if (!this.validateApiKeyFormat(apiKey)) {
      throw new ConfigurationError('Invalid Anthropic API key format (must start with sk-ant-)', 'anthropic');
    }

    const url = `${this.baseUrl}/messages`;
    const headers = this.getRequiredHeaders(apiKey);
    const payload = this.buildRequestPayload(messages, options);

    this.lastRequest = {
      url,
      payload: { ...payload, messages: `[${payload.messages.length} messages]` },
      timestamp: Date.now()
    };

    return this.executeWithRetry(async () => {
      const fetchOptions = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      };

      // Support abort signal for cancellation
      if (options.signal) {
        fetchOptions.signal = options.signal;
      }

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw this.createErrorFromResponse(response, errorData);
      }

      const data = await response.json();

      // Log caching statistics
      if (data.usage) {
        console.log('[Anthropic] Token usage:', {
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
          cacheCreation: data.usage.cache_creation_input_tokens || 0,
          cacheRead: data.usage.cache_read_input_tokens || 0
        });
      }

      // Extract text content from response
      const content = this.extractTextContent(data.content);

      return {
        content,
        model: data.model,
        stopReason: data.stop_reason,
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
          cacheCreationTokens: data.usage?.cache_creation_input_tokens || 0,
          cacheReadTokens: data.usage?.cache_read_input_tokens || 0
        }
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming Request
  // ---------------------------------------------------------------------------

  /**
   * Send a streaming message request
   * @param {Array} messages - Conversation messages
   * @param {Object} [options={}] - Request options
   * @yields {Object} Streaming chunks with type: 'text', 'error', 'done', or 'usage'
   */
  async *streamMessage(messages, options = {}) {
    const apiKey = await this.getApiKey();

    if (!apiKey) {
      yield { type: 'error', error: 'API key not configured' };
      return;
    }

    if (!this.validateApiKeyFormat(apiKey)) {
      yield { type: 'error', error: 'Invalid Anthropic API key format' };
      return;
    }

    const url = `${this.baseUrl}/messages`;
    const headers = this.getRequiredHeaders(apiKey);
    const payload = {
      ...this.buildRequestPayload(messages, options),
      stream: true
    };

    this.lastRequest = {
      url,
      payload: { ...payload, messages: `[${payload.messages.length} messages]` },
      timestamp: Date.now()
    };

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    };

    if (options.signal) {
      fetchOptions.signal = options.signal;
    }

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (error.name === 'AbortError') {
        yield { type: 'error', error: 'Request aborted' };
        return;
      }
      yield { type: 'error', error: `Network error: ${error.message}` };
      return;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const providerError = this.createErrorFromResponse(response, errorData);
      this.lastError = providerError;
      yield { type: 'error', error: providerError.message, statusCode: response.status };
      return;
    }

    // Process SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Yield final usage if available
          if (usage) {
            yield { type: 'usage', usage };
          }
          yield { type: 'done' };
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by \n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer

        for (const eventBlock of events) {
          const parsed = this.parseSSEEvent(eventBlock);
          if (!parsed) continue;

          const { eventType, data } = parsed;

          // Handle different event types
          switch (eventType) {
            case 'message_start':
              // Initial message with model info
              if (data.message?.usage) {
                usage = {
                  inputTokens: data.message.usage.input_tokens || 0,
                  outputTokens: 0,
                  cacheCreationTokens: data.message.usage.cache_creation_input_tokens || 0,
                  cacheReadTokens: data.message.usage.cache_read_input_tokens || 0
                };
              }
              break;

            case 'content_block_start':
              // Start of a content block (text, tool_use, etc.)
              break;

            case 'content_block_delta':
              // Delta content - the main text chunks
              if (data.delta?.type === 'text_delta' && data.delta.text) {
                yield { type: 'text', text: data.delta.text };
              }
              break;

            case 'content_block_stop':
              // End of a content block
              break;

            case 'message_delta':
              // Final message info with stop reason and output tokens
              if (data.usage?.output_tokens) {
                if (usage) {
                  usage.outputTokens = data.usage.output_tokens;
                }
              }
              break;

            case 'message_stop':
              // Stream complete
              if (usage) {
                yield { type: 'usage', usage };
              }
              yield { type: 'done' };
              return;

            case 'error':
              // Error event in stream
              yield { type: 'error', error: data.error?.message || 'Stream error' };
              return;

            case 'ping':
              // Keep-alive ping, ignore
              break;

            default:
              // Unknown event type, log and continue
              console.log(`[Anthropic] Unknown event type: ${eventType}`);
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        yield { type: 'error', error: 'Stream aborted' };
      } else {
        yield { type: 'error', error: `Stream error: ${error.message}` };
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {
        // Reader may already be released
      }
    }
  }

  /**
   * Parse a single SSE event block
   * @param {string} eventBlock - Raw SSE event text
   * @returns {Object|null} Parsed event with eventType and data
   */
  parseSSEEvent(eventBlock) {
    const lines = eventBlock.split('\n');
    let eventType = null;
    let data = null;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') {
          return { eventType: 'done', data: {} };
        }
        try {
          data = JSON.parse(dataStr);
        } catch (e) {
          // Non-JSON data, skip
          continue;
        }
      }
    }

    // If we have data, use its type if event wasn't explicit
    if (data && !eventType && data.type) {
      eventType = data.type;
    }

    if (eventType && data) {
      return { eventType, data };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Response Processing
  // ---------------------------------------------------------------------------

  /**
   * Extract text content from response content blocks
   * @param {Array} contentBlocks - Response content blocks
   * @returns {string} Combined text content
   */
  extractTextContent(contentBlocks) {
    if (!contentBlocks || !Array.isArray(contentBlocks)) {
      return '';
    }

    return contentBlocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  /**
   * Create a standardized error from HTTP response
   * @param {Response} response - Fetch Response object
   * @param {Object} [errorData] - Parsed error data
   * @returns {ProviderError} Appropriate error type
   */
  createErrorFromResponse(response, errorData = {}) {
    const message = errorData.error?.message || `API error: ${response.status}`;

    // Authentication error (401)
    if (response.status === 401) {
      return new AuthenticationError(message, 'anthropic');
    }

    // Rate limit error (429)
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      return new RateLimitError(
        message,
        'anthropic',
        retryAfter ? parseInt(retryAfter, 10) : null
      );
    }

    // Overloaded error (529)
    if (response.status === 529) {
      const retryAfter = response.headers.get('retry-after');
      return new OverloadedError(
        message || 'Anthropic API is overloaded',
        retryAfter ? parseInt(retryAfter, 10) : null
      );
    }

    // Bad request (400) - usually invalid request
    if (response.status === 400) {
      return new ProviderError(message, 'anthropic', 400, false, errorData);
    }

    // Server errors (5xx) - retryable
    if (response.status >= 500) {
      return new ProviderError(message, 'anthropic', response.status, true, errorData);
    }

    // Default error
    const retryable = this.shouldRetry(response.status, null);
    return new ProviderError(message, 'anthropic', response.status, retryable, errorData);
  }

  /**
   * Determine if an error should trigger a retry
   * Extends base class to handle Anthropic-specific status codes
   * @param {number} statusCode - HTTP status code
   * @param {Error} error - Error object
   * @returns {boolean} Whether to retry
   */
  shouldRetry(statusCode, error) {
    // Anthropic 529 (overloaded) is retryable
    if (statusCode === 529) {
      return true;
    }
    // Delegate to base class for standard codes
    return super.shouldRetry(statusCode, error);
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Get list of available models
   * @returns {string[]} Array of model IDs
   */
  getAvailableModels() {
    return [...this.availableModels];
  }

  /**
   * Check if provider is properly configured
   * @returns {Promise<{ready: boolean, error?: string}>}
   */
  async isReady() {
    const baseReady = await super.isReady();
    if (!baseReady.ready) {
      return baseReady;
    }

    const apiKey = await this.getApiKey();
    if (!this.validateApiKeyFormat(apiKey)) {
      return {
        ready: false,
        error: 'Invalid Anthropic API key format (must start with sk-ant-)'
      };
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
    AnthropicProvider,
    OverloadedError
  };
}

// Export for ES modules (Chrome extension context)
export { AnthropicProvider, OverloadedError };
