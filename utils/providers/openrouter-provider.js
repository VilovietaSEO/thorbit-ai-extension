/**
 * OpenRouter AI Provider
 *
 * Provides access to 400+ AI models through OpenRouter's unified API gateway.
 * Uses OpenAI-compatible request format with additional OpenRouter-specific headers.
 *
 * Supported models include:
 * - Anthropic: anthropic/claude-sonnet-4.5, anthropic/claude-opus-4.5
 * - OpenAI: openai/gpt-4-turbo, openai/gpt-4o
 * - Google: google/gemini-pro-1.5
 * - Meta: meta-llama/llama-3.1-70b-instruct
 * - And many more...
 *
 * @see https://openrouter.ai/docs
 */

import {
  AIProvider,
  ProviderError,
  ConfigurationError,
  RateLimitError,
  AuthenticationError
} from './base-provider.js';

// =============================================================================
// OpenRouter-Specific Errors
// =============================================================================

/**
 * Error for insufficient credits on OpenRouter account
 */
class InsufficientCreditsError extends ProviderError {
  constructor(message, details = {}) {
    super(message, 'openrouter', 402, false, details);
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * Error for invalid or unavailable model
 */
class InvalidModelError extends ProviderError {
  constructor(message, model, details = {}) {
    super(message, 'openrouter', 400, false, { model, ...details });
    this.name = 'InvalidModelError';
    this.model = model;
  }
}

// =============================================================================
// OpenRouter Provider
// =============================================================================

/**
 * OpenRouter AI Provider
 *
 * Implements AIProvider interface for OpenRouter's API gateway.
 * Provides access to hundreds of models through a single API.
 *
 * @extends AIProvider
 */
class OpenRouterProvider extends AIProvider {
  /**
   * @param {Object} config - Provider configuration
   * @param {string} [config.apiKey] - OpenRouter API key
   * @param {string} [config.keyStorageKey='openrouter_api_key'] - Storage key for API key
   * @param {string} [config.referer='https://thorbit.com'] - HTTP-Referer header value
   * @param {string} [config.appName='Thorbit AI Assistant'] - X-Title header value
   * @param {string} [config.defaultModel='anthropic/claude-sonnet-4.5'] - Default model
   * @param {Object} [config.retry] - Retry configuration
   */
  constructor(config = {}) {
    super({
      name: 'openrouter',
      apiEndpoint: 'https://openrouter.ai/api/v1',
      defaultModel: config.defaultModel || 'anthropic/claude-sonnet-4.5',
      apiKey: config.apiKey || null,
      keySource: config.keySource || 'storage',
      keyStorageKey: config.keyStorageKey || 'openrouter_api_key',
      retry: config.retry
    });

    // OpenRouter-specific configuration
    this.referer = config.referer || 'https://thorbit.com';
    this.appName = config.appName || 'Thorbit AI Assistant';

    // Base URL for API requests
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  // ---------------------------------------------------------------------------
  // Configuration Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate provider configuration
   * @returns {{valid: boolean, errors: string[]}}
   */
  validateConfig() {
    const errors = [];

    if (!this.baseUrl) {
      errors.push('API endpoint (baseUrl) is required');
    }

    if (!this.defaultModel) {
      errors.push('Default model is required');
    }

    // Validate model format (should be provider/model-name)
    if (this.defaultModel && !this.defaultModel.includes('/')) {
      errors.push('Model must be in format: provider/model-name (e.g., anthropic/claude-sonnet-4.5)');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get required headers for OpenRouter API
   * @param {string} apiKey - API key
   * @returns {Object} Headers object
   */
  getRequiredHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.referer,
      'X-Title': this.appName
    };
  }

  // ---------------------------------------------------------------------------
  // Request Building
  // ---------------------------------------------------------------------------

  /**
   * Build request body for OpenRouter API
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} options - Request options
   * @returns {Object} Request body
   */
  buildRequestBody(messages, options = {}) {
    const body = {
      model: options.model || this.defaultModel,
      messages: this.formatMessages(messages, options),
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 1.0,
      stream: options.stream || false
    };

    // Add optional parameters
    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }

    if (options.frequencyPenalty !== undefined) {
      body.frequency_penalty = options.frequencyPenalty;
    }

    if (options.presencePenalty !== undefined) {
      body.presence_penalty = options.presencePenalty;
    }

    if (options.stop) {
      body.stop = options.stop;
    }

    return body;
  }

  /**
   * Format messages for OpenRouter API (OpenAI format)
   * @param {Message[]} messages - Messages to format
   * @param {RequestOptions} options - Request options
   * @returns {Object[]} Formatted messages
   */
  formatMessages(messages, options = {}) {
    const formatted = [];

    // Add system prompt if provided
    if (options.systemPrompt) {
      const systemContent = typeof options.systemPrompt === 'string'
        ? options.systemPrompt
        : options.systemPrompt.text || options.systemPrompt.content;

      if (systemContent) {
        formatted.push({
          role: 'system',
          content: systemContent
        });
      }
    }

    // Format each message
    for (const msg of messages) {
      formatted.push({
        role: msg.role,
        content: this.formatMessageContent(msg.content)
      });
    }

    return formatted;
  }

  /**
   * Format message content (handle text and image content)
   * @param {string|Array} content - Message content
   * @returns {string|Array} Formatted content
   */
  formatMessageContent(content) {
    // Simple string content
    if (typeof content === 'string') {
      return content;
    }

    // Array content (multimodal)
    if (Array.isArray(content)) {
      return content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'image' && block.source) {
          // Convert to OpenAI image format
          return {
            type: 'image_url',
            image_url: {
              url: block.source.data
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source.url
            }
          };
        }
        return block;
      });
    }

