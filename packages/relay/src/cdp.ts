/**
 * cdp.ts — Chrome DevTools Protocol client, encapsulated as CDPSession.
 * Instantiate one CDPSession per relay port / Chrome tab (target) pair.
 * All sessions may share a single Chrome debug port.
 */
import { WebSocket } from 'ws';

export type CDPTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

/** Fetch all page targets from a running Chrome instance. */
export async function listTargets(cdpPort = 9222): Promise<CDPTarget[]> {
  const res = await fetch(`http://localhost:${cdpPort}/json`);
  if (!res.ok) throw new Error(`[cdp] Chrome not reachable at localhost:${cdpPort}`);
  const all = await res.json() as Array<Record<string, string>>;
  return all
    .filter(t => t.type === 'page')
    .map(t => ({
      id: t.id ?? '',
      type: t.type ?? '',
      url: t.url ?? '',
      webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? '',
    }));
}

export class CDPSession {
  readonly cdpPort: number;

  private _targetId  = '';
  private _targetUrl = '';
  /** Populated after connect() resolves. */
  get targetId()  { return this._targetId; }
  get targetUrl() { return this._targetUrl; }

  private cdpWs: WebSocket | null = null;
  private msgId = 1;
  private vpW = 1280;
  private vpH = 800;
  private screenshotCallback: ((jpeg: Buffer) => void) | null = null;
  private lastClickAt = 0;
  private reconnectHandler: (() => void) | null = null;
  private didSignalDisconnect = false;
  private screencastActive = false;
  /** When set, reconnect will re-attach to this specific target ID. */
  private pinnedTargetId: string | undefined;

  // Generic CDP event listeners: method → Set of handlers
  private eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  constructor(cdpPort = 9222) {
    this.cdpPort = cdpPort;
  }

