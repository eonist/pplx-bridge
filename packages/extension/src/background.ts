// src/background.ts — service worker
// Extension no longer owns CDP. The relay owns the CDP session for each tab.
// Extension responsibility: capture frames via chrome.tabs.captureVisibleTab and
// push them to the relay via /stream/push. Actions flow relay → offscreen → (ignored,
// relay dispatches input via CDP directly).

const FPS     = 5;
const QUALITY = 60;

let capturing       = false;
let intervalId      = 0;
let capturing_frame = false;
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

  // Frame capture via captureVisibleTab — no CDP, no debugger ownership conflict
  intervalId = setInterval(async () => {
    if (!capturing || capturing_frame || captureTabId === null) return;
    capturing_frame = true;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ quality: QUALITY });
      const buf = dataUrlToBuffer(dataUrl);
      chrome.runtime.sendMessage({ type: 'frame', data: buf }).catch(() => {});
    } catch (err) {
      console.warn('[bg] captureVisibleTab error:', (err as Error).message);
    } finally {
      capturing_frame = false;
    }
  }, Math.round(1000 / FPS)) as unknown as number;
});

// Respond to offscreen requesting tabId after it boots
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getTabId') {
    sendResponse({ tabId: captureTabId });
    return true;
  }
});

function stopCapture() {
  capturing       = false;
  capturing_frame = false;
  captureTabId    = null;
  clearInterval(intervalId);
  (chrome.offscreen as any).closeDocument?.().catch(() => {});
  console.log('[bg] capture stopped');
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}
