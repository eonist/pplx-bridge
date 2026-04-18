import express from 'express';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// macOS uses port 7000 for AirPlay Receiver — default to 7001
const PORT = Number(process.env.PORT ?? 7001);

const app = express();
const server = createServer(app);

// ── Private Network Access (PNA) — Chrome blocks ws://localhost from public origins
//    unless the server echoes back Access-Control-Allow-Private-Network: true
//    https://developer.chrome.com/blog/private-network-access-update
server.on('upgrade', (req: IncomingMessage, socket, head) => {
  // The WebSocketServer handles the actual upgrade; we only need to inject
  // the PNA header during the HTTP 101 handshake.  ws exposes this via
  // the 'headers' event on each socket after the handshake object is built,
  // but the simplest reliable approach is to patch handleProtocols / the
  // verifyClient option on the WSS.  Instead we intercept at the http server
  // level by monkey-patching socket.write for the duration of the upgrade.
  const _write = socket.write.bind(socket);
  (socket as NodeJS.WritableStream & { write: typeof _write }).write = (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean => {
    if (typeof chunk === 'string' && chunk.startsWith('HTTP/1.1 101')) {
      chunk = chunk.replace(
        '\r\n\r\n',
        '\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\n\r\n',
      );
    }
    // @ts-ignore
    return _write(chunk, ...args);
  };
});

// ── Static viewer ─────────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');

// CORS + PNA for all HTTP responses (preflight OPTIONS for WS pre-flight)
app.use((_req, res: ServerResponse & { setHeader: (k: string, v: string) => void }, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(publicDir));
app.get('/live', (_req, res) => {
  res.sendFile(path.join(publicDir, 'live.html'));
});

// ── Asset proxy ───────────────────────────────────────────────────────────────
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

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, port: PORT }));

// ── WebSocket channels ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const recorders = new Set<WebSocket>();
const viewers   = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  const url = req.url ?? '';

  if (url === '/ingest') {
    recorders.add(ws);
    console.log(`[relay] ▲ recorder connected   (total: ${recorders.size})`);
    ws.on('message', (data) => {
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(data);
      }
    });
    ws.on('close', () => { recorders.delete(ws); console.log('[relay] ▼ recorder disconnected'); });

  } else if (url === '/subscribe') {
    viewers.add(ws);
    console.log(`[relay] ▲ viewer connected     (total: ${viewers.size})`);
    ws.on('close', () => { viewers.delete(ws); console.log('[relay] ▼ viewer disconnected'); });

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
