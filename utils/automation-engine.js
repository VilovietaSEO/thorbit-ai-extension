/**
 * Automation Engine - Core State Machine Orchestrator
 *
 * Implements the observe-plan-act loop for autonomous browser automation.
 * Ties together all existing primitives:
 * - extractPrunedDom() from content-script.js
 * - executeAction() from content-script.js
 * - MessageRouter from service-worker.js
 * - persistState()/getState() from service-worker.js
 * - AgentPromptAssembler from prompts/agent-assembler.js
 *
 * State Machine Phases:
 * - idle: No active automation
 * - running: Executing observe-plan-act loop
 * - paused: Temporarily halted, can resume
 * - awaiting_approval: Dangerous action requires user confirmation
 * - error: Unrecoverable error state
 * - goal_complete: Goal successfully achieved
 *
 * Service Worker Termination Handling:
 * - Uses chrome.alarms to schedule loop continuation
 * - Persists state to chrome.storage.session before every potential termination
 * - Restores state on alarm wake-up
 */

import { AgentPromptAssembler } from '../prompts/agent-assembler.js';

// =============================================================================
// Constants
// =============================================================================

const LOOP_ALARM_NAME = 'automation-loop';
const LOOP_DELAY_MINUTES = 0.01; // ~600ms - quick continuation
const ACTION_DELAY_MS = 500; // Delay between actions to let page settle
const MAX_ACTIONS_PER_RESPONSE = 5;
const MAX_HISTORY_LENGTH = 50; // Prevent unbounded history growth
const DOM_CONFIDENCE_THRESHOLD = 0.7; // Below this, request screenshot

// Dangerous action patterns that require user approval
const DANGEROUS_PATTERNS = [
  'submit',
  'payment',
  'delete',
  'remove',
  'purchase',
  'buy',
  'confirm',
  'send',
  'checkout',
  'order',
  'subscribe',
  'unsubscribe',
  'cancel',
  'password',
  'security'
];

// =============================================================================
// AutomationEngine Class
// =============================================================================

