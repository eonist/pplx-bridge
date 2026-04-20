/**
 * cdp.ts — Chrome DevTools Protocol client, encapsulated as CDPSession.
 * Instantiate one CDPSession per relay port / Chrome debug port pair.
 */
import { WebSocket } from 'ws';

export class CDPSession {
  private cdpWs: WebSocket | null = null;
  private msgId = 1;
  private vpW = 1280;
  private vpH = 800;
  private screenshotCallback: ((jpeg: Buffer) => void) | null = null;
  private lastClickAt = 0;
  private reconnectHandler: (() => void) | null = null;
  private didSignalDisconnect = false;
  private screenshotInterval = 0;
  readonly cdpPort: number;

  constructor(cdpPort = 9222) {
    this.cdpPort = cdpPort;
  }

  setReconnectHandler(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  private signalDisconnect(): void {
    if (this.didSignalDisconnect) return;
    this.didSignalDisconnect = true;
    this.cdpWs = null;
    this.reconnectHandler?.();
  }

  private attachLifecycle(ws: WebSocket): void {
    ws.on('close', () => {
      console.log(`[cdp:${this.cdpPort}] socket closed`);
      this.signalDisconnect();
    });
    ws.on('error', (err) => {
      console.error(`[cdp:${this.cdpPort}] socket error:`, (err as Error).message);
      this.signalDisconnect();
    });
  }

  async connect(screenshotCallback: (jpeg: Buffer) => void): Promise<void> {
    this.screenshotCallback = screenshotCallback;
    const res = await fetch(`http://localhost:${this.cdpPort}/json`);
    if (!res.ok) throw new Error(`[cdp:${this.cdpPort}] Chrome not reachable at localhost:${this.cdpPort}`);
    const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
    const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'))
               ?? targets.find(t => t.type === 'page');
    if (!page) throw new Error(`[cdp:${this.cdpPort}] No page target found.`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    this.cdpWs = ws;
    this.didSignalDisconnect = false;
    this.attachLifecycle(ws);
    await this.send('Page.enable', {});
    await this.refreshViewport();
    console.log(`[cdp:${this.cdpPort}] connected → ${page.url} (viewport ${this.vpW}x${this.vpH})`);
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
      console.log(`[cdp:${this.cdpPort}] click at`, x, y);
      return;
    }

    if (type === 'type') {
      const sinceClick = Date.now() - this.lastClickAt;
      if (sinceClick < 150) await new Promise(r => setTimeout(r, 150 - sinceClick));
      const text = action.value as string;
      console.log(`[cdp:${this.cdpPort}] type:`, JSON.stringify(text.slice(0, 80)));
      const result = await this.send('Runtime.evaluate', {
        expression: `(function() {
  var el = document.querySelector('[data-lexical-editor="true"]');
  if (!el) el = document.activeElement;
  if (el) { el.focus(); }
  var ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
  return ok;
})()`,
        returnByValue: true,
        awaitPromise: false,
      }) as { result: { value: unknown } };
      console.log(`[cdp:${this.cdpPort}] execCommand result:`, result?.result?.value);
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
        console.log(`[cdp:${this.cdpPort}] key:`, key, modifiers ? `(modifiers:${modifiers})` : '');
      }
      return;
    }

    if (type === 'scroll') {
      const { x, y } = this.coords(0.5, 0.5);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: (action.x as number) * 100, deltaY: (action.y as number) * 100 });
      return;
    }
  }

  startScreenshots(fps = 1): void {
    if (this.screenshotInterval) return;
    let busy = false;
    this.screenshotInterval = setInterval(async () => {
      if (busy || !this.isConnected()) return;
      busy = true;
      try {
        const result = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true }) as { data: string };
        if (this.screenshotCallback) this.screenshotCallback(Buffer.from(result.data, 'base64'));
      } catch { /* ignore */ } finally { busy = false; }
    }, Math.round(1000 / fps)) as unknown as number;
  }

  stopScreenshots(): void {
    clearInterval(this.screenshotInterval);
    this.screenshotInterval = 0;
  }
}
