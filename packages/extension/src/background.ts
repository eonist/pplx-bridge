// background.ts — MV3 service worker
// CDP fallback for gesture-gated actions (file upload, trusted clicks, etc.)
// Keeps the debugger session open between calls to reduce attach/detach overhead.

interface CdpMessage {
  type: 'cdp';
  method: string;
  params?: Record<string, unknown>;
}

// Track which tabs we have the debugger attached to
const attached = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
}

// Detach on tab removal to avoid orphaned debugger sessions
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attached.has(tabId)) return;
  chrome.debugger.detach({ tabId }).catch(() => {});
  attached.delete(tabId);
});

chrome.runtime.onMessage.addListener(
  (msg: CdpMessage, _sender, sendResponse) => {
    if (msg.type !== 'cdp') return false;

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); return; }

      try {
        await ensureAttached(tabId);
        const result = await chrome.debugger.sendCommand(
          { tabId },
          msg.method,
          msg.params ?? {},
        );
        sendResponse({ ok: true, result });
      } catch (err) {
        console.error('[pplx-bridge background] CDP error:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    });

    return true; // keep channel open for async sendResponse
  },
);