    return content;
  }

  // ---------------------------------------------------------------------------
  // Non-Streaming Request
  // ---------------------------------------------------------------------------

  /**
   * Send a non-streaming message request
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @returns {Promise<Object>} Response with content and usage
   */
  async sendMessage(messages, options = {}) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new ConfigurationError('OpenRouter API key not configured', 'openrouter');
    }

    const requestBody = this.buildRequestBody(messages, { ...options, stream: false });

    return this.executeWithRetry(async () => {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getRequiredHeaders(apiKey),
        body: JSON.stringify(requestBody),
        signal: options.signal
      });

      // Track last request for debugging
      this.lastRequest = {
        url: `${this.baseUrl}/chat/completions`,
        body: requestBody,
        timestamp: Date.now()
      };

      if (!response.ok) {
        const error = await this.handleErrorResponse(response);
        this.lastError = error;
        throw error;
      }

      const data = await response.json();
      return this.parseResponse(data);
    });
  }

  /**
   * Parse OpenRouter response to standardized format
   * @param {Object} data - Raw API response
   * @returns {Object} Standardized response
   */
  parseResponse(data) {
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || '',
      finishReason: choice?.finish_reason || 'stop',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0
      },
      model: data.model,
      id: data.id
    };
  }

  // ---------------------------------------------------------------------------
  // Streaming Request
  // ---------------------------------------------------------------------------

  /**
   * Send a streaming message request
   * @param {Message[]} messages - Conversation messages
   * @param {RequestOptions} [options={}] - Request options
   * @yields {StreamChunk} Streaming chunks
   */
  async *streamMessage(messages, options = {}) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new ConfigurationError('OpenRouter API key not configured', 'openrouter');
    }

    const requestBody = this.buildRequestBody(messages, { ...options, stream: true });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getRequiredHeaders(apiKey),
      body: JSON.stringify(requestBody),
      signal: options.signal
    });

    // Track last request for debugging
    this.lastRequest = {
      url: `${this.baseUrl}/chat/completions`,
      body: requestBody,
      timestamp: Date.now(),
      streaming: true
    };

    if (!response.ok) {
      const error = await this.handleErrorResponse(response);
      this.lastError = error;
      throw error;
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
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed || trimmed === ':') {
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              // Stream complete
              if (usage) {
                yield { type: 'usage', usage };
              }
              yield { type: 'done' };
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              const finishReason = parsed.choices?.[0]?.finish_reason;

              // Extract text content
              if (delta?.content) {
                yield { type: 'text', text: delta.content };
              }

              // Capture usage if present (some models include it)
              if (parsed.usage) {
                usage = {
                  inputTokens: parsed.usage.prompt_tokens || 0,
                  outputTokens: parsed.usage.completion_tokens || 0,
                  totalTokens: parsed.usage.total_tokens || 0
                };
              }

              // Handle finish reason
              if (finishReason && finishReason !== 'null') {
                if (usage) {
                  yield { type: 'usage', usage };
                }
                yield { type: 'done', finishReason };
                return;
              }
            } catch (parseError) {
              // Skip malformed JSON, continue processing
              console.warn('[OpenRouter] Failed to parse SSE data:', parseError.message);
            }
          }
        }
      }

      // End of stream without [DONE] marker
      if (usage) {
        yield { type: 'usage', usage };
      }
      yield { type: 'done' };

    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Error Handling
  // ---------------------------------------------------------------------------

  /**
   * Handle error response from OpenRouter API
   * @param {Response} response - Fetch response
   * @returns {Promise<ProviderError>} Appropriate error type
   */
  async handleErrorResponse(response) {
    let errorData = {};

    try {
      errorData = await response.json();
    } catch {
      // Response body not JSON
    }

    const errorMessage = errorData.error?.message
      || errorData.message
      || `OpenRouter API error: ${response.status}`;

    // Handle specific OpenRouter errors
    switch (response.status) {
      case 400:
        // Check if it's an invalid model error
        if (errorMessage.toLowerCase().includes('model')) {
          return new InvalidModelError(
            errorMessage,
            this.lastRequest?.body?.model,
            errorData
          );
        }
        return new ProviderError(errorMessage, 'openrouter', 400, false, errorData);

      case 401:
        return new AuthenticationError(
          'Invalid OpenRouter API key. Please check your credentials.',
          'openrouter'
        );

      case 402:
        return new InsufficientCreditsError(
          'Insufficient credits on OpenRouter account. Please add credits at openrouter.ai.',
          errorData
        );

      case 429:
        const retryAfter = response.headers.get('retry-after');
        return new RateLimitError(
          errorMessage,
          'openrouter',
          retryAfter ? parseInt(retryAfter, 10) : null
        );

      case 503:
        // Model temporarily unavailable
        return new ProviderError(
          `Model temporarily unavailable: ${errorMessage}`,
          'openrouter',
          503,
          true, // Retryable
          errorData
        );

      default:
        return this.createErrorFromResponse(response, errorData);
    }
  }

  // ---------------------------------------------------------------------------
  // Model Utilities
  // ---------------------------------------------------------------------------

  /**
   * Get list of popular models available on OpenRouter
   * @returns {Object[]} Model list with id and name
   */
  static getPopularModels() {
    return [
      // Anthropic
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude 4.5 Sonnet', provider: 'Anthropic' },
      { id: 'anthropic/claude-opus-4.5', name: 'Claude 4.5 Opus', provider: 'Anthropic' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
      { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', provider: 'Anthropic' },
      { id: 'anthropic/claude-3-sonnet', name: 'Claude 3 Sonnet', provider: 'Anthropic' },
      { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', provider: 'Anthropic' },

      // OpenAI
      { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'OpenAI' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'OpenAI' },
      { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'OpenAI' },

      // Google
      { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro', provider: 'Google' },
      { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash', provider: 'Google' },
      { id: 'google/gemini-pro', name: 'Gemini Pro', provider: 'Google' },

      // Meta
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', provider: 'Meta' },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', provider: 'Meta' },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', provider: 'Meta' },

      // Mistral
      { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'Mistral' },
      { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B', provider: 'Mistral' }
    ];
  }

  /**
   * Validate if a model ID is in correct format
   * @param {string} modelId - Model ID to validate
   * @returns {boolean} True if valid format
   */
  static isValidModelFormat(modelId) {
    return typeof modelId === 'string' && modelId.includes('/');
  }
}

// =============================================================================
// Exports
// =============================================================================

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OpenRouterProvider,
    InsufficientCreditsError,
    InvalidModelError
  };
}

// Export for ES modules (Chrome extension context)
export {
  OpenRouterProvider,
  InsufficientCreditsError,
  InvalidModelError
};
