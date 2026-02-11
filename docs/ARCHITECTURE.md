# AI Page Analyzer: Architecture Documentation

## Overview

AI Page Analyzer is a Chrome extension built on Manifest V3 that provides AI-powered web page analysis through a conversational side panel interface. The architecture is designed to handle the unique constraints of MV3 service workers while delivering reliable, streaming AI responses.

---

## Architecture Diagram

```
                                    +------------------------+
                                    |     Side Panel UI      |
                                    |   (React + Zustand)    |
                                    |                        |
                                    | - ChatInterface.jsx    |
                                    | - StreamingMessage.jsx |
                                    | - ProgressIndicator.jsx|
                                    +----------+-------------+
                                               |
                                               | Port connection
                                               | (real-time streaming)
                                               v
+------------------------+         +---------------------------+
|    Content Script      |<------->|    Service Worker         |
|   (DOM Extraction)     | message |   (Orchestration)         |
|                        | passing |                           |
| - extractPrunedDom()   |         | - Message routing         |
| - findInteractive()    |         | - Chrome Alarms keep-alive|
| - generateSelector()   |         | - State persistence       |
+------------------------+         +-------------+-------------+
                                                 |
                                                 | message
                                                 | passing
                                                 v
                                  +-----------------------------+
                                  |    Offscreen Document       |
                                  |   (AI Processing)           |
                                  |                             |
                                  | - Anthropic API calls       |
                                  | - SSE stream parsing        |
                                  | - Prompt caching            |
                                  +-------------+---------------+
                                                |
                                                | HTTPS
                                                v
                                  +-----------------------------+
                                  |   Backend Proxy (Optional)  |
                                  |   - Auth validation         |
                                  |   - API key protection      |
                                  |   - Rate limiting           |
                                  +-------------+---------------+
                                                |
                                                | HTTPS
                                                v
                                  +-----------------------------+
                                  |     Anthropic Claude API    |
                                  |   - claude-sonnet-4         |
                                  |   - Prompt caching          |
                                  |   - Streaming responses     |
                                  +-----------------------------+
```

---

## Component Details

### 1. Service Worker (service-worker.js)

The service worker is the central orchestrator of the extension. It coordinates communication between all components and manages the extension lifecycle.

**Key Responsibilities:**
- Route messages between content scripts, side panel, and offscreen document
- Manage Chrome Alarms for keep-alive during long AI operations
- Persist state to chrome.storage.session
- Handle extension installation and updates
- Open side panel on user action

**Lifecycle Constraints:**
- Terminates after 30 seconds of inactivity
- Maximum 5 minutes of continuous operation
- Must externalize all state to chrome.storage

**Keep-Alive Strategy:**

```javascript
// Chrome Alarms pattern (recommended)
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('keepalive', {
    periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
    delayInMinutes: KEEPALIVE_INTERVAL_MINUTES
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    // Resume pending tasks from storage
    const state = await chrome.storage.session.get('pendingTask');
    if (state.pendingTask) {
      await resumeTask(state.pendingTask);
    }
  }
});
```

**Message Router Pattern:**

```javascript
const MessageRouter = {
  handlers: new Map(),

  register(type, handler) {
    this.handlers.set(type, handler);
  },

  async handle(message, sender) {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      return { error: 'Unknown message type' };
    }
    return handler(message, sender);
  }
};

// Register handlers
MessageRouter.register('ANALYZE_PAGE', async (msg, sender) => {
  const dom = await chrome.tabs.sendMessage(sender.tab.id, { action: 'EXTRACT_DOM' });
  return sendToOffscreen({ action: 'ANALYZE_DOM', dom });
});
```

---

### 2. Content Script (content-script.js)

The content script runs in the context of web pages and is responsible for DOM extraction. It operates in an isolated world, sharing DOM access with the page but having a separate JavaScript context.

**Key Responsibilities:**
- Extract pruned DOM tree for AI consumption
- Identify and label interactive elements
- Generate CSS selectors for element targeting
- Execute actions on the page (if needed)

**DOM Pruning Strategy:**

The content script implements browser-use inspired pruning to reduce token usage by 60-80%:

1. **Viewport filtering**: Skip elements more than 1000px from the visible viewport
2. **Tag filtering**: Exclude SCRIPT, STYLE, NOSCRIPT, SVG, PATH tags
3. **Visibility checking**: Skip elements with display:none, visibility:hidden, or zero dimensions
4. **Depth limiting**: Maximum 20 levels of DOM nesting
5. **Text truncation**: Limit text content to 100 characters per element
6. **Interactive labeling**: Mark buttons, links, inputs with unique labels [0], [1], etc.

**Output Structure:**

