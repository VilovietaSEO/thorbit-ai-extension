/**
 * Service Worker for AI Page Assistant Chrome Extension
 *
 * Handles:
 * - Chrome Alarms keep-alive pattern (0.4-min interval)
 * - Message routing with handler registration
 * - State persistence to chrome.storage.session
 * - Side panel management via action.onClicked
 * - Offscreen document coordination
 * - Automation engine orchestration (observe-plan-act loop)
 */

import { getAutomationEngine, LOOP_ALARM_NAME } from './utils/automation-engine.js';
import { getBrowserProviderManager } from './utils/browser/browser-provider-manager.js';

// =============================================================================
// Constants
// =============================================================================

const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds - survives 30s termination
const KEEPALIVE_ALARM_NAME = 'keepalive';

// Track connected sidepanel ports to send responses
const connectedPorts = new Map();

// =============================================================================
// Message Router
// =============================================================================

/**
 * Centralized message routing system with handler registration
 */
const MessageRouter = {
  handlers: new Map(),

  /**
   * Register a handler for a specific message type
   * @param {string} type - Message type identifier
   * @param {Function} handler - Async handler function (message, sender) => result
   */
  register(type, handler) {
    this.handlers.set(type, handler);
    console.log(`[MessageRouter] Registered handler for: ${type}`);
  },

  /**
   * Route a message to its registered handler
   * @param {Object} message - Message object with type property
   * @param {Object} sender - Chrome message sender object
   * @returns {Promise<Object>} Handler response or error
   */
  async handle(message, sender) {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      console.warn(`[MessageRouter] No handler for message type: ${message.type}`);
      return { error: 'Unknown message type', type: message.type };
    }

    try {
      const result = await handler(message, sender);
      return result;
    } catch (error) {
      console.error(`[MessageRouter] Error handling ${message.type}:`, error);
      return { error: error.message, type: message.type };
    }
  }
};

// =============================================================================
// State Persistence
// =============================================================================

/**
 * Persist state to chrome.storage.session (survives service worker termination)
 * @param {string} key - Storage key
 * @param {*} value - Value to persist
 */
async function persistState(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
    console.log(`[State] Persisted: ${key}`);
  } catch (error) {
    console.error(`[State] Failed to persist ${key}:`, error);
  }
}

/**
 * Retrieve state from chrome.storage.session
 * @param {string} key - Storage key
 * @param {*} defaultValue - Default value if key not found
 * @returns {Promise<*>} Retrieved value or default
 */
async function getState(key, defaultValue = null) {
  try {
    const result = await chrome.storage.session.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
  } catch (error) {
    console.error(`[State] Failed to get ${key}:`, error);
    return defaultValue;
  }
}

/**
 * Clear specific state key
 * @param {string} key - Storage key to clear
 */
async function clearState(key) {
  try {
    await chrome.storage.session.remove(key);
    console.log(`[State] Cleared: ${key}`);
  } catch (error) {
    console.error(`[State] Failed to clear ${key}:`, error);
  }
}

// =============================================================================
// Offscreen Document Management
// =============================================================================

let creatingOffscreen = null; // Global promise to prevent race conditions

/**
 * Ensure offscreen document exists before sending messages
 * Uses recovery pattern with global promise to prevent duplicate creation
 * @param {string} path - Path to offscreen HTML document
 */
async function ensureOffscreenDocument(path = 'offscreen.html') {
  const offscreenUrl = chrome.runtime.getURL(path);

  // Check if document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return; // Already exists
  }

  // Prevent concurrent creation attempts
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  console.log('[Offscreen] Creating offscreen document');
  creatingOffscreen = chrome.offscreen.createDocument({
    url: path,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'AI model inference and DOM processing'
  });

  try {
    await creatingOffscreen;
    console.log('[Offscreen] Document created successfully');
  } finally {
    creatingOffscreen = null;
  }
}

/**
 * Send message to offscreen document with automatic recovery
 * @param {Object} message - Message to send
 * @returns {Promise<Object>} Response from offscreen document
 */
async function sendToOffscreen(message) {
  try {
    await ensureOffscreenDocument('offscreen.html');
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    return response;
  } catch (error) {
    console.error('[Offscreen] Communication error:', error);
    return { error: `Communication failed: ${error.message}` };
  }
}

// =============================================================================
// Keep-Alive Pattern (Chrome Alarms)
// =============================================================================

/**
 * Initialize or reinitialize the keep-alive alarm
 * Called on startup and can be called to reset the alarm
 */
async function initializeKeepAlive() {
  // Clear any existing alarm first
  await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);

  // Create new alarm
  await chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
    delayInMinutes: KEEPALIVE_INTERVAL_MINUTES
  });

  console.log(`[KeepAlive] Alarm initialized (${KEEPALIVE_INTERVAL_MINUTES * 60}s interval)`);
}

/**
 * Handle keep-alive alarm - resume pending tasks if any
 */
