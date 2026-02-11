/**
 * AI Page Assistant - Side Panel Root Component
 *
 * This is a vanilla JS implementation that mimics React patterns.
 * For production, consider using a bundler (webpack/vite) with actual React.
 *
 * The CSP 'script-src self' prevents CDN React imports.
 */

// =============================================================================
// State Management (Simple Zustand-like store)
// =============================================================================

const createStore = (initialState) => {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    setState: (partial) => {
      const newState = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...newState };
      listeners.forEach((listener) => listener(state));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

// Initialize store with persisted state
const store = createStore({
  messages: [],
  isLoading: false,
  isStreaming: false,
  currentResponse: '',
  error: null,
  connectionStatus: 'connecting', // 'connected', 'disconnected', 'connecting'
});

// Persist to chrome.storage.session
const persistState = async () => {
  try {
    const { messages } = store.getState();
    await chrome.storage.session.set({ 'ai-assistant-messages': messages });
  } catch (e) {
    console.error('Failed to persist state:', e);
  }
};

// Load persisted state
const loadPersistedState = async () => {
  try {
    const result = await chrome.storage.session.get('ai-assistant-messages');
    if (result['ai-assistant-messages']) {
      store.setState({ messages: result['ai-assistant-messages'] });
    }
  } catch (e) {
    console.error('Failed to load persisted state:', e);
  }
};

// =============================================================================
// Service Worker Communication
// =============================================================================

let messagePort = null;

const connectToServiceWorker = () => {
  store.setState({ connectionStatus: 'connecting' });

  try {
    messagePort = chrome.runtime.connect({ name: 'sidepanel' });

    messagePort.onMessage.addListener((msg) => {
      handleServiceWorkerMessage(msg);
    });

    messagePort.onDisconnect.addListener(() => {
      console.log('Port disconnected');
      store.setState({ connectionStatus: 'disconnected' });
      messagePort = null;

      // Attempt reconnection after delay
      setTimeout(connectToServiceWorker, 2000);
    });

    store.setState({ connectionStatus: 'connected' });
  } catch (e) {
    console.error('Failed to connect to service worker:', e);
    store.setState({ connectionStatus: 'disconnected' });
  }
};

const handleServiceWorkerMessage = (msg) => {
  switch (msg.type) {
    case 'STREAM_CHUNK':
      store.setState((state) => ({
        currentResponse: state.currentResponse + msg.text,
        isStreaming: true,
      }));
      render();
      break;

    case 'STREAM_DONE':
      const { currentResponse, messages } = store.getState();
      if (currentResponse) {
        store.setState({
          messages: [...messages, {
            id: Date.now(),
            role: 'assistant',
            content: currentResponse,
            timestamp: new Date().toISOString(),
          }],
          currentResponse: '',
          isStreaming: false,
          isLoading: false,
        });
        persistState();
      }
      render();
      break;

    case 'STREAM_ERROR':
      store.setState({
        error: msg.error || 'An error occurred',
        isStreaming: false,
        isLoading: false,
        currentResponse: '',
      });
      render();
      break;

    case 'DOM_EXTRACTED':
      // DOM extraction complete, can proceed with analysis
      console.log('DOM extracted:', msg.tokenCount, 'tokens');
      break;

    default:
      console.log('Unknown message type:', msg.type);
  }
};

const sendMessage = async (content) => {
  const { messages } = store.getState();

  // Add user message
  const userMessage = {
    id: Date.now(),
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
  };

  store.setState({
    messages: [...messages, userMessage],
    isLoading: true,
    error: null,
    currentResponse: '',
  });

  persistState();
  render();

  try {
    // Send to service worker
    await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      prompt: content,
    });
  } catch (e) {
    console.error('Failed to send message:', e);
    store.setState({
      error: 'Failed to send message. Please try again.',
      isLoading: false,
    });
    render();
  }
};

const clearConversation = async () => {
  store.setState({
    messages: [],
    currentResponse: '',
    error: null,
  });
  await chrome.storage.session.remove('ai-assistant-messages');
  render();
};

// =============================================================================
// UI Components (Vanilla JS)
// =============================================================================

