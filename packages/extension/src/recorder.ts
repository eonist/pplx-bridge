// recorder.ts — MV3 content script on perplexity.ai
// Bundled by esbuild into dist/recorder.js (IIFE)
import { record } from 'rrweb';
import type { Mirror } from 'rrweb-snapshot';

const RELAY_INGEST  = 'ws://localhost:7000/ingest';
const RELAY_ACTIONS = 'ws://localhost:7000/actions';

type ActionFrame =
  | { type: 'click';   id: number; offsetX?: number; offsetY?: number; testId?: string | null; ariaLabel?: string | null; role?: string | null; text?: string | null }
  | { type: 'input';   id: number; value: string }
  | { type: 'keydown'; id: number; key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
  | { type: 'scroll';  id: number; x: number; y: number }
  | { type: 'cdp';     method: string; params: Record<string, unknown> };

let rrwebMirror: Mirror | null = null;

// ── Node resolution ───────────────────────────────────────────────────────────
// Priority: rrweb mirror id → data-testid → aria-label → role+text heuristic
function resolveNode(
  id: number,
  testId?:    string | null,
  ariaLabel?: string | null,
  role?:      string | null,
  text?:      string | null,
): Element | null {
  // 1. Primary: rrweb mirror (fast, O(1))
  const node = rrwebMirror?.getNode(id);
  if (node instanceof Element) return node;

  // 2. Stable attribute fallbacks (M4 stale-id recovery)
  if (testId) {
    const el = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`);
    if (el) { console.warn('[pplx-bridge] stale-id → data-testid:', testId); return el; }
  }
  if (ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(ariaLabel)}"]`);
    if (el) { console.warn('[pplx-bridge] stale-id → aria-label:', ariaLabel); return el; }
  }
  // 3. Role + visible text heuristic (last resort)
  if (role && text) {
    const candidates = Array.from(document.querySelectorAll(`[role="${CSS.escape(role)}"]`));
    const match = candidates.find(el => el.textContent?.trim() === text);
    if (match) { console.warn('[pplx-bridge] stale-id → role+text:', role, text); return match; }
  }

  console.error('[pplx-bridge] cannot resolve node id:', id);
  return null;
}

// ── Action executor ───────────────────────────────────────────────────────────
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
      // Fire full mousedown → mouseup → click sequence
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      break;

    case 'input': {
      const el = node as HTMLElement;
      el.focus();
      if (el.isContentEditable) {
        // ProseMirror / Lexical (pplx.ai main composer)
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, act.value);
      } else {
        // Plain <textarea> / <input> — native setter bypasses React's wiring
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input), 'value'
        )?.set;
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
          key: act.key, code: act.code,
          bubbles: true, cancelable: true,
          shiftKey: act.shiftKey, ctrlKey: act.ctrlKey, metaKey: act.metaKey,
        }));
      }
      break;
    }

    case 'scroll':
      // Scroll the real element; mutations flow back through rrweb automatically
      (node as Element).scrollTo(act.x, act.y);
      break;
  }
}

// ── WebSocket connections ─────────────────────────────────────────────────────
function startRecorder(): void {
  function connectIngest(): void {
    const ws = new WebSocket(RELAY_INGEST);

    ws.onopen = () => {
      console.log('[pplx-bridge] ingest connected');

      const stop = record({
        emit(event) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
        },
        inlineStylesheet: true,
        collectFonts:     true,
        recordShadowDOM:  true,
        recordCanvas:     true,
        inlineImages:     false,
        // Slim down the snapshot: strip noise that bloats the stream
        // without affecting Comet's ability to read / interact with the DOM
        slimDOMOptions: {
          script:               true,
          comment:              true,
          headFavicon:          true,
          headWhitespace:       true,
          headMetaSocial:       true,
          headMetaRobots:       true,
          headMetaHttpEquiv:    true,
          headMetaVerification: true,
        },
      });

      // rrweb v2: mirror lives on the record function itself
      rrwebMirror = (record as unknown as { mirror: Mirror }).mirror;

      ws.onclose = () => {
        stop?.();
        rrwebMirror = null;
        console.warn('[pplx-bridge] ingest closed — reconnecting in 2s');
        setTimeout(connectIngest, 2000);
      };
    };

    ws.onerror = () => ws.close();
  }

  function connectActions(): void {
    const ws = new WebSocket(RELAY_ACTIONS);

    ws.onmessage = ({ data }: MessageEvent<string>) => {
      try { executeAction(JSON.parse(data) as ActionFrame); }
      catch (e) { console.error('[pplx-bridge] bad action frame:', e); }
    };

    ws.onclose = () => {
      console.warn('[pplx-bridge] actions closed — reconnecting in 2s');
      setTimeout(connectActions, 2000);
    };

    ws.onerror = () => ws.close();
  }

  connectIngest();
  connectActions();
}

startRecorder();
