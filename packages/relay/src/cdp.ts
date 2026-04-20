/**
 * cdp.ts — direct Chrome DevTools Protocol client.
 */
import { WebSocket } from 'ws';

let cdpWs: WebSocket | null = null;
let msgId = 1;
let vpW = 1280;
let vpH = 800;
let _screenshotCallback: ((jpeg: Buffer) => void) | null = null;
let lastClickAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let reconnectInFlight: Promise<void> | null = null;
let started = false;
let isConnecting = false;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

function attachSocketLifecycleHandlers(): void {
  if (!cdpWs) return;

  cdpWs.on('close', () => {
    console.warn('[cdp] socket closed');
    cdpWs = null;
    scheduleReconnect();
  });

  cdpWs.on('error', (err) => {
    console.warn('[cdp] socket error:', (err as Error).message);
  });
}

async function openCDP(): Promise<void> {
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
  attachSocketLifecycleHandlers();
  await send('Page.enable', {});
  await refreshViewport();
  reconnectAttempts = 0;
  console.log(`[cdp] connected → ${page.url} (viewport ${vpW}x${vpH})`);
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer || reconnectInFlight) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  console.log(`[cdp] reconnect scheduled in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectCDP().catch((err) => {
      console.error('[cdp] reconnect failed:', (err as Error).message);
      scheduleReconnect();
    });
  }, delay);
}

export async function connectCDP(screenshotCallback: (jpeg: Buffer) => void): Promise<void> {
  _screenshotCallback = screenshotCallback;
  started = true;
  await reconnectCDP();
}

export async function reconnectCDP(): Promise<void> {
  if (reconnectInFlight) return reconnectInFlight;
  reconnectInFlight = (async () => {
    isConnecting = true;
    try {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (cdpWs) {
        try { cdpWs.removeAllListeners(); } catch {}
        try { cdpWs.close(); } catch {}
        cdpWs = null;
      }
      await openCDP();
    } finally {
      isConnecting = false;
      reconnectInFlight = null;
    }
  })();
  return reconnectInFlight;
}

export function isCDPConnected(): boolean {
  return cdpWs?.readyState === WebSocket.OPEN;
}

export function getCDPState(): 'open' | 'reconnecting' | 'offline' {
  if (cdpWs?.readyState === WebSocket.OPEN) return 'open';
  if (isConnecting || reconnectInFlight || reconnectTimer) return 'reconnecting';
  return 'offline';
}

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return reject(new Error('[cdp] not connected'));
    const id = msgId++;
    const onMsg = (data: Buffer) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== id) return;
      cdpWs!.off('message', onMsg);
      if (msg.error) reject(msg.error); else resolve(msg.result);
    };
    cdpWs.on('message', onMsg);
    cdpWs.send(JSON.stringify({ id, method, params }));
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
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    return;
  }

  if (type === 'click') {
    const { x, y } = coords(action.x as number, action.y as number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await new Promise(r => setTimeout(r, 80));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1, buttons: 1 });
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

    const result = await send('Runtime.evaluate', {
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

let screenshotInterval = 0;

export function startScreenshots(fps = 1): void {
  if (screenshotInterval) return;
  let busy = false;
  screenshotInterval = setInterval(async () => {
    if (busy || !isCDPConnected()) return;
    busy = true;
    try {
      const result = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true }) as { data: string };
      if (_screenshotCallback) _screenshotCallback(Buffer.from(result.data, 'base64'));
    } catch { /* ignore */ } finally { busy = false; }
  }, Math.round(1000 / fps)) as unknown as number;
}

export function stopScreenshots(): void {
  clearInterval(screenshotInterval);
  screenshotInterval = 0;
}
