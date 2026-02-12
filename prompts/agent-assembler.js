/**
 * Agent Prompt Assembler
 *
 * Dynamically assembles system prompts from modular pieces based on context.
 * Follows the same pattern as Thorbit AI Assistant's PromptAssembler.
 *
 * Usage:
 *   const assembler = new AgentPromptAssembler();
 *   const systemPrompt = await assembler.assemble({
 *     hasScreenshot: true,
 *     platform: 'google',
 *     hasForm: false,
 *     goal: 'Search for Chrome extensions',
 *     history: [],
 *     userSystemPrompt: 'Be extra careful with clicks',
 *     siteRules: { allow: ['*.google.com'], block: [] }
 *   });
 */

// Module definitions with inline content
// In production, these would be loaded from files

const MODULES = {
  // Core (always loaded)
  'core/identity': {
    loadWhen: 'always',
    priority: 0,
    content: `You are a browser automation agent. You accomplish goals by operating web browsers - navigating pages, clicking elements, typing text, and observing results.

You receive a goal and the current page state. You return actions to execute.

You work step-by-step: observe the page, plan actions, execute, then observe again. You never guess - if you can't find an element, you say so.

You are precise, methodical, and careful. One wrong click can derail the entire task.`
  },

  'core/output-format': {
    loadWhen: 'always',
    priority: 0,
    content: `## Output Format

Return ONLY a JSON array of actions. No explanation, no markdown, just JSON.

Example:
[
  { "type": "click", "label": 5 },
  { "type": "type", "label": 3, "value": "search query" },
  { "type": "wait", "ms": 500 }
]

Special responses:
- Goal achieved: [] (empty array)
- Stuck/confused: [{ "type": "stuck", "reason": "Cannot find login button" }]

Rules:
- Maximum 5 actions per response
- After navigation or click, always include a wait
- Re-observe after major actions`
  },

  // Operations (always loaded)
  'operations/dom-interaction': {
    loadWhen: 'always',
    priority: 10,
    content: `## DOM Interaction Actions

**click** - Click an element by label: { "type": "click", "label": 5 }
**type** - Enter text: { "type": "type", "label": 3, "value": "hello" }
**scroll** - Scroll page: { "type": "scroll", "direction": "down", "amount": 500 }
**hover** - Hover element: { "type": "hover", "label": 7 }
**focus** - Focus element: { "type": "focus", "label": 2 }`
  },

  'operations/navigation': {
    loadWhen: 'always',
    priority: 10,
    content: `## Navigation Actions

**navigate** - Go to URL: { "type": "navigate", "url": "https://google.com" }
**wait** - Wait for page: { "type": "wait", "ms": 1000 }
**back** - Browser back: { "type": "back" }
**refresh** - Reload: { "type": "refresh" }

Always wait after navigation before interacting.`
  },

  'operations/observation': {
    loadWhen: 'always',
    priority: 10,
    content: `## Understanding Page State

Interactive elements are labeled: [0], [1], [2], etc.

Example:
[0] button - "Sign In"
[1] input - "" (placeholder: "Email")
[2] button - "Submit"

Use labels in actions: { "type": "click", "label": 0 }

If element not found: scroll, wait, or report stuck.`
  },

  // Visual (screenshot available)
  'visual/screenshot-analysis': {
    loadWhen: 'context.hasScreenshot',
    priority: 15,
    content: `## Screenshot Analysis

When DOM labels are insufficient, use the screenshot to:
- Identify unlabeled elements (canvas, SVG, custom)
- Understand layout and visual state
- Detect loading states, errors, modals

Coordinate-based click (last resort):
{ "type": "click_coords", "x": 450, "y": 320 }`
  },

  // Platforms
  'platforms/social-media': {
    loadWhen: 'context.platform:facebook,twitter,linkedin,instagram',
    priority: 20,
    content: `## Social Media Patterns

**Facebook:** Like/comment/share buttons on posts, "What's on your mind?" composer
**Twitter/X:** Heart=like, Arrows=retweet, "What's happening?" composer
**LinkedIn:** "Start a post" composer, Like/Comment/Repost buttons
**Instagram:** Heart=like, Speech bubble=comment, Plus=new post

Common: Infinite scroll, modals for compose, login walls.`
  },

  'platforms/search-engines': {
    loadWhen: 'context.platform:google,bing,duckduckgo',
    priority: 20,
    content: `## Search Engine Patterns

1. Find search input (usually [0] or [1])
2. Type query
3. Press Enter or click search button
4. Wait for results
5. Click desired result link

Results: blue links = organic, "Ad" = paid. Pagination at bottom.`
  },

  'platforms/ecommerce': {
    loadWhen: 'context.platform:amazon,shopify,ebay',
    priority: 20,
    content: `## E-commerce Patterns

**Amazon:** "Add to Cart" (yellow), "Buy Now" (orange)
**Shopify:** "Add to Cart"/"Add to Bag", cart icon in header
**eBay:** "Buy It Now" vs "Place Bid"

IMPORTANT: Payment/checkout require approval. Never auto-submit payment.`
  },

  // Forms
  'forms/form-filling': {
    loadWhen: 'context.hasForm',
    priority: 20,
    content: `## Form Handling

Fill fields top-to-bottom. For dropdowns: click to open, click option.
Required fields often marked with *.
Red borders = validation error.
Look for "Submit"/"Send"/"Continue" button at bottom.`
  },

  // Safety (always loaded)
  'safety/approval-gates': {
    loadWhen: 'always',
    priority: 25,
    content: `## Actions Requiring Approval

Flag these for user confirmation:
- Payment/purchase submission
- Delete/remove actions
- Password/security changes
- Publishing/sending messages

Flag with: { "type": "approval_required", "action": "click", "label": 5, "reason": "Payment" }`
  },

  'safety/boundaries': {
    loadWhen: 'always',
    priority: 25,
    content: `## Boundaries

Never: Enter payment info without instruction, access banking without permission, download files, change system settings.

Always: Respect block lists, stop on CAPTCHA, report when goal cannot be achieved.

When uncertain: Ask rather than guess.`
  }
};