async function handleKeepAlive() {
  console.log('[KeepAlive] Alarm fired - service worker active');

  // Check for pending tasks that need to be resumed
  const pendingTask = await getState('pendingTask');
  if (pendingTask) {
    console.log('[KeepAlive] Resuming pending task:', pendingTask.type);
    await resumePendingTask(pendingTask);
  }
}

/**
 * Resume a pending task after service worker recovery
 * @param {Object} task - Task object with type and data
 */
async function resumePendingTask(task) {
  try {
    switch (task.type) {
      case 'AI_REQUEST':
        // Re-send AI request to offscreen document
        await sendToOffscreen({
          action: 'AI_REQUEST',
          ...task.data
        });
        break;

      case 'DOM_ANALYSIS':
        // Re-trigger DOM analysis
        if (task.tabId) {
          await chrome.tabs.sendMessage(task.tabId, { action: 'EXTRACT_DOM' });
        }
        break;

      default:
        console.warn('[KeepAlive] Unknown pending task type:', task.type);
    }

    // Clear the pending task after successful resume
    await clearState('pendingTask');
  } catch (error) {
    console.error('[KeepAlive] Failed to resume task:', error);
    // Keep the task for next alarm if it failed
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

/**
 * Check if a tab is accessible for automation
 * @param {number} tabId - Tab ID to check
 * @returns {Promise<{accessible: boolean, error?: string, url?: string}>}
 */
async function isTabAccessible(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      return { accessible: false, error: 'Tab does not exist' };
    }

    const url = tab.url || '';

    // Check for restricted URLs where content scripts can't run
    if (url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('about:') ||
        url.startsWith('data:') ||
        url.startsWith('file://') ||
        url === '' ||
        url === 'chrome://newtab/') {
      return {
        accessible: false,
        error: `Cannot automate this page type: ${url.split('/')[0] || 'empty'}`,
        url
      };
    }

    return { accessible: true, url };
  } catch (error) {
    return { accessible: false, error: `Tab error: ${error.message}` };
  }
}

/**
 * Send message to content script with retry logic and exponential backoff
 * @param {number} tabId - Tab ID
 * @param {Object} message - Message to send
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Object>} Response from content script
 */
async function sendMessageWithRetry(tabId, message, maxRetries = 5) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check if tab is still accessible before each attempt
      const tabCheck = await isTabAccessible(tabId);
      if (!tabCheck.accessible) {
        throw new Error(tabCheck.error);
      }

      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`[Handler] Message attempt ${attempt + 1}/${maxRetries} failed:`, error.message);

      // Don't retry if it's a definite error (not just timing)
      if (error.message.includes('Cannot automate') ||
          error.message.includes('Tab does not exist') ||
          error.message.includes('Tab error')) {
        throw error;
      }

      // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
      if (attempt < maxRetries - 1) {
        const delay = 200 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`Failed to communicate with page after ${maxRetries} attempts. ${lastError?.message || ''}`);
}

/**
 * Inject content script manually if not already loaded
 * @param {number} tabId - Tab ID
 * @returns {Promise<boolean>} Whether injection succeeded
 */
async function ensureContentScriptLoaded(tabId) {
  try {
    // Try to ping the content script first
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (response?.success || response?.ready) {
      return true;
    }
  } catch (e) {
    // Content script not loaded, try to inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'content-scripts/cs-constants.js',
          'content-scripts/cs-site-rules.js',
          'content-scripts/cs-digest.js',
          'content-scripts/cs-dom-extractor.js',
          'content-scripts/cs-action-executor.js',
          'content-scripts/cs-message-handler.js'
        ]
      });
      // Wait a moment for the script to initialize
      await new Promise(r => setTimeout(r, 100));
      return true;
    } catch (injectError) {
      console.error('[Handler] Failed to inject content script:', injectError.message);
      return false;
    }
  }
  return false;
}

/**
 * Format interactive elements for the AI
 * Creates a readable list of elements with labels
 * @param {Array} elements - Interactive elements from DOM extraction
 * @returns {string} Formatted element list
 */
function formatInteractiveElements(elements) {
  if (!elements || elements.length === 0) {
    return 'No interactive elements found on this page.';
  }

  const lines = [];
  for (const el of elements.slice(0, 50)) { // Limit to 50 elements
    const tag = el.tag?.toLowerCase() || 'element';
    const text = el.text || el.attributes?.placeholder || el.attributes?.['aria-label'] || el.attributes?.value || '';
    const type = el.attributes?.type ? ` (${el.attributes.type})` : '';
    const href = el.attributes?.href ? ` → ${el.attributes.href.slice(0, 50)}` : '';

    let line = `[${el.label}] ${tag}${type}`;
    if (text) {
      line += ` - "${text.slice(0, 60)}"`;
    }
    if (href) {
      line += href;
    }
    lines.push(line);
  }

  if (elements.length > 50) {
    lines.push(`... and ${elements.length - 50} more elements`);
  }

  return lines.join('\n');
}

