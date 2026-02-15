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

// Immediately log to verify script is loading
console.log('[Offscreen] Script file loaded at', new Date().toISOString());

// Track initialization state
let initializationError = null;
let providersReady = false;
let initializationStep = 'not_started';
let initializationLogs = [];

// Declare module variables (will be assigned after dynamic import)
let ProviderManager = null;
let AnthropicProvider = null;
let OpenRouterProvider = null;
let AgentPromptAssembler = null;
let providerManager = null;
let agentPromptAssembler = null;

// Helper to track initialization progress
function logProgress(step, message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${step}: ${message}`;
  console.log('[Offscreen]', logEntry);
  initializationLogs.push(logEntry);
  initializationStep = step;
}

// Load modules dynamically with error handling
async function loadModules() {
  try {
    logProgress('load_modules_start', 'Starting module imports');

    const [pmModule, apModule, orModule, aaModule] = await Promise.all([
      import('./utils/providers/provider-manager.js'),
      import('./utils/providers/anthropic-provider.js'),
      import('./utils/providers/openrouter-provider.js'),
      import('./prompts/agent-assembler.js')
    ]);

    logProgress('modules_imported', 'Extracting classes from modules');

    ProviderManager = pmModule.ProviderManager;
    AnthropicProvider = apModule.AnthropicProvider;
    OpenRouterProvider = orModule.OpenRouterProvider;
    AgentPromptAssembler = aaModule.AgentPromptAssembler;

    logProgress('creating_instances', 'Creating provider manager instances');

    // Create instances
    providerManager = new ProviderManager();
    agentPromptAssembler = new AgentPromptAssembler();

    logProgress('load_modules_complete', 'All modules loaded successfully');
    return true;
  } catch (error) {
    const errorMsg = `${error.name}: ${error.message}`;
    logProgress('load_modules_error', errorMsg);
    console.error('[Offscreen] MODULE LOAD ERROR:', error);
    console.error('[Offscreen] Error stack:', error.stack);
    initializationError = `Module load failed: ${error.message}`;
    return false;
  }
}

console.log('[Offscreen] Module loader defined');

// =============================================================================
// Early Message Handler Registration (works even if modules fail to load)
// =============================================================================

// Register message listener immediately so PING always works
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at offscreen document
  if (message.target !== 'offscreen') {
    return false;
  }

  console.log('[Offscreen] Received message:', message.action, 'providersReady:', providersReady);

  // Handle PING immediately even if providers aren't ready
  if (message.action === 'PING') {
    sendResponse({
      status: 'alive',
      timestamp: Date.now(),
      document: 'offscreen',
      providersReady: providersReady,
      initializationError: initializationError,
      initializationStep: initializationStep,
      initializationLogs: initializationLogs.slice(-10), // Last 10 log entries
      activeProvider: providerManager?.getActiveProviderName() || null,
      availableProviders: providerManager?.getProviderNames() || [],
      hasProviderManager: !!providerManager,
      hasAgentAssembler: !!agentPromptAssembler
    });
    return true;
  }

  // For other messages, check if providers are ready
  if (!providersReady) {
    sendResponse({
      error: initializationError || 'Providers not yet initialized. Please wait.',
      providersReady: false
    });
    return true;
  }

  // Route to full message handler
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

  return true;
});

console.log('[Offscreen] Early message listener registered');

// Test if script continues executing
try {
  initializationLogs.push('[CHECKPOINT 1] After message listener registration');
  console.log('[Offscreen] Checkpoint 1 passed');
} catch (e) {
  console.error('[Offscreen] Checkpoint 1 failed:', e);
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Default model configuration
  model: 'claude-sonnet-4-20250514',
  maxTokens: 6000,

  // Backend proxy configuration (fallback when no API keys)
  useBackendProxy: false,
  backendProxyUrl: 'http://localhost:3000/api/ai',
  backendProxyEndpoint: 'https://api.anthropic.com/v1/messages'
};

initializationLogs.push('[CHECKPOINT] After CONFIG');

// =============================================================================
// Provider Manager Instance (created after modules load)
// =============================================================================

// providerManager and agentPromptAssembler are created in loadModules()
// and assigned to the let variables declared at the top

/**
 * Initialize providers from stored API keys
 * Called on document load and when settings change
 */
async function initializeProviders() {
  console.log('[Offscreen] Initializing providers...');

  try {
    // Offscreen documents only have chrome.runtime access, not chrome.storage
    // Get settings from service worker via message passing
    const settingsResponse = await chrome.runtime.sendMessage({
      type: 'GET_SETTINGS'
    });

    if (!settingsResponse || settingsResponse.error) {
      console.warn('[Offscreen] Failed to get settings from service worker:', settingsResponse?.error);
      return {
        success: false,
        error: 'Failed to load settings from service worker'
      };
    }

    const settings = settingsResponse.settings || {};

    // Get API keys from settings
    const apiKeys = {
      anthropic: settings.apiKeys?.anthropic || null,
      openrouter: settings.apiKeys?.openrouter || null
    };

    // Get the active provider and model from settings
    const activeProvider = settings.provider || 'anthropic';
    const activeModel = settings.model || settings.models?.[activeProvider] || 'claude-sonnet-4-5-20250929';

    console.log('[Offscreen] Settings loaded:', {
      hasAnthropicKey: !!apiKeys.anthropic,
      anthropicKeyLength: apiKeys.anthropic?.length || 0,
      hasOpenRouterKey: !!apiKeys.openrouter,
      activeProvider,
      activeModel,
      rawSettings: JSON.stringify(settings).substring(0, 200)
    });

    // Get model for each provider from settings
    const anthropicModel = settings.models?.anthropic || 'claude-sonnet-4-5-20250929';
    const openrouterModel = settings.models?.openrouter || 'mistralai/mistral-large-2411';

    // Register Anthropic provider if API key exists
    if (apiKeys.anthropic) {
      const anthropicProvider = new AnthropicProvider({
        apiKey: apiKeys.anthropic,
        defaultModel: anthropicModel,
        enableCaching: true
      });

      providerManager.registerProvider('anthropic', anthropicProvider);
      console.log('[Offscreen] Anthropic provider registered with model:', anthropicModel);
    }

    // Register OpenRouter provider if API key exists
    if (apiKeys.openrouter) {
      const openRouterProvider = new OpenRouterProvider({
        apiKey: apiKeys.openrouter,
        defaultModel: openrouterModel,
        referer: 'https://thorbit.com',
        appName: 'Thorbit AI Assistant'
      });

      providerManager.registerProvider('openrouter', openRouterProvider);
      console.log('[Offscreen] OpenRouter provider registered with model:', openrouterModel);
    }

    // Set active provider from settings
    if (providerManager.hasProvider(activeProvider)) {
      const result = await providerManager.setActiveProvider(activeProvider);
      if (result.success) {
        console.log(`[Offscreen] Active provider set to: ${activeProvider}`);
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
    const finalActiveProvider = providerManager.getActiveProviderName();
    console.log(`[Offscreen] Initialization complete. Active provider: ${finalActiveProvider || 'none'}`);

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
// TEMPORARILY COMMENTED OUT TO DEBUG
// chrome.storage.onChanged.addListener(async (changes, areaName) => {
//   const relevantKeys = [
//     'settings',  // Primary settings key from settings-manager.js
//     'anthropicApiKey',  // Legacy
//     'openrouter_api_key',  // Legacy
//     'provider',  // Legacy
//     'apiKeys'  // Legacy
//   ];

//   const hasRelevantChange = relevantKeys.some(key => key in changes);

//   if (hasRelevantChange) {
//     console.log('[Offscreen] Settings changed, reinitializing providers...');
//     await initializeProviders();
//   }
// });

initializationLogs.push('[CHECKPOINT] After storage listener (commented out)');

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
/**
 * Chat System Prompt - Conversational AI with browser tools
 */
const CHAT_SYSTEM_PROMPT = `You are a helpful AI assistant in a browser extension. You can chat naturally AND control the browser when needed.

## When to use browser actions
- User asks you to navigate somewhere: use navigate action
- User asks you to click, type, or interact: use those actions
- User just wants to chat or ask questions: just respond normally

## Available Actions
When you need to control the browser, add an actions block at the END of your response:

\`\`\`actions
[{ "type": "navigate", "url": "https://google.com" }]
\`\`\`

Actions:
- navigate: { "type": "navigate", "url": "https://..." }
- click: { "type": "click", "label": 0 }
- type: { "type": "type", "label": 0, "value": "text" }
- scroll: { "type": "scroll", "direction": "down" }
- back: { "type": "back" }

## Response style
- Be concise and natural
- For navigation requests, just do it with a brief acknowledgment
- Don't be verbose about what you're doing
- If you can't do something, explain briefly why`;

/**
 * Agent System Prompt - For when actively analyzing/interacting with a page
 * Used by AGENT_STEP in the agentic loop after navigation/actions
 */
const AGENT_SYSTEM_PROMPT = `You are a browser automation agent executing a multi-step task. You MUST continue acting until the goal is fully achieved.

## Page Elements
Interactive elements are labeled [0], [1], [2], etc. Use these labels for click/type actions.

## Output Format
ALWAYS respond with actions in this EXACT format:

\`\`\`actions
[{ "type": "click", "label": 0 }]
\`\`\`

Available actions:
- click: { "type": "click", "label": 5 }
- type: { "type": "type", "label": 3, "value": "search text" }
- scroll: { "type": "scroll", "direction": "down" }
- navigate: { "type": "navigate", "url": "https://..." }
- wait: { "type": "wait", "ms": 1000 }
- back: { "type": "back" }

## Rules
- If the goal is NOT yet achieved, you MUST return actions to continue
- If the goal IS fully achieved, respond with ONLY text (no actions block)
- If stuck, return: \`\`\`actions
[{ "type": "stuck", "reason": "explanation" }]
\`\`\`
- Maximum 3 actions per response
- Keep text brief — focus on actions, not descriptions`;

// Keep old name for backward compatibility
const SYSTEM_PROMPT_TEXT = AGENT_SYSTEM_PROMPT;

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

/**
 * Build user message from page observation for agent action planning
 * @param {Object} observation - Page observation from content script
 * @param {Object} observation.domState - DOM state with URL, title, interactive elements
 * @param {boolean} observation.screenshot - Whether screenshot is available
 * @returns {string} Formatted user message
 */
function buildPageStateMessage(observation) {
  const { domState, screenshot } = observation;

  let message = `Current page:\nURL: ${domState.url}\nTitle: ${domState.title}\n\n`;

  // Add interactive elements
  if (domState.interactiveElements?.length > 0) {
    message += 'Interactive elements:\n';
    for (const el of domState.interactiveElements.slice(0, 50)) {
      const text = el.text || el.placeholder || el.value || '';
      message += `[${el.label}] ${el.tag}`;
      if (text) {
        message += ` - "${text.slice(0, 50)}"`;
      }
      message += '\n';
    }
  }

  // Note if screenshot available
  if (screenshot) {
    message += '\n[Screenshot attached for visual context]\n';
  }

  message += '\nWhat actions should I take next? Return JSON array only.';

  return message;
}

// Checkpoint after system prompts
try {
  initializationLogs.push('[CHECKPOINT 1.5] After system prompts defined');
  console.log('[Offscreen] Checkpoint 1.5 passed');
} catch (e) {
  console.error('[Offscreen] Checkpoint 1.5 failed:', e);
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
// Agent Action Planning
// =============================================================================

/**
 * Plan actions for browser automation agent
 * Uses modular prompt system via AgentPromptAssembler
 * @param {Object} message - Request message
 * @param {string} message.goal - User's automation goal
 * @param {Object} message.observation - Page observation (domState, screenshot)
 * @param {Array} message.history - Action history
 * @param {string} message.systemPrompt - Pre-assembled system prompt from AutomationEngine
 * @returns {Promise<Object>} Planned actions
 */
async function planActions(message) {
  try {
    const { goal, observation, history, systemPrompt } = message;

    // Validate required fields
    if (!observation?.domState) {
      return {
        actions: [],
        error: 'Missing page observation data'
      };
    }

    // Get active provider
    const activeProvider = providerManager.getActiveProvider();

    if (!activeProvider) {
      return {
        actions: [],
        error: 'No AI provider configured. Please set up authentication.',
        needsAuth: true
      };
    }

    // Build user message from observation
    const userMessage = buildPageStateMessage(observation);

    console.log('[Offscreen] Planning actions for goal:', goal);
    console.log('[Offscreen] Provider:', providerManager.getActiveProviderName());

    // Send to AI with structured output
    const response = await providerManager.sendMessage([
      { role: 'user', content: userMessage }
    ], {
      systemPrompt: systemPrompt,
      maxTokens: 2000
      // Temperature forced to 1.0 by extended thinking mode
    });

    console.log('[Offscreen] AI response for action planning:', {
      provider: providerManager.getActiveProviderName(),
      model: response.model,
      usage: response.usage
    });

    // Parse JSON actions from response
    const content = response.content || '';

    // Extract JSON array from response (handle markdown code blocks)
    let jsonContent = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonContent = jsonMatch[1].trim();
    }

    // Parse the actions
    let actions;
    try {
      actions = JSON.parse(jsonContent);
    } catch (parseError) {
      console.error('[Offscreen] Failed to parse AI response as JSON:', content);
      return {
        actions: [],
        error: 'AI returned invalid JSON response',
        rawContent: content,
        loadedModules: agentPromptAssembler.getLoadedModules()
      };
    }

    // Validate actions array
    if (!Array.isArray(actions)) {
      console.error('[Offscreen] AI returned non-array response:', actions);
      return {
        actions: [],
        error: 'AI returned non-array response',
        rawContent: content,
        loadedModules: agentPromptAssembler.getLoadedModules()
      };
    }

    return {
      actions,
      usage: response.usage,
      model: response.model,
      provider: providerManager.getActiveProviderName(),
      loadedModules: agentPromptAssembler.getLoadedModules()
    };

  } catch (error) {
    console.error('[Offscreen] PLAN_ACTIONS error:', error);
    return {
      actions: [],
      error: error.message || 'Failed to plan actions',
      loadedModules: agentPromptAssembler.getLoadedModules()
    };
  }
}

// =============================================================================
// Chat Message Handler - Simple conversational AI with tools
// =============================================================================

/**
 * Handle a simple chat message - AI responds naturally, may include actions
 * @param {Object} message - Chat message
 * @param {string} message.message - User's message
 * @param {Object} message.pageContext - Current page context (url, title)
 * @param {Array} message.history - Conversation history
 * @returns {Promise<Object>} AI response
 */
async function handleChatMessage(message) {
  const { message: userMessage, pageContext, history = [] } = message || {};

  console.log('[Offscreen] CHAT_MESSAGE:', userMessage?.substring(0, 50));
  console.log('[Offscreen] History length:', history.length);
  console.log('[Offscreen] Available providers:', providerManager.getProviderNames());
  console.log('[Offscreen] Active provider:', providerManager.getActiveProviderName());

  // Validate input
  if (!userMessage || typeof userMessage !== 'string') {
    return {
      error: 'No message provided',
    };
  }

  const activeProvider = providerManager.getActiveProvider();

  if (!activeProvider) {
    console.error('[Offscreen] No active provider! Registered:', providerManager.getProviderNames());
    return {
      error: 'No AI provider configured. Please add your API key in settings.',
      needsAuth: true
    };
  }

  try {
    // Build simple context — only URL + title, NOT full DOM/content
    let contextNote = '';
    if (pageContext?.url && pageContext.url !== 'unknown') {
      contextNote = `\n\n[Current tab: ${pageContext.title || pageContext.url}]`;
    }

    // Convert history to Anthropic format with defensive trimming
    // This prevents context bloat even if the sidepanel sends too much
    const MAX_HISTORY_MESSAGES = 20;
    const MAX_MSG_CHARS = 2000;
    const messages = [];

    // Only take the most recent messages
    const recentHistory = history.slice(-MAX_HISTORY_MESSAGES);

    for (const msg of recentHistory) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        let content = msg.content || '';
        // Truncate oversized messages to prevent token explosion
        if (content.length > MAX_MSG_CHARS) {
          content = content.slice(0, MAX_MSG_CHARS) + '\n...[truncated]';
        }
        messages.push({ role: msg.role, content });
      }
    }

    // Add current user message (untruncated — it's the user's actual request)
    messages.push({
      role: 'user',
      content: userMessage + contextNote
    });

    const options = {
      maxTokens: 2048,
      systemPrompt: CHAT_SYSTEM_PROMPT,
      // Temperature forced to 1.0 by extended thinking mode
      // Enable caching on system prompt for cost savings
      cacheSystemPrompt: true
    };

    const response = await providerManager.sendMessage(messages, options);

    console.log('[Offscreen] Chat response:', {
      provider: providerManager.getActiveProviderName(),
      contentLength: response.content?.length
    });

    return {
      success: true,
      content: response.content,
      model: response.model,
      usage: response.usage,
      provider: providerManager.getActiveProviderName()
    };

  } catch (error) {
    console.error('[Offscreen] Chat error:', error);
    return {
      error: error.message,
      provider: providerManager.getActiveProviderName()
    };
  }
}

