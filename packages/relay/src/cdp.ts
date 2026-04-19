/**
 * cdp.ts — direct Chrome DevTools Protocol client.
 */
import { WebSocket } from 'ws';
import { execSync } from 'child_process';

let cdpWs: WebSocket | null = null;
let msgId = 1;
let vpW = 1280;
let vpH = 800;
let _screenshotCallback: ((jpeg: Buffer) => void) | null = null;
let lastClickAt = 0;

export async function connectCDP(screenshotCallback: (jpeg: Buffer) => void): Promise<void> {
  _screenshotCallback = screenshotCallback;
  const res = await fetch('http://localhost:9222/json');
  if (!res.ok) throw new Error('[cdp] Chrome not reachable at localhost:9222');
  const targets = await res.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
  const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'))
             ?? targets.find(t => t.type === 'page');
  if (!page) throw new Error('[cdp] No page target found.');
  cdpWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    cdpWs!.once('open', resolve);
    cdpWs!.once('error', reject);
  });
  await send('Page.enable', {});
  await refreshViewport();
  console.log(`[cdp] connected \u2192 ${page.url} (viewport ${vpW}x${vpH})`);
}

export function isCDPConnected(): boolean {
  return cdpWs?.readyState === WebSocket.OPEN;
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

/** Dispatch a single printable character using the full keyDown→char→keyUp sequence.
 *  ProseMirror/Lexical require keyDown before they accept the char event. */
async function dispatchChar(ch: string): Promise<void> {
  const base = { key: ch, text: ch, unmodifiedText: ch };
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await send('Input.dispatchKeyEvent', { ...base, type: 'char' });
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

/** Read macOS clipboard via pbpaste. Returns empty string on error. */
function readClipboard(): string {
  try {
    return execSync('pbpaste', { encoding: 'utf8' });
  } catch {
    return '';
  }
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
    console.log('[cdp] type:', JSON.stringify(text.slice(0, 60)));
    if (text.length === 1) {
      await dispatchChar(text);
    } else {
      // Bulk string: use Input.insertText (native CDP, no execCommand deprecation issues)
      await send('Input.insertText', { text });
      console.log('[cdp] insertText:', JSON.stringify(text.slice(0, 60)));
    }
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

    // Intercept Cmd+V: read macOS clipboard and inject via Input.insertText
    if (meta && key === 'v') {
      const clipboard = readClipboard();
      if (clipboard) {
        console.log('[cdp] paste via pbpaste:', JSON.stringify(clipboard.slice(0, 80)));
        await send('Input.insertText', { text: clipboard });
      }
      return;
    }

    if (special.includes(key) || modifiers) {
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