/**
 * Detect platform from URL
 */
function detectPlatform(url) {
  if (!url) return null;

  const platformPatterns = {
    'google': /google\.(com|[a-z]{2,3})/i,
    'bing': /bing\.com/i,
    'duckduckgo': /duckduckgo\.com/i,
    'facebook': /facebook\.com|fb\.com/i,
    'twitter': /twitter\.com|x\.com/i,
    'linkedin': /linkedin\.com/i,
    'instagram': /instagram\.com/i,
    'amazon': /amazon\.(com|[a-z]{2,3})/i,
    'ebay': /ebay\.(com|[a-z]{2,3})/i,
    'shopify': /myshopify\.com/i
  };

  for (const [platform, pattern] of Object.entries(platformPatterns)) {
    if (pattern.test(url)) {
      return platform;
    }
  }

  return null;
}

/**
 * Check if form elements exist in interactive elements
 */
function hasFormElements(interactiveElements) {
  if (!interactiveElements || !Array.isArray(interactiveElements)) {
    return false;
  }

  const formTags = ['INPUT', 'TEXTAREA', 'SELECT'];
  return interactiveElements.some(el =>
    formTags.includes(el.tag?.toUpperCase())
  );
}

/**
 * Evaluate loadWhen condition
 */
function evaluateCondition(condition, context) {
  if (!condition || condition === 'always') {
    return true;
  }

  // context.hasScreenshot
  if (condition === 'context.hasScreenshot') {
    return context.hasScreenshot === true;
  }

  // context.hasForm
  if (condition === 'context.hasForm') {
    return context.hasForm === true;
  }

  // context.platform:value1,value2
  if (condition.startsWith('context.platform:')) {
    const platforms = condition.split(':')[1].split(',');
    return platforms.includes(context.platform);
  }

  return false;
}

