/**
 * Message Router - Centralized message routing for Chrome Extension
 *
 * Provides a type-based message routing system with:
 * - Handler registration via Map
 * - Async response handling with sendResponse
 * - Error handling for unknown message types
 * - Middleware support for logging and validation
 *
 * Reference: reference-architecture.md lines 414-456
 */

/**
 * MessageRouter class for centralized message handling
 * Uses a Map for O(1) handler lookup by message type
 */
class MessageRouter {
  constructor() {
    /** @type {Map<string, Function>} */
    this.handlers = new Map();

    /** @type {Array<Function>} */
    this.middleware = [];

    /** @type {boolean} */
    this.debug = false;
  }

  /**
   * Enable or disable debug logging
   * @param {boolean} enabled - Whether to enable debug mode
   */
  setDebug(enabled) {
    this.debug = enabled;
  }

  /**
   * Log message if debug is enabled
   * @param {string} level - Log level (log, warn, error)
   * @param  {...any} args - Arguments to log
   */
  log(level, ...args) {
    if (this.debug) {
      console[level]('[MessageRouter]', ...args);
    }
  }

  /**
   * Register a handler for a specific message type
   * @param {string} type - The message type to handle
   * @param {Function} handler - Async function (message, sender) => response
   * @throws {Error} If type is not a string or handler is not a function
   */
  register(type, handler) {
    if (typeof type !== 'string' || !type) {
      throw new Error('Message type must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }

    if (this.handlers.has(type)) {
      this.log('warn', `Overwriting existing handler for type: ${type}`);
    }

    this.handlers.set(type, handler);
    this.log('log', `Registered handler for type: ${type}`);
  }

  /**
   * Unregister a handler for a specific message type
   * @param {string} type - The message type to unregister
   * @returns {boolean} True if handler was removed, false if not found
   */
  unregister(type) {
    const removed = this.handlers.delete(type);
    if (removed) {
      this.log('log', `Unregistered handler for type: ${type}`);
    }
    return removed;
  }

  /**
   * Check if a handler is registered for a type
   * @param {string} type - The message type to check
   * @returns {boolean} True if handler exists
   */
  hasHandler(type) {
    return this.handlers.has(type);
  }

  /**
   * Get all registered message types
   * @returns {string[]} Array of registered types
   */
  getRegisteredTypes() {
    return Array.from(this.handlers.keys());
  }

  /**
   * Add middleware that runs before handlers
   * Middleware receives (message, sender) and can modify or validate
   * @param {Function} fn - Middleware function
   */
  use(fn) {
    if (typeof fn !== 'function') {
      throw new Error('Middleware must be a function');
    }
    this.middleware.push(fn);
  }

  /**
   * Handle an incoming message by routing to the appropriate handler
   * @param {Object} message - The message object with 'type' property
   * @param {Object} sender - The sender information from Chrome
   * @returns {Promise<any>} The handler response or error object
   */
  async handle(message, sender) {
    const startTime = Date.now();

    // Validate message has a type
    if (!message || typeof message.type !== 'string') {
      this.log('warn', 'Received message without valid type:', message);
      return {
        success: false,
        error: 'Invalid message: missing type property'
      };
    }

    this.log('log', `Handling message type: ${message.type}`, {
      tabId: sender?.tab?.id,
      url: sender?.tab?.url?.substring(0, 50)
    });

    // Run middleware
    try {
      for (const middleware of this.middleware) {
        await middleware(message, sender);
      }
    } catch (middlewareError) {
      this.log('error', 'Middleware error:', middlewareError);
      return {
        success: false,
        error: `Middleware error: ${middlewareError.message}`
      };
    }

    // Find handler
    const handler = this.handlers.get(message.type);
    if (!handler) {
      this.log('warn', `No handler for message type: ${message.type}`);
      return {
        success: false,
        error: `Unknown message type: ${message.type}`,
        availableTypes: this.getRegisteredTypes()
      };
    }

    // Execute handler
    try {
      const result = await handler(message, sender);
      const duration = Date.now() - startTime;

      this.log('log', `Handler completed for ${message.type} in ${duration}ms`);

      return {
        success: true,
        data: result
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.log('error', `Handler error for ${message.type} after ${duration}ms:`, error);

      return {
        success: false,
        error: error.message || 'Handler execution failed',
        type: message.type
      };
    }
  }

  /**
   * Create a Chrome runtime message listener that uses this router
   * This should be called once in the service worker
   * @returns {Function} Listener function for chrome.runtime.onMessage.addListener
   */
  createListener() {
    return (message, sender, sendResponse) => {
      this.handle(message, sender)
        .then(response => {
          sendResponse(response);
        })
        .catch(error => {
          this.log('error', 'Unexpected error in message handling:', error);
          sendResponse({
            success: false,
            error: error.message || 'Unexpected error'
          });
        });

      // Return true to indicate async response
      // This is CRITICAL for Chrome message passing
      return true;
    };
  }

  /**
   * Install this router as the message listener
   * Convenience method that registers the listener with Chrome
   */
  install() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(this.createListener());
      this.log('log', 'Message router installed');
    } else {
      this.log('warn', 'Chrome runtime not available - router not installed');
    }
  }
}

// Create singleton instance
const messageRouter = new MessageRouter();

// Export both the instance and the class for flexibility
export { MessageRouter, messageRouter };
export default messageRouter;
