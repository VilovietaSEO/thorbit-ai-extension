/**
 * DOM Pruning Utilities
 *
 * Optimized DOM extraction for AI consumption.
 * Implements browser-use patterns for viewport filtering, interactive detection, and indexed labeling.
 *
 * Token reduction target: 60-80% compared to raw DOM
 *
 * @module utils/dom-pruning
 */

/**
 * Tags that should be skipped during DOM traversal
 * These elements don't contribute meaningful content for AI analysis
 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'HEAD']);

/**
 * Tags that are inherently interactive
 */
const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY']);

/**
 * ARIA roles that indicate interactivity
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
  'searchbox',
]);

/**
 * Attributes that are relevant for AI understanding
 */
const RELEVANT_ATTRIBUTES = ['id', 'name', 'type', 'href', 'placeholder', 'aria-label', 'title', 'alt', 'value', 'data-testid'];

/**
 * Maximum depth for DOM traversal to prevent stack overflow
 */
const MAX_DEPTH = 20;

/**
 * Maximum text content length to capture per element
 */
const MAX_TEXT_LENGTH = 100;

/**
 * Maximum attribute value length to capture
 */
const MAX_ATTR_LENGTH = 100;

/**
 * Determines if an element is interactive (can receive user input or trigger actions)
 *
 * @param {Element} element - DOM element to check
 * @returns {boolean} True if element is interactive
 */
function isInteractive(element) {
  // Check tag name
  if (INTERACTIVE_TAGS.has(element.tagName)) {
    return true;
  }

  // Check ARIA role
  const role = element.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) {
    return true;
  }

  // Check for click handlers
  if (element.onclick !== null || element.hasAttribute('onclick')) {
    return true;
  }

  // Check for keyboard accessibility (tabIndex >= 0, excluding body)
  if (element.tabIndex >= 0 && element.tagName !== 'BODY' && element.tagName !== 'HTML') {
    return true;
  }

  // Check for contenteditable
  if (element.isContentEditable) {
    return true;
  }

  // Check for draggable
  if (element.draggable) {
    return true;
  }

  return false;
}

/**
 * Determines if an element is visible to the user
 * Checks CSS visibility, opacity, dimensions, and viewport proximity
 *
 * @param {Element} element - DOM element to check
 * @param {number} viewportThreshold - Max distance from viewport in pixels (default: 1000)
 * @returns {boolean} True if element is visible
 */
function isVisible(element, viewportThreshold = 1000) {
  // Check if element exists and has computed style
  if (!element || !element.getBoundingClientRect) {
    return false;
  }

  try {
    const style = window.getComputedStyle(element);

    // Check CSS visibility properties
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;

    // Check pointer-events for truly hidden elements
    // (commented out - some hidden elements may still be relevant for AI)
    // if (style.pointerEvents === 'none') return false;

    // Check element dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    // Viewport filtering: skip elements too far from visible area
    // This significantly reduces token count by excluding off-screen content
    const distanceFromViewport = Math.max(
      rect.top - window.innerHeight, // Below viewport
      -rect.bottom,                   // Above viewport
      rect.left - window.innerWidth,  // Right of viewport
      -rect.right                     // Left of viewport
    );

    return distanceFromViewport < viewportThreshold;
  } catch (error) {
    // If we can't determine visibility, assume visible
    console.warn('[dom-pruning] Error checking visibility:', error);
    return true;
  }
}

/**
 * Generates a CSS selector for an element
 * Priority: ID > name attribute > path-based selector with nth-of-type
 *
 * @param {Element} element - DOM element to generate selector for
 * @returns {string} CSS selector string
 */
