// offscreen.ts — persistent WebSocket host
// Offscreen documents are regular pages: Chrome does NOT apply the 30s SW kill timer.

const PROBE_PORTS  = [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009];
const FALLBACK_PORT = 7001;

let actWs:    WebSocket | null = null;
let streamWs: WebSocket | null = null;

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

async function resolveRelayPort(): Promise<number> {
  // Get the URL of the tab this offscreen doc was opened for
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = activeTab?.url ?? '';

  const results = await Promise.all(PROBE_PORTS.map(p => probePort(p)));

  // Exact URL match first
  for (const health of results) {
    if (health?.targetUrl && tabUrl && health.targetUrl === tabUrl) {
      console.log(`[offscreen] matched relay port ${health.port} for ${tabUrl}`);
      return health.port;
    }
  }

  // Prefix match (handles query-string drift after navigation)
  for (const health of results) {
    if (health?.targetUrl && tabUrl && tabUrl.startsWith(health.targetUrl.split('?')[0])) {
      console.log(`[offscreen] prefix-matched relay port ${health.port} for ${tabUrl}`);
      return health.port;
    }
  }

  // Fallback: first responding port
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
    chrome.runtime.sendMessage({ type: 'action', payload: msg.data })
      .catch(() => {});
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

(async () => {
  const port  = await resolveRelayPort();
  const relay = `ws://localhost:${port}`;
  connectActions(relay);
  connectStream(relay);
})();
