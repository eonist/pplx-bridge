import { execSync } from 'child_process';
import express from 'express';
import { createServer } from 'http';
import { ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { CDPSession } from './cdp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

const SCREENSHOT_FPS   = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30_000;
const QUEUED_ACTION_MAX = 20;
const QUEUED_ACTION_TTL_MS = 10_000;

type QueuedAction = { action: Record<string, unknown>; expiresAt: number };

class RelaySession {
  private readonly port: number;
  private readonly cdp: CDPSession;

  private typeBuffer = '';
  private typeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectInFlight = false;
  private readonly queuedActions: QueuedAction[] = [];
  private readonly streamViewers = new Set<WebSocket>();

  constructor(port: number, cdpPort: number) {
    this.port = port;
    this.cdp  = new CDPSession(cdpPort);
    this.cdp.setReconnectHandler(() => this.scheduleReconnect());
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private broadcastFrame(jpeg: Buffer): void {
    const data = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
    for (const v of this.streamViewers) {
      if (v.readyState === WebSocket.OPEN) v.send(data, { binary: true });
    }
  }

  private flushTypeBuffer(): string {
    if (!this.typeBuffer) return '';
    const text = this.typeBuffer;
    this.typeBuffer = '';
    if (this.typeTimer) { clearTimeout(this.typeTimer); this.typeTimer = null; }
    console.log(`[relay:${this.port}] flush type:`, JSON.stringify(text.slice(0, 80)));
    return text;
  }

  private handlePaste(): void {
    try {
      const text = execSync('pbpaste', { encoding: 'utf8' }).trim();
      if (!text) { console.log(`[relay:${this.port}] paste: clipboard empty`); return; }
      console.log(`[relay:${this.port}] paste:`, JSON.stringify(text.slice(0, 80)));
      this.enqueueOrRunAction({ type: 'type', value: text });
    } catch (err) {
      console.error(`[relay:${this.port}] pbpaste failed:`, (err as Error).message);
    }
  }

  // ── Action queue ──────────────────────────────────────────────────────

  private pruneQueuedActions(): void {
    const now = Date.now();
    while (this.queuedActions.length && this.queuedActions[0]!.expiresAt <= now)
      this.queuedActions.shift();
  }

  private queueAction(action: Record<string, unknown>): void {
    this.pruneQueuedActions();
    if (this.queuedActions.length >= QUEUED_ACTION_MAX) this.queuedActions.shift();
    this.queuedActions.push({ action, expiresAt: Date.now() + QUEUED_ACTION_TTL_MS });
    console.log(`[relay:${this.port}] queued action:`, JSON.stringify(action).slice(0, 120));
  }

  private async runAction(action: Record<string, unknown>): Promise<void> {
    try {
      await this.cdp.handleAction(action);
    } catch (err) {
      if ((err as Error).message?.includes('not connected')) {
        this.queueAction(action);
        this.scheduleReconnect();
        return;
      }
      console.error(`[relay:${this.port}] CDP action error:`, (err as Error).message ?? err);
    }
  }

  private enqueueOrRunAction(action: Record<string, unknown>): void {
    if (!this.cdp.isConnected()) {
      this.queueAction(action);
      this.scheduleReconnect();
      return;
    }
    this.runAction(action).catch((err) =>
      console.error(`[relay:${this.port}] action pipeline error:`, (err as Error).message ?? err)
    );
  }

  private async flushQueuedActions(): Promise<void> {
    this.pruneQueuedActions();
    while (this.queuedActions.length && this.cdp.isConnected()) {
      const next = this.queuedActions.shift();
      if (!next || next.expiresAt <= Date.now()) continue;
      await this.runAction(next.action);
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────

  private async reconnectCDP(): Promise<void> {
    if (this.reconnectInFlight || this.cdp.isConnected()) return;
    this.reconnectInFlight = true;
    this.cdp.stopScreenshots();
    try {
      console.log(`[relay:${this.port}] reconnecting CDP...`);
      await this.cdp.connect((jpeg) => this.broadcastFrame(jpeg));
      this.cdp.startScreenshots(SCREENSHOT_FPS);
      console.log(`[relay:${this.port}] CDP reconnected`);
      await this.flushQueuedActions();
      this.reconnectDelayMs = RECONNECT_BASE_MS;
    } catch (err) {
      console.error(`[relay:${this.port}] reconnect failed:`, (err as Error).message);
      this.scheduleReconnect();
    } finally {
      this.reconnectInFlight = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.cdp.isConnected() || this.reconnectTimer || this.reconnectInFlight) return;
    const delay = this.reconnectDelayMs;
    console.log(`[relay:${this.port}] scheduling reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectCDP().catch((err) =>
        console.error(`[relay:${this.port}] reconnect pipeline error:`, (err as Error).message ?? err)
      );
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  // ── Start ─────────────────────────────────────────────────────────────

  start(): void {
    const app    = express();
    const server = createServer(app);
    const wss    = new WebSocketServer({ server });

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
        console.error(`[relay:${this.port}] asset proxy error:`, err);
        res.status(502).send('proxy error');
      }
    });

    app.get('/health', (_req, res) =>
      res.json({ ok: true, port: this.port, cdpPort: this.cdp.cdpPort, cdp: this.cdp.isConnected() })
    );

    wss.on('connection', (ws, req) => {
      const url = req.url ?? '';

      if (url === '/stream/push') {
        console.log(`[relay:${this.port}] ▲ streamer connected`);
        ws.on('message', () => {});
        ws.on('close', () => console.log(`[relay:${this.port}] ▼ streamer disconnected`));

      } else if (url === '/stream') {
        this.streamViewers.add(ws);
        console.log(`[relay:${this.port}] ▲ stream-viewer connected (total: ${this.streamViewers.size})`);
        ws.on('close', () => {
          this.streamViewers.delete(ws);
          console.log(`[relay:${this.port}] ▼ stream-viewer disconnected`);
        });

      } else if (url === '/actions') {
        let isReceiver = false;

        ws.on('message', (raw) => {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(raw instanceof Buffer ? raw.toString() : String(raw)); } catch (_) {}

          if (parsed?.register === 'extension') {
            isReceiver = true;
            console.log(`[relay:${this.port}] ▲ action-receiver (ext) connected`);
            return;
          }

          if (!isReceiver) {
            if (!parsed) return;

            if (parsed.type === 'keydown' && parsed.key === 'v' && parsed.metaKey === true) {
              const buffered = this.flushTypeBuffer();
              if (buffered) this.enqueueOrRunAction({ type: 'type', value: buffered });
              console.log(`[relay:${this.port}] action → Cmd+V (intercepted as paste)`);
              this.handlePaste();
              return;
            }

            if (parsed.type === 'type' && typeof parsed.value === 'string' && parsed.value.length === 1) {
              this.typeBuffer += parsed.value as string;
              if (this.typeTimer) clearTimeout(this.typeTimer);
              this.typeTimer = setTimeout(() => {
                const buffered = this.flushTypeBuffer();
                if (buffered) this.enqueueOrRunAction({ type: 'type', value: buffered });
              }, 200);
              return;
            }

            const buffered = this.flushTypeBuffer();
            if (buffered) this.enqueueOrRunAction({ type: 'type', value: buffered });

            if (parsed.type !== 'mousemove')
              console.log(`[relay:${this.port}] action →`, JSON.stringify(parsed).slice(0, 120));

            this.enqueueOrRunAction(parsed);
          }
        });

        ws.on('close', () => {
          if (isReceiver) console.log(`[relay:${this.port}] ▼ action-receiver (ext) disconnected`);
        });
      }
    });

    server.listen(this.port, async () => {
      const w = 44;
      console.log(`\n╔${'═'.repeat(w)}╗`);
      console.log(`║  pplx-bridge relay  →  localhost:${this.port}${' '.repeat(w - 28 - String(this.port).length)}║`);
      console.log(`╚${'═'.repeat(w)}╝`);
      console.log(`  Stream view  ws://localhost:${this.port}/stream`);
      console.log(`  Actions      ws://localhost:${this.port}/actions`);
      console.log(`  Viewer       http://localhost:${this.port}/live`);
      console.log(`  Health       http://localhost:${this.port}/health`);
      console.log(`  CDP port     ${this.cdp.cdpPort}\n`);
      console.log(`  ⚠️  Start Chrome with:`);
      console.log(`     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \\`);
      console.log(`       --remote-debugging-port=${this.cdp.cdpPort} \\`);
      console.log(`       --user-data-dir=/tmp/pplx-bridge-${this.cdp.cdpPort} \\`);
      console.log(`       https://perplexity.ai\n`);

      try {
        await this.cdp.connect((jpeg) => this.broadcastFrame(jpeg));
        this.reconnectDelayMs = RECONNECT_BASE_MS;
        this.cdp.startScreenshots(SCREENSHOT_FPS);
        console.log(`[relay:${this.port}] CDP ready — input + screenshots active\n`);
      } catch (err) {
        console.error(`[relay:${this.port}] CDP connect failed:`, (err as Error).message);
        console.error(`[relay:${this.port}] Start Chrome with --remote-debugging-port=${this.cdp.cdpPort}\n`);
        this.scheduleReconnect();
      }
    });
  }
}

/**
 * Parse session pairs from argv or env.
 *
 * Usage:
 *   node dist/index.js                     → single session port=7001 cdp=9222
 *   node dist/index.js 7001 7002 7003       → three sessions, cdp ports 9222/9223/9224
 *   PORT=7002 CDP_PORT=9223 node dist/index.js  → single session (env, backward-compat)
 *   node dist/index.js 7001:9222 7002:9223  → explicit relay:cdp pairs
 */
function parseSessionArgs(): Array<{ port: number; cdpPort: number }> {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    return args.map((arg) => {
      if (arg.includes(':')) {
        const [p, c] = arg.split(':').map(Number);
        return { port: p!, cdpPort: c! };
      }
      const port = Number(arg);
      return { port, cdpPort: 9222 + (port - 7001) };
    });
  }

  // env / defaults (backward-compatible)
  const port    = Number(process.env.PORT     ?? 7001);
  const cdpPort = Number(process.env.CDP_PORT ?? 9222 + (port - 7001));
  return [{ port, cdpPort }];
}

for (const { port, cdpPort } of parseSessionArgs()) {
  new RelaySession(port, cdpPort).start();
}
