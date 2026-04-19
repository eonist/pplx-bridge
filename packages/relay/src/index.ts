import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectCDP, handleAction, startScreenshots, isCDPConnected } from './cdp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 7001);

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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, port: PORT, cdp: isCDPConnected() }));

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const streamViewers = new Set<WebSocket>(); // live viewer tabs

// Send a JPEG buffer to all connected viewers
function broadcastFrame(jpeg: Buffer): void {
  const data = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  for (const v of streamViewers) {
    if (v.readyState === WebSocket.OPEN) v.send(data, { binary: true });
  }
}

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  // ── /stream/push — kept for extension backward-compat (ignored if CDP active)
  if (url === '/stream/push') {
    console.log('[relay] ▲ streamer connected (extension frame push — CDP mode ignores this)');
    ws.on('message', () => {}); // drain
    ws.on('close', () => console.log('[relay] ▼ streamer disconnected'));

  // ── /stream — viewer receives JPEG frames ─────────────────────────────────
  } else if (url === '/stream') {
    streamViewers.add(ws);
    console.log(`[relay] ▲ stream-viewer connected (total: ${streamViewers.size})`);
    ws.on('close', () => {
      streamViewers.delete(ws);
      console.log('[relay] ▼ stream-viewer disconnected');
    });

  // ── /actions — Comet sends actions; relay injects via CDP ─────────────────
  } else if (url === '/actions') {
    let isReceiver = false;

    ws.on('message', (raw) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw instanceof Buffer ? raw.toString() : String(raw)); } catch (_) {}

      // Extension registration handshake — acknowledge but don't rely on it
      if (parsed?.register === 'extension') {
        isReceiver = true;
        console.log('[relay] ▲ action-receiver (ext) connected — CDP mode: extension ignored for input');
        return;
      }

      if (!isReceiver) {
        // Action from Comet → inject directly via CDP
        if (parsed) {
          if (parsed.type !== 'mousemove') {
            console.log('[relay] action →', JSON.stringify(parsed).slice(0, 120));
          }
          handleAction(parsed).catch((err) => {
            console.error('[relay] CDP action error:', (err as Error).message ?? err);
          });
        }
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

  // Connect to Chrome CDP
  try {
    await connectCDP(broadcastFrame);
    startScreenshots(1);
    console.log('[relay] CDP ready — input + screenshots active\n');
  } catch (err) {
    console.error('[relay] CDP connect failed:', (err as Error).message);
    console.error('[relay] Start Chrome with --remote-debugging-port=9222 and restart relay\n');
  }
});
