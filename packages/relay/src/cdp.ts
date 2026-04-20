/**
 * cdp.ts — direct Chrome DevTools Protocol client.
 *
 * Screenshot strategy: Page.startScreencast (push) instead of polling
 * Page.captureScreenshot (request/response). This separates the video
 * channel (unsolicited CDP events) from the input channel (request/response
 * send() calls), so they can never contend on the WebSocket message queue.
 */
import { WebSocket } from 'ws';

let cdpWs: WebSocket | null = null;
let msgId = 1;
let vpW = 1280;
let vpH = 800;
let _screenshotCallback: ((jpeg: Buffer) => void) | null = null;
let lastClickAt = 0;
let _reconnectHandler: (() => void) | null = null;
let _didSignalDisconnect = false;
let _screencastRunning = false;

export function setCDPReconnectHandler(handler: () => void): void {
  _reconnectHandler = handler;
}

function signalDisconnect(): void {
  if (_didSignalDisconnect) return;
  _didSignalDisconnect = true;
  _screencastRunning = false;
  cdpWs = null;
  _reconnectHandler?.();
}

function attachLifecycle(ws: WebSocket): void {
  ws.on('close', () => {
    console.log('[cdp] socket closed');
    signalDisconnect();
  });
  ws.on('error', (err) => {
    console.error('[cdp] socket error:', (err as Error).message);
    signalDisconnect();
  });
}

/**
 * Persistent event listener for unsolicited CDP events (method-only messages).
 * Handles Page.screencastFrame — Chrome pushes these without us asking,
 * so they never block or are blocked by input send() calls.
 */
function attachEventListener(ws: WebSocket): void {
  ws.on('message', (data: Buffer) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    // Unsolicited events have no id
    if (msg.id !== undefined) return;
    if (msg.method === 'Page.screencastFrame') {
      const params = msg.params as Record<string, unknown>;
      const sessionId = params.sessionId as number;
      const jpeg = Buffer.from(params.data as string, 'base64');
      if (_screenshotCallback) _screenshotCallback(jpeg);
      // Ack is required — without it Chrome stops sending frames
      send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  });
}

export async function connectCDP(screenshotCallback: (jpeg: Buffer) => void): Promise<void> {
  _screenshotCallback = screenshotCallback;
  const res = await fetch('http://localhost:9222/json');
  if (!res.ok) throw new Error('[cdp] Chrome not reachable at localhost:9222');
  const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
  const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'))
             ?? targets.find(t => t.type === 'page');
  if (!page) throw new Error('[cdp] No page target found.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  cdpWs = ws;
  _didSignalDisconnect = false;
  attachLifecycle(ws);
  attachEventListener(ws);
  await send('Page.enable', {});
  await refreshViewport();
  console.log(`[cdp] connected → ${page.url} (viewport ${vpW}x${vpH})`);
}

export function isCDPConnected(): boolean {
  return cdpWs?.readyState === WebSocket.OPEN;
}

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return reject(new Error('[cdp] not connected'));
    const ws = cdpWs;
    const id = msgId++;
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

async function refreshViewport(): Promise<void> {
  try {
    const layout = await send('Page.getLayoutMetrics') as Record<string, Record<string, number>>;
    const vp = layout.cssVisualViewport ?? layout.cssLayoutViewport;
    vpW = vp?.clientWidth  ?? 1280;
    vpH = vp?.clientHeight ?? 800;
  } catch { /* keep cached */ }
}

function coords(nx: number, ny: number) {
  return { x: Math.round(nx * vpW), y: Math.round(ny * vpH) };
}

function keyCode(key: string): number {
  const map: Record<string, number> = {
    Enter: 13, Backspace: 8, Tab: 9, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46, Home: 36, End: 35,
  };
  return map[key] ?? 0;
}

export async function handleAction(action: Record<string, unknown>): Promise<void> {
  const type = action.type as string;

  if (type === 'mousemove') {
    const { x, y } = coords(action.x as number, action.y as number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    return;
  }

  if (type === 'click') {
    const { x, y } = coords(action.x as number, action.y as number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved',   x, y, button: 'none', buttons: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    lastClickAt = Date.now();
    setTimeout(() => refreshViewport(), 600);
    console.log('[cdp] click at', x, y);
    return;
  }

  if (type === 'type') {
    const sinceClick = Date.now() - lastClickAt;
    if (sinceClick < 150) await new Promise(r => setTimeout(r, 150 - sinceClick));
    const text = action.value as string;
    console.log('[cdp] type:', JSON.stringify(text.slice(0, 80)));
    // Do NOT call el.focus() here — it triggers Lexical's onFocus handler
    // which resets the caret to end of content, discarding the position
    // set by the preceding click. The click already focused the element.
    const result = await send('Runtime.evaluate', {
      expression: `(function() {
  var el = document.querySelector('[data-lexical-editor="true"]');
  if (!el) el = document.activeElement;
  var ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
  return ok;
})()`,
      returnByValue: true,
      awaitPromise: false,
    }) as { result: { value: unknown } };
    console.log('[cdp] execCommand result:', result?.result?.value);
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
    const vk        = keyCode(key);
    const special   = ['Enter','Backspace','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Delete','Home','End'];
    if (special.includes(key) || modifiers) {
      if (key === 'Enter' && !modifiers) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', text: ' ', unmodifiedText: ' ' });
        await send('Input.dispatchKeyEvent', { type: 'char',    key: ' ', text: ' ', unmodifiedText: ' ' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: ' ', text: ' ', unmodifiedText: ' ' });
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp',      key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      console.log('[cdp] key:', key, modifiers ? `(modifiers:${modifiers})` : '');
    }
    return;
  }

  if (type === 'scroll') {
    const { x, y } = coords(0.5, 0.5);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: (action.x as number) * 100, deltaY: (action.y as number) * 100 });
    return;
  }
}

/**
 * Start Chrome's push-based screencast. Chrome emits Page.screencastFrame
 * events (handled in attachEventListener) — no polling, no request/response
 * contention with input events.
 */
export async function startScreenshots(fps = 5): Promise<void> {
  if (_screencastRunning || !isCDPConnected()) return;
  try {
    await send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: vpW,
      maxHeight: vpH,
      everyNthFrame: 1,
    });
    _screencastRunning = true;
    console.log(`[cdp] screencast started (push, ~${fps}fps target)`);
  } catch (err) {
    console.error('[cdp] startScreencast failed:', (err as Error).message);
  }
}

export async function stopScreenshots(): Promise<void> {
  if (!_screencastRunning || !isCDPConnected()) { _screencastRunning = false; return; }
  try {
    await send('Page.stopScreencast', {});
  } catch { /* ignore */ } finally {
    _screencastRunning = false;
  }
}