/**
 * Parse actions from AI response
 * Tries multiple formats: ```actions, ```json, ```, and raw JSON arrays
 * @param {string} content - AI response content
 * @returns {{ text: string, actions: Array }} Parsed text and actions
 */
function parseActionsFromResponse(content) {
  if (!content) return { text: '', actions: [] };

  // Strategy 1: ```actions [...] ``` block (preferred format)
  const actionsMatch = content.match(/```actions\s*([\s\S]*?)```/);
  if (actionsMatch) {
    const text = content.replace(/```actions\s*[\s\S]*?```/, '').trim();
    try {
      const actions = JSON.parse(actionsMatch[1].trim());
      if (Array.isArray(actions) && actions.length > 0) {
        return { text, actions };
      }
    } catch (e) {
      console.warn('[Handler] Failed to parse ```actions JSON:', e);
    }
  }

  // Strategy 2: ```json [...] ``` block
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        const text = content.replace(/```json\s*[\s\S]*?```/, '').trim();
        return { text, actions: parsed };
      }
    } catch (e) { /* not an actions JSON block, continue */ }
  }

  // Strategy 3: Generic ``` [...] ``` code block containing a JSON array
  const codeBlockMatch = content.match(/```\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        const text = content.replace(/```\s*[\s\S]*?```/, '').trim();
        return { text, actions: parsed };
      }
    } catch (e) { /* not a JSON code block, continue */ }
  }

  // Strategy 4: Raw JSON array (entire response or at end of response)
  // Try the whole content first
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        return { text: '', actions: parsed };
      }
    } catch (e) { /* not a raw JSON response */ }
  }

  // Try extracting a JSON array from the end of the response
  const trailingArrayMatch = content.match(/(\[[\s\S]*\])\s*$/);
  if (trailingArrayMatch) {
    try {
      const parsed = JSON.parse(trailingArrayMatch[1]);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        const text = content.slice(0, content.lastIndexOf(trailingArrayMatch[1])).trim();
        return { text, actions: parsed };
      }
    } catch (e) { /* not a trailing JSON array */ }
  }

  // No actions found in any format
  return { text: content, actions: [] };
}

/**
 * Execute a single action
 * @param {number} tabId - Tab to execute action on
 * @param {Object} action - Action to execute
 * @returns {Promise<Object>} Action result
 */
async function executeAction(tabId, action) {
  console.log('[Handler] Executing action:', action.type, action);

  // Validate tab before most actions
  if (action.type !== 'wait') {
    const tabCheck = await isTabAccessible(tabId);
    if (!tabCheck.accessible && action.type !== 'navigate') {
      return { success: false, error: tabCheck.error };
    }
  }

  try {
    switch (action.type) {
      case 'navigate':
        if (!action.url) return { success: false, error: 'No URL provided' };
        // Normalize URL
        let url = action.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        await chrome.tabs.update(tabId, { url });
        // Wait for navigation to start and content script to load
        await new Promise(r => setTimeout(r, 1500));
        // Try to ensure content script is loaded on new page
        await ensureContentScriptLoaded(tabId);
        return { success: true, action: 'navigate', url };

      case 'click':
        if (action.label === undefined) return { success: false, error: 'No label provided' };
        return await sendMessageWithRetry(tabId, {
          type: 'EXECUTE_ACTION',
          action: 'click',
          label: action.label
        });

      case 'type':
        if (action.label === undefined || !action.value) {
          return { success: false, error: 'Label and value required' };
        }
        return await sendMessageWithRetry(tabId, {
          type: 'EXECUTE_ACTION',
          action: 'type',
          label: action.label,
          value: action.value
        });

      case 'scroll':
        return await sendMessageWithRetry(tabId, {
          type: 'SCROLL_PAGE',
          direction: action.direction || 'down',
          amount: action.amount || 500
        });

      case 'wait':
        const ms = action.ms || 1000;
        await new Promise(resolve => setTimeout(resolve, ms));
        return { success: true, action: 'wait', ms };

      case 'back':
        await chrome.tabs.goBack(tabId);
        await new Promise(r => setTimeout(r, 1000));
        return { success: true, action: 'back' };

      case 'refresh':
        await chrome.tabs.reload(tabId);
        await new Promise(r => setTimeout(r, 1500));
        return { success: true, action: 'refresh' };

      default:
        return { success: false, error: `Unknown action: ${action.type}` };
    }
  } catch (error) {
    console.error('[Handler] Action execution error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Capture screenshot of the current tab
 * @param {number} tabId - Tab ID
 * @returns {Promise<string|null>} Base64 screenshot or null
 */
async function captureScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return null;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 80
    });
    return dataUrl;
  } catch (error) {
    console.warn('[Screenshot] Capture failed:', error.message);
    return null;
  }
}

/**
 * Handle a user chat message - AI responds and may use browser tools
 * @param {string} userMessage - User's message
 * @param {number} tabId - Current tab ID (for context, not mandatory automation)
 * @param {Array} history - Conversation history
 */
async function handleUserMessage(userMessage, tabId, history = []) {
  console.log('[Agent] Processing user message:', userMessage.substring(0, 50));

  // Get current tab context (URL, title) - lightweight, no DOM extraction yet
  let pageContext = { url: 'unknown', title: 'unknown' };
  try {
    if (tabId) {
      const tabCheck = await isTabAccessible(tabId);
      if (tabCheck.accessible) {
        const tab = await chrome.tabs.get(tabId);
        pageContext = { url: tab.url || 'unknown', title: tab.title || 'unknown' };
      }
    }
  } catch (e) {
    // Ignore - we'll work without page context
  }

  // Trim history before sending to offscreen — prevents context bloat
  // Only send last 20 messages, truncate long ones
  const trimmedHistory = history.slice(-20).map(msg => {
    if (!msg || !msg.content) return msg;
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '\n...[truncated]'
      : msg.content;
    return { role: msg.role, content };
  });

  // Send to AI with trimmed conversation history
  let aiResult;
  try {
    aiResult = await sendToOffscreen({
      action: 'CHAT_MESSAGE',
      message: userMessage,
      pageContext: pageContext,
      history: trimmedHistory
    });
  } catch (e) {
    console.error('[Agent] Failed to send to offscreen:', e);
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: 'Failed to connect to AI service. Please try again.'
    });
    broadcastToSidepanel({ type: 'STREAM_DONE' });
    return;
  }

  // Check if we got a valid response
  if (!aiResult) {
    console.error('[Agent] aiResult is falsy:', aiResult);
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: 'No response from AI service. Please check your API key in settings.'
    });
    broadcastToSidepanel({ type: 'STREAM_DONE' });
    return;
  }

  console.log('[Agent] AI result received:', {
    hasError: !!aiResult.error,
    hasContent: !!aiResult.content,
    provider: aiResult.provider,
    needsAuth: aiResult.needsAuth
  });

  // Check for errors in the response
  if (aiResult.error) {
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: aiResult.error
    });
    broadcastToSidepanel({ type: 'STREAM_DONE' });
    return;
  }

  // Check if we have content
  if (!aiResult.content) {
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: 'AI returned an empty response.'
    });
    broadcastToSidepanel({ type: 'STREAM_DONE' });
    return;
  }

  // Parse response for text and actions
  const { text, actions } = parseActionsFromResponse(aiResult.content);

  // Show AI's response text
  if (text) {
    broadcastToSidepanel({ type: 'STREAM_CHUNK', text: text });
  }

  // Execute any actions the AI requested and continue agentic loop if needed
  if (actions && actions.length > 0) {
    try {
      await executeActionsWithAgenticLoop(actions, tabId, userMessage, history);
    } catch (e) {
      console.error('[Agent] Agentic loop threw:', e);
      broadcastToSidepanel({ type: 'STREAM_CHUNK', text: `\n(Error: ${e.message})` });
      broadcastToSidepanel({ type: 'STREAM_DONE' });
    }
  } else {
    broadcastToSidepanel({ type: 'STREAM_DONE' });
  }
}

/**
 * Execute actions and continue agentic loop for multi-step tasks
 * @param {Array} actions - Actions to execute
 * @param {number} tabId - Tab ID
 * @param {string} originalGoal - User's original goal
 * @param {Array} history - Conversation history
 * @param {number} maxIterations - Safety limit
 */
async function executeActionsWithAgenticLoop(actions, tabId, originalGoal, history = [], maxIterations = 5) {
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    // Execute current actions
    await executeActionsSequence(actions, tabId);

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 1500));

    // Check if tab is still accessible
    const tabCheck = await isTabAccessible(tabId);
    if (!tabCheck.accessible) {
      broadcastToSidepanel({ type: 'STREAM_DONE' });
      return;
    }

    // Ensure content script is loaded on the (possibly new) page
    await ensureContentScriptLoaded(tabId);

    // Extract DOM to see new page state
    let domResult;
    try {
      domResult = await sendMessageWithRetry(tabId, { type: 'EXTRACT_DOM' });
    } catch (e) {
      console.log('[Agent] Could not read page, ending loop:', e.message);
      broadcastToSidepanel({ type: 'STREAM_DONE' });
      return;
    }

    if (!domResult.success) {
      console.log('[Agent] DOM extraction failed:', domResult.error);
      broadcastToSidepanel({ type: 'STREAM_DONE' });
      return;
    }

    const pageData = domResult.data;
    const elementsText = formatInteractiveElements(pageData.interactiveElements);

    // Ask AI what to do next
    const nextResult = await sendToOffscreen({
      action: 'AGENT_STEP',
      goal: originalGoal,
      iteration: iteration,
      dom: elementsText,
      url: pageData.url,
      title: pageData.title
    });

    if (nextResult.error) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Could not continue: ${nextResult.error})`
      });
      broadcastToSidepanel({ type: 'STREAM_DONE' });
      return;
    }

    const { text: nextText, actions: nextActions } = parseActionsFromResponse(nextResult.content);

    if (nextText) {
      broadcastToSidepanel({ type: 'STREAM_CHUNK', text: '\n\n' + nextText });
    }

    // No more actions = task complete
    if (!nextActions || nextActions.length === 0 || nextActions[0]?.type === 'done') {
      broadcastToSidepanel({ type: 'STREAM_DONE' });
      return;
    }

    // Continue with next actions
    actions = nextActions;
  }

  // Max iterations reached
  broadcastToSidepanel({
    type: 'STREAM_CHUNK',
    text: '\n\n(Reached maximum steps, stopping)'
  });
  broadcastToSidepanel({ type: 'STREAM_DONE' });
}

