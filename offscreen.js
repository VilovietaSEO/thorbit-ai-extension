/**
 * Offscreen Document for AI Page Assistant Chrome Extension
 *
 * Purpose: Execute AI API calls and DOM processing in an isolated context.
 * Offscreen documents can make network requests that would be blocked by CSP
 * in service workers, and they persist across service worker terminations.
 *
 * Message Flow:
 * 1. Service worker ensures offscreen document exists (recovery pattern)
 * 2. Service worker sends message with target: 'offscreen'
 * 3. This document processes the request (AI API call)
 * 4. Response sent back via sendResponse
 *
 * Streaming Flow:
 * 1. Port connection established from service worker
 * 2. Streaming request received via port
 * 3. SSE chunks forwarded back through port.postMessage
 * 4. Completion message sent when stream ends
 *
 * Provider Support:
 * - Anthropic: Direct API calls with prompt caching
 * - OpenRouter: 400+ models through unified gateway (BYOK)
 * - Fallback: Backend proxy when no API keys configured
 */

import { ProviderManager } from './utils/providers/provider-manager.js';
import { AnthropicProvider } from './utils/providers/anthropic-provider.js';
import { OpenRouterProvider } from './utils/providers/openrouter-provider.js';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Default model configuration
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,

  // Backend proxy configuration (fallback when no API keys)
  useBackendProxy: false,
  backendProxyUrl: 'http://localhost:3000/api/ai',
  backendProxyEndpoint: 'https://api.anthropic.com/v1/messages'
};

// =============================================================================
// Provider Manager Instance
// =============================================================================

const providerManager = new ProviderManager();

/**
 * Initialize providers from stored API keys
 * Called on document load and when settings change
 */