class AutomationEngine {
  /**
   * Create a new AutomationEngine instance
   */
  constructor() {
    this.state = {
      phase: 'idle',
      goal: null,
      step: 0,
      context: {},
      history: [],
      pendingAction: null,
      error: null,
      startedAt: null,
      lastUpdatedAt: null
    };
    this.promptAssembler = new AgentPromptAssembler();
    this._initialized = false;
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Start a new automation workflow with a goal
   * @param {string} goal - The goal to achieve
   * @returns {Promise<void>}
   */
  async start(goal) {
    if (!goal || typeof goal !== 'string') {
      throw new Error('Goal must be a non-empty string');
    }

    console.log('[AutomationEngine] Starting with goal:', goal);

    // Initialize fresh state
    this.state = {
      phase: 'running',
      goal: goal.trim(),
      step: 0,
      context: {},
      history: [],
      pendingAction: null,
      error: null,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now()
    };

    await this.persistState();
    await this.notifyUI('started', { goal: this.state.goal });
    await this.executeLoop();
  }

  /**
   * Pause the automation workflow
   * @returns {Promise<void>}
   */
  async pause() {
    if (this.state.phase !== 'running') {
      console.warn('[AutomationEngine] Cannot pause - not running');
      return;
    }

    console.log('[AutomationEngine] Pausing');
    this.state.phase = 'paused';
    this.state.lastUpdatedAt = Date.now();

    // Cancel any pending loop alarm
    await chrome.alarms.clear(LOOP_ALARM_NAME);

    await this.persistState();
    await this.notifyUI('paused', {});
  }

  /**
   * Resume a paused workflow
   * @returns {Promise<void>}
   */
  async resume() {
    if (this.state.phase !== 'paused') {
      console.warn('[AutomationEngine] Cannot resume - not paused');
      return;
    }

    console.log('[AutomationEngine] Resuming');
    this.state.phase = 'running';
    this.state.lastUpdatedAt = Date.now();

    await this.persistState();
    await this.notifyUI('resumed', {});
    await this.executeLoop();
  }

  /**
   * Stop the automation workflow completely
   * @returns {Promise<void>}
   */
  async stop() {
    console.log('[AutomationEngine] Stopping');

    // Cancel any pending loop alarm
    await chrome.alarms.clear(LOOP_ALARM_NAME);

    const previousPhase = this.state.phase;
    this.state.phase = 'idle';
    this.state.lastUpdatedAt = Date.now();

    await this.persistState();
    await this.notifyUI('stopped', { previousPhase });
  }

  /**
   * Restore state from storage (call after service worker wake-up)
   * @returns {Promise<boolean>} True if state was restored
   */
  async restoreState() {
    try {
      const stored = await chrome.storage.session.get([
        'automationState',
        'automationContext'
      ]);

      if (stored.automationState) {
        this.state = stored.automationState;
        this._initialized = true;
        console.log('[AutomationEngine] State restored, phase:', this.state.phase);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[AutomationEngine] Failed to restore state:', error);
      return false;
    }
  }

  /**
   * Continue the loop after alarm wake-up
   * @returns {Promise<void>}
   */
  async continueFromAlarm() {
    await this.restoreState();

    if (this.state.phase === 'running') {
      console.log('[AutomationEngine] Continuing from alarm');
      await this.executeLoop();
    }
  }

  // ===========================================================================
  // Approval Flow
  // ===========================================================================

  /**
   * Approve a pending action and continue execution
   * @returns {Promise<void>}
   */
  async approveAndContinue() {
    if (this.state.phase !== 'awaiting_approval') {
      console.warn('[AutomationEngine] No action awaiting approval');
      return;
    }

    const action = this.state.pendingAction;
    if (!action) {
      console.error('[AutomationEngine] No pending action found');
      this.state.phase = 'error';
      this.state.error = 'Pending action was lost';
      await this.persistState();
      return;
    }

    console.log('[AutomationEngine] User approved action:', action);

    // Clear pending state and continue
    this.state.pendingAction = null;
    this.state.phase = 'running';
    this.state.lastUpdatedAt = Date.now();

    await this.persistState();
    await this.notifyUI('approved', { action });

    // Execute the approved action
    const result = await this.act(action);
    this.addToHistory(action, result);

    if (result.success) {
      // Schedule next loop iteration
      await this.scheduleLoopContinuation();
    } else {
      // Re-observe on failure
      await this.executeLoop();
    }
  }

  /**
   * Reject a pending action and continue observing
   * @param {string} reason - Reason for rejection
   * @returns {Promise<void>}
   */
  async rejectAndContinue(reason = 'User rejected') {
    if (this.state.phase !== 'awaiting_approval') {
      console.warn('[AutomationEngine] No action awaiting approval');
      return;
    }

    const action = this.state.pendingAction;
    console.log('[AutomationEngine] User rejected action:', action, 'Reason:', reason);

    // Add rejection to history
    this.addToHistory(action, {
      success: false,
      error: reason,
      rejected: true
    });

    // Clear pending state and continue
    this.state.pendingAction = null;
    this.state.phase = 'running';
    this.state.lastUpdatedAt = Date.now();

    await this.persistState();
    await this.notifyUI('rejected', { action, reason });

    // Continue with next observation
    await this.executeLoop();
  }

  // ===========================================================================
  // Core Loop
  // ===========================================================================

  /**
   * Execute the main observe-plan-act loop
   * @returns {Promise<void>}
   */
  async executeLoop() {
    // Exit conditions
    if (this.state.phase !== 'running') {
      console.log('[AutomationEngine] Loop exiting - phase:', this.state.phase);
      return;
    }

    console.log('[AutomationEngine] Loop iteration', this.state.step);

    try {
      // 1. OBSERVE - Get current page state
      const observation = await this.observe();

      if (!observation.success) {
        console.error('[AutomationEngine] Observation failed:', observation.error);
        await this.notifyUI('observation_failed', { error: observation.error });
        // Schedule retry
        await this.scheduleLoopContinuation();
        return;
      }

      // 2. PLAN - Use modular prompt system to get actions
      const systemPrompt = await this.buildSystemPrompt(observation);
      const userMessage = this.buildUserMessage(observation);

      const actions = await this.plan(systemPrompt, userMessage, observation);

      // Check for goal completion (empty actions array)
      if (!actions || actions.length === 0) {
        console.log('[AutomationEngine] Goal appears complete');
        this.state.phase = 'goal_complete';
        this.state.lastUpdatedAt = Date.now();
        await this.persistState();
        await this.notifyUI('goal_complete', { goal: this.state.goal, history: this.state.history });
        return;
      }

      // Check for "stuck" response
      if (actions.length === 1 && actions[0].type === 'stuck') {
        console.log('[AutomationEngine] AI is stuck:', actions[0].reason);
        await this.notifyUI('stuck', { reason: actions[0].reason });
        // Schedule retry with fresh observation
        await this.scheduleLoopContinuation();
        return;
      }

      // 3. ACT - Execute actions one by one
      for (const action of actions) {
        // Check if action requires approval
        if (this.requiresApproval(action)) {
          await this.requestApproval(action);
          return; // Exit loop, wait for user
        }

        const result = await this.act(action);
        this.addToHistory(action, result);

        if (!result.success) {
          console.warn('[AutomationEngine] Action failed:', action, result.error);
          await this.notifyUI('action_failed', { action, error: result.error });
          // Re-observe on failure
          break;
        }

        // Let page settle after action
        await this.delay(ACTION_DELAY_MS);
      }

      // 4. INCREMENT & SCHEDULE
      this.state.step++;
      this.state.lastUpdatedAt = Date.now();
      await this.persistState();

      // Schedule next loop iteration via alarm (handles SW termination)
      await this.scheduleLoopContinuation();

    } catch (error) {
      console.error('[AutomationEngine] Loop error:', error);
      this.state.phase = 'error';
      this.state.error = error.message;
      this.state.lastUpdatedAt = Date.now();
      await this.persistState();
      await this.notifyUI('error', { error: error.message });
    }
  }

  /**
   * Schedule the next loop iteration via chrome.alarms
   * This survives service worker termination
   * @returns {Promise<void>}
   */
  async scheduleLoopContinuation() {
    await chrome.alarms.create(LOOP_ALARM_NAME, {
      delayInMinutes: LOOP_DELAY_MINUTES
    });
    console.log('[AutomationEngine] Scheduled loop continuation');
  }

  // ===========================================================================
  // Observe Phase
  // ===========================================================================

  /**
   * Observe the current page state
   * @returns {Promise<Object>} Observation result with domState and optional screenshot
   */
  async observe() {
    try {
      // Get active tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!tab || !tab.id) {
        return {
          success: false,
          error: 'No active tab found'
        };
      }

      // Check if tab URL is valid for content script
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        return {
          success: false,
          error: 'Cannot interact with this page type'
        };
      }

      // Extract DOM from content script
      let domResponse;
      try {
        domResponse = await chrome.tabs.sendMessage(tab.id, {
          type: 'EXTRACT_DOM',
          viewportThreshold: 1000
        });
      } catch (error) {
        // Content script might not be injected
        return {
          success: false,
          error: 'Content script not available - try refreshing the page'
        };
      }

      if (!domResponse || !domResponse.success) {
        return {
          success: false,
          error: domResponse?.error || 'DOM extraction failed',
          blocked: domResponse?.blocked,
          reason: domResponse?.reason
        };
      }

      const domState = domResponse.data;

      // Calculate confidence based on interactive element count and visibility
      const confidence = this.calculateDomConfidence(domState);

      // Capture screenshot if DOM confidence is low
      let screenshot = null;
      if (confidence < DOM_CONFIDENCE_THRESHOLD) {
        try {
          screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: 'jpeg',
            quality: 70
          });
          console.log('[AutomationEngine] Captured screenshot due to low confidence');
        } catch (error) {
          console.warn('[AutomationEngine] Screenshot capture failed:', error);
        }
      }

