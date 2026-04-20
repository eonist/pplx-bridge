// src/background.ts — service worker
// Extension no longer owns CDP. The relay owns the CDP session for each tab.
// Extension responsibility: create the offscreen document so it can maintain
// persistent WebSocket connections to the relay. Frame capture is handled
// entirely by the relay via Page.startScreencast — captureVisibleTab must NOT
// be used here because it activates the captured tab, firing focus/visibility
// events that reset Lexical's caret position in background tabs.

let offscreenReady = false;
let captureTabId: number | null = null;

// ── Main click handler ────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;
  captureTabId = tabId;
  console.log('[bg] activating relay bridge for tab', tabId);

  // Create offscreen document — owns WebSocket connections persistently
  try {
    const existing = await (chrome.offscreen as any).hasDocument?.();
    if (!existing) {
      await (chrome.offscreen as any).createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['BLOBS'],
        justification: 'Persistent WebSocket relay bridge for pplx-bridge',
      });
      console.log('[bg] offscreen document created');
      offscreenReady = true;
    }
  } catch (err) {
    console.error('[bg] offscreen create failed:', err);
  }

  // Send tabId to offscreen so it can resolve the correct relay port
  try {
    await chrome.runtime.sendMessage({ type: 'init', tabId });
  } catch { /* offscreen may not be ready yet — it will request tabId on boot */ }
});

// Respond to offscreen requesting tabId after it boots
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getTabId') {
    sendResponse({ tabId: captureTabId });
    return true;
  }
});
