import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// macOS uses port 7000 for AirPlay Receiver — default to 7001
const PORT = Number(process.env.PORT ?? 7001);

const app = express();
const server = createServer(app);

// ── Static viewer ───────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');

app.use((_req, res: ServerResponse & { setHeader: (k: string, v: string) => void }, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(publicDir));
app.get('/live', (_req, res) => res.sendFile(path.join(publicDir, 'live.html')));

// ── Asset proxy ──────────────────────────────────────────────────────────────
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

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const recorders = new Set<WebSocket>();
const viewers   = new Set<WebSocket>();

// rrweb event type 2 = FullSnapshot
// We cache the last meta (type 4) + full snapshot (type 2) pair so
// late-joining viewers get an immediate frame to render.
const RRWEB_META          = 4;
const RRWEB_FULL_SNAPSHOT = 2;

let cachedMeta:     string | null = null;
let cachedSnapshot: string | null = null;

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  if (url === '/ingest') {
    recorders.add(ws);
    console.log(`[relay] ▲ recorder connected   (total: ${recorders.size})`);

    ws.on('message', (raw) => {
      const data = raw instanceof Buffer ? raw.toString() : String(raw);

      // Cache meta + full-snapshot for late joiners
      try {
        const evt = JSON.parse(data) as { type: number };
        if (evt.type === RRWEB_META)          cachedMeta     = data;
        if (evt.type === RRWEB_FULL_SNAPSHOT) cachedSnapshot = data;
      } catch (_) {}

      // Broadcast to all live viewers
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data);
      }
    });

    ws.on('close', () => {
      recorders.delete(ws);
      console.log('[relay] ▼ recorder disconnected');
    });

  } else if (url === '/subscribe') {
    viewers.add(ws);
    console.log(`[relay] ▲ viewer connected     (total: ${viewers.size})`);

    // Immediately send cached snapshot so viewer doesn’t wait for next keystroke
    if (cachedMeta     && ws.readyState === WebSocket.OPEN) ws.send(cachedMeta);
    if (cachedSnapshot && ws.readyState === WebSocket.OPEN) ws.send(cachedSnapshot);

    ws.on('close', () => {
      viewers.delete(ws);
      console.log('[relay] ▼ viewer disconnected');
    });

  } else if (url === '/actions') {
    ws.on('message', (data) => {
      for (const r of recorders) {
        if (r.readyState === WebSocket.OPEN) r.send(data);
      }
    });
  }
});

server.listen(PORT, () => {
  const w = 44;
  console.log(`\n╔${'═'.repeat(w)}╗`);
  console.log(`║  pplx-bridge relay  →  localhost:${PORT}${' '.repeat(w - 28 - String(PORT).length)}║`);
  console.log(`╚${'═'.repeat(w)}╝`);
  console.log(`  Ingest      ws://localhost:${PORT}/ingest`);
  console.log(`  Subscribe   ws://localhost:${PORT}/subscribe`);
  console.log(`  Actions     ws://localhost:${PORT}/actions`);
  console.log(`  Viewer      http://localhost:${PORT}/live`);
  console.log(`  Health      http://localhost:${PORT}/health\n`);
  console.log(`  ⚠️  Comet → Settings → Assistant → Site access`);
  console.log(`     set localhost → Full access\n`);
});
