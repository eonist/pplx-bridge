import { execSync } from 'child_process';
import express from 'express';
import { createServer, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { CDPSession } from './cdp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

const SCREENSHOT_FPS    = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 30_000;
const QUEUED_ACTION_MAX = 20;
const QUEUED_ACTION_TTL_MS = 10_000;

type QueuedAction = {
  action: Record<string, unknown>;
  expiresAt: number;
};

export class RelaySession {
  private cdp: CDPSession;
  private streamViewers = new Set<WebSocket>();
  private pushers = new Set<WebSocket>();         // extension /stream/push senders
  private typeBuffer = '';
  private typeTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedActions: QueuedAction[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private reconnectInFlight = false;

  // Serial action queue — ensures only one CDP action runs at a time,
  // preventing rapid click bursts from being seen as double/triple-clicks.
  private actionChain: Promise<void> = Promise.resolve();

  constructor(
    private port: number,
    private cdpPort: number,
    private targetId?: string,
  ) {
    this.cdp = new CDPSession(cdpPort);
    this.cdp.setReconnectHandler(() => this.scheduleReconnect());
  }

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
    if (this.typeTimer) {
      clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
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

  private pruneQueuedActions(): void {
    const now = Date.now();
    while (this.queuedActions.length && this.queuedActions[0]!.expiresAt <= now) this.queuedActions.shift();
  }

  private queueAction(action: Record<string, unknown>): void {
    this.pruneQueuedActions();
    if (this.queuedActions.length >= QUEUED_ACTION_MAX) this.queuedActions.shift();
    this.queuedActions.push({ action, expiresAt: Date.now() + QUEUED_ACTION_TTL_MS });
    console.log(`[relay:${this.port}] queued action while disconnected:`, JSON.stringify(action).slice(0, 120));
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
    // Chain onto the serial promise so actions execute one-at-a-time.
    // This prevents rapid viewer clicks from arriving as double/triple-clicks
    // in Chrome (which would select text and clobber the caret position).
    this.actionChain = this.actionChain.then(() => this.runAction(action)).catch((err) => {
      console.error(`[relay:${this.port}] action pipeline error:`, (err as Error).message ?? err);
    });
  }

  private async flushQueuedActions(): Promise<void> {
    this.pruneQueuedActions();
    while (this.queuedActions.length && this.cdp.isConnected()) {
      const next = this.queuedActions.shift();
      if (!next || next.expiresAt <= Date.now()) continue;
      await this.runAction(next.action);
    }
  }

  private async reconnectCDP(): Promise<void> {
    if (this.reconnectInFlight || this.cdp.isConnected()) return;
    this.reconnectInFlight = true;
    this.cdp.stopScreenshots();
    try {
      console.log(`[relay:${this.port}] reconnecting CDP...`);
      await this.cdp.connect((jpeg) => this.broadcastFrame(jpeg), this.targetId);
      // Only start CDP screencast if no extension pushers are connected
      if (this.pushers.size === 0) {
        this.cdp.startScreenshots(SCREENSHOT_FPS);
      }
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
      this.reconnectCDP().catch((err) => {
        console.error(`[relay:${this.port}] reconnect pipeline error:`, (err as Error).message ?? err);
      });
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

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

    app.get('/health', (_req, res) => res.json({
      ok:        true,
      port:      this.port,
      cdpPort:   this.cdpPort,
      targetId:  this.cdp.targetId  || null,
      targetUrl: this.cdp.targetUrl || null,
      cdp:       this.cdp.isConnected(),
    }));

    wss.on('connection', (ws, req) => {
      const url = req.url ?? '';

      if (url === '/stream/push') {
        // Extension frame pusher — preferred over CDP screencast
        this.pushers.add(ws);
        console.log(`[relay:${this.port}] ▲ extension pusher connected (total: ${this.pushers.size}) — pausing CDP screencast`);
        // Stop CDP screencast while extension is pushing frames (avoids dual render)
        if (this.cdp.isConnected()) this.cdp.stopScreenshots();

        ws.on('message', (data) => {
          // Forward raw JPEG binary from extension to all stream viewers
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
          for (const v of this.streamViewers) {
            if (v.readyState === WebSocket.OPEN) v.send(buf, { binary: true });
          }
        });

        ws.on('close', () => {
          this.pushers.delete(ws);
          console.log(`[relay:${this.port}] ▼ extension pusher disconnected — resuming CDP screencast`);
          // Resume CDP screencast when extension disconnects
          if (this.cdp.isConnected() && this.pushers.size === 0) {
            this.cdp.startScreenshots(SCREENSHOT_FPS);
          }
        });

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

            if (
              parsed.type === 'keydown' &&
              parsed.key === 'v' &&
              parsed.metaKey === true
            ) {
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

            // Don't flush the type buffer on click/mousemove — a click sets its own
            // caret position. Flushing before the click would call el.focus() in the
            // type handler, resetting the caret to end before the click lands.
            if (parsed.type !== 'mousemove' && parsed.type !== 'click') {
              const buffered = this.flushTypeBuffer();
              if (buffered) this.enqueueOrRunAction({ type: 'type', value: buffered });
            }

            if (parsed.type !== 'mousemove') {
              console.log(`[relay:${this.port}] action →`, JSON.stringify(parsed).slice(0, 120));
            }
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
      console.log(`  Health       http://localhost:${this.port}/health\n`);
      if (this.targetId) {
        console.log(`  ⚠️  Pinned to CDP target ${this.targetId} on port ${this.cdpPort}\n`);
      } else {
        console.log(`  ⚠️  Chrome must be started with --remote-debugging-port=${this.cdpPort}\n`);
      }

      try {
        await this.cdp.connect((jpeg) => this.broadcastFrame(jpeg), this.targetId);
        this.reconnectDelayMs = RECONNECT_BASE_MS;
        // Start CDP screencast only if no extension pusher is already connected
        if (this.pushers.size === 0) {
          this.cdp.startScreenshots(SCREENSHOT_FPS);
        }
        console.log(`[relay:${this.port}] CDP ready — input active, screencast ${ this.pushers.size > 0 ? 'deferred (extension pushing)' : 'active' }\n`);
      } catch (err) {
        console.error(`[relay:${this.port}] CDP connect failed:`, (err as Error).message);
        this.scheduleReconnect();
      }
    });
  }
}