/**
 * Execute a sequence of actions, with optional follow-up observation
 * @param {Array} actions - Actions to execute
 * @param {number} tabId - Tab ID
 */
async function executeActionsSequence(actions, tabId) {
  for (const action of actions) {
    // Show brief status
    broadcastToSidepanel({
      type: 'STATUS',
      status: getActionStatus(action)
    });

    try {
      const result = await executeAction(tabId, action);

      if (!result.success) {
        broadcastToSidepanel({
          type: 'STREAM_CHUNK',
          text: `\n(Could not ${action.type}: ${result.error})`
        });
      }
    } catch (e) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Action failed: ${e.message})`
      });
    }

    // Small delay between actions
    if (action.type !== 'wait') {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Clear status when done
  broadcastToSidepanel({ type: 'STATUS', status: null });
}

/**
 * Get a brief status message for an action
 */
function getActionStatus(action) {
  switch (action.type) {
    case 'navigate': return `Opening ${action.url}...`;
    case 'click': return 'Clicking...';
    case 'type': return 'Typing...';
    case 'scroll': return 'Scrolling...';
    case 'wait': return 'Waiting...';
    default: return 'Working...';
  }
}

/**
 * Full observation loop - only used when AI explicitly needs page analysis
 * @param {string} goal - What to analyze/accomplish
 * @param {number} tabId - Tab to observe
 * @param {number} maxIterations - Safety limit
 */
async function runObservationLoop(goal, tabId, maxIterations = 5) {
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    console.log(`[Agent] Observation iteration ${iteration}/${maxIterations}`);

    // Check tab accessibility
    const tabCheck = await isTabAccessible(tabId);
    if (!tabCheck.accessible) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Cannot read this page: ${tabCheck.error})`
      });
      break;
    }

    // Show brief status
    broadcastToSidepanel({ type: 'STATUS', status: 'Reading page...' });

    // Ensure content script is loaded
    await ensureContentScriptLoaded(tabId);

    // Extract DOM
    let domResult;
    try {
      domResult = await sendMessageWithRetry(tabId, { type: 'EXTRACT_DOM' });
    } catch (e) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Could not read page: ${e.message})`
      });
      break;
    }

    if (!domResult.success) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Page read failed: ${domResult.error || 'unknown error'})`
      });
      break;
    }

    const pageData = domResult.data;
    const elementsText = formatInteractiveElements(pageData.interactiveElements);
    const screenshot = await captureScreenshot(tabId);

    // Clear status, ask AI
    broadcastToSidepanel({ type: 'STATUS', status: null });

    const aiResult = await sendToOffscreen({
      action: 'AGENT_STEP',
      goal: goal,
      iteration: iteration,
      dom: elementsText,
      url: pageData.url,
      title: pageData.title,
      screenshot: screenshot
    });

    if (aiResult.error) {
      broadcastToSidepanel({
        type: 'STREAM_CHUNK',
        text: `\n(Error: ${aiResult.error})`
      });
      break;
    }

    const { text, actions } = parseActionsFromResponse(aiResult.content);

    if (text) {
      broadcastToSidepanel({ type: 'STREAM_CHUNK', text: text });
    }

    // No more actions = done
    if (actions.length === 0 || actions[0]?.type === 'done') {
      break;
    }

    // Execute actions
    await executeActionsSequence(actions, tabId);

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 800));
  }
}

