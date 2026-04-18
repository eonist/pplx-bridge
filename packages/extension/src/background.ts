// background.ts — service worker
// Handles the extension toolbar button click:
//   1. Gets the active tab
//   2. Starts tab capture (requires user gesture — button click provides it)
//   3. Feeds the MediaStream into an offscreen canvas, encodes JPEG frames
//   4. Sends binary frames to relay /stream/push
//   5. Opens /actions WS, registers as extension, forwards actions to the tab

const RELAY = 'ws://localhost:7001';
const FPS   = 8;  // captures per second — raise to 15 for smoother feel
const QUALITY = 0.6; // JPEG quality 0–1

let capturing = false;

chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) return;
  if (!tab.id) return;
  const tabId = tab.id;

  capturing = true;
  console.log('[bg] starting capture for tab', tabId);

  // ── 1. Tab capture ────────────────────────────────────────────────────────
  const stream: MediaStream = await new Promise((resolve, reject) =>
    chrome.tabCapture.capture({ video: true, audio: false }, (s) => {
      if (!s) reject(new Error(chrome.runtime.lastError?.message ?? 'capture failed'));
      else resolve(s);
    })
  );

  // ── 2. Feed stream into offscreen video + canvas ──────────────────────────
  const video  = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  const canvas  = document.createElement('canvas');
  const ctx     = canvas.getContext('2d')!;

  // ── 3. Open stream WS ─────────────────────────────────────────────────────
  const streamWs = new WebSocket(`${RELAY}/stream/push`);
  streamWs.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    streamWs.onopen  = () => resolve();
    streamWs.onerror = () => reject(new Error('stream WS failed to connect'));
  });
  console.log('[bg] stream WS connected');

  // ── 4. Frame loop ─────────────────────────────────────────────────────────
  const interval = setInterval(() => {
    if (streamWs.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      capturing = false;
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 800;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob || streamWs.readyState !== WebSocket.OPEN) return;
      blob.arrayBuffer().then(buf => streamWs.send(buf));
    }, 'image/jpeg', QUALITY);
  }, Math.round(1000 / FPS));

  // ── 5. Actions WS ─────────────────────────────────────────────────────────
  const actWs = new WebSocket(`${RELAY}/actions`);
  actWs.onopen = () => {
    actWs.send(JSON.stringify({ register: 'extension' }));
    console.log('[bg] actions WS connected, registered as extension');
  };

  actWs.onmessage = async (msg) => {
    let action: Record<string, unknown>;
    try { action = JSON.parse(msg.data); } catch { return; }
    console.log('[bg] action received:', action);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: injectAction,
        args: [action],
      });
    } catch (err) {
      console.error('[bg] executeScript error:', err);
    }
  };

  actWs.onclose = () => console.warn('[bg] actions WS closed');
});

// ── Injector function (runs inside the page context) ─────────────────────────
// This is serialised and sent via executeScript — keep it self-contained.
function injectAction(action: Record<string, unknown>) {
  const type = action.type as string;

  if (type === 'click' || type === 'mousemove') {
    const x = (action.x as number) * window.innerWidth;
    const y = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return;
    if (type === 'click') {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    } else {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    }
    return;
  }

  if (type === 'type') {
    const value = action.value as string;
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // React-compatible: use native value setter
      const proto = el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new InputEvent('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      el.focus();
      // Insert text at cursor via execCommand (works in most React contenteditable)
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, value);
    }
    return;
  }

  if (type === 'keydown') {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    const init: KeyboardEventInit = {
      key:      action.key      as string,
      code:     action.code     as string,
      shiftKey: action.shiftKey as boolean ?? false,
      ctrlKey:  action.ctrlKey  as boolean ?? false,
      metaKey:  action.metaKey  as boolean ?? false,
      bubbles:  true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup',   init));
    return;
  }

  if (type === 'scroll') {
    const x = (action.x as number) * window.innerWidth;
    const y = (action.y as number) * window.innerHeight;
    const el = document.elementFromPoint(
      window.innerWidth / 2, window.innerHeight / 2
    ) as HTMLElement | null;
    window.scrollBy(x, y);
    el?.scrollBy?.(x, y);
  }
}