/**
 * Agent Prompt Assembler
 */
class AgentPromptAssembler {
  constructor() {
    this.modules = MODULES;
    this.loadedModules = [];
  }

  /**
   * Assemble system prompt from modules based on context
   * @param {Object} [context] - Assembly context
   * @param {boolean} [context.hasScreenshot] - Screenshot available
   * @param {string} [context.platform] - Detected platform (or auto-detect from URL)
   * @param {boolean} [context.hasForm] - Form elements present
   * @param {string} [context.goal] - User's goal
   * @param {Array} [context.history] - Action history
   * @param {string} [context.url] - Current page URL
   * @param {Object} [context.domState] - DOM state with interactiveElements
   * @param {string} [context.userSystemPrompt] - User's custom instructions
   * @param {Object} [context.siteRules] - Allow/block rules
   * @returns {string} Assembled system prompt
   */
  assemble(context = {}) {
    this.loadedModules = [];

    // Auto-detect platform if not provided
    if (!context.platform && context.url) {
      const detectedPlatform = detectPlatform(context.url);
      if (detectedPlatform) {
        context.platform = detectedPlatform;
      }
    }

    // Auto-detect forms if not provided
    if (context.hasForm === undefined && context.domState?.interactiveElements) {
      context.hasForm = hasFormElements(context.domState.interactiveElements);
    }

    // Collect and sort modules by priority
    const modulesToLoad = [];

    for (const [path, module] of Object.entries(this.modules)) {
      if (evaluateCondition(module.loadWhen, context)) {
        modulesToLoad.push({ path, ...module });
      }
    }

    // Sort by priority
    modulesToLoad.sort((a, b) => a.priority - b.priority);

    // Build prompt parts
    const parts = [];

    for (const module of modulesToLoad) {
      parts.push(module.content);
      this.loadedModules.push(module.path);
    }

    // Add dynamic content
    const dynamicParts = [];

    // User's custom system prompt
    if (context.userSystemPrompt) {
      dynamicParts.push(`<USER_INSTRUCTIONS>\n${context.userSystemPrompt}\n</USER_INSTRUCTIONS>`);
    }

    // Site rules
    if (context.siteRules) {
      const rulesText = [];
      if (context.siteRules.allow?.length) {
        rulesText.push(`Allowed sites: ${context.siteRules.allow.join(', ')}`);
      }
      if (context.siteRules.block?.length) {
        rulesText.push(`Blocked sites (never visit): ${context.siteRules.block.join(', ')}`);
      }
      if (rulesText.length) {
        dynamicParts.push(`<SITE_RULES>\n${rulesText.join('\n')}\n</SITE_RULES>`);
      }
    }

    // Current goal
    if (context.goal) {
      dynamicParts.push(`<GOAL>\n${context.goal}\n</GOAL>`);
    }

    // Action history
    if (context.history && context.history.length > 0) {
      const historyText = context.history.map((h, i) =>
        `${i + 1}. ${h.action?.type || 'unknown'}: ${JSON.stringify(h.action)} → ${h.result?.success ? 'success' : 'failed'}`
      ).join('\n');
      dynamicParts.push(`<HISTORY>\n${historyText}\n</HISTORY>`);
    }

    // Combine everything
    let prompt = parts.join('\n\n');

    if (dynamicParts.length > 0) {
      prompt += '\n\n## Context\n\n' + dynamicParts.join('\n\n');
    }

    return prompt;
  }

  /**
   * Get list of modules loaded in last assembly
   */
  getLoadedModules() {
    return [...this.loadedModules];
  }

  /**
   * Estimate token count (rough: 1 token ≈ 4 chars)
   */
  estimateTokens(context) {
    const prompt = this.assemble(context);
    return Math.ceil(prompt.length / 4);
  }
}

export { AgentPromptAssembler, detectPlatform, hasFormElements };
