// background.ts — MV3 service worker
// Owns both WebSocket connections (ingest + actions) so they run in the
// extension context, which is exempt from Chrome's Private Network Access
// (PNA) policy that blocks ws://localhost from content scripts on public origins.

const PORT         = 7001;
const RELAY_INGEST  = `ws://localhost:${PORT}/ingest`;
const RELAY_ACTIONS = `ws://localhost:${PORT}/actions`;

// ── WebSocket relay ───────────────────────────────────────────────────────────

let ingestWs:  WebSocket | null = null;
let actionsWs: WebSocket | null = null;

// tabId → port for content-script communication
const contentPorts = new Map<number, chrome.runtime.Port>();

function connectIngest(): void {
  const ws = new WebSocket(RELAY_INGEST);
  ingestWs = ws;

  ws.onopen  = () => console.log('[pplx-bridge bg] ingest connected');
  ws.onclose = () => {
    ingestWs = null;
    console.warn('[pplx-bridge bg] ingest closed — reconnecting');
    setTimeout(connectIngest, 2000);
  };
  ws.onerror = () => ws.close();
}

function connectActions(): void {
  const ws = new WebSocket(RELAY_ACTIONS);
  actionsWs = ws;

  ws.onopen = () => console.log('[pplx-bridge bg] actions connected');
  ws.onmessage = ({ data }: MessageEvent<string>) => {
    // Forward action frames to every connected content script
    for (const port of contentPorts.values()) {
      try { port.postMessage({ type: 'action', data }); } catch (_) {}
    }
  };
  ws.onclose = () => {
    actionsWs = null;
    console.warn('[pplx-bridge bg] actions closed — reconnecting');
    setTimeout(connectActions, 2000);
  };
  ws.onerror = () => ws.close();
}

connectIngest();
connectActions();

// ── Content-script port ───────────────────────────────────────────────────────
// Content script connects via chrome.runtime.connect({ name: 'pplx-recorder' })
// and sends rrweb events as { type: 'rrweb', data: <json string> }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pplx-recorder') return;

  const tabId = port.sender?.tab?.id;
  if (tabId != null) contentPorts.set(tabId, port);

  console.log(`[pplx-bridge bg] content script connected (tab ${tabId})`);

  port.onMessage.addListener((msg: { type: string; data: string }) => {
    if (msg.type === 'rrweb') {
      if (ingestWs?.readyState === WebSocket.OPEN) {
        ingestWs.send(msg.data);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId != null) contentPorts.delete(tabId);
    console.log(`[pplx-bridge bg] content script disconnected (tab ${tabId})`);
  });
});

// ── CDP fallback ──────────────────────────────────────────────────────────────

interface CdpMessage {
  type: 'cdp';
  method: string;
  params?: Record<string, unknown>;
}

const attached = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!attached.has(tabId)) return;
  chrome.debugger.detach({ tabId }).catch(() => {});
  attached.delete(tabId);
});

chrome.runtime.onMessage.addListener(
  (msg: CdpMessage, _sender, sendResponse) => {
    if (msg.type !== 'cdp') return false;

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { sendResponse({ ok: false, error: 'no active tab' }); return; }

      try {
        await ensureAttached(tabId);
        const result = await chrome.debugger.sendCommand(
          { tabId },
          msg.method,
          msg.params ?? {},
        );
        sendResponse({ ok: true, result });
      } catch (err) {
        console.error('[pplx-bridge background] CDP error:', err);
        sendResponse({ ok: false, error: String(err) });
      }
    });

    return true;
  },
);