  setReconnectHandler(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  private signalDisconnect(): void {
    if (this.didSignalDisconnect) return;
    this.didSignalDisconnect = true;
    this.screencastActive = false;
    this.cdpWs = null;
    this.reconnectHandler?.();
  }

  private attachLifecycle(ws: WebSocket): void {
    ws.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      // Route CDP events to registered listeners
      if (typeof msg.method === 'string' && msg.params) {
        const listeners = this.eventListeners.get(msg.method as string);
        if (listeners) {
          for (const fn of listeners) fn(msg.params as Record<string, unknown>);
        }
      }
    });
    ws.on('close', () => {
      console.log(`[cdp:${this.cdpPort}/${this._targetId || '?'}] socket closed`);
      this.signalDisconnect();
    });
    ws.on('error', (err) => {
      console.error(`[cdp:${this.cdpPort}/${this._targetId || '?'}] socket error:`, (err as Error).message);
      this.signalDisconnect();
    });
  }

  private cdpOn(method: string, handler: (params: Record<string, unknown>) => void): void {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, new Set());
    this.eventListeners.get(method)!.add(handler);
  }

  private cdpOff(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.eventListeners.get(method)?.delete(handler);
  }

  async connect(screenshotCallback: (jpeg: Buffer) => void, targetId?: string): Promise<void> {
    this.screenshotCallback = screenshotCallback;
    if (targetId) this.pinnedTargetId = targetId;

    const targets = await listTargets(this.cdpPort);

    let page: CDPTarget | undefined;
    if (this.pinnedTargetId) {
      page = targets.find(t => t.id === this.pinnedTargetId);
      if (!page) throw new Error(`[cdp:${this.cdpPort}] target ${this.pinnedTargetId} not found`);
    } else {
      page = targets.find(t => t.url.includes('perplexity.ai')) ?? targets[0];
      if (!page) throw new Error(`[cdp:${this.cdpPort}] No page target found.`);
      this.pinnedTargetId = page.id;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    this.cdpWs = ws;
    this.didSignalDisconnect = false;
    this._targetId  = page.id;
    this._targetUrl = page.url;
    this.attachLifecycle(ws);
    await this.send('Page.enable', {});
    await this.refreshViewport();
    console.log(`[cdp:${this.cdpPort}/${page.id}] connected → ${page.url} (viewport ${this.vpW}x${this.vpH})`);
  }

  isConnected(): boolean {
    return this.cdpWs?.readyState === WebSocket.OPEN;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.cdpWs || this.cdpWs.readyState !== WebSocket.OPEN)
        return reject(new Error(`[cdp:${this.cdpPort}] not connected`));
      const ws = this.cdpWs;
      const id = this.msgId++;
      const onMsg = (data: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id !== id) return;
        ws.off('message', onMsg);
        if (msg.error) reject(msg.error); else resolve(msg.result);
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        ws.off('message', onMsg);
        reject(err);
      });
    });
  }

  private async refreshViewport(): Promise<void> {
    try {
      const layout = await this.send('Page.getLayoutMetrics') as Record<string, Record<string, number>>;
      const vp = layout.cssVisualViewport ?? layout.cssLayoutViewport;
      this.vpW = vp?.clientWidth  ?? 1280;
      this.vpH = vp?.clientHeight ?? 800;
    } catch { /* keep cached */ }
  }

  private coords(nx: number, ny: number) {
    return { x: Math.round(nx * this.vpW), y: Math.round(ny * this.vpH) };
  }

  private keyCode(key: string): number {
    const map: Record<string, number> = {
      Enter: 13, Backspace: 8, Tab: 9, Escape: 27,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Delete: 46, Home: 36, End: 35,
    };
    return map[key] ?? 0;
  }

  async handleAction(action: Record<string, unknown>): Promise<void> {
    const type = action.type as string;

    if (type === 'mousemove') {
      const { x, y } = this.coords(action.x as number, action.y as number);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      return;
    }

    if (type === 'click') {
      const { x, y } = this.coords(action.x as number, action.y as number);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await new Promise(r => setTimeout(r, 80));
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
      this.lastClickAt = Date.now();
      setTimeout(() => this.refreshViewport(), 600);
      console.log(`[cdp:${this.cdpPort}/${this._targetId}] click at`, x, y);
      return;
    }

    if (type === 'type') {
      const sinceClick = Date.now() - this.lastClickAt;
      if (sinceClick < 150) await new Promise(r => setTimeout(r, 150 - sinceClick));
      const text = action.value as string;
      console.log(`[cdp:${this.cdpPort}/${this._targetId}] type:`, JSON.stringify(text.slice(0, 80)));
      const result = await this.send('Runtime.evaluate', {
        expression: `(function() {
  var el = document.activeElement;
  if (!el || el === document.body) {
    el = document.querySelector('[data-lexical-editor="true"]');
    if (el) el.focus();
  }
  var ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
  return ok;
})()`,
        returnByValue: true,
        awaitPromise: false,
      }) as { result: { value: unknown } };
      console.log(`[cdp:${this.cdpPort}/${this._targetId}] execCommand result:`, result?.result?.value);
      return;
    }

    if (type === 'keydown') {
      const key = action.key as string;
      if (['Meta', 'Shift', 'Control', 'Alt'].includes(key)) return;
      const code      = (action.code as string) ?? key;
      const shift     = Boolean(action.shiftKey);
      const ctrl      = Boolean(action.ctrlKey);
      const meta      = Boolean(action.metaKey);
      const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
      const vk        = this.keyCode(key);
      const special   = ['Enter','Backspace','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete','Home','End'];
      if (special.includes(key) || modifiers) {
        if (key === 'Enter' && !modifiers) {
          await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', text: ' ', unmodifiedText: ' ' });
          await this.send('Input.dispatchKeyEvent', { type: 'char',    key: ' ', text: ' ', unmodifiedText: ' ' });
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: ' ', text: ' ', unmodifiedText: ' ' });
          await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        }
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp',      key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        console.log(`[cdp:${this.cdpPort}/${this._targetId}] key:`, key, modifiers ? `(modifiers:${modifiers})` : '');
      }
      return;
    }

    if (type === 'scroll') {
      const { x, y } = this.coords(0.5, 0.5);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: (action.x as number) * 100, deltaY: (action.y as number) * 100 });
      return;
    }
  }

  private screencastFrameHandler: ((params: Record<string, unknown>) => void) | null = null;

  startScreenshots(fps = 5): void {
    if (this.screencastActive) return;
    this.screencastActive = true;

    this.screencastFrameHandler = (params) => {
      const { data, sessionId } = params as { data: string; sessionId: number };
      if (this.screenshotCallback) {
        this.screenshotCallback(Buffer.from(data, 'base64'));
      }
      this.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    };

    this.cdpOn('Page.screencastFrame', this.screencastFrameHandler);

    this.send('Page.startScreencast', {
      format:        'jpeg',
      quality:       60,
      maxWidth:      this.vpW,
      maxHeight:     this.vpH,
      everyNthFrame: Math.max(1, Math.round(30 / fps)),
    }).catch((err) => {
      console.error(`[cdp:${this.cdpPort}/${this._targetId}] startScreencast error:`, (err as Error).message);
      this.screencastActive = false;
    });

    console.log(`[cdp:${this.cdpPort}/${this._targetId}] screencast started (target ~${fps}fps)`);
  }

  stopScreenshots(): void {
    if (!this.screencastActive) return;
    this.screencastActive = false;

    if (this.screencastFrameHandler) {
      this.cdpOff('Page.screencastFrame', this.screencastFrameHandler);
      this.screencastFrameHandler = null;
    }

    this.send('Page.stopScreencast', {}).catch(() => {});
    console.log(`[cdp:${this.cdpPort}/${this._targetId}] screencast stopped`);
  }
}
