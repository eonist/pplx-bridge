// recorder.ts — MV3 content script on perplexity.ai
// WebSockets live in the background service worker (exempt from PNA).
// This script records via rrweb and shuttles events through a chrome.runtime port.
import { record } from 'rrweb';
import type { Mirror } from 'rrweb-snapshot';

type ActionFrame =
  | { type: 'click';   id: number; offsetX?: number; offsetY?: number; testId?: string | null; ariaLabel?: string | null; role?: string | null; text?: string | null }
  | { type: 'type';    id: number; value: string }   // full string to set on element
  | { type: 'input';   id: number; value: string }   // legacy alias for type
  | { type: 'keydown'; id: number | null; key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
  | { type: 'scroll';  id: number; x: number; y: number }
  | { type: 'cdp';     method: string; params: Record<string, unknown> };

let rrwebMirror: Mirror | null = null;

function resolveNode(id: number | null, testId?: string | null, ariaLabel?: string | null, role?: string | null, text?: string | null): Element | null {
  if (id !== null) {
    const node = rrwebMirror?.getNode(id);
    if (node instanceof Element) return node;
  }

  if (testId) {
    const el = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`);
    if (el) { console.warn('[pplx-bridge] stale-id → data-testid:', testId); return el; }
  }
  if (ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(ariaLabel)}"]`);
    if (el) { console.warn('[pplx-bridge] stale-id → aria-label:', ariaLabel); return el; }
  }
  if (role && text) {
    const candidates = Array.from(document.querySelectorAll(`[role="${CSS.escape(role)}"]`));
    const match = candidates.find(el => el.textContent?.trim() === text);
    if (match) { console.warn('[pplx-bridge] stale-id → role+text:', role, text); return match; }
  }

  console.error('[pplx-bridge] cannot resolve node id:', id);
  return null;
}

// Set text on any element React-style: works for input, textarea, contenteditable.
function setNativeValue(el: HTMLElement, value: string): void {
  el.focus();

  if (el.isContentEditable) {
    // Clear and set via Selection API — works reliably in React apps
    el.textContent = '';
    const range = document.createRange();
    const sel   = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertText', false, value);
    // Fallback: if execCommand didn't work, set directly and fire events
    if (el.textContent !== value) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    }
  } else {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = Object.getPrototypeOf(input);
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function executeAction(act: ActionFrame): void {
  if (act.type === 'cdp') {
    chrome.runtime.sendMessage({ type: 'cdp', method: act.method, params: act.params });
    return;
  }

  const node = resolveNode(
    'id' in act ? act.id : null,
    act.type === 'click' ? (act.testId    ?? null) : null,
    act.type === 'click' ? (act.ariaLabel ?? null) : null,
    act.type === 'click' ? (act.role      ?? null) : null,
    act.type === 'click' ? (act.text      ?? null) : null,
  );
  if (!node) return;

  switch (act.type) {
    case 'click':
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      break;

    case 'type':
    case 'input':
      setNativeValue(node as HTMLElement, act.value);
      break;

    case 'keydown': {
      const target = (node as HTMLElement);
      target.focus();
      for (const evtType of ['keydown', 'keypress', 'keyup'] as const) {
        target.dispatchEvent(new KeyboardEvent(evtType, {
          key: act.key, code: act.code, bubbles: true, cancelable: true,
          shiftKey: act.shiftKey, ctrlKey: act.ctrlKey, metaKey: act.metaKey,
        }));
      }
      // For Enter on contenteditable / form submission
      if (act.key === 'Enter') {
        const form = target.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }
      break;
    }

    case 'scroll':
      (node as Element).scrollTo(act.x, act.y);
      break;
  }
}

function startRecorder(): void {
  const port = chrome.runtime.connect({ name: 'pplx-recorder' });

  port.onMessage.addListener((msg: { type: string; data: string }) => {
    if (msg.type === 'action') {
      try { executeAction(JSON.parse(msg.data) as ActionFrame); }
      catch (e) { console.error('[pplx-bridge] bad action frame:', e); }
    }
  });

  port.onDisconnect.addListener(() => {
    console.warn('[pplx-bridge] background port disconnected — reloading recorder in 2s');
    setTimeout(startRecorder, 2000);
  });

  const stop = record({
    emit(event) {
      port.postMessage({ type: 'rrweb', data: JSON.stringify(event) });
    },
    inlineStylesheet: true,
    collectFonts:     true,
    recordShadowDOM:  true,
    recordCanvas:     false,
    inlineImages:     false,
    slimDOMOptions: {
      script: true, comment: true, headFavicon: true, headWhitespace: true,
      headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true,
    },
  });

  rrwebMirror = (record as unknown as { mirror: Mirror }).mirror;

  console.log('[pplx-bridge] recorder started → events piped via background SW');

  port.onDisconnect.addListener(() => stop?.());
}

startRecorder();
