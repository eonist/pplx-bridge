// recorder.ts — injected as content script on perplexity.ai
import * as rrweb from 'rrweb';

const RELAY_INGEST  = 'ws://localhost:7000/ingest';
const RELAY_ACTIONS = 'ws://localhost:7000/actions';

let ingestWs: WebSocket;
let actionsWs: WebSocket;

function connect() {
  // --- Ingest: push rrweb events to relay ---
  ingestWs = new WebSocket(RELAY_INGEST);

  ingestWs.onopen = () => {
    console.log('[pplx-bridge] recorder connected to relay');
    rrweb.record({
      emit(event) {
        if (ingestWs.readyState === WebSocket.OPEN) {
          ingestWs.send(JSON.stringify(event));
        }
      },
      // Options for rich fidelity on pplx.ai
      inlineStylesheet: true,
      collectFonts: true,
      recordShadowDOM: true,
      recordCanvas: true,
      // Inline images to avoid cross-origin 404s in viewer
      // set to false and use relay asset proxy if bandwidth is a concern
      inlineImages: false,
    });
  };

  ingestWs.onclose = () => {
    console.warn('[pplx-bridge] ingest WS closed — reconnecting in 2s');
    setTimeout(connect, 2000);
  };

  // --- Actions: receive action frames from relay, execute on real DOM ---
  actionsWs = new WebSocket(RELAY_ACTIONS);

  actionsWs.onmessage = (msg: MessageEvent) => {
    const act = JSON.parse(msg.data as string) as ActionFrame;
    executeAction(act);
  };
}

type ActionFrame =
  | { type: 'click';  id: number; offsetX?: number; offsetY?: number; testId?: string | null; ariaLabel?: string | null }
  | { type: 'input';  id: number; value: string }
  | { type: 'scroll'; id: number; x: number; y: number }
  | { type: 'cdp';    method: string; params: Record<string, unknown> };

function resolveNode(id: number, testId?: string | null, ariaLabel?: string | null): Element | null {
  // Primary: rrweb mirror
  const mirror = (rrweb.record as unknown as { mirror: { getNode(id: number): Node | null } }).mirror;
  const node = mirror?.getNode(id);
  if (node instanceof Element) return node;

  // Fallback: stable attributes (M4 — stale id recovery)
  if (testId) {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (el) { console.warn('[pplx-bridge] stale id, resolved by data-testid:', testId); return el; }
  }
  if (ariaLabel) {
    const el = document.querySelector(`[aria-label="${ariaLabel}"]`);
    if (el) { console.warn('[pplx-bridge] stale id, resolved by aria-label:', ariaLabel); return el; }
  }

  console.error('[pplx-bridge] could not resolve node for id:', id);
  return null;
}

function executeAction(act: ActionFrame) {
  if (act.type === 'cdp') {
    // Forwarded to background.ts via chrome.runtime.sendMessage
    chrome.runtime.sendMessage({ type: 'cdp', method: act.method, params: act.params });
    return;
  }

  const node = resolveNode(
    act.id,
    act.type === 'click' ? act.testId : null,
    act.type === 'click' ? act.ariaLabel : null,
  );
  if (!node) return;

  switch (act.type) {
    case 'click':
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      break;

    case 'input': {
      (node as HTMLElement).focus();
      // Use insertText InputEvent so React controlled inputs don't wipe the value
      node.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: act.value, bubbles: true, cancelable: true }));
      node.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: act.value, bubbles: true }));
      break;
    }

    case 'scroll':
      (node as Element).scrollTo(act.x, act.y);
      break;
  }
}

connect();