```javascript
{
  url: "https://example.com/page",
  title: "Page Title",
  tree: {
    tag: "div",
    text: "...",
    children: [...]
  },
  interactiveElements: [
    { label: 0, tag: "BUTTON", text: "Submit", selector: "#submit-btn" },
    { label: 1, tag: "A", text: "Learn More", selector: ".cta-link" }
  ],
  viewport: {
    width: 1920,
    height: 1080,
    scrollY: 0
  }
}
```

---

### 3. Offscreen Document (offscreen.html, offscreen.js)

The offscreen document provides DOM access unavailable in service workers, essential for parsing AI responses. Only ONE offscreen document is allowed per extension.

**Key Responsibilities:**
- Make Anthropic API calls
- Parse SSE streaming responses
- Implement prompt caching
- Forward response chunks to service worker

**Recovery Pattern:**

The offscreen document may be closed by Chrome. We implement a robust recovery pattern:

```javascript
let creating; // Global promise to prevent race conditions

async function ensureOffscreenDocument(path) {
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
  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: path,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'AI model inference and DOM processing',
  });

  await creating;
  creating = null;
}
```

**Streaming Implementation:**

```javascript
async function streamAIResponse(prompt, onChunk) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      stream: true,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' } // Enable caching
        }
      ],
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

    for (const line of lines) {
      const data = JSON.parse(line.slice(6));
      if (data.type === 'content_block_delta') {
        onChunk(data.delta.text);
      }
    }
  }
}
```

---

### 4. Side Panel (sidepanel/)

The side panel provides a persistent chat interface that survives page navigation. Built with React and Zustand for state management.

**Key Responsibilities:**
- Display chat interface with message history
- Handle user input and send to service worker
- Display streaming AI responses in real-time
- Persist conversation state across sessions

**State Management with Zustand:**

```javascript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useAgentStore = create(
  persist(
    (set, get) => ({
      conversationHistory: [],
      currentTask: null,
      automationState: 'idle',
      error: null,

      addMessage: (msg) => set(state => ({
        conversationHistory: [...state.conversationHistory, msg]
      })),

      setError: (error) => set({
        automationState: 'error',
        error
      }),

      reset: () => set({
        conversationHistory: [],
        currentTask: null,
        automationState: 'idle',
        error: null
      }),
    }),
    {
      name: 'ai-agent-state',
      storage: {
        getItem: async (name) => {
          const result = await chrome.storage.session.get(name);
          return result[name] || null;
        },
        setItem: async (name, value) => {
          await chrome.storage.session.set({ [name]: value });
        },
        removeItem: async (name) => {
          await chrome.storage.session.remove(name);
        },
      },
    }
  )
);
```

**Streaming Display Pattern:**

```javascript
function useAIStream() {
  const [response, setResponse] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(async (prompt) => {
    setIsStreaming(true);
    setResponse('');

    const port = chrome.runtime.connect({ name: 'ai-stream' });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'CHUNK') {
        setResponse(prev => prev + msg.text);
      } else if (msg.type === 'DONE') {
        setIsStreaming(false);
        port.disconnect();
      }
    });

    chrome.runtime.sendMessage({
      type: 'START_STREAM',
      prompt
    });
  }, []);

  return { response, isStreaming, startStream };
}
```

---

### 5. Backend Proxy (Optional)

The backend proxy protects API keys and provides authentication. It's recommended for production deployments.

**Key Responsibilities:**
- Store Anthropic API key securely (environment variable)
- Validate extension session tokens
- Proxy API requests to Anthropic
- Implement rate limiting
- Log usage for monitoring

**Authentication Flow:**

```
1. User clicks "Login" in extension
2. Extension opens auth window to backend
3. User authenticates (OAuth/Clerk)
4. Backend generates extension_token (JWT, 30-day expiry)
5. Token returned to extension via callback URL
6. Extension stores token in chrome.storage.local
7. All API calls include: Authorization: Bearer {token}
```

---

## Data Flow

### Page Analysis Flow

```
1. User sends message in side panel
   |
2. Side panel -> Service Worker (ANALYZE_PAGE message)
   |
3. Service Worker -> Content Script (EXTRACT_DOM message)
   |
4. Content Script extracts DOM, prunes, returns
   |
5. Service Worker -> Offscreen Document (AI_REQUEST message)
   |
6. Offscreen Document -> Anthropic API (streaming request)
   |
7. Anthropic API streams response chunks
   |
8. Offscreen Document -> Service Worker (CHUNK messages)
   |
9. Service Worker -> Side Panel (Port messages)
   |
10. Side Panel displays streaming response
```

### State Persistence Flow

```
State Change in UI
       |
       v
Zustand Store Update
       |
       v
persist middleware triggers
       |
       v
chrome.storage.session.set()
       |
       v
Service Worker Termination (30s inactivity)
       |
       v
Service Worker Restart
       |
       v
chrome.storage.session.get()
       |
       v
Zustand Store Rehydration
```

---