const Icons = {
  send: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
  clear: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  sparkles: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"></path><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"></path><path d="M19 13l.5 1.5L21 15l-1.5.5L19 17l-.5-1.5L17 15l1.5-.5L19 13z"></path></svg>`,
  alertCircle: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
};

const renderHeader = () => `
  <header class="header">
    <div class="header-left">
      <span class="header-title">AI Page Assistant</span>
    </div>
    <div class="header-actions">
      <button class="header-btn" id="clear-btn" title="Clear conversation">
        ${Icons.clear}
      </button>
    </div>
  </header>
`;

const renderEmptyState = () => `
  <div class="empty-state">
    <div class="empty-state-icon">${Icons.sparkles}</div>
    <h2 class="empty-state-title">Analyze this page</h2>
    <p class="empty-state-description">
      Ask questions about the current page, extract information, or get AI-powered insights.
    </p>
    <div class="quick-actions">
      <button class="quick-action-btn" data-prompt="Summarize this page">
        Summarize page
      </button>
      <button class="quick-action-btn" data-prompt="What are the main topics on this page?">
        Main topics
      </button>
      <button class="quick-action-btn" data-prompt="Extract all links from this page">
        Extract links
      </button>
    </div>
  </div>
`;

const renderMessage = (msg) => {
  const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `
    <div class="message ${msg.role}">
      <div class="message-content">${escapeHtml(msg.content)}</div>
      <div class="message-meta">${timeStr}</div>
    </div>
  `;
};

const renderStreamingMessage = (content) => `
  <div class="message assistant">
    <div class="message-content">
      ${escapeHtml(content)}<span class="streaming-cursor"></span>
    </div>
  </div>
`;

const renderLoadingIndicator = () => `
  <div class="loading-indicator">
    <div class="loading-spinner"></div>
    <span>Analyzing page...</span>
  </div>
`;

const renderError = (error) => `
  <div class="inline-error">
    <span>${escapeHtml(error)}</span>
  </div>
`;

const renderChatArea = () => {
  const { messages, isLoading, isStreaming, currentResponse, error } = store.getState();

  if (messages.length === 0 && !isLoading && !isStreaming && !error) {
    return `<div class="chat-area">${renderEmptyState()}</div>`;
  }

  let content = messages.map(renderMessage).join('');

  if (isStreaming && currentResponse) {
    content += renderStreamingMessage(currentResponse);
  } else if (isLoading) {
    content += renderLoadingIndicator();
  }

  if (error) {
    content += renderError(error);
  }

  return `<div class="chat-area" id="chat-area">${content}</div>`;
};

const renderInputArea = () => {
  const { isLoading, isStreaming, connectionStatus } = store.getState();
  const isDisabled = isLoading || isStreaming || connectionStatus === 'disconnected';

  return `
    <div class="input-area">
      <div class="connection-status">
        <span class="connection-dot ${connectionStatus}"></span>
        <span>${connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
      </div>
      <div class="input-container">
        <textarea
          id="message-input"
          class="input-textarea"
          placeholder="Ask about this page..."
          rows="1"
          ${isDisabled ? 'disabled' : ''}
        ></textarea>
        <button class="send-btn" id="send-btn" ${isDisabled ? 'disabled' : ''} title="Send message">
          ${Icons.send}
        </button>
      </div>
    </div>
  `;
};

// =============================================================================
// Rendering & Event Binding
// =============================================================================

const escapeHtml = (text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

const render = () => {
  const root = document.getElementById('root');
  if (!root) return;

  root.innerHTML = `
    <div class="app-container">
      ${renderHeader()}
      ${renderChatArea()}
      ${renderInputArea()}
    </div>
  `;

  // Bind events
  bindEvents();

  // Scroll to bottom of chat
  scrollToBottom();
};

const bindEvents = () => {
  // Send button
  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('message-input');

  if (sendBtn && input) {
    sendBtn.addEventListener('click', () => {
      const content = input.value.trim();
      if (content) {
        sendMessage(content);
      }
    });

    // Enter to send (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const content = input.value.trim();
        if (content) {
          sendMessage(content);
        }
      }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  // Clear button
  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearConversation);
  }

  // Quick action buttons
  document.querySelectorAll('.quick-action-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) {
        sendMessage(prompt);
      }
    });
  });
};

const scrollToBottom = () => {
  const chatArea = document.getElementById('chat-area');
  if (chatArea) {
    chatArea.scrollTop = chatArea.scrollHeight;
  }
};

// =============================================================================
// Initialization
// =============================================================================

const init = async () => {
  console.log('AI Page Assistant initializing...');

  // Load persisted messages
  await loadPersistedState();

  // Connect to service worker
  connectToServiceWorker();

  // Initial render
  render();

  // Re-render on state changes
  store.subscribe(() => {
    // Debounce renders slightly for streaming
    requestAnimationFrame(render);
  });

  console.log('AI Page Assistant ready');
};

// Start the app
init();