async function initializeProviders() {
  console.log('[Offscreen] Initializing providers...');

  try {
    // Load API keys from storage
    const localData = await chrome.storage.local.get([
      'anthropicApiKey',
      'openrouter_api_key'
    ]);

    const syncData = await chrome.storage.sync.get([
      'provider',
      'apiKeys'
    ]);

    // Merge storage sources (sync takes precedence for apiKeys)
    const apiKeys = {
      anthropic: syncData.apiKeys?.anthropic || localData.anthropicApiKey || null,
      openrouter: syncData.apiKeys?.openrouter || localData.openrouter_api_key || null
    };

    // Register Anthropic provider if API key exists
    if (apiKeys.anthropic) {
      const anthropicProvider = new AnthropicProvider({
        apiKey: apiKeys.anthropic,
        defaultModel: CONFIG.model,
        enableCaching: true
      });

      providerManager.registerProvider('anthropic', anthropicProvider);
      console.log('[Offscreen] Anthropic provider registered');
    }

    // Register OpenRouter provider if API key exists
    if (apiKeys.openrouter) {
      const openRouterProvider = new OpenRouterProvider({
        apiKey: apiKeys.openrouter,
        defaultModel: 'anthropic/claude-sonnet-4.5',
        referer: 'https://thorbit.com',
        appName: 'Thorbit AI Assistant'
      });

      providerManager.registerProvider('openrouter', openRouterProvider);
      console.log('[Offscreen] OpenRouter provider registered');
    }

    // Set active provider from settings
    const preferredProvider = syncData.provider || 'anthropic';

    if (providerManager.hasProvider(preferredProvider)) {
      const result = await providerManager.setActiveProvider(preferredProvider);
      if (result.success) {
        console.log(`[Offscreen] Active provider set to: ${preferredProvider}`);
      } else {
        console.warn(`[Offscreen] Failed to set active provider: ${result.error}`);
        // Try to recover with any available provider
        await providerManager.attemptRecovery();
      }
    } else if (providerManager.getProviderNames().length > 0) {
      // Fallback to first available provider
      await providerManager.attemptRecovery();
    }

    // Log provider status
    const activeProvider = providerManager.getActiveProviderName();
    console.log(`[Offscreen] Initialization complete. Active provider: ${activeProvider || 'none'}`);

    return {
      success: true,
      activeProvider,
      availableProviders: providerManager.getProviderNames()
    };

  } catch (error) {
    console.error('[Offscreen] Provider initialization failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Listen for storage changes to update providers dynamically
 */
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  const relevantKeys = [
    'anthropicApiKey',
    'openrouter_api_key',
    'provider',
    'apiKeys'
  ];

  const hasRelevantChange = relevantKeys.some(key => key in changes);

  if (hasRelevantChange) {
    console.log('[Offscreen] Settings changed, reinitializing providers...');
    await initializeProviders();
  }
});

// =============================================================================
// Backend Proxy Fallback
// =============================================================================

/**
 * Get session token for backend proxy authentication
 * @returns {Promise<string|null>} Session token or null
 */
async function getSessionToken() {
  const result = await chrome.storage.session.get('sessionToken');
  return result.sessionToken || null;
}

/**
 * Check if we should use backend proxy (no API keys configured)
 * @returns {boolean}
 */
function shouldUseBackendProxy() {
  return CONFIG.useBackendProxy && !providerManager.getActiveProvider();
}

// =============================================================================
// System Prompts
// =============================================================================

/**
 * System prompt for DOM analysis - marked for caching
 * This prompt is reused across requests, so caching provides 90% cost reduction
 */
const SYSTEM_PROMPT_TEXT = `You are an AI assistant that analyzes web pages. You help users understand page content, find information, and interact with web elements.

When analyzing a page, you receive a pruned DOM representation that includes:
- Page title and URL
- Interactive elements (buttons, links, inputs) with unique labels like [0], [1], etc.
- Visible text content from the viewport area
- Hidden element indicators (elements not currently visible)

Your capabilities:
1. Summarize page content and purpose
2. Find specific information requested by the user
3. Identify interactive elements and their purposes
4. Suggest actions the user might want to take
5. Answer questions about the page structure and content

Guidelines:
- Be concise but thorough
- Reference specific elements by their labels when relevant
- If information is not visible in the provided DOM, say so
- Suggest scrolling or navigation if needed information might be elsewhere
- Format responses with clear sections when appropriate

Always respond in a helpful, conversational manner.`;

/**
 * System prompt object with cache control (for Anthropic direct API)
 */
const SYSTEM_PROMPT = {
  type: 'text',
  text: SYSTEM_PROMPT_TEXT,
  cache_control: { type: 'ephemeral' }
};

/**
 * Build the messages array with proper structure
 * @param {string} dom - Pruned DOM content
 * @param {string} url - Page URL
 * @param {string} title - Page title
 * @param {string} prompt - User's analysis prompt
 * @returns {Array} Messages array for API request
 */
function buildMessages(dom, url, title, prompt) {
  return [
    {
      role: 'user',
      content: `Page Information:
URL: ${url}
Title: ${title}

DOM Content:
${dom}

---

User Request: ${prompt}`
    }
  ];
}

// =============================================================================
// AI API Calls via Provider Manager
// =============================================================================

/**
 * Analyze DOM content using AI via provider manager
 * @param {Object} params - Analysis parameters
 * @param {string} params.dom - Pruned DOM content
 * @param {string} params.url - Page URL
 * @param {string} params.title - Page title
 * @param {string} params.prompt - User's analysis prompt
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeDomWithAI({ dom, url, title, prompt }) {
  const activeProvider = providerManager.getActiveProvider();

  // If no provider configured, try backend proxy fallback
  if (!activeProvider) {
    if (shouldUseBackendProxy()) {
      return await analyzeDomWithBackendProxy({ dom, url, title, prompt });
    }

    return {
      error: 'No AI provider configured. Please set up authentication.',
      needsAuth: true
    };
  }

  const messages = buildMessages(dom, url, title, prompt);

  const options = {
    maxTokens: CONFIG.maxTokens,
    systemPrompt: SYSTEM_PROMPT_TEXT
  };

  try {
    const response = await providerManager.sendMessage(messages, options);

    console.log('[Offscreen] AI response received:', {
      provider: providerManager.getActiveProviderName(),
      model: response.model,
      usage: response.usage
    });

    return {
      success: true,
      content: response.content,
      model: response.model,
      usage: response.usage,
      stopReason: response.stopReason || response.finishReason,
      provider: providerManager.getActiveProviderName()
    };
  } catch (error) {
    console.error('[Offscreen] AI analysis error:', error);

    // Check if we should attempt provider recovery
    if (error.retryable === false && providerManager.getProviderNames().length > 1) {
      console.log('[Offscreen] Attempting provider recovery...');
      const recovery = await providerManager.attemptRecovery();
      if (recovery.recovered) {
        console.log(`[Offscreen] Recovered to provider: ${recovery.provider}`);
        // Retry with new provider
        return analyzeDomWithAI({ dom, url, title, prompt });
      }
    }

    return {
      error: error.message,
      errorCode: error.statusCode,
      retryable: error.retryable !== false,
      provider: providerManager.getActiveProviderName()
    };
  }
}

/**
 * Backend proxy fallback for when no API keys are configured
 * @param {Object} params - Analysis parameters
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeDomWithBackendProxy({ dom, url, title, prompt }) {
  console.log('[Offscreen] Using backend proxy fallback');

  const payload = {
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system: [SYSTEM_PROMPT],
    messages: buildMessages(dom, url, title, prompt)
  };

  try {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };

    const sessionToken = await getSessionToken();
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`;
    }

    const response = await fetch(CONFIG.backendProxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Backend proxy error: ${response.status}`);
    }

    const data = await response.json();

    const textContent = data.content
      ?.filter(block => block.type === 'text')
      ?.map(block => block.text)
      ?.join('\n') || '';

    return {
      success: true,
      content: textContent,
      model: data.model,
      usage: data.usage,
      stopReason: data.stop_reason,
      provider: 'backend-proxy'
    };
  } catch (error) {
    console.error('[Offscreen] Backend proxy error:', error);
    return {
      error: error.message,
      provider: 'backend-proxy'
    };
  }
}

/**
 * Extract structured data using AI via provider manager
 * @param {Object} params - Extraction parameters
 * @param {string} params.html - HTML content
 * @param {Object} params.schema - Expected data schema
 * @returns {Promise<Object>} Extracted data
 */
async function extractStructuredData({ html, schema }) {
  const activeProvider = providerManager.getActiveProvider();

  if (!activeProvider && !shouldUseBackendProxy()) {
    return {
      error: 'No AI provider configured. Please set up authentication.',
      needsAuth: true
    };
  }

  const extractionSystemPrompt = `You are a data extraction assistant. Extract structured data from HTML content according to the provided schema. Return ONLY valid JSON matching the schema.

Schema:
${JSON.stringify(schema, null, 2)}

Extract the data and return it as JSON.`;

  const messages = [
    {
      role: 'user',
      content: `Extract data from this HTML:\n\n${html}`
    }
  ];

  const options = {
    maxTokens: CONFIG.maxTokens,
    systemPrompt: extractionSystemPrompt
  };

  try {
    const response = await providerManager.sendMessage(messages, options);

    const textContent = response.content || '';

    // Try to parse as JSON
    try {
      const extracted = JSON.parse(textContent);
      return {
        success: true,
        data: extracted,
        usage: response.usage,
        provider: providerManager.getActiveProviderName()
      };
    } catch (parseError) {
      return {
        success: true,
        data: textContent,
        warning: 'Response was not valid JSON',
        usage: response.usage,
        provider: providerManager.getActiveProviderName()
      };
    }
  } catch (error) {
    console.error('[Offscreen] Data extraction error:', error);
    return {
      error: error.message,
      errorCode: error.statusCode,
      provider: providerManager.getActiveProviderName()
    };
  }
}

// =============================================================================
// Streaming Support via Provider Manager
// =============================================================================

/**
 * Handle streaming AI request via port connection
 * Uses provider manager for multi-provider support
 * @param {chrome.runtime.Port} port - Port for sending chunks
 * @param {Object} params - Request parameters
 */
async function handleStreamingRequest(port, params) {
  const { dom, url, title, prompt } = params;
  const activeProvider = providerManager.getActiveProvider();

  if (!activeProvider) {
    // Try backend proxy fallback for streaming
    if (shouldUseBackendProxy()) {
      await handleStreamingWithBackendProxy(port, params);
      return;
    }

    port.postMessage({
      error: 'No AI provider configured. Please set up authentication.',
      needsAuth: true,
      done: true
    });
    return;
  }

  const messages = buildMessages(dom, url, title, prompt);

  const options = {
    maxTokens: CONFIG.maxTokens,
    systemPrompt: SYSTEM_PROMPT_TEXT,
    stream: true
  };

  try {
    console.log(`[Offscreen] Starting stream with provider: ${providerManager.getActiveProviderName()}`);

    const stream = providerManager.streamMessage(messages, options);

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text':
          port.postMessage({
            chunk: chunk.text,
            provider: providerManager.getActiveProviderName()
          });
          break;

        case 'usage':
          port.postMessage({
            usage: chunk.usage,
            provider: providerManager.getActiveProviderName()
          });
          break;

        case 'error':
          port.postMessage({
            error: chunk.error,
            statusCode: chunk.statusCode,
            done: true
          });
          return;

        case 'done':
          port.postMessage({
            done: true,
            finishReason: chunk.finishReason,
            provider: providerManager.getActiveProviderName()
          });
          return;
      }
    }

    // Ensure we send done if stream ends without explicit done event
    port.postMessage({
      done: true,
      provider: providerManager.getActiveProviderName()
    });

  } catch (error) {
    console.error('[Offscreen] Streaming error:', error);
    port.postMessage({
      error: error.message,
      done: true,
      provider: providerManager.getActiveProviderName()
    });
  }
}

