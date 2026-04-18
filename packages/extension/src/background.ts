// src/background.ts — service worker
const RELAY   = 'ws://localhost:7001';
const FPS     = 4;
const QUALITY = 0.6;

let capturing       = false;
let intervalId      = 0;
let keepAliveId     = 0;
let capturing_frame = false;
let streamWs: WebSocket | null = null;
let actWs:    WebSocket | null = null;
let debugTabId: number | null  = null;

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

// Convert normalised 0-1 coords → real pixels using tab dimensions
async function resolveCoords(nx: number, ny: number): Promise<{ x: number; y: number }> {
  if (debugTabId === null) return { x: nx, y: ny };
  const tab = await chrome.tabs.get(debugTabId);
  const w = tab.width  ?? 1280;
  const h = tab.height ?? 800;
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
    const key     = action.key     as string;
    const code    = action.code    as string;
    const shift   = (action.shiftKey as boolean) ?? false;
    const ctrl    = (action.ctrlKey  as boolean) ?? false;
    const meta    = (action.metaKey  as boolean) ?? false;
    // CDP modifiers bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8
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

// ── Main click handler ────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) { stopCapture(); return; }
  if (!tab.id || !tab.windowId) return;
  const tabId    = tab.id;
  const windowId = tab.windowId;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // 1. Keep-alive
  keepAliveId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20_000) as unknown as number;

  // 2. Attach debugger (trusted input)
  try {
    await cdpAttach(tabId);
  } catch (err) {
    console.error('[bg] debugger attach failed:', err);
    stopCapture();
    return;
  }

  // 3. Actions WS
  actWs = new WebSocket(`${RELAY}/actions`);
  await new Promise<void>((resolve) => {
    actWs!.onopen = () => {
      actWs!.send(JSON.stringify({ register: 'extension' }));
      console.log('[bg] actions WS connected');
      resolve();
    };
    actWs!.onerror = () => { console.error('[bg] actions WS error'); resolve(); };
  });

  actWs.onmessage = async (msg) => {
    let action: Record<string, unknown>;
    try { action = JSON.parse(msg.data); } catch { return; }
    if (action.type !== 'mousemove') console.log('[bg] action:', action.type, action);
    try {
      await handleAction(action);
    } catch (err) {
      console.error('[bg] handleAction error:', err);
    }
  };
  actWs.onclose = () => console.warn('[bg] actions WS closed');

  // 4. Stream WS
  streamWs = new WebSocket(`${RELAY}/stream/push`);
  await new Promise<void>((resolve, reject) => {
    streamWs!.onopen  = () => { console.log('[bg] stream WS connected'); resolve(); };
    streamWs!.onerror = () => reject(new Error('stream WS failed'));
  });

  // 5. Frame loop
  intervalId = setInterval(async () => {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) { stopCapture(); return; }
    if (capturing_frame) return;
    capturing_frame = true;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format:  'jpeg',
        quality: Math.round(QUALITY * 100),
      });
      if (streamWs.readyState === WebSocket.OPEN) streamWs.send(dataUrlToBuffer(dataUrl));
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
  clearInterval(keepAliveId);
  streamWs?.close();
  actWs?.close();
  streamWs = null;
  actWs    = null;
  cdpDetach();
  console.log('[bg] capture stopped');
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}
