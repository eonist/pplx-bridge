// background.ts — MV3 service worker
// Handles CDP fallback for gesture-gated actions (file upload, clipboard, etc.)
// chrome.debugger requires the "debugger" manifest permission.

chrome.runtime.onMessage.addListener(
  (msg: { type: string; method: string; params?: Record<string, unknown> }, _sender, sendResponse) => {
    if (msg.type !== 'cdp') return false;

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); return; }

      try {
        // Attach may throw if already attached — swallow and continue
        try { await chrome.debugger.attach({ tabId }, '1.3'); } catch { /* already attached */ }

        await chrome.debugger.sendCommand({ tabId }, msg.method, msg.params ?? {});

        // Detach only if we attached; safe to always try
        try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }

        sendResponse({ ok: true });
      } catch (err) {
        console.error('[pplx-bridge background] CDP error:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    });

    return true; // keep channel open for async response
  },
);