      return {
        success: true,
        tab,
        domState: {
          ...domState,
          confidence
        },
        screenshot,
        siteContext: domResponse.siteContext
      };

    } catch (error) {
      console.error('[AutomationEngine] Observe error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate confidence score for DOM extraction
   * @param {Object} domState - Extracted DOM state
   * @returns {number} Confidence score 0-1
   */
  calculateDomConfidence(domState) {
    if (!domState) return 0;

    let score = 0;

    // Has interactive elements
    if (domState.interactiveElements?.length > 0) {
      score += 0.3;
    }

    // Has meaningful content in tree
    if (domState.tree && Object.keys(domState.tree).length > 0) {
      score += 0.2;
    }

    // Has page metadata
    if (domState.url && domState.title) {
      score += 0.2;
    }

    // Reasonable number of interactive elements (not too few, not too many)
    const elementCount = domState.interactiveElements?.length || 0;
    if (elementCount >= 3 && elementCount <= 100) {
      score += 0.2;
    }

    // Viewport info available
    if (domState.viewport) {
      score += 0.1;
    }

    return Math.min(score, 1);
  }

  // ===========================================================================
  // Plan Phase
  // ===========================================================================

  /**
   * Build system prompt using AgentPromptAssembler
   * @param {Object} observation - Observation result
   * @returns {Promise<string>} Assembled system prompt
   */
  async buildSystemPrompt(observation) {
    const userSystemPrompt = await this.getUserSystemPrompt();
    const siteRules = await this.getSiteRules();

    return this.promptAssembler.assemble({
      url: observation.domState?.url,
      hasScreenshot: !!observation.screenshot,
      domState: observation.domState,
      goal: this.state.goal,
      history: this.state.history.slice(-10), // Last 10 actions
      userSystemPrompt,
      siteRules
    });
  }

  /**
   * Build user message with current observation
   * @param {Object} observation - Observation result
   * @returns {Object} User message content array
   */
  buildUserMessage(observation) {
    const parts = [];

    // Page info
    parts.push({
      type: 'text',
      text: `## Current Page

URL: ${observation.domState?.url || 'Unknown'}
Title: ${observation.domState?.title || 'Unknown'}
Step: ${this.state.step}

## Interactive Elements

${this.formatInteractiveElements(observation.domState?.interactiveElements || [])}

## Viewport

${JSON.stringify(observation.domState?.viewport || {}, null, 2)}

What actions should I take to achieve the goal?`
    });

    // Add screenshot if available
    if (observation.screenshot) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: observation.screenshot.replace(/^data:image\/\w+;base64,/, '')
        }
      });
    }

    return parts;
  }

  /**
   * Format interactive elements for AI consumption
   * @param {Array} elements - Interactive elements array
   * @returns {string} Formatted element list
   */
  formatInteractiveElements(elements) {
    if (!elements || elements.length === 0) {
      return 'No interactive elements found';
    }

    return elements.map(el => {
      const attrs = [];
      if (el.id) attrs.push(`id="${el.id}"`);
      if (el.name) attrs.push(`name="${el.name}"`);
      if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
      if (el['aria-label']) attrs.push(`aria-label="${el['aria-label']}"`);

      const attrStr = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
      const text = el.text ? ` - "${el.text.slice(0, 50)}${el.text.length > 50 ? '...' : ''}"` : '';

      return `[${el.label}] ${el.tag?.toLowerCase() || 'element'}${attrStr}${text}`;
    }).join('\n');
  }

  /**
   * Get AI plan for next actions
   * @param {string} systemPrompt - Assembled system prompt
   * @param {Object} userMessage - User message with observation
   * @param {Object} observation - Full observation object
   * @returns {Promise<Array>} Array of actions to execute
   */
  async plan(systemPrompt, userMessage, observation) {
    try {
      // Send to offscreen document for AI processing
      const response = await chrome.runtime.sendMessage({
        type: 'AI_REQUEST',
        payload: {
          systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 1024,
          temperature: 0.2 // Low temperature for deterministic actions
        }
      });

      if (response.error) {
        console.error('[AutomationEngine] AI request failed:', response.error);
        return [{ type: 'stuck', reason: 'AI request failed: ' + response.error }];
      }

      // Parse JSON action array from response
      return this.parseActionsFromResponse(response.content || response.text || '');

    } catch (error) {
      console.error('[AutomationEngine] Plan error:', error);
      return [{ type: 'stuck', reason: 'Planning failed: ' + error.message }];
    }
  }

  /**
   * Parse actions from AI response text
   * @param {string} responseText - AI response text
   * @returns {Array} Parsed actions array
   */
  parseActionsFromResponse(responseText) {
    try {
      // Clean up response - find JSON array
      let text = responseText.trim();

      // Try to extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }

      const actions = JSON.parse(text);

      if (!Array.isArray(actions)) {
        console.warn('[AutomationEngine] Response is not an array');
        return [{ type: 'stuck', reason: 'AI response was not an action array' }];
      }

      // Validate and limit actions
      const validActions = actions
        .filter(a => a && typeof a === 'object' && a.type)
        .slice(0, MAX_ACTIONS_PER_RESPONSE);

      return validActions;

    } catch (error) {
      console.error('[AutomationEngine] Failed to parse actions:', error);
      return [{ type: 'stuck', reason: 'Could not parse AI response as actions' }];
    }
  }

  // ===========================================================================
  // Act Phase
  // ===========================================================================

  /**
   * Execute a single action
   * @param {Object} action - Action to execute
   * @returns {Promise<Object>} Execution result
   */
  async act(action) {
    if (!action || !action.type) {
      return { success: false, error: 'Invalid action' };
    }

    console.log('[AutomationEngine] Executing action:', action.type);

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!tab || !tab.id) {
        return { success: false, error: 'No active tab' };
      }

      switch (action.type) {
        case 'click':
          return await this.executeClick(tab.id, action);

        case 'type':
          return await this.executeType(tab.id, action);

        case 'scroll':
          return await this.executeScroll(tab.id, action);

        case 'hover':
          return await this.executeHover(tab.id, action);

        case 'focus':
          return await this.executeFocus(tab.id, action);

        case 'navigate':
          return await this.executeNavigate(tab.id, action);

        case 'back':
          return await this.executeBack(tab.id);

        case 'refresh':
          return await this.executeRefresh(tab.id);

        case 'wait':
          return await this.executeWait(action);

        case 'click_coords':
          return await this.executeClickCoords(tab.id, action);

        case 'approval_required':
          // This is a signal, not an action - should have been caught earlier
          return { success: false, error: 'Approval required for action' };

        case 'stuck':
          // Not an action, just a status
          return { success: false, error: action.reason || 'Agent is stuck' };

        default:
          return { success: false, error: `Unknown action type: ${action.type}` };
      }

    } catch (error) {
      console.error('[AutomationEngine] Action execution error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute click action via content script
   */
  async executeClick(tabId, action) {
    if (action.label === undefined && action.label !== 0) {
      return { success: false, error: 'Click action requires label' };
    }

    return chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_ACTION',
      action: 'click',
      label: action.label
    });
  }

  /**
   * Execute type action via content script
   */
  async executeType(tabId, action) {
    if (action.label === undefined || !action.value) {
      return { success: false, error: 'Type action requires label and value' };
    }

    return chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_ACTION',
      action: 'type',
      label: action.label,
      value: action.value
    });
  }

  /**
   * Execute scroll action via content script
   */
  async executeScroll(tabId, action) {
    return chrome.tabs.sendMessage(tabId, {
      type: 'SCROLL_PAGE',
      direction: action.direction || 'down',
      amount: action.amount
    });
  }

  /**
   * Execute hover action via content script
   */
  async executeHover(tabId, action) {
    if (action.label === undefined) {
      return { success: false, error: 'Hover action requires label' };
    }

    return chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_ACTION',
      action: 'hover',
      label: action.label
    });
  }

  /**
   * Execute focus action via content script
   */
  async executeFocus(tabId, action) {
    if (action.label === undefined) {
      return { success: false, error: 'Focus action requires label' };
    }

    return chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_ACTION',
      action: 'focus',
      label: action.label
    });
  }

  /**
   * Execute navigation to URL
   */
  async executeNavigate(tabId, action) {
    if (!action.url) {
      return { success: false, error: 'Navigate action requires url' };
    }

    try {
      await chrome.tabs.update(tabId, { url: action.url });
      // Wait for navigation to start
      await this.delay(1000);
      return { success: true, action: 'navigate', url: action.url };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute browser back
   */
  async executeBack(tabId) {
    try {
      await chrome.tabs.goBack(tabId);
      await this.delay(500);
      return { success: true, action: 'back' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute page refresh
   */
  async executeRefresh(tabId) {
    try {
      await chrome.tabs.reload(tabId);
      await this.delay(1000);
      return { success: true, action: 'refresh' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute wait action
   */
  async executeWait(action) {
    const ms = action.ms || 1000;
    await this.delay(ms);
    return { success: true, action: 'wait', ms };
  }

  /**
   * Execute click at specific coordinates (fallback)
   */
  async executeClickCoords(tabId, action) {
    if (action.x === undefined || action.y === undefined) {
      return { success: false, error: 'Click coords requires x and y' };
    }

    // Use Chrome debugger API for coordinate clicks
    // This is a fallback when label-based click isn't available
    try {
      // For now, inject a click event - full implementation would use debugger
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          const element = document.elementFromPoint(x, y);
          if (element) {
            element.click();
            return { success: true };
          }
          return { success: false, error: 'No element at coordinates' };
        },
        args: [action.x, action.y]
      });
      return { success: true, action: 'click_coords', x: action.x, y: action.y };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===========================================================================
  // Approval & Safety
  // ===========================================================================

  /**
   * Check if an action requires user approval
   * @param {Object} action - Action to check
   * @returns {boolean} True if approval required
   */
  requiresApproval(action) {
    // Explicit approval_required type
    if (action.type === 'approval_required') {
      return true;
    }

    // Check action content against dangerous patterns
    const actionStr = JSON.stringify(action).toLowerCase();
    return DANGEROUS_PATTERNS.some(pattern =>
      actionStr.includes(pattern)
    );
  }

  /**
   * Request user approval for an action
   * @param {Object} action - Action requiring approval
   * @returns {Promise<void>}
   */
  async requestApproval(action) {
    console.log('[AutomationEngine] Requesting approval for:', action);

    this.state.phase = 'awaiting_approval';
    this.state.pendingAction = action;
    this.state.lastUpdatedAt = Date.now();

    await this.persistState();
    await this.notifyUI('approval_required', {
      action,
      reason: this.getApprovalReason(action)
    });
  }

  /**
   * Get human-readable reason for approval request
   * @param {Object} action - Action requiring approval
   * @returns {string} Reason description
   */
  getApprovalReason(action) {
    const actionStr = JSON.stringify(action).toLowerCase();

    if (actionStr.includes('payment') || actionStr.includes('purchase') || actionStr.includes('buy')) {
      return 'This action may involve a payment or purchase';
    }
    if (actionStr.includes('delete') || actionStr.includes('remove')) {
      return 'This action may delete or remove content';
    }
    if (actionStr.includes('submit') || actionStr.includes('send')) {
      return 'This action will submit or send something';
    }
    if (actionStr.includes('password') || actionStr.includes('security')) {
      return 'This action involves security settings';
    }

    return 'This action requires your confirmation';
  }

  // ===========================================================================
  // History Management
  // ===========================================================================

  /**
   * Add action and result to history
   * @param {Object} action - Executed action
   * @param {Object} result - Execution result
   */
  addToHistory(action, result) {
    this.state.history.push({
      action,
      result,
      timestamp: Date.now(),
      step: this.state.step
    });

    // Trim history if too long
    if (this.state.history.length > MAX_HISTORY_LENGTH) {
      this.state.history = this.state.history.slice(-MAX_HISTORY_LENGTH);
    }
  }

  // ===========================================================================
  // State Persistence
  // ===========================================================================

  /**
   * Persist current state to chrome.storage.session
   * Called before any potential service worker termination
   * @returns {Promise<void>}
   */
  async persistState() {
    try {
      await chrome.storage.session.set({
        automationState: this.state,
        automationContext: this.state.context
      });
      console.log('[AutomationEngine] State persisted, phase:', this.state.phase);
    } catch (error) {
      console.error('[AutomationEngine] Failed to persist state:', error);
    }
  }

  // ===========================================================================
  // Settings Access
  // ===========================================================================

  /**
   * Get user's custom system prompt from settings
   * @returns {Promise<string>}
   */
  async getUserSystemPrompt() {
    try {
      const result = await chrome.storage.sync.get('settings');
      return result.settings?.systemPrompt || '';
    } catch (error) {
      console.warn('[AutomationEngine] Failed to get user system prompt:', error);
      return '';
    }
  }

  /**
   * Get site rules (allowed/blocked sites) from settings
   * @returns {Promise<Object>}
   */
  async getSiteRules() {
    try {
      const result = await chrome.storage.sync.get('settings');
      const settings = result.settings || {};
      return {
        allow: settings.allowedSites || [],
        block: settings.disallowedSites || []
      };
    } catch (error) {
      console.warn('[AutomationEngine] Failed to get site rules:', error);
      return { allow: [], block: [] };
    }
  }

  // ===========================================================================
  // UI Notification
  // ===========================================================================

  /**
   * Notify UI components of automation events
   * @param {string} event - Event name
   * @param {Object} data - Event data
   * @returns {Promise<void>}
   */
  async notifyUI(event, data) {
    try {
      await chrome.runtime.sendMessage({
        type: 'AUTOMATION_EVENT',
        event,
        data,
        state: {
          phase: this.state.phase,
          step: this.state.step,
          goal: this.state.goal
        }
      });
      console.log('[AutomationEngine] UI notified:', event);
    } catch (error) {
      // UI might not be listening - that's ok
      console.debug('[AutomationEngine] UI notification failed (normal if no listener):', error);
    }
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Delay execution for specified milliseconds
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current state (for external inspection)
   * @returns {Object} Current state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Check if automation is currently active
   * @returns {boolean}
   */
  isActive() {
    return this.state.phase === 'running' || this.state.phase === 'awaiting_approval';
  }

  /**
   * Get summary of loaded prompt modules
   * @returns {Array} Module names
   */
  getLoadedPromptModules() {
    return this.promptAssembler.getLoadedModules();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let automationEngineInstance = null;

/**
 * Get the singleton AutomationEngine instance
 * @returns {AutomationEngine}
 */
function getAutomationEngine() {
  if (!automationEngineInstance) {
    automationEngineInstance = new AutomationEngine();
  }
  return automationEngineInstance;
}

// =============================================================================
// Exports
// =============================================================================

export {
  AutomationEngine,
  getAutomationEngine,
  LOOP_ALARM_NAME,
  DANGEROUS_PATTERNS
};