// Handler: Debug status check
MessageRouter.register('DEBUG_STATUS', async () => {
  const result = {
    settings: null,
    offscreen: null,
    offscreenError: null,
    timestamp: new Date().toISOString()
  };

  try {
    // Check settings storage
    const syncData = await chrome.storage.sync.get('settings');
    const settings = syncData.settings || {};
    result.settings = {
      provider: settings.provider,
      hasAnthropicKey: !!settings.apiKeys?.anthropic,
      anthropicKeyLength: settings.apiKeys?.anthropic?.length || 0,
      anthropicKeyPrefix: settings.apiKeys?.anthropic?.substring(0, 10) || 'none',
      hasOpenRouterKey: !!settings.apiKeys?.openrouter,
      model: settings.model
    };
  } catch (e) {
    result.settingsError = e.message;
  }

  try {
    // Check if offscreen document exists
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    result.offscreenUrl = offscreenUrl;

    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    result.offscreenExists = contexts.length > 0;
    result.offscreenContexts = contexts.map(c => ({
      type: c.contextType,
      url: c.documentUrl,
      id: c.contextId
    }));

    // Try to create it if it doesn't exist
    if (contexts.length === 0) {
      console.log('[DEBUG_STATUS] Creating offscreen document...');
      await ensureOffscreenDocument('offscreen.html');
      result.offscreenCreated = true;
      // Wait longer for offscreen to initialize (2.5s)
      console.log('[DEBUG_STATUS] Waiting for offscreen to initialize...');
      await new Promise(r => setTimeout(r, 2500));

      // Re-check contexts after creation
      const newContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
      });
      result.offscreenExistsAfterCreate = newContexts.length > 0;
    }

    // Ping offscreen for provider status
    console.log('[DEBUG_STATUS] Sending PING to offscreen...');
    const pingStart = Date.now();
    const offscreenStatus = await sendToOffscreen({ action: 'PING' });
    const pingDuration = Date.now() - pingStart;

    result.offscreen = offscreenStatus;
    result.offscreenType = typeof offscreenStatus;
    result.offscreenKeys = offscreenStatus ? Object.keys(offscreenStatus) : 'null/undefined';
    result.pingDurationMs = pingDuration;
  } catch (e) {
    result.offscreenError = e.message;
    result.offscreenErrorStack = e.stack;
  }

  return result;
});

