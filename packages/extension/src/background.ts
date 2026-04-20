// src/background.ts — service worker
// Extension no longer owns CDP or frame capture.
// The relay owns the CDP session and streams frames via Page.startScreencast.
// Extension responsibility: manage offscreen document for WebSocket relay bridge.

let capturing    = false;
let captureTabId: number | null = null;

// ── Main click handler ────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) { stopCapture(); return; }
  if (!tab.id) return;
  const tabId = tab.id;
  captureTabId = tabId;
  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

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

function stopCapture() {
  capturing    = false;
  captureTabId = null;
  (chrome.offscreen as any).closeDocument?.().catch(() => {});
  console.log('[bg] capture stopped');
}