/**
 * Backend proxy fallback for streaming when no API keys configured
 * @param {chrome.runtime.Port} port - Port for sending chunks
 * @param {Object} params - Request parameters
 */
async function handleStreamingWithBackendProxy(port, params) {
  const { dom, url, title, prompt } = params;

  console.log('[Offscreen] Using backend proxy for streaming');

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  };

  const sessionToken = await getSessionToken();
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  const payload = {
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    stream: true,
    system: [SYSTEM_PROMPT],
    messages: buildMessages(dom, url, title, prompt)
  };

  try {
    const response = await fetch(CONFIG.backendProxyUrl + '/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      port.postMessage({
        error: errorData.error?.message || `Backend proxy error: ${response.status}`,
        done: true
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        port.postMessage({ done: true, provider: 'backend-proxy' });
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            port.postMessage({ done: true, provider: 'backend-proxy' });
            return;
          }

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_delta') {
              const delta = event.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                port.postMessage({
                  chunk: delta.text,
                  provider: 'backend-proxy'
                });
              }
            } else if (event.type === 'message_stop') {
              port.postMessage({ done: true, provider: 'backend-proxy' });
              return;
            } else if (event.type === 'error') {
              port.postMessage({
                error: event.error?.message || 'Stream error',
                done: true
              });
              return;
            }
          } catch (parseError) {
            // Skip non-JSON lines
          }
        }
      }
    }
  } catch (error) {
    console.error('[Offscreen] Backend proxy streaming error:', error);
    port.postMessage({
      error: error.message,
      done: true
    });
  }
}