// Handler: User chat message - AI responds naturally, uses tools as needed
MessageRouter.register('ANALYZE_PAGE', async (message, sender) => {
  const userMessage = message.prompt || '';
  const history = message.history || [];
  console.log('[Handler] Chat message:', userMessage.substring(0, 50), 'history length:', history.length);

  try {
    // Get active tab for context
    let tabId = sender.tab?.id;
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }

    // Handle the message - AI decides what to do
    await handleUserMessage(userMessage, tabId, history);

    return { success: true };

  } catch (error) {
    console.error('[Handler] Chat error:', error);
    broadcastToSidepanel({ type: 'STREAM_ERROR', error: error.message });
    return { error: error.message };
  }
});

// Handler: Execute action on page (click, type, etc.)
MessageRouter.register('EXECUTE_ACTION', async (message, sender) => {
  console.log('[Handler] EXECUTE_ACTION:', message.action);

  let tabId = sender.tab?.id;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }

  if (!tabId) {
    return { error: 'No active tab found' };
  }

  return chrome.tabs.sendMessage(tabId, {
    action: 'EXECUTE',
    ...message.payload
  });
});

// Handler: Get current state
MessageRouter.register('GET_STATE', async (message) => {
  const conversationHistory = await getState('conversationHistory', []);
  const currentTask = await getState('currentTask', null);
  const automationState = await getState('automationState', 'idle');

  return {
    conversationHistory,
    currentTask,
    automationState
  };
});

// Handler: Update conversation history
MessageRouter.register('UPDATE_CONVERSATION', async (message) => {
  const { messages } = message;
  await persistState('conversationHistory', messages);
  return { success: true };
});

// Handler: Clear conversation
MessageRouter.register('CLEAR_CONVERSATION', async () => {
  await clearState('conversationHistory');
  await clearState('currentTask');
  await persistState('automationState', 'idle');
  return { success: true };
});

// Handler: Forward AI request to offscreen
MessageRouter.register('AI_REQUEST', async (message) => {
  // Store as pending task
  await persistState('pendingTask', {
    type: 'AI_REQUEST',
    data: message.payload,
    timestamp: Date.now()
  });

  try {
    const result = await sendToOffscreen({
      action: 'AI_REQUEST',
      ...message.payload
    });

    await clearState('pendingTask');
    return result;
  } catch (error) {
    console.error('[Handler] AI_REQUEST error:', error);
    return { error: error.message };
  }
});

// Handler: Get settings for offscreen document (offscreen can only use chrome.runtime)
MessageRouter.register('GET_SETTINGS', async () => {
  try {
    const syncData = await chrome.storage.sync.get('settings');
    return {
      success: true,
      settings: syncData.settings || {}
    };
  } catch (error) {
    console.error('[Handler] GET_SETTINGS error:', error);
    return {
      error: error.message
    };
  }
});

// Handler: Health check
MessageRouter.register('PING', async () => {
  return {
    status: 'alive',
    timestamp: Date.now(),
    alarmActive: await chrome.alarms.get(KEEPALIVE_ALARM_NAME) !== null
  };
});

// =============================================================================
// Automation Engine Message Handlers
// =============================================================================

// Handler: Start automation with a goal
MessageRouter.register('START_AUTOMATION', async (message) => {
  console.log('[Handler] START_AUTOMATION:', message.goal);
  const engine = getAutomationEngine();
  await engine.start(message.goal);
  return { success: true };
});

