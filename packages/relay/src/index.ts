import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7000;

const app = express();
const server = createServer(app);

// Serve viewer static files
app.use(express.static(path.join(__dirname, '../../viewer/public')));
app.get('/live', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../viewer/public/live.html'));
});

// Asset proxy — forwards requests to original origin so cross-origin resources resolve
app.get('/assets/*', async (req, res) => {
  const target = decodeURIComponent(req.params[0] as string);
  try {
    const upstream = await fetch(target);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch {
    res.status(502).send('proxy error');
  }
});

// --- WebSocket channels ---
const wss = new WebSocketServer({ server });

// All connected recorders (Chrome extension)
const recorders = new Set<WebSocket>();
// All connected viewers (Comet tab)
const viewers = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  if (url === '/ingest') {
    // Recorder → relay
    recorders.add(ws);
    console.log(`[relay] recorder connected (total: ${recorders.size})`);
    ws.on('message', (data) => {
      // Fan out rrweb events to all viewers
      for (const viewer of viewers) {
        if (viewer.readyState === WebSocket.OPEN) viewer.send(data);
      }
    });
    ws.on('close', () => { recorders.delete(ws); console.log('[relay] recorder disconnected'); });

  } else if (url === '/subscribe') {
    // Viewer → relay (receive events)
    viewers.add(ws);
    console.log(`[relay] viewer connected (total: ${viewers.size})`);
    ws.on('close', () => { viewers.delete(ws); console.log('[relay] viewer disconnected'); });

  } else if (url === '/actions') {
    // Viewer → relay → recorder (action back-channel)
    ws.on('message', (data) => {
      for (const recorder of recorders) {
        if (recorder.readyState === WebSocket.OPEN) recorder.send(data);
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`\n[pplx-bridge relay] listening on http://localhost:${PORT}`);
  console.log(`  Ingest WS:    ws://localhost:${PORT}/ingest`);
  console.log(`  Subscribe WS: ws://localhost:${PORT}/subscribe`);
  console.log(`  Actions WS:   ws://localhost:${PORT}/actions`);
  console.log(`  Viewer:       http://localhost:${PORT}/live`);
  console.log(`\n⚠️  Reminder: In Comet → Settings → Assistant → Site access, set localhost to Full access.\n`);
});
