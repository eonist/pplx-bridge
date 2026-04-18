import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7000;

const app = express();
const server = createServer(app);

// Serve viewer static files (live.html etc.)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/live', (_req, res) => {
  res.sendFile(path.join(publicDir, 'live.html'));
});

// Asset proxy — forwards requests to original origin
// so cross-origin resources (images, fonts, CSS) resolve in the viewer
app.get('/assets/*', async (req, res) => {
  const target = decodeURIComponent((req.params as Record<string, string>)[0]);
  if (!target.startsWith('https://')) {
    res.status(400).send('only https targets allowed');
    return;
  }
  try {
    const upstream = await fetch(target);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    // Remove CSP from proxied responses so the viewer can load them
    res.removeHeader('content-security-policy');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[relay] asset proxy error:', err);
    res.status(502).send('proxy error');
  }
});

// --- WebSocket channels ---
const wss = new WebSocketServer({ server });

const recorders = new Set<WebSocket>(); // Chrome extension ingest connections
const viewers   = new Set<WebSocket>(); // Comet viewer tab connections

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  // 1. Recorder → relay: rrweb events stream in
  if (url === '/ingest') {
    recorders.add(ws);
    console.log(`[relay] recorder connected  (total: ${recorders.size})`);

    ws.on('message', (data) => {
      // Fan out to all active viewers
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data);
      }
    });

    ws.on('close', () => {
      recorders.delete(ws);
      console.log('[relay] recorder disconnected');
    });

  // 2. Viewer → relay: subscribes to rrweb event stream
  } else if (url === '/subscribe') {
    viewers.add(ws);
    console.log(`[relay] viewer connected    (total: ${viewers.size})`);

    ws.on('close', () => {
      viewers.delete(ws);
      console.log('[relay] viewer disconnected');
    });

  // 3. Viewer → relay → recorder: action back-channel
  } else if (url === '/actions') {
    ws.on('message', (data) => {
      // Forward action frames to all recorders
      for (const r of recorders) {
        if (r.readyState === WebSocket.OPEN) r.send(data);
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  pplx-bridge relay  →  localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`  Ingest WS    ws://localhost:${PORT}/ingest`);
  console.log(`  Subscribe WS ws://localhost:${PORT}/subscribe`);
  console.log(`  Actions WS   ws://localhost:${PORT}/actions`);
  console.log(`  Viewer       http://localhost:${PORT}/live\n`);
  console.log(`  ⚠️  Comet → Settings → Assistant → Site access`);
  console.log(`     set localhost to: Full access\n`);
});
