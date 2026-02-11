/**
 * Service Worker for AI Page Assistant Chrome Extension
 *
 * Handles:
 * - Chrome Alarms keep-alive pattern (0.4-min interval)
 * - Message routing with handler registration
 * - State persistence to chrome.storage.session
 * - Side panel management via action.onClicked
 * - Offscreen document coordination
 */

// =============================================================================
// Constants
// =============================================================================

const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds - survives 30s termination
const KEEPALIVE_ALARM_NAME = 'keepalive';

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
  await ensureOffscreenDocument('offscreen.html');
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
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

// Handler: Analyze current page
MessageRouter.register('ANALYZE_PAGE', async (message, sender) => {
  console.log('[Handler] ANALYZE_PAGE from:', sender.tab?.id || 'unknown');

  // Store as pending task in case of termination
  await persistState('pendingTask', {
    type: 'DOM_ANALYSIS',
    tabId: sender.tab?.id,
    timestamp: Date.now()
  });

  try {
    // Get active tab if sender doesn't have tab info
    let tabId = sender.tab?.id;
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }

    if (!tabId) {
      throw new Error('No active tab found');
    }

    // Request DOM extraction from content script
    const domResult = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DOM' });

    if (domResult.error) {
      throw new Error(domResult.error);
    }

    // Send to offscreen for AI processing
    const analysisResult = await sendToOffscreen({
      action: 'ANALYZE_DOM',
      dom: domResult.dom,
      url: domResult.url,
      title: domResult.title,
      prompt: message.prompt || 'Analyze this page and provide insights.'
    });

    // Clear pending task on success
    await clearState('pendingTask');

    return analysisResult;
  } catch (error) {
    console.error('[Handler] ANALYZE_PAGE error:', error);
    await clearState('pendingTask');
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

// Handler: Health check
MessageRouter.register('PING', async () => {
  return {
    status: 'alive',
    timestamp: Date.now(),
    alarmActive: await chrome.alarms.get(KEEPALIVE_ALARM_NAME) !== null
  };
});

// =============================================================================
// Event Listeners
// =============================================================================

// Service worker startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[ServiceWorker] onStartup - Browser started');
  await initializeKeepAlive();
  await updateTaskBadge();
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

// Handle port connections (for streaming responses)
chrome.runtime.onConnect.addListener((port) => {
  console.log('[ServiceWorker] Port connected:', port.name);

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
