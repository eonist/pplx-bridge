// background.ts — service worker, handles CDP fallback for gesture-gated actions
// Receives messages from recorder.ts via chrome.runtime.sendMessage

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'cdp') return;

  // Get the active tab to attach the debugger
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    const tabId = tab.id;

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params ?? {});
      await chrome.debugger.detach({ tabId });
      sendResponse({ ok: true });
    } catch (err) {
      console.error('[pplx-bridge background] CDP error:', err);
      sendResponse({ ok: false, error: String(err) });
    }
  });

  return true; // keep message channel open for async response
});
