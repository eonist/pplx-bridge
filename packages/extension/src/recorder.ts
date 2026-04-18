// recorder.ts — MV3 content script on perplexity.ai
// WebSockets live in the background service worker (exempt from PNA).
// This script records via rrweb and shuttles events through a chrome.runtime port.
import { record } from 'rrweb';
import type { Mirror } from 'rrweb-snapshot';

type ActionFrame =
  | { type: 'click';   id: number; offsetX?: number; offsetY?: number; testId?: string | null; ariaLabel?: string | null; role?: string | null; text?: string | null }
  | { type: 'input';   id: number; value: string }
  | { type: 'keydown'; id: number; key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
  | { type: 'scroll';  id: number; x: number; y: number }
  | { type: 'cdp';     method: string; params: Record<string, unknown> };

let rrwebMirror: Mirror | null = null;

function resolveNode(id: number, testId?: string | null, ariaLabel?: string | null, role?: string | null, text?: string | null): Element | null {
  const node = rrwebMirror?.getNode(id);
  if (node instanceof Element) return node;

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

function executeAction(act: ActionFrame): void {
  if (act.type === 'cdp') {
    chrome.runtime.sendMessage({ type: 'cdp', method: act.method, params: act.params });
    return;
  }

  const node = resolveNode(
    act.id,
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

    case 'input': {
      const el = node as HTMLElement;
      el.focus();
      if (el.isContentEditable) {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, act.value);
      } else {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        nativeSetter?.call(input, act.value);
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      break;
    }

    case 'keydown': {
      const el = node as HTMLElement;
      el.focus();
      for (const type of ['keydown', 'keyup'] as const) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: act.key, code: act.code, bubbles: true, cancelable: true,
          shiftKey: act.shiftKey, ctrlKey: act.ctrlKey, metaKey: act.metaKey,
        }));
      }
      break;
    }

    case 'scroll':
      (node as Element).scrollTo(act.x, act.y);
      break;
  }
}

function startRecorder(): void {
  // Connect to the background service worker which owns the WebSockets.
  // The background SW is an extension context and is not subject to PNA.
  const port = chrome.runtime.connect({ name: 'pplx-recorder' });

  // Receive action frames forwarded from the relay via the background SW
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

  // Start rrweb recording; emit each event through the port to the background SW
  const stop = record({
    emit(event) {
      port.postMessage({ type: 'rrweb', data: JSON.stringify(event) });
    },
    inlineStylesheet: true,
    collectFonts:     true,
    recordShadowDOM:  true,
    recordCanvas:     false,   // disabled: causes makeProxy crash on screen.height in MV3
    inlineImages:     false,
    slimDOMOptions: {
      script: true, comment: true, headFavicon: true, headWhitespace: true,
      headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true,
    },
  });

  rrwebMirror = (record as unknown as { mirror: Mirror }).mirror;

  console.log('[pplx-bridge] recorder started → events piped via background SW');

  // Clean up rrweb when the port dies
  port.onDisconnect.addListener(() => stop?.());
}

startRecorder();