// Handler: Forward automation events to sidepanel
MessageRouter.register('AUTOMATION_EVENT', async (message) => {
  console.log('[Handler] AUTOMATION_EVENT:', message.event);

  // Forward to sidepanel ports
  broadcastToSidepanel({
    type: 'AUTOMATION_EVENT',
    event: message.event,
    data: message.data,
    state: message.state
  });

  // Also send as stream for immediate feedback
  if (message.event === 'action_executed' && message.data?.action) {
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: `\n[Action: ${message.data.action.type}] ${message.data.result?.success ? 'Success' : 'Failed'}\n`
    });
  } else if (message.event === 'goal_complete') {
    broadcastToSidepanel({
      type: 'STREAM_CHUNK',
      text: '\nGoal completed successfully!'
    });
    broadcastToSidepanel({ type: 'STREAM_DONE' });
  } else if (message.event === 'error') {
    broadcastToSidepanel({
      type: 'STREAM_ERROR',
      error: message.data?.error || 'Automation error'
    });
  }

  return { received: true };
});

// Handler: Pause running automation
MessageRouter.register('PAUSE_AUTOMATION', async () => {
  console.log('[Handler] PAUSE_AUTOMATION');
  const engine = getAutomationEngine();
  await engine.pause();
  return { success: true };
});

// Handler: Resume paused automation
MessageRouter.register('RESUME_AUTOMATION', async () => {
  console.log('[Handler] RESUME_AUTOMATION');
  const engine = getAutomationEngine();
  await engine.resume();
  return { success: true };
});

// Handler: Stop automation completely
MessageRouter.register('STOP_AUTOMATION', async () => {
  console.log('[Handler] STOP_AUTOMATION');
  const engine = getAutomationEngine();
  await engine.stop();
  return { success: true };
});

// Handler: Approve pending action
MessageRouter.register('APPROVE_ACTION', async () => {
  console.log('[Handler] APPROVE_ACTION');
  const engine = getAutomationEngine();
  await engine.approveAndContinue();
  return { success: true };
});

// Handler: Reject pending action
MessageRouter.register('REJECT_ACTION', async (message) => {
  console.log('[Handler] REJECT_ACTION:', message.reason);
  const engine = getAutomationEngine();
  await engine.rejectAndContinue(message.reason);
  return { success: true };
});

// Handler: Get automation state
MessageRouter.register('GET_AUTOMATION_STATE', async () => {
  const engine = getAutomationEngine();
  return {
    success: true,
    state: engine.getState(),
    isActive: engine.isActive(),
    loadedModules: engine.getLoadedPromptModules()
  };
});

// =============================================================================
// Browser Provider Message Handlers (Day 2)
// =============================================================================

// Handler: Get provider status (attached/detached, active provider, metrics)
MessageRouter.register('GET_PROVIDER_STATUS', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const engine = getAutomationEngine();
    const status = engine.getProviderStatus(tab.id);
    const metrics = engine.getMetrics(tab.id);

    return { success: true, status, metrics };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler: Set provider preference (auto/dom/cdp_ax)
MessageRouter.register('SET_PROVIDER_PREFERENCE', async (message) => {
  const engine = getAutomationEngine();
  engine.setProviderPreference(message.preference);
  return { success: true, preference: message.preference };
});

// Handler: Manually attach/detach CDP
MessageRouter.register('TOGGLE_CDP', async (message) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const engine = getAutomationEngine();
    const result = await engine.toggleCDP(tab.id, message.attach);
    return { success: result, attached: message.attach };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler: Scan interactables (direct — for UI display)
MessageRouter.register('SCAN_INTERACTABLES', async (message) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const mgr = getBrowserProviderManager();
    const result = await mgr.getInteractables(tab.id, {
      scope: message.scope || 'viewport',
      maxElements: message.maxElements || 100,
    });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler: Get page state (modal, toasts, digest)
MessageRouter.register('GET_PAGE_STATE', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const mgr = getBrowserProviderManager();
    const state = await mgr.getState(tab.id);
    return { success: true, ...state };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler: Wait for condition (UI change, element appears, spinner gone, etc.)
MessageRouter.register('WAIT_FOR', async (message) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const mgr = getBrowserProviderManager();
    const result = await mgr.waitFor(tab.id, {
      type: message.condition,
      baselineDigest: message.baselineDigest,
      roleContains: message.roleContains,
      nameContains: message.nameContains,
      textContains: message.textContains,
    }, message.timeoutMs);

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handler: Get performance metrics
MessageRouter.register('GET_METRICS', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { success: false, error: 'No active tab' };

    const mgr = getBrowserProviderManager();
    const metrics = mgr.getMetrics(tab.id);
    return { success: true, metrics };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// =============================================================================
// Event Listeners
// =============================================================================

// Service worker startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[ServiceWorker] onStartup - Browser started');
  await initializeKeepAlive();
  await updateTaskBadge();

  // Restore automation engine state and resume if needed
  const engine = getAutomationEngine();
  const restored = await engine.restoreState();
  if (restored) {
    const state = engine.getState();
    console.log('[ServiceWorker] Restored automation state, phase:', state.phase);

    // If was running, resume the loop
    if (state.phase === 'running') {
      console.log('[ServiceWorker] Resuming automation loop after startup');
      await engine.resume();
    }
  }
});

// Extension installed or updated
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[ServiceWorker] onInstalled:', details.reason);
  await initializeKeepAlive();
  await updateTaskBadge();

  // Initialize default state on fresh install
  if (details.reason === 'install') {
    await persistState('conversationHistory', []);
    await persistState('automationState', 'idle');
    console.log('[ServiceWorker] Initial state created');
  }
});

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Handle automation loop continuation
  if (alarm.name === LOOP_ALARM_NAME) {
    console.log('[Alarm] Automation loop alarm fired');
    const engine = getAutomationEngine();
    await engine.continueFromAlarm();
    return;
  }

  // Handle keepalive alarm
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    await handleKeepAlive();
  }
});

