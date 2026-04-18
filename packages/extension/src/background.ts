// background.ts — service worker
const RELAY   = 'ws://localhost:7001';
const FPS     = 8;
const QUALITY = 0.6;
const SCROLL_MULTIPLIER = 12; // wheel deltaY is tiny — scale up

let capturing   = false;
let intervalId  = 0;
let keepAliveId = 0;
let streamWs: WebSocket | null = null;
let actWs: WebSocket | null = null;

chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) { stopCapture(); return; }
  if (!tab.id || !tab.windowId) return;
  const tabId    = tab.id;
  const windowId = tab.windowId;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // ── 1. Stream WS ──────────────────────────────────────────────────────
  streamWs = new WebSocket(`${RELAY}/stream/push`);
  await new Promise<void>((resolve, reject) => {
    streamWs!.onopen  = () => resolve();
    streamWs!.onerror = () => reject(new Error('stream WS failed'));
  });
  console.log('[bg] stream WS connected');

  // ── 2. Frame loop ─────────────────────────────────────────────────────
  intervalId = setInterval(async () => {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) { stopCapture(); return; }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'jpeg',
        quality: Math.round(QUALITY * 100),
      });
      if (streamWs.readyState === WebSocket.OPEN) streamWs.send(dataUrlToBuffer(dataUrl));
    } catch (err) {
      console.warn('[bg] captureVisibleTab error:', err);
    }
  }, Math.round(1000 / FPS)) as unknown as number;

  // ── 3. Actions WS ─────────────────────────────────────────────────────
  actWs = new WebSocket(`${RELAY}/actions`);
  actWs.onopen = () => {
    actWs!.send(JSON.stringify({ register: 'extension' }));
    console.log('[bg] actions WS connected');
  };
  actWs.onmessage = async (msg) => {
    let action: Record<string, unknown>;
    try { action = JSON.parse(msg.data); } catch { return; }
    if (action.type !== 'mousemove') console.log('[bg] action:', action.type, action);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: injectAction,
        args: [action],
      });
      if (action.type === 'click') console.log('[bg] executeScript result:', JSON.stringify(result));
    } catch (err) {
      console.error('[bg] executeScript error:', err);
    }
  };
  actWs.onclose = () => { console.warn('[bg] actions WS closed'); };

  // ── 4. Keep-alive: chrome.runtime.getPlatformInfo every 20s ───────────
  // MV3 service workers idle-kill after ~30s; this prevents that.
  keepAliveId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* keep SW alive */ });
  }, 20_000) as unknown as number;
});

function stopCapture() {
  capturing = false;
  clearInterval(intervalId);
  clearInterval(keepAliveId);
  streamWs?.close();
  actWs?.close();
  streamWs = null;
  actWs    = null;
  console.log('[bg] capture stopped');
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// ── Injector (runs inside page context via executeScript) ──────────────────
function injectAction(action: Record<string, unknown>) {
  const SCROLL_MULTIPLIER = 12;
  const type = action.type as string;

  if (type === 'click' || type === 'mousemove') {
    const x  = (action.x as number) * window.innerWidth;
    const y  = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return `no element at (${x.toFixed(0)}, ${y.toFixed(0)})`;
    if (type === 'click') {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return `clicked ${el.tagName} #${el.id} .${el.className}`;
    } else {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    }
    return;
  }

  if (type === 'type') {
    const char = action.value as string;
    const el   = document.activeElement as HTMLElement | null;
    if (!el) return 'no active element';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto  = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      // Append character to current value (don't replace)
      setter?.call(el, el.value + char);
      el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: char, inputType: 'insertText' }));
    } else if ((el as HTMLElement).isContentEditable) {
      el.focus();
      document.execCommand('insertText', false, char);
    }
    return;
  }

  if (type === 'keydown') {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    const init: KeyboardEventInit = {
      key: action.key as string, code: action.code as string,
      shiftKey: (action.shiftKey as boolean) ?? false,
      ctrlKey:  (action.ctrlKey  as boolean) ?? false,
      metaKey:  (action.metaKey  as boolean) ?? false,
      bubbles: true, cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup',   init));
    // Handle Enter/Backspace natively on inputs
    if (action.key === 'Enter' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      el.form?.requestSubmit();
    }
    if (action.key === 'Backspace' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      const proto  = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, el.value.slice(0, -1));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
    return;
  }

  if (type === 'scroll') {
    const dx = (action.x as number) * SCROLL_MULTIPLIER;
    const dy = (action.y as number) * SCROLL_MULTIPLIER;
    window.scrollBy(dx, dy);
    // Also try scrolling the element under centre
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) as HTMLElement | null;
    el?.scrollBy?.(dx, dy);
  }
}
