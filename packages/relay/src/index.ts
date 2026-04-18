import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7000);

const app = express();
const server = createServer(app);

// ── Static viewer ─────────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/live', (_req, res) => {
  res.sendFile(path.join(publicDir, 'live.html'));
});

// ── Asset proxy ───────────────────────────────────────────────────────────────
// Forwards requests to original origin so cross-origin resources resolve
// inside the viewer iframe without CSP / CORS errors.
app.get('/assets/*', async (req, res) => {
  const raw    = (req.params as Record<string, string>)[0];
  const target = decodeURIComponent(raw);

  if (!target.startsWith('https://')) {
    res.status(400).send('only https:// targets allowed');
    return;
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'pplx-bridge/0.1 asset-proxy' },
    });
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    // Strip security headers that would block the viewer from rendering assets
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');
    res.removeHeader('cross-origin-resource-policy');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[relay] asset proxy error:', err);
    res.status(502).send('proxy error');
  }
});

// ── Health check (useful for CI / prereq script) ──────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const recorders = new Set<WebSocket>(); // Chrome extension ingest
const viewers   = new Set<WebSocket>(); // Comet viewer tabs

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  // 1. /ingest — recorder → relay: rrweb event stream in
  if (url === '/ingest') {
    recorders.add(ws);
    console.log(`[relay] ▲ recorder connected   (total: ${recorders.size})`);

    ws.on('message', (data) => {
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data);
      }
    });

    ws.on('close', () => {
      recorders.delete(ws);
      console.log('[relay] ▼ recorder disconnected');
    });

  // 2. /subscribe — viewer → relay: receives rrweb events
  } else if (url === '/subscribe') {
    viewers.add(ws);
    console.log(`[relay] ▲ viewer connected     (total: ${viewers.size})`);

    ws.on('close', () => {
      viewers.delete(ws);
      console.log('[relay] ▼ viewer disconnected');
    });

  // 3. /actions — viewer → relay → recorder: action back-channel
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
