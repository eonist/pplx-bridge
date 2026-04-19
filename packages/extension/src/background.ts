// src/background.ts — service worker (CDP only; WebSockets live in offscreen.ts)
const FPS     = 1;   // Chrome quota: MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2
const QUALITY = 0.6;

let capturing       = false;
let intervalId      = 0;
let capturing_frame = false;
let debugTabId: number | null = null;

// ── CDP via chrome.debugger ───────────────────────────────────────────────────
async function cdpAttach(tabId: number) {
  await chrome.debugger.attach({ tabId }, '1.3');
  debugTabId = tabId;
  console.log('[bg] debugger attached to tab', tabId);
}

async function cdpDetach() {
  if (debugTabId === null) return;
  try { await chrome.debugger.detach({ tabId: debugTabId }); } catch {}
  console.log('[bg] debugger detached from tab', debugTabId);
  debugTabId = null;
}

function cdpSend(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (debugTabId === null) return Promise.reject(new Error('debugger not attached'));
  return chrome.debugger.sendCommand({ tabId: debugTabId }, method, params);
}

// Convert normalised 0-1 coords to real viewport pixels via CDP Page.getLayoutMetrics
async function resolveCoords(nx: number, ny: number): Promise<{ x: number; y: number }> {
  const layout = await cdpSend('Page.getLayoutMetrics') as Record<string, Record<string, number>>;
  const vp = layout.cssVisualViewport ?? layout.cssLayoutViewport;
  const w = vp?.clientWidth  ?? 1280;
  const h = vp?.clientHeight ?? 800;
  return { x: Math.round(nx * w), y: Math.round(ny * h) };
}

// ── Action handler ────────────────────────────────────────────────────────────
async function handleAction(action: Record<string, unknown>) {
  const type = action.type as string;

  if (type === 'mousemove') {
    const { x, y } = await resolveCoords(action.x as number, action.y as number);
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    return;
  }

  if (type === 'click') {
    const { x, y } = await resolveCoords(action.x as number, action.y as number);
    await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    console.log('[bg] CDP click at', x, y);
    return;
  }

  if (type === 'type') {
    const text = action.value as string;
    await cdpSend('Input.insertText', { text });
    return;
  }

  if (type === 'keydown') {
    const key = action.key as string;
    // Skip bare modifier keys — CDP rejects them and crashes the SW
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(key)) return;
    const code      = action.code     as string;
    const shift     = (action.shiftKey as boolean) ?? false;
    const ctrl      = (action.ctrlKey  as boolean) ?? false;
    const meta      = (action.metaKey  as boolean) ?? false;
    const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key, code, modifiers, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
    return;
  }

  if (type === 'scroll') {
    const { x, y } = await resolveCoords(0.5, 0.5);
    const deltaX = (action.x as number) * 120;
    const deltaY = (action.y as number) * 120;
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return;
  }
}

// ── Message listener: actions from offscreen, frames outbound ─────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'action') {
    let action: Record<string, unknown>;
    try { action = JSON.parse(msg.payload as string); } catch { sendResponse({ ok: false }); return; }
    if (action.type !== 'mousemove') console.log('[bg] action:', action.type, action);
    handleAction(action)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => { console.error('[bg] handleAction error:', err); sendResponse({ ok: false }); });
    return true; // keep channel open for async response
  }
});

// ── Main click handler ────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) { stopCapture(); return; }
  if (!tab.id || !tab.windowId) return;
  const tabId    = tab.id;
  const windowId = tab.windowId;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // 1. Attach debugger
  try {
    await cdpAttach(tabId);
  } catch (err) {
    console.error('[bg] debugger attach failed:', err);
    stopCapture();
    return;
  }

  // 2. Create offscreen document — owns WebSocket connections persistently
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

  // 3. Frame capture loop — 1 fps to stay under Chrome quota (max 2/sec)
  intervalId = setInterval(async () => {
    if (!capturing) return;
    if (capturing_frame) return;
    capturing_frame = true;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format:  'jpeg',
        quality: Math.round(QUALITY * 100),
      });
      chrome.runtime.sendMessage({ type: 'frame', data: dataUrlToBuffer(dataUrl) })
        .catch(() => {});
    } catch (err) {
      console.warn('[bg] captureVisibleTab error:', err);
    } finally {
      capturing_frame = false;
    }
  }, Math.round(1000 / FPS)) as unknown as number;
});

function stopCapture() {
  capturing       = false;
  capturing_frame = false;
  clearInterval(intervalId);
  cdpDetach();
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
