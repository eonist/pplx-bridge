// recorder.ts — MV3 content script on perplexity.ai
// Bundled by esbuild into dist/recorder.js (IIFE, no runtime imports)
import { record } from 'rrweb';

const RELAY_INGEST  = 'ws://localhost:7000/ingest';
const RELAY_ACTIONS = 'ws://localhost:7000/actions';

type ActionFrame =
  | { type: 'click';  id: number; offsetX?: number; offsetY?: number; testId?: string | null; ariaLabel?: string | null }
  | { type: 'input';  id: number; value: string }
  | { type: 'scroll'; id: number; x: number; y: number }
  | { type: 'cdp';    method: string; params: Record<string, unknown> };

// rrweb exposes the mirror on the stopFn returned by record().
// We keep a ref to resolve node ids in the action executor.
let rrwebMirror: { getNode(id: number): Node | null } | null = null;

function resolveNode(
  id: number,
  testId?: string | null,
  ariaLabel?: string | null,
): Element | null {
  const node = rrwebMirror?.getNode(id);
  if (node instanceof Element) return node;

  // Stale-id fallback (M4)
  if (testId) {
    const el = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`);
    if (el) { console.warn('[pplx-bridge] stale id → data-testid:', testId); return el; }
  }
  if (ariaLabel) {
    const el = document.querySelector(`[aria-label="${CSS.escape(ariaLabel)}"]`);
    if (el) { console.warn('[pplx-bridge] stale id → aria-label:', ariaLabel); return el; }
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
    act.type === 'click' ? (act.testId ?? null) : null,
    act.type === 'click' ? (act.ariaLabel ?? null) : null,
  );
  if (!node) return;

  switch (act.type) {
    case 'click':
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      break;

    case 'input': {
      const el = node as HTMLElement;
      el.focus();
      // insertText keeps React controlled inputs happy
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: act.value, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('input',       { inputType: 'insertText', data: act.value, bubbles: true }));
      break;
    }

    case 'scroll':
      (node as Element).scrollTo(act.x, act.y);
      break;
  }
}

function startRecorder(): void {
  let ingestWs: WebSocket;
  let actionsWs: WebSocket;

  function connectIngest(): void {
    ingestWs = new WebSocket(RELAY_INGEST);

    ingestWs.onopen = () => {
      console.log('[pplx-bridge] recorder → relay connected');

      const stopFn = record({
        emit(event) {
          if (ingestWs.readyState === WebSocket.OPEN) {
            ingestWs.send(JSON.stringify(event));
          }
        },
        inlineStylesheet: true,
        collectFonts:     true,
        recordShadowDOM:  true,
        recordCanvas:     true,
        inlineImages:     false, // use relay asset proxy instead
      });

      // Expose mirror via the record module's shared mirror object
      // rrweb v2 attaches mirror to the record function itself
      rrwebMirror = (record as unknown as { mirror: typeof rrwebMirror }).mirror;

      ingestWs.onclose = () => {
        stopFn?.();
        console.warn('[pplx-bridge] ingest closed — reconnecting in 2s');
        setTimeout(connectIngest, 2000);
      };
    };

    ingestWs.onerror = () => ingestWs.close();
  }

  function connectActions(): void {
    actionsWs = new WebSocket(RELAY_ACTIONS);

    actionsWs.onmessage = (msg: MessageEvent<string>) => {
      try {
        executeAction(JSON.parse(msg.data) as ActionFrame);
      } catch (e) {
        console.error('[pplx-bridge] bad action frame:', e);
      }
    };

    actionsWs.onclose = () => {
      console.warn('[pplx-bridge] actions WS closed — reconnecting in 2s');
      setTimeout(connectActions, 2000);
    };

    actionsWs.onerror = () => actionsWs.close();
  }

  connectIngest();
  connectActions();
}

startRecorder();