// Main message listener - route all messages through MessageRouter
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Skip messages targeted at offscreen document
  if (message.target === 'offscreen') {
    return false;
  }

  // Route through MessageRouter
  MessageRouter.handle(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('[ServiceWorker] Message handling error:', error);
      sendResponse({ error: error.message });
    });

  // Return true to indicate async response
  return true;
});

// Handle extension icon click - open side panel
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[ServiceWorker] Action clicked on tab:', tab.id);

  try {
    // Open the side panel for the current window
    await chrome.sidePanel.open({ windowId: tab.windowId });
    console.log('[ServiceWorker] Side panel opened');
  } catch (error) {
    console.error('[ServiceWorker] Failed to open side panel:', error);
  }
});

// Handle port connections (for streaming responses and sidepanel)
chrome.runtime.onConnect.addListener((port) => {
  console.log('[ServiceWorker] Port connected:', port.name);

  // Track sidepanel connections
  if (port.name === 'sidepanel') {
    const portId = Date.now().toString();
    connectedPorts.set(portId, port);
    console.log('[ServiceWorker] Sidepanel port registered:', portId);

    port.onDisconnect.addListener(() => {
      connectedPorts.delete(portId);
      console.log('[ServiceWorker] Sidepanel port disconnected:', portId);
    });
    return;
  }

  port.onMessage.addListener(async (message) => {
    if (message.type === 'STREAM_REQUEST') {
      // Forward streaming request to offscreen and pipe responses back through port
      try {
        await ensureOffscreenDocument('offscreen.html');

        // Create a port to offscreen for streaming
        const offscreenPort = chrome.runtime.connect({ name: 'offscreen-stream' });

        offscreenPort.onMessage.addListener((chunk) => {
          port.postMessage(chunk);
        });

        offscreenPort.postMessage({
          action: 'STREAM_AI_REQUEST',
          ...message.payload
        });
      } catch (error) {
        port.postMessage({ error: error.message, done: true });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[ServiceWorker] Port disconnected:', port.name);
  });
});

/**
 * Send message to all connected sidepanel ports
 * @param {Object} message - Message to send
 */
function broadcastToSidepanel(message) {
  connectedPorts.forEach((port, portId) => {
    try {
      port.postMessage(message);
    } catch (error) {
      console.error('[ServiceWorker] Failed to send to port:', portId, error);
      connectedPorts.delete(portId);
    }
  });
}

// =============================================================================
// Task Badge Management
// =============================================================================

/**
 * Update extension badge with pending task count
 * Shows count of uncompleted tasks from popup task list
 * Badge hides when count is 0 (empty string)
 */
async function updateTaskBadge() {
  try {
    // Note: popup.js uses chrome.storage.local, not sync
    const result = await chrome.storage.local.get('tasks');
    const tasks = result.tasks || [];
    const pendingCount = tasks.filter(t => !t.completed).length;

    // Update badge text (empty string hides badge)
    await chrome.action.setBadgeText({
      text: pendingCount > 0 ? String(pendingCount) : ''
    });

    // Set badge color to Thorbit terracotta
    await chrome.action.setBadgeBackgroundColor({
      color: '#C4704F'
    });

    console.log('[Badge] Updated:', pendingCount, 'pending tasks');
  } catch (error) {
    console.error('[Badge] Failed to update:', error);
  }
}

// Listen for task storage changes (from popup or any context)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.tasks) {
    updateTaskBadge();
  }
});

// =============================================================================
// Initialization
// =============================================================================

// Initialize keep-alive alarm immediately when service worker loads
(async () => {
  console.log('[ServiceWorker] Initializing...');
  await initializeKeepAlive();
  await updateTaskBadge();
  console.log('[ServiceWorker] Ready');
})();
