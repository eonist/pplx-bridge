// src/background.ts — service worker
const RELAY   = 'ws://localhost:7001';
const FPS     = 4;           // 4 fps stays well under Chrome's capture quota
const QUALITY = 0.6;
const SCROLL_MULTIPLIER = 12;

let capturing   = false;
let intervalId  = 0;
let keepAliveId = 0;
let capturing_frame = false; // busy-guard: skip if previous capture still in flight
let streamWs: WebSocket | null = null;
let actWs:    WebSocket | null = null;

chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) { stopCapture(); return; }
  if (!tab.id || !tab.windowId) return;
  const tabId    = tab.id;
  const windowId = tab.windowId;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // ── 1. Keep-alive first ──────────────────────────────────────────────────
  keepAliveId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => { /* keep SW alive */ });
  }, 20_000) as unknown as number;

  // ── 2. Actions WS ────────────────────────────────────────────────────────
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
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world:  'MAIN',
        func:   injectAction,
        args:   [action],
      });
      if (action.type === 'click') console.log('[bg] click result:', JSON.stringify(result));
    } catch (err) {
      console.error('[bg] executeScript error:', err);
    }
  };
  actWs.onclose = () => console.warn('[bg] actions WS closed');

  // ── 3. Stream WS ─────────────────────────────────────────────────────────
  streamWs = new WebSocket(`${RELAY}/stream/push`);
  await new Promise<void>((resolve, reject) => {
    streamWs!.onopen  = () => { console.log('[bg] stream WS connected'); resolve(); };
    streamWs!.onerror = () => reject(new Error('stream WS failed'));
  });

  // ── 4. Frame loop ─────────────────────────────────────────────────────────
  intervalId = setInterval(async () => {
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) { stopCapture(); return; }
    if (capturing_frame) return; // skip if last capture still pending
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
  capturing = false;
  capturing_frame = false;
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

// ── Injector (runs inside page context via executeScript) ─────────────────
function injectAction(action: Record<string, unknown>) {
  const SCROLL_MULTIPLIER = 12;
  const type = action.type as string;

  function fireClick(el: Element, x: number, y: number) {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerover',  { ...opts, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover',  opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousemove',  opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown',  opts));
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup',   opts));
    el.dispatchEvent(new MouseEvent('click',     opts));
  }

  if (type === 'mousemove') {
    const x  = (action.x as number) * window.innerWidth;
    const y  = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(x, y);
    if (el) {
      const opts = { bubbles: true, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
    }
    return;
  }

  if (type === 'click') {
    const x  = (action.x as number) * window.innerWidth;
    const y  = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(x, y);
    if (!el) return `no element at (${x.toFixed(0)}, ${y.toFixed(0)})`;
    fireClick(el, x, y);
    return `clicked ${el.tagName} #${el.id} .${[...el.classList].join(' ')}`;
  }

  if (type === 'type') {
    const char = action.value as string;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return 'no active element';
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const proto  = active instanceof HTMLInputElement
        ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(active, active.value + char);
      active.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (active.isContentEditable) {
      active.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(active);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand('insertText', false, char);
    }
    return;
  }

  if (type === 'keydown') {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    const init: KeyboardEventInit = {
      key:      action.key      as string,
      code:     action.code     as string,
      shiftKey: (action.shiftKey as boolean) ?? false,
      ctrlKey:  (action.ctrlKey  as boolean) ?? false,
      metaKey:  (action.metaKey  as boolean) ?? false,
      bubbles: true, cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup',   init));
    if (action.key === 'Enter') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.form?.requestSubmit();
      } else if (el.isContentEditable) {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[type="submit"], button[aria-label*="ubmit"], button[data-testid*="submit"]'
        );
        btn?.click();
      }
    }
    if (action.key === 'Backspace') {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto  = el instanceof HTMLInputElement
          ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, el.value.slice(0, -1));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else if (el.isContentEditable) {
        document.execCommand('delete', false);
      }
    }
    return;
  }

  if (type === 'scroll') {
    const dx = (action.x as number) * SCROLL_MULTIPLIER;
    const dy = (action.y as number) * SCROLL_MULTIPLIER;
    window.scrollBy(dx, dy);
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) as HTMLElement | null;
    el?.scrollBy?.(dx, dy);
  }
}