## Error Handling

### Retry Strategy

```javascript
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true
  } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1 || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(
        Math.pow(2, attempt) * baseDelay + Math.random() * 1000,
        maxDelay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### Graceful Degradation

```javascript
async function analyzePageWithFallback(tabId) {
  const dom = await chrome.tabs.sendMessage(tabId, { action: 'EXTRACT_DOM' });

  // Try primary model
  try {
    return await analyzeWithClaude(dom);
  } catch (primaryError) {
    console.warn('Claude failed, trying fallback:', primaryError);

    // Final fallback: cached or heuristic result
    const cached = await getCachedAnalysis(dom.url);
    if (cached) return cached;

    return getHeuristicAnalysis(dom);
  }
}
```

---

## Performance Optimizations

### Token Optimization

| Technique | Savings | Implementation |
|-----------|---------|----------------|
| DOM pruning | 60-80% | Remove non-interactive elements, limit depth |
| Prompt caching | 50-90% | Static system prompt cached at Anthropic |
| Text truncation | 20-30% | Limit text per element to 100 chars |
| Tag filtering | 10-20% | Skip script, style, svg tags |

### Memory Management

- Clear large DOM objects after processing
- Limit conversation history to 50 messages
- Use session storage for ephemeral data
- Implement proper cleanup on extension unload

---

## Security Considerations

### Content Script Security

- Treat all content script data as untrusted
- Sanitize DOM content before AI processing
- Validate all message types
- Truncate text to prevent prompt injection

### API Key Protection

- Never bundle API keys in extension
- Use backend proxy for production
- Store session tokens securely
- Implement token expiration and refresh

### Content Security Policy

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

---

## Directory Structure

```
chrome-extension-ai-assistant/
+-- manifest.json                 # MV3 configuration
+-- service-worker.js             # Background orchestrator
+-- offscreen.html                # Offscreen document wrapper
+-- offscreen.js                  # AI processing
+-- content-script.js             # DOM extraction
|
+-- sidepanel/
|   +-- index.html                # Side panel entry
|   +-- index.jsx                 # React root
|   +-- components/
|   |   +-- ChatInterface.jsx     # Main chat UI
|   |   +-- StreamingMessage.jsx  # Real-time display
|   |   +-- ProgressIndicator.jsx # Loading states
|   |   +-- ErrorBoundary.jsx     # Error handling
|   +-- store/
|       +-- agentStore.js         # Zustand state
|
+-- utils/
|   +-- dom-pruning.js            # DOM extraction
|   +-- message-router.js         # Message handling
|   +-- offscreen-utils.js        # Offscreen recovery
|
+-- backend-proxy/                # Optional auth proxy
|   +-- server.js
|   +-- routes/
|       +-- auth.js
|       +-- ai-proxy.js
|
+-- assets/
|   +-- icon-16.png
|   +-- icon-48.png
|   +-- icon-128.png
|
+-- docs/
    +-- PRIVACY.md
    +-- CHROME_STORE_LISTING.md
    +-- ARCHITECTURE.md
```

---

## API Reference

### Chrome APIs Used

| API | Purpose |
|-----|---------|
| `chrome.runtime.sendMessage` | One-time message passing |
| `chrome.runtime.connect` | Long-lived port for streaming |
| `chrome.tabs.sendMessage` | Message to content script |
| `chrome.scripting.executeScript` | Programmatic script injection |
| `chrome.storage.session` | Session-scoped state persistence |
| `chrome.storage.local` | Persistent storage for auth tokens |
| `chrome.sidePanel.open` | Open side panel UI |
| `chrome.alarms.create` | Keep-alive timer |
| `chrome.offscreen.createDocument` | Create offscreen document |

### Anthropic API

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/messages` | Create AI completion |
| `stream: true` | Enable SSE streaming |
| `cache_control` | Enable prompt caching |

---

## Deployment

### Development

```bash
# Load unpacked extension
1. Navigate to chrome://extensions
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select chrome-extension-ai-assistant/ directory
```

### Production

```bash
# Package for Chrome Web Store
1. Remove development artifacts
2. Create ZIP of extension directory
3. Upload to Chrome Web Store Developer Dashboard
4. Submit for review
```

---

## Testing

### Manual Testing Checklist

- [ ] Extension loads without errors
- [ ] Side panel opens on icon click
- [ ] DOM extraction captures interactive elements
- [ ] AI responses stream correctly
- [ ] State persists across browser restart
- [ ] Service worker recovers after termination
- [ ] Offscreen document recovers after closure
- [ ] Error handling displays user-friendly messages

### Service Worker Lifecycle Testing

```
1. Open chrome://serviceworker-internals
2. Find extension service worker
3. Click "Stop" to terminate
4. Wait 30 seconds
5. Verify worker restarts via alarm
6. Verify state recovered from storage
```
