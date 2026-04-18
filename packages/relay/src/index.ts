import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// macOS uses port 7000 for AirPlay Receiver — default to 7001
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
app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// /stream  — extension sends binary JPEG frames; viewers receive them
const streamers     = new Set<WebSocket>(); // extension (sender)
const streamViewers = new Set<WebSocket>(); // viewer tab (receiver)

// /actions — viewer sends action JSON; extension receives it
const actionReceivers = new Set<WebSocket>(); // extension

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  // ── /stream/push — extension pushes JPEG frames ───────────────────────────
  if (url === '/stream/push') {
    streamers.add(ws);
    console.log(`[relay] ▲ streamer connected    (total: ${streamers.size})`);

    ws.on('message', (data, isBinary) => {
      // Forward raw binary frame to every viewer
      for (const v of streamViewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      streamers.delete(ws);
      console.log('[relay] ▼ streamer disconnected');
    });

  // ── /stream — viewer receives JPEG frames ─────────────────────────────────
  } else if (url === '/stream') {
    streamViewers.add(ws);
    console.log(`[relay] ▲ stream-viewer connected (total: ${streamViewers.size})`);

    ws.on('close', () => {
      streamViewers.delete(ws);
      console.log('[relay] ▼ stream-viewer disconnected');
    });

  // ── /actions — bidirectional action channel ───────────────────────────────
  // Viewer sends actions → relay logs + forwards to extension.
  // Extension connects here to receive actions.
  } else if (url === '/actions') {
    // Distinguish sender (viewer) from receiver (extension) by who sends first.
    // We use a simple heuristic: extension registers itself by sending
    // JSON { "register": "extension" } on connect. Everyone else is a viewer.
    let isExtension = false;

    ws.on('message', (raw) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(raw instanceof Buffer ? raw.toString() : String(raw)); } catch (_) {}

      // Extension registration handshake
      if (parsed?.register === 'extension') {
        isExtension = true;
        actionReceivers.add(ws);
        console.log(`[relay] ▲ action-receiver (ext) connected (total: ${actionReceivers.size})`);
        return;
      }

      if (!isExtension) {
        // Message from viewer → log and forward to all extension receivers
        console.log('[relay] action →', JSON.stringify(parsed ?? raw.toString()).slice(0, 120));
        for (const r of actionReceivers) {
          if (r.readyState === WebSocket.OPEN) r.send(raw);
        }
      }
    });

    ws.on('close', () => {
      if (isExtension) {
        actionReceivers.delete(ws);
        console.log('[relay] ▼ action-receiver (ext) disconnected');
      }
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
  console.log(`     set localhost → Full access\n`);
});