function generateSelector(element) {
  // Fastest path: element has ID
  if (element.id) {
    // Ensure ID is valid CSS (escape if needed)
    const escapedId = CSS.escape ? CSS.escape(element.id) : element.id;
    return `#${escapedId}`;
  }

  // Second path: element has name attribute
  const name = element.getAttribute('name');
  if (name) {
    const escapedName = CSS.escape ? CSS.escape(name) : name;
    return `[name="${escapedName}"]`;
  }

  // Third path: check for data-testid (commonly used in modern apps)
  const testId = element.getAttribute('data-testid');
  if (testId) {
    const escapedTestId = CSS.escape ? CSS.escape(testId) : testId;
    return `[data-testid="${escapedTestId}"]`;
  }

  // Generate path-based selector
  const path = [];
  let current = element;

  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    // If we hit an element with ID, use it and stop
    if (current.id) {
      const escapedId = CSS.escape ? CSS.escape(current.id) : current.id;
      selector = `#${escapedId}`;
      path.unshift(selector);
      break;
    }

    // Calculate nth-of-type index among siblings
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((s) => s.tagName === current.tagName);
      const index = siblings.indexOf(current);
      if (siblings.length > 1 && index >= 0) {
        selector += `:nth-of-type(${index + 1})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;
  }

  return path.length > 0 ? path.join(' > ') : element.tagName.toLowerCase();
}

/**
 * Extracts text content from an element, avoiding duplicate content from children
 * Only captures direct text nodes to prevent repetition
 *
 * @param {Element} element - DOM element to extract text from
 * @returns {string} Trimmed text content (max MAX_TEXT_LENGTH chars)
 */
function extractDirectText(element) {
  let text = '';

  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    }
  }

  return text.trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * Processes a single DOM element and its children recursively
 * Creates a pruned representation optimized for AI consumption
 *
 * @param {Element} element - DOM element to process
 * @param {Object} context - Processing context (labelIndex, interactiveElements, viewportThreshold)
 * @param {number} depth - Current recursion depth
 * @returns {Object|null} Processed element object or null if element should be skipped
 */
function processElement(element, context, depth = 0) {
  // Prevent excessive recursion
  if (depth > MAX_DEPTH) {
    return null;
  }

  // Skip non-element nodes
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  // Skip tags that don't contribute meaningful content
  if (SKIP_TAGS.has(element.tagName)) {
    return null;
  }

  // Skip invisible elements
  if (!isVisible(element, context.viewportThreshold)) {
    return null;
  }

  // Build result object
  const result = {
    tag: element.tagName.toLowerCase(),
  };

  // Extract direct text (avoid duplicate content from children)
  const directText = extractDirectText(element);
  if (directText) {
    result.text = directText;
  }

  // Handle interactive elements
  if (isInteractive(element)) {
    result.label = `[${context.labelIndex}]`;

    // Store interactive element metadata
    const rect = element.getBoundingClientRect();
    context.interactiveElements.push({
      label: context.labelIndex,
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, MAX_TEXT_LENGTH) || '',
      selector: generateSelector(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      attributes: extractRelevantAttributes(element),
    });

    context.labelIndex++;
  }

  // Add relevant attributes to result
  for (const attr of RELEVANT_ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (value) {
      result[attr] = value.slice(0, MAX_ATTR_LENGTH);
    }
  }

  // Process children recursively
  const children = [];
  for (const child of element.children) {
    const processed = processElement(child, context, depth + 1);
    if (processed) {
      children.push(processed);
    }
  }

  if (children.length > 0) {
    result.children = children;
  }

  return result;
}

/**
 * Extracts relevant attributes from an element
 *
 * @param {Element} element - DOM element
 * @returns {Object} Object with relevant attribute key-value pairs
 */
function extractRelevantAttributes(element) {
  const attrs = {};
  for (const attr of RELEVANT_ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (value) {
      attrs[attr] = value.slice(0, MAX_ATTR_LENGTH);
    }
  }
  return attrs;
}

/**
 * Main entry point: Extracts a pruned DOM tree optimized for AI consumption
 *
 * Uses browser-use patterns:
 * - Viewport filtering (skip elements >viewportThreshold px from viewport)
 * - Interactive element detection and labeling
 * - Skip non-semantic tags (SCRIPT, STYLE, SVG, etc.)
 * - Depth limiting (max 20 levels)
 * - Text truncation (max 100 chars)
 *
 * @param {Object} options - Extraction options
 * @param {number} options.viewportThreshold - Max distance from viewport in px (default: 1000)
 * @param {boolean} options.includeHidden - Include hidden elements (default: false)
 * @returns {Object} Pruned DOM result with tree, interactiveElements, and metadata
 */
function extractPrunedDom(options = {}) {
  const { viewportThreshold = 1000 } = options;

  // Processing context shared across recursive calls
  const context = {
    labelIndex: 0,
    interactiveElements: [],
    viewportThreshold,
  };

  // Process the body (or documentElement if body is empty)
  const rootElement = document.body || document.documentElement;
  const tree = processElement(rootElement, context, 0);

  return {
    url: window.location.href,
    title: document.title,
    tree,
    interactiveElements: context.interactiveElements,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    meta: {
      extractedAt: new Date().toISOString(),
      elementCount: context.labelIndex,
      totalInteractive: context.interactiveElements.length,
    },
  };
}

/**
 * Estimates token count for the extracted DOM
 * Rough estimate: ~4 characters per token for English text
 *
 * @param {Object} prunedDom - Result from extractPrunedDom
 * @returns {number} Estimated token count
 */
function estimateTokenCount(prunedDom) {
  const jsonString = JSON.stringify(prunedDom);
  // Rough estimate: ~4 chars per token
  return Math.ceil(jsonString.length / 4);
}

/**
 * Compresses the DOM result for transmission
 * Removes null values and empty arrays/objects
 *
 * @param {Object} obj - Object to compress
 * @returns {Object} Compressed object
 */
function compressDomResult(obj) {
  if (Array.isArray(obj)) {
    return obj.map(compressDomResult).filter((item) => item !== null && item !== undefined);
  }

  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const compressed = compressDomResult(value);
      // Skip null, undefined, empty strings, empty arrays, empty objects
      if (
        compressed !== null &&
        compressed !== undefined &&
        compressed !== '' &&
        !(Array.isArray(compressed) && compressed.length === 0) &&
        !(typeof compressed === 'object' && Object.keys(compressed).length === 0)
      ) {
        result[key] = compressed;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  return obj;
}

/**
 * Finds an interactive element by its label index
 *
 * @param {Object} prunedDom - Result from extractPrunedDom
 * @param {number} labelIndex - Label index to find
 * @returns {Object|null} Interactive element metadata or null if not found
 */
function findInteractiveByLabel(prunedDom, labelIndex) {
  return prunedDom.interactiveElements.find((el) => el.label === labelIndex) || null;
}

/**
 * Gets a DOM element by its selector from the interactive elements list
 *
 * @param {string} selector - CSS selector
 * @returns {Element|null} DOM element or null if not found
 */
function getElementBySelector(selector) {
  try {
    return document.querySelector(selector);
  } catch (error) {
    console.warn('[dom-pruning] Invalid selector:', selector, error);
    return null;
  }
}

// Export functions for use in content script
// Using both ES modules and global scope for compatibility
if (typeof window !== 'undefined') {
  window.DomPruning = {
    extractPrunedDom,
    isInteractive,
    isVisible,
    generateSelector,
    processElement,
    estimateTokenCount,
    compressDomResult,
    findInteractiveByLabel,
    getElementBySelector,
    SKIP_TAGS,
    INTERACTIVE_TAGS,
    INTERACTIVE_ROLES,
    MAX_DEPTH,
    MAX_TEXT_LENGTH,
  };
}

// ES module exports
export {
  extractPrunedDom,
  isInteractive,
  isVisible,
  generateSelector,
  processElement,
  estimateTokenCount,
  compressDomResult,
  findInteractiveByLabel,
  getElementBySelector,
  SKIP_TAGS,
  INTERACTIVE_TAGS,
  INTERACTIVE_ROLES,
  MAX_DEPTH,
  MAX_TEXT_LENGTH,
};

export default extractPrunedDom;
