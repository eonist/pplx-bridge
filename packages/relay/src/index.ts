import { execSync } from 'child_process';
import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectCDP, handleAction, startScreenshots, stopScreenshots, isCDPConnected, setCDPReconnectHandler } from './cdp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 7001);
const SCREENSHOT_FPS = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const QUEUED_ACTION_MAX = 20;
const QUEUED_ACTION_TTL_MS = 10_000;

const app    = express();
const server = createServer(app);

const publicDir = path.join(__dirname, 'public');

app.use((_req, res: ServerResponse & { setHeader: (k: string, v: string) => void }, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(publicDir));
app.get('/live', (_req, res) => res.sendFile(path.join(publicDir, 'live.html')));

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

app.get('/health', (_req, res) => res.json({ ok: true, port: PORT, cdp: isCDPConnected() }));

const wss = new WebSocketServer({ server });
const streamViewers = new Set<WebSocket>();

function broadcastFrame(jpeg: Buffer): void {
  const data = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  for (const v of streamViewers) {
    if (v.readyState === WebSocket.OPEN) v.send(data, { binary: true });
  }
}

function handlePaste(): void {
  try {
    const text = execSync('pbpaste', { encoding: 'utf8' }).trim();
    if (!text) { console.log('[relay] paste: clipboard empty'); return; }
    console.log('[relay] paste:', JSON.stringify(text.slice(0, 80)));
    enqueueOrRunAction({ type: 'type', value: text });
  } catch (err) {
    console.error('[relay] pbpaste failed:', (err as Error).message);
  }
}

type QueuedAction = {
  action: Record<string, unknown>;
  expiresAt: number;
};

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = RECONNECT_BASE_MS;
let reconnectInFlight = false;
const queuedActions: QueuedAction[] = [];

const liveQueue: Record<string, unknown>[] = [];
let liveWorkerRunning = false;

function pruneQueuedActions(): void {
  const now = Date.now();
  while (queuedActions.length && queuedActions[0]!.expiresAt <= now) queuedActions.shift();
}

function queueAction(action: Record<string, unknown>): void {
  pruneQueuedActions();
  if (queuedActions.length >= QUEUED_ACTION_MAX) queuedActions.shift();
  queuedActions.push({ action, expiresAt: Date.now() + QUEUED_ACTION_TTL_MS });
  console.log('[relay] queued action while disconnected:', JSON.stringify(action).slice(0, 120));
}

async function runAction(action: Record<string, unknown>): Promise<void> {
  try {
    await handleAction(action);
  } catch (err) {
    if ((err as Error).message?.includes('not connected')) {
      queueAction(action);
      scheduleReconnect();
      return;
    }
    console.error('[relay] CDP action error:', (err as Error).message ?? err);
  }
}

async function drainLiveQueue(): Promise<void> {
  if (liveWorkerRunning) return;
  liveWorkerRunning = true;
  try {
    while (liveQueue.length) {
      const action = liveQueue.shift()!;
      if (!isCDPConnected()) {
        queueAction(action);
        scheduleReconnect();
        continue;
      }
      await runAction(action);
    }
  } finally {
    liveWorkerRunning = false;
  }
}

function enqueueOrRunAction(action: Record<string, unknown>): void {
  if (!isCDPConnected()) {
    queueAction(action);
    scheduleReconnect();
    return;
  }
  liveQueue.push(action);
  drainLiveQueue().catch((err) => {
    console.error('[relay] action pipeline error:', (err as Error).message ?? err);
  });
}

async function flushQueuedActions(): Promise<void> {
  pruneQueuedActions();
  while (queuedActions.length && isCDPConnected()) {
    const next = queuedActions.shift();
    if (!next || next.expiresAt <= Date.now()) continue;
    liveQueue.push(next.action);
  }
  await drainLiveQueue();
}

async function reconnectCDP(): Promise<void> {
  if (reconnectInFlight || isCDPConnected()) return;
  reconnectInFlight = true;
  await stopScreenshots();
  try {
    console.log('[relay] reconnecting CDP...');
    await connectCDP(broadcastFrame);
    await startScreenshots(SCREENSHOT_FPS);
    console.log('[relay] CDP reconnected');
    await flushQueuedActions();
    reconnectDelayMs = RECONNECT_BASE_MS;
  } catch (err) {
    console.error('[relay] reconnect failed:', (err as Error).message);
    scheduleReconnect();
  } finally {
    reconnectInFlight = false;
  }
}

function scheduleReconnect(): void {
  if (isCDPConnected() || reconnectTimer || reconnectInFlight) return;
  const delay = reconnectDelayMs;
  console.log(`[relay] scheduling reconnect in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectCDP().catch((err) => {
      console.error('[relay] reconnect pipeline error:', (err as Error).message ?? err);
    });
  }, delay);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}

setCDPReconnectHandler(() => {
  scheduleReconnect();
});

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  if (url === '/stream/push') {
    console.log('[relay] ▲ streamer connected (extension frame push — CDP mode ignores this)');
    ws.on('message', () => {});
    ws.on('close', () => console.log('[relay] ▼ streamer disconnected'));

  } else if (url === '/stream') {
    streamViewers.add(ws);
    console.log(`[relay] ▲ stream-viewer connected (total: ${streamViewers.size})`);
    ws.on('close', () => {
      streamViewers.delete(ws);
      console.log('[relay] ▼ stream-viewer disconnected');
    });

  } else if (url === '/actions') {
    let isReceiver = false;

    ws.on('message', (raw) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw instanceof Buffer ? raw.toString() : String(raw)); } catch (_) {}

      if (parsed?.register === 'extension') {
        isReceiver = true;
        console.log('[relay] ▲ action-receiver (ext) connected — CDP mode: extension ignored for input');
        return;
      }

      if (!isReceiver) {
        if (!parsed) return;

        // Intercept Cmd+V as paste — read from macOS clipboard via pbpaste
        if (
          parsed.type === 'keydown' &&
          parsed.key === 'v' &&
          parsed.metaKey === true
        ) {
          console.log('[relay] action → Cmd+V (intercepted as paste)');
          handlePaste();
          return;
        }

        if (parsed.type !== 'mousemove') {
          console.log('[relay] action →', JSON.stringify(parsed).slice(0, 120));
        }
        enqueueOrRunAction(parsed);
      }
    });

    ws.on('close', () => {
      if (isReceiver) console.log('[relay] ▼ action-receiver (ext) disconnected');
    });
  }
});

server.listen(PORT, async () => {
  const w = 44;
  console.log(`\n╔${'═'.repeat(w)}╗`);
  console.log(`║  pplx-bridge relay  →  localhost:${PORT}${' '.repeat(w - 28 - String(PORT).length)}║`);
  console.log(`╚${'═'.repeat(w)}╝`);
  console.log(`  Stream view  ws://localhost:${PORT}/stream`);
  console.log(`  Actions      ws://localhost:${PORT}/actions`);
  console.log(`  Viewer       http://localhost:${PORT}/live`);
  console.log(`  Health       http://localhost:${PORT}/health\n`);
  console.log(`  ⚠️  Start Chrome with:`);
  console.log(`     /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\`);
  console.log(`       --remote-debugging-port=9222 \\`);
  console.log(`       --user-data-dir=/tmp/pplx-bridge-profile \\`);
  console.log(`       https://perplexity.ai\n`);

  try {
    await connectCDP(broadcastFrame);
    reconnectDelayMs = RECONNECT_BASE_MS;
    await startScreenshots(SCREENSHOT_FPS);
    console.log('[relay] CDP ready — input + screencast active\n');
  } catch (err) {
    console.error('[relay] CDP connect failed:', (err as Error).message);
    console.error('[relay] Start Chrome with --remote-debugging-port=9222 and restart relay\n');
    scheduleReconnect();
  }
});
