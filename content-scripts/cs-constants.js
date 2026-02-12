/**
 * Content Script: Shared Constants & Namespace
 *
 * First file loaded. Sets up the shared namespace and all constants
 * used by the other content-script modules.
 */
(function () {
  'use strict';

  // Shared namespace — all content-script modules read/write via this
  window.__thorbit = window.__thorbit || {};
  const T = window.__thorbit;

  // Default threshold for viewport filtering (pixels from viewport)
  T.DEFAULT_VIEWPORT_THRESHOLD = 1000;

  // Maximum recursion depth to prevent deep nesting issues
  T.MAX_DEPTH = 20;

  // Tags to skip during DOM traversal
  T.SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'HEAD', 'BR', 'HR',
  ]);

  // Tags considered interactive by default
  T.INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'DETAILS',
  ]);

  // ARIA roles that indicate interactivity
  T.INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'menu', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch',
    'tab', 'treeitem', 'slider', 'spinbutton', 'searchbox', 'gridcell',
  ]);

  // Attributes to preserve in the pruned DOM
  T.RELEVANT_ATTRIBUTES = [
    'id', 'name', 'type', 'href', 'src', 'alt', 'placeholder',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'title',
    'value', 'role', 'data-testid', 'for',
  ];
})();