// =============================================================================
// Agentic Step Handler (with Screenshot/Vision Support)
// =============================================================================

/**
 * Handle a single agent step in the observe-plan-act loop
 * Supports multimodal input (screenshot + DOM) for vision-capable models
 * @param {Object} message - Agent step message
 * @param {string} message.goal - User's goal
 * @param {number} message.iteration - Current iteration number
 * @param {string} message.dom - Pruned DOM content with labeled elements
 * @param {string} message.url - Current page URL
 * @param {string} message.title - Current page title
 * @param {string} message.screenshot - Base64 data URL of screenshot (optional)
 * @returns {Promise<Object>} AI response with planned actions
 */
async function handleAgentStep(message) {
  const { goal, iteration, dom, url, title, screenshot } = message;

  console.log('[Offscreen] AGENT_STEP:', {
    goal: goal?.substring(0, 50),
    iteration,
    url,
    hasScreenshot: !!screenshot
  });

  const activeProvider = providerManager.getActiveProvider();

  if (!activeProvider) {
    return {
      error: 'No AI provider configured. Please set up authentication.',
      needsAuth: true
    };
  }

  try {
    // Build the context message — goal-first, action-oriented
    let contextText = `GOAL: ${goal}\n`;
    contextText += `Step: ${iteration}\n\n`;
    contextText += `Current page: ${url}\n`;
    contextText += `Title: ${title}\n\n`;
    contextText += `Interactive elements:\n${dom}\n\n`;
    contextText += `What actions achieve the goal? Use \`\`\`actions format. If goal is fully done, say so without actions.`;

    // Build message content - with or without screenshot
    let messageContent;

    if (screenshot && screenshot.startsWith('data:image/')) {
      // Extract base64 data from data URL
      const base64Match = screenshot.match(/^data:image\/(jpeg|png|gif|webp);base64,(.+)$/);

      if (base64Match) {
        const mediaType = `image/${base64Match[1]}`;
        const base64Data = base64Match[2];

        // Multimodal message with image + text
        messageContent = [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data
            }
          },
          {
            type: 'text',
            text: contextText
          }
        ];

        console.log('[Offscreen] Including screenshot in request (multimodal)');
      } else {
        // Fallback to text-only if image parsing fails
        messageContent = contextText;
        console.warn('[Offscreen] Screenshot parsing failed, using text-only');
      }
    } else {
      // Text-only message
      messageContent = contextText;
    }

    const messages = [
      {
        role: 'user',
        content: messageContent
      }
    ];

    const options = {
      maxTokens: CONFIG.maxTokens,
      systemPrompt: SYSTEM_PROMPT_TEXT
      // Temperature forced to 1.0 by extended thinking mode
    };

    const response = await providerManager.sendMessage(messages, options);

    console.log('[Offscreen] AGENT_STEP response:', {
      provider: providerManager.getActiveProviderName(),
      model: response.model,
      contentLength: response.content?.length,
      usage: response.usage
    });

    return {
      success: true,
      content: response.content,
      model: response.model,
      usage: response.usage,
      provider: providerManager.getActiveProviderName()
    };

  } catch (error) {
    console.error('[Offscreen] AGENT_STEP error:', error);

    // Attempt provider recovery for certain errors
    if (error.retryable === false && providerManager.getProviderNames().length > 1) {
      console.log('[Offscreen] Attempting provider recovery...');
      const recovery = await providerManager.attemptRecovery();
      if (recovery.recovered) {
        console.log(`[Offscreen] Recovered to provider: ${recovery.provider}`);
        return handleAgentStep(message); // Retry with new provider
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

    if (!response.body) {
      port.postMessage({
        error: 'Response body is null - streaming not supported',
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
// Message Routing (handler registered early at top of file)
// =============================================================================

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

    case 'PLAN_ACTIONS':
      // Agent automation action planning
      return await planActions(message);

    case 'AGENT_STEP':
      // Unified agentic step with screenshot support
      return await handleAgentStep(message);

    case 'CHAT_MESSAGE':
      // Simple chat - AI responds naturally and may request browser actions
      return await handleChatMessage(message);

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
 * - Load modules dynamically
 * - Set up providers from stored API keys
 * - Listen for configuration changes
 */
async function initialize() {
  logProgress('init_start', 'Starting initialization');

  try {
    // Step 1: Load modules
    const modulesLoaded = await loadModules();
    if (!modulesLoaded) {
      logProgress('init_failed', 'Module loading failed, stopping');
      return;
    }

    // Step 2: Initialize providers
    logProgress('init_providers_start', 'Initializing providers');
    const result = await initializeProviders();

    if (!result.success) {
      logProgress('init_providers_warning', result.error || 'Provider init returned success=false');
      initializationError = result.error || 'Provider initialization failed';
    } else {
      providersReady = true;
      const providerList = providerManager.getProviderNames().join(', ') || 'none';
      const active = providerManager.getActiveProviderName() || 'none';
      logProgress('init_complete', `Ready! Providers: [${providerList}], Active: ${active}`);
    }

  } catch (error) {
    logProgress('init_error', `${error.name}: ${error.message}`);
    console.error('[Offscreen] Error stack:', error.stack);
    initializationError = `Initialization failed: ${error.message}`;
  }
}

// Checkpoint before calling initialize
try {
  initializationLogs.push('[CHECKPOINT 2] Reached end of script');
  console.log('[Offscreen] Checkpoint 2: About to call initialize()');
} catch (e) {
  console.error('[Offscreen] Checkpoint 2 failed:', e);
}

logProgress('script_loaded', 'Script file loaded, calling initialize()');
initialize();
