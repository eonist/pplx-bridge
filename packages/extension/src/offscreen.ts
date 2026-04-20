// offscreen.ts — persistent WebSocket host
// Offscreen documents are regular pages: Chrome does NOT apply the 30s SW kill timer.

const PROBE_PORTS   = [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009];
const FALLBACK_PORT = 7001;

let actWs:    WebSocket | null = null;
let streamWs: WebSocket | null = null;
let resolvedPort: number | null = null;

// ── Port discovery via /health ────────────────────────────────────────────────

interface HealthResponse {
  port: number;
  targetUrl?: string;
  cdp: boolean;
}

async function probePort(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return await res.json() as HealthResponse;
  } catch {
    return null;
  }
}

async function getTabUrl(tabId: number): Promise<string> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getTabId' }, (res) => {
      // We already have tabId — just get the URL via chrome.tabs.get
      chrome.tabs.get(tabId, (tab) => resolve(tab?.url ?? ''));
    });
  });
}

async function resolveRelayPort(tabId: number | null): Promise<number> {
  const tabUrl = tabId ? await new Promise<string>((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(tab?.url ?? ''));
  }) : '';

  // Retry until relay is up and URL matches (handles relay not yet connected at boot)
  for (let attempt = 0; attempt < 10; attempt++) {
    const results = await Promise.all(PROBE_PORTS.map(p => probePort(p)));

    // Exact URL match
    for (const health of results) {
      if (health?.targetUrl && tabUrl && health.targetUrl === tabUrl) {
        console.log(`[offscreen] matched relay port ${health.port} for ${tabUrl}`);
        return health.port;
      }
    }

    // Prefix match (handles query-string drift)
    for (const health of results) {
      if (health?.targetUrl && tabUrl && tabUrl.startsWith(health.targetUrl.split('?')[0])) {
        console.log(`[offscreen] prefix-matched relay port ${health.port} for ${tabUrl}`);
        return health.port;
      }
    }

    if (attempt < 9) {
      console.log(`[offscreen] no URL match yet (attempt ${attempt + 1}/10) — retrying in 500ms`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Fallback: first responding port
  const results = await Promise.all(PROBE_PORTS.map(p => probePort(p)));
  const first = results.find(h => h !== null);
  if (first) {
    console.warn(`[offscreen] no URL match — falling back to port ${first.port}`);
    return first.port;
  }

  console.warn(`[offscreen] no relay found — falling back to port ${FALLBACK_PORT}`);
  return FALLBACK_PORT;
}

// ── WebSocket connections ─────────────────────────────────────────────────────

function connectActions(relay: string) {
  actWs = new WebSocket(`${relay}/actions`);
  actWs.onopen = () => {
    actWs!.send(JSON.stringify({ register: 'extension' }));
    console.log('[offscreen] actions WS connected to', relay);
  };
  actWs.onmessage = (msg) => {
    // Actions flow relay → CDP directly now; no need to forward to background
    void msg;
  };
  actWs.onclose = () => {
    console.warn('[offscreen] actions WS closed — reconnecting in 1s');
    setTimeout(() => connectActions(relay), 1000);
  };
  actWs.onerror = () => console.error('[offscreen] actions WS error');
}

function connectStream(relay: string) {
  streamWs = new WebSocket(`${relay}/stream/push`);
  streamWs.onopen  = () => console.log('[offscreen] stream WS connected to', relay);
  streamWs.onclose = () => {
    console.warn('[offscreen] stream WS closed — reconnecting in 1s');
    setTimeout(() => connectStream(relay), 1000);
  };
  streamWs.onerror = () => console.error('[offscreen] stream WS error');
}

// Receive JPEG frames from background SW and push to relay
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'frame' && streamWs?.readyState === WebSocket.OPEN) {
    streamWs.send(msg.data as ArrayBuffer);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(tabId: number | null) {
  const port  = await resolveRelayPort(tabId);
  resolvedPort = port;
  const relay = `ws://localhost:${port}`;
  connectActions(relay);
  connectStream(relay);
}

// Listen for tabId from background (sent on extension icon click)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'init' && typeof msg.tabId === 'number') {
    if (resolvedPort === null) boot(msg.tabId as number);
  }
});

// On first load, request tabId from background in case init message was missed
(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'getTabId' }) as { tabId: number | null };
  if (resolvedPort === null) boot(res?.tabId ?? null);
})();
