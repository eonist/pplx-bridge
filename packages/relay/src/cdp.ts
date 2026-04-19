/**
 * cdp.ts — direct Chrome DevTools Protocol client.
 * Connects to Chrome launched with --remote-debugging-port=9222.
 */
import { WebSocket } from 'ws';

let cdpWs: WebSocket | null = null;
let msgId = 1;
let vpW = 1280;
let vpH = 800;
let _screenshotCallback: ((jpeg: Buffer) => void) | null = null;

export async function connectCDP(screenshotCallback: (jpeg: Buffer) => void): Promise<void> {
  _screenshotCallback = screenshotCallback;

  const res = await fetch('http://localhost:9222/json');
  if (!res.ok) throw new Error('[cdp] Chrome not reachable at localhost:9222. Start Chrome with --remote-debugging-port=9222');
  const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;

  const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'))
             ?? targets.find(t => t.type === 'page');
  if (!page) throw new Error('[cdp] No page target found. Open a tab in Chrome.');

  cdpWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    cdpWs!.once('open', resolve);
    cdpWs!.once('error', (e) => reject(e));
  });

  await send('Page.enable', {});
  await send('Runtime.enable', {});
  await refreshViewport();
  console.log(`[cdp] connected → ${page.url} (viewport ${vpW}x${vpH})`);
}

export function isCDPConnected(): boolean {
  return cdpWs?.readyState === WebSocket.OPEN;
}

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('[cdp] not connected'));
    }
    const id = msgId++;
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== id) return;
      cdpWs!.off('message', onMessage);
      if (msg.error) reject(msg.error); else resolve(msg.result);
    };
    cdpWs.on('message', onMessage);
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

/**
 * Type text into the focused element.
 *
 * - Single character: use keyDown + char + keyUp sequence.
 *   This fires the full keydown→keypress→input→keyup chain that React/ProseMirror
 *   responds to, one character at a time.
 *
 * - Multi-character string (Comet batches): use clipboard paste.
 *   writeText() + Ctrl+V fires a ClipboardEvent that ProseMirror handles natively.
 */
async function typeText(text: string): Promise<void> {
  if (text.length === 1) {
    // Single char — full key event sequence
    const key  = text;
    const code = `Key${text.toUpperCase()}`;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text });
    await send('Input.dispatchKeyEvent', { type: 'char',    key, code, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp',   key, code });
    return;
  }

  // Multi-char: clipboard paste
  const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const clipResult = await send('Runtime.evaluate', {
    expression: `navigator.clipboard.writeText(\`${escaped}\`)`,
    awaitPromise: true,
    userGesture: true,
  }) as Record<string, unknown>;

  const clipOk = !(clipResult as any)?.exceptionDetails;

  if (clipOk) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'v', code: 'KeyV', modifiers: 2 });
    console.log('[cdp] paste:', JSON.stringify(text.slice(0, 60)));
  } else {
    // Last resort fallback
    await send('Input.insertText', { text });
    console.log('[cdp] insertText fallback:', JSON.stringify(text.slice(0, 60)));
  }
}

// ── Input injection ───────────────────────────────────────────────────────────

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
    setTimeout(() => refreshViewport(), 600);
    console.log('[cdp] click at', x, y);
    return;
  }

  if (type === 'type') {
    await typeText(action.value as string);
    return;
  }

  if (type === 'keydown') {
    const key = action.key as string;
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(key)) return;
    const code  = (action.code as string) ?? key;
    const shift = Boolean(action.shiftKey);
    const ctrl  = Boolean(action.ctrlKey);
    const meta  = Boolean(action.metaKey);
    const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp',   key, code, modifiers, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 });
    return;
  }

  if (type === 'scroll') {
    const { x, y } = coords(0.5, 0.5);
    const deltaX = (action.x as number) * 100;
    const deltaY = (action.y as number) * 100;
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return;
  }
}

// ── Screenshot loop ───────────────────────────────────────────────────────────

let screenshotInterval = 0;

export function startScreenshots(fps = 1): void {
  if (screenshotInterval) return;
  let busy = false;
  screenshotInterval = setInterval(async () => {
    if (busy || !isCDPConnected()) return;
    busy = true;
    try {
      const result = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true }) as { data: string };
      if (_screenshotCallback) {
        _screenshotCallback(Buffer.from(result.data, 'base64'));
      }
    } catch { /* ignore transient errors */ } finally {
      busy = false;
    }
  }, Math.round(1000 / fps)) as unknown as number;
}

export function stopScreenshots(): void {
  clearInterval(screenshotInterval);
  screenshotInterval = 0;
}