// =============================================================================
// Message Handling
// =============================================================================

/**
 * Main message handler for offscreen document
 * Routes messages to appropriate handlers based on action
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at offscreen document
  if (message.target !== 'offscreen') {
    return false;
  }

  console.log('[Offscreen] Received message:', message.action);

  // Route to appropriate handler
  handleMessage(message)
    .then(result => {
      console.log('[Offscreen] Sending response for:', message.action);
      sendResponse(result);
    })
    .catch(error => {
      console.error('[Offscreen] Error handling message:', error);
      sendResponse({
        error: error.message,
        action: message.action
      });
    });

  // Return true to indicate async response
  return true;
});

/**
 * Route message to appropriate handler
 * @param {Object} message - Message object with action
 * @returns {Promise<Object>} Handler result
 */
async function handleMessage(message) {
  switch (message.action) {
    case 'ANALYZE_DOM':
      return await analyzeDomWithAI({
        dom: message.dom,
        url: message.url,
        title: message.title,
        prompt: message.prompt
      });

    case 'EXTRACT_DATA':
      return await extractStructuredData({
        html: message.html,
        schema: message.schema
      });

    case 'AI_REQUEST':
      // Generic AI request - can be customized based on payload
      return await analyzeDomWithAI({
        dom: message.dom || '',
        url: message.url || 'N/A',
        title: message.title || 'N/A',
        prompt: message.prompt || message.query || 'Analyze this content.'
      });

    case 'GET_PROVIDER_STATUS':
      // Return current provider status
      return {
        success: true,
        activeProvider: providerManager.getActiveProviderName(),
        availableProviders: providerManager.getProviderNames(),
        providersInfo: providerManager.getProvidersInfo(),
        health: await providerManager.checkHealth()
      };

    case 'SWITCH_PROVIDER':
      // Switch to a different provider
      if (!message.provider) {
        return { error: 'Provider name required' };
      }
      const switchResult = await providerManager.switchProvider(message.provider);
      return {
        success: switchResult.success,
        error: switchResult.error,
        activeProvider: providerManager.getActiveProviderName()
      };

    case 'REINITIALIZE_PROVIDERS':
      // Reinitialize providers from storage
      return await initializeProviders();

    case 'PING':
      return {
        status: 'alive',
        timestamp: Date.now(),
        document: 'offscreen',
        activeProvider: providerManager.getActiveProviderName()
      };

    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

// =============================================================================
// Port-Based Streaming Connection
// =============================================================================

/**
 * Handle port connections for streaming responses
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-stream') {
    return;
  }

  console.log('[Offscreen] Stream port connected');

  port.onMessage.addListener(async (message) => {
    if (message.action === 'STREAM_AI_REQUEST') {
      await handleStreamingRequest(port, message);
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[Offscreen] Stream port disconnected');
  });
});

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the offscreen document
 * - Set up providers from stored API keys
 * - Listen for configuration changes
 */
async function initialize() {
  console.log('[Offscreen] Document loading...');

  try {
    const result = await initializeProviders();
    console.log('[Offscreen] Initialization result:', result);

    if (!result.success) {
      console.warn('[Offscreen] Provider initialization warning:', result.error);
    }

    console.log('[Offscreen] Document loaded and ready');
    console.log('[Offscreen] Available providers:', providerManager.getProviderNames());
    console.log('[Offscreen] Active provider:', providerManager.getActiveProviderName() || 'none');

  } catch (error) {
    console.error('[Offscreen] Initialization error:', error);
  }
}

// Run initialization on document load
initialize();
