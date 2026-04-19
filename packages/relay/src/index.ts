import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT     = Number(process.env.PORT ?? 7001);
const CDP_HOST = process.env.CDP_HOST ?? 'localhost';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);

const app    = express();
const server = createServer(app);

// ── CORS + static viewer ─────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');

app.use((_req, res: ServerResponse & { setHeader: (k: string, v: string) => void }, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(publicDir));
app.get('/live', (_req, res) => res.sendFile(path.join(publicDir, 'live.html')));

// ── Asset proxy ───────────────────────────────────────────────────────────────
app.get('/assets/*', async (req, res) => {
  const raw    = (req.params as Record<string, string>)[0];
  const target = decodeURIComponent(raw);
  if (!target.startsWith('https://')) { res.status(400).send('only https:// targets allowed'); return; }
  try {
    const upstream = await fetch(target, { headers: { 'User-Agent': 'pplx-bridge/0.1 asset-proxy' } });
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');
    res.removeHeader('cross-origin-resource-policy');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('[relay] asset proxy error:', err);
    res.status(502).send('proxy error');
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

// ── CDP client — connects to Chrome remote debugging port ────────────────────
interface CdpSession {
  ws:        WebSocket;
  sessionId: string;
  width:     number;
  height:    number;
}

let cdp: CdpSession | null = null;
let cdpMsgId = 1;
const cdpPending = new Map<number, (r: unknown) => void>();

async function cdpConnect(): Promise<void> {
  // Fetch the list of debuggable targets
  let targets: Array<{ type: string; webSocketDebuggerUrl?: string; url?: string; title?: string }>;
  try {
    const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
    targets = await r.json() as typeof targets;
  } catch {
    console.warn('[cdp] Chrome not reachable on port', CDP_PORT, '— will retry in 5 s');
    setTimeout(cdpConnect, 5000);
    return;
  }

  // Pick the first real page (not devtools, not extensions)
  const target = targets.find(t =>
    t.type === 'page' &&
    t.webSocketDebuggerUrl &&
    !t.url?.startsWith('chrome') &&
    !t.url?.startsWith('devtools')
  );

  if (!target?.webSocketDebuggerUrl) {
    console.warn('[cdp] no suitable page target found — will retry in 5 s');
    setTimeout(cdpConnect, 5000);
    return;
  }

  console.log(`[cdp] connecting to: ${target.title ?? target.url}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  ws.on('open', async () => {
    console.log('[cdp] ✓ connected to Chrome');
    // Get layout metrics for coord resolution
    const layout = await cdpSendRaw(ws, 'Page.getLayoutMetrics', {}) as Record<string, Record<string, number>>;
    const vp = layout.cssVisualViewport ?? layout.cssLayoutViewport ?? {};
    const width  = vp.clientWidth  ?? 1280;
    const height = vp.clientHeight ?? 800;
    cdp = { ws, sessionId: '', width, height };
    console.log(`[cdp] viewport ${width}×${height}`);
  });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const id = msg.id as number | undefined;
    if (id !== undefined) {
      const resolve = cdpPending.get(id);
      if (resolve) { cdpPending.delete(id); resolve(msg.result); }
    }
  });

  ws.on('close', () => {
    console.warn('[cdp] disconnected — reconnecting in 3 s');
    cdp = null;
    setTimeout(cdpConnect, 3000);
  });

  ws.on('error', (err) => {
    console.error('[cdp] ws error:', err.message);
  });
}

function cdpSendRaw(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    const id = cdpMsgId++;
    cdpPending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function cdpSend(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!cdp) return Promise.reject(new Error('CDP not connected'));
  return cdpSendRaw(cdp.ws, method, params);
}

function px(nx: number, ny: number): { x: number; y: number } {
  const w = cdp?.width  ?? 1280;
  const h = cdp?.height ?? 800;
  return { x: Math.round(nx * w), y: Math.round(ny * h) };
}

async function handleAction(action: Record<string, unknown>): Promise<void> {
  if (!cdp) { console.warn('[cdp] action dropped — not connected'); return; }
  const type = action.type as string;

  if (type === 'mousemove') {
    const { x, y } = px(action.x as number, action.y as number);
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    return;
  }

  if (type === 'click') {
    const { x, y } = px(action.x as number, action.y as number);
    await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    console.log('[cdp] click', x, y);
    return;
  }

  if (type === 'type') {
    await cdpSend('Input.insertText', { text: action.value as string });
    return;
  }

  if (type === 'keydown') {
    const key  = action.key as string;
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(key)) return; // bare modifiers
    const code      = action.code     as string;
    const shift     = (action.shiftKey as boolean) || false;
    const ctrl      = (action.ctrlKey  as boolean) || false;
    const meta      = (action.metaKey  as boolean) || false;
    const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key, code, modifiers });
    console.log('[cdp] key', key);
    return;
  }

  if (type === 'scroll') {
    const { x, y } = px(0.5, 0.5);
    await cdpSend('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y,
      deltaX: (action.x as number) * 120,
      deltaY: (action.y as number) * 120,
    });
  }
}

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const streamers     = new Set<WebSocket>();
const streamViewers = new Set<WebSocket>();
const actionReceivers = new Set<WebSocket>(); // kept for compat; no longer used for input

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  if (url === '/stream/push') {
    streamers.add(ws);
    console.log(`[relay] ▲ streamer connected    (total: ${streamers.size})`);
    ws.on('message', (data, isBinary) => {
      for (const v of streamViewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data, { binary: isBinary });
      }
    });
    ws.on('close', () => { streamers.delete(ws); console.log('[relay] ▼ streamer disconnected'); });

  } else if (url === '/stream') {
    streamViewers.add(ws);
    console.log(`[relay] ▲ stream-viewer connected (total: ${streamViewers.size})`);
    ws.on('close', () => { streamViewers.delete(ws); console.log('[relay] ▼ stream-viewer disconnected'); });

  } else if (url === '/actions') {
    let isExtension = false;
    ws.on('message', (raw) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw instanceof Buffer ? raw.toString() : String(raw)); } catch (_) {}

      if (parsed?.register === 'extension') {
        isExtension = true;
        actionReceivers.add(ws);
        console.log(`[relay] ▲ action-receiver (ext) connected (total: ${actionReceivers.size})`);
        return;
      }

      if (!isExtension && parsed) {
        // Inject via CDP directly — no extension SW involvement
        console.log('[relay] action →', JSON.stringify(parsed).slice(0, 80));
        handleAction(parsed).catch(err => console.error('[cdp] handleAction error:', err.message));
      }
    });

    ws.on('close', () => {
      if (isExtension) { actionReceivers.delete(ws); console.log('[relay] ▼ action-receiver (ext) disconnected'); }
    });
  }
});

server.listen(PORT, () => {
  const w = 44;
  console.log(`\n╔${'═'.repeat(w)}╗`);
  console.log(`║  pplx-bridge relay  →  localhost:${PORT}${' '.repeat(w - 28 - String(PORT).length)}║`);
  console.log(`╚${'═'.repeat(w)}╝`);
  console.log(`  Stream push  ws://localhost:${PORT}/stream/push`);
  console.log(`  Stream view  ws://localhost:${PORT}/stream`);
  console.log(`  Actions      ws://localhost:${PORT}/actions`);
  console.log(`  Viewer       http://localhost:${PORT}/live`);
  console.log(`  Health       http://localhost:${PORT}/health\n`);
  console.log(`  ⚠️  Comet → Settings → Assistant → Site access`);
  console.log(`     set localhost → Full access`);
  console.log(`\n  ℹ️  Chrome must be launched with --remote-debugging-port=9222`);
  console.log(`     macOS: open -a "Google Chrome" --args --remote-debugging-port=9222\n`);
});

// Kick off CDP connection after server starts
cdpConnect();
