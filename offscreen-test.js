// Minimal offscreen test - no imports
console.log('[Offscreen-Test] Script loaded at', new Date().toISOString());

// Test that chrome.runtime is available
console.log('[Offscreen-Test] chrome.runtime available:', !!chrome?.runtime);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen-Test] Message received:', JSON.stringify(message));

  // Ignore messages not targeted at offscreen
  if (message.target !== 'offscreen') {
    console.log('[Offscreen-Test] Ignoring - not targeted at offscreen');
    return false;
  }

  console.log('[Offscreen-Test] Processing action:', message.action);

  if (message.action === 'PING') {
    console.log('[Offscreen-Test] Sending PING response');
    sendResponse({ status: 'alive', test: true, timestamp: Date.now() });
    return true; // Indicate we called sendResponse
  }

  // For other actions, indicate we won't respond
  console.log('[Offscreen-Test] Unknown action:', message.action);
  return false;
});

console.log('[Offscreen-Test] Listener registered successfully');
