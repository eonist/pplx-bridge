// background.ts — service worker
// Uses chrome.tabs.captureVisibleTab() which IS available in MV3 service workers.
// Polls at FPS interval, encodes each frame as JPEG, sends binary to relay /stream/push.
// Also opens /actions WS and injects received actions into the target tab.

const RELAY   = 'ws://localhost:7001';
const FPS     = 8;
const QUALITY = 0.6;

let capturing  = false;
let intervalId = 0;
let streamWs: WebSocket | null = null;
let actWs: WebSocket | null = null;

chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) {
    // Second click = stop
    stopCapture();
    return;
  }
  if (!tab.id || !tab.windowId) return;
  const tabId    = tab.id;
  const windowId = tab.windowId;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // ── 1. Open stream WS ──────────────────────────────────────────────────
  streamWs = new WebSocket(`${RELAY}/stream/push`);
  await new Promise<void>((resolve, reject) => {
    streamWs!.onopen  = () => resolve();
    streamWs!.onerror = () => reject(new Error('stream WS failed'));
  });
  console.log('[bg] stream WS connected');

  // ── 2. Frame loop via captureVisibleTab ───────────────────────────────
  // captureVisibleTab returns a data URL (jpeg); we convert to binary ArrayBuffer.
  intervalId = setInterval(async () => {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
      stopCapture();
      return;
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg',
        quality: Math.round(QUALITY * 100),
      });
      // Convert data URL to ArrayBuffer and send
      const binary = dataUrlToBuffer(dataUrl);
      if (streamWs.readyState === WebSocket.OPEN) streamWs.send(binary);
    } catch (err) {
      console.warn('[bg] captureVisibleTab error:', err);
    }
  }, Math.round(1000 / FPS)) as unknown as number;

  // ── 3. Actions WS ─────────────────────────────────────────────────────
  actWs = new WebSocket(`${RELAY}/actions`);
  actWs.onopen = () => {
    actWs!.send(JSON.stringify({ register: 'extension' }));
    console.log('[bg] actions WS connected, registered as extension');
  };
  actWs.onmessage = async (msg) => {
    let action: Record<string, unknown>;
    try { action = JSON.parse(msg.data); } catch { return; }
    console.log('[bg] action received:', action);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: injectAction,
        args: [action],
      });
    } catch (err) {
      console.error('[bg] executeScript error:', err);
    }
  };
  actWs.onclose = () => console.warn('[bg] actions WS closed');
});

function stopCapture() {
  capturing = false;
  clearInterval(intervalId);
  streamWs?.close();
  actWs?.close();
  streamWs = null;
  actWs    = null;
  console.log('[bg] capture stopped');
}

// Convert a JPEG data URL to an ArrayBuffer
function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// ── Injector (serialised into page context via executeScript) ──────────────────
function injectAction(action: Record<string, unknown>) {
  const type = action.type as string;

  if (type === 'click' || type === 'mousemove') {
    const x = (action.x as number) * window.innerWidth;
    const y = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return;
    if (type === 'click') {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    } else {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    }
    return;
  }

  if (type === 'type') {
    const value = action.value as string;
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto  = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new InputEvent('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, value);
    }
    return;
  }

  if (type === 'keydown') {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    const init: KeyboardEventInit = {
      key:        action.key      as string,
      code:       action.code     as string,
      shiftKey:   (action.shiftKey as boolean) ?? false,
      ctrlKey:    (action.ctrlKey  as boolean) ?? false,
      metaKey:    (action.metaKey  as boolean) ?? false,
      bubbles:    true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup',   init));
    return;
  }

  if (type === 'scroll') {
    window.scrollBy(action.x as number, action.y as number);
  }
}
