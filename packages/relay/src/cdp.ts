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
let _reconnectHandler: (() => void) | null = null;
let _didSignalDisconnect = false;

export function setCDPReconnectHandler(handler: () => void): void {
  _reconnectHandler = handler;
}

function signalDisconnect(): void {
  if (_didSignalDisconnect) return;
  _didSignalDisconnect = true;
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

/**
 * After a CDP click lands the native caret correctly, Lexical's reconciler
 * fires and overwrites the DOM selection with EditorState.selection (stale).
 * The fix: read caretRangeFromPoint at (x,y), resolve it to a Lexical node key
 * + offset, then call editor.update(() => $setSelection(...)) so the reconciler
 * writes the correct position back instead of the stale one.
 *
 * Ref: https://github.com/facebook/lexical/issues/6514 (Lexical team FAQ)
 * Ref: https://stackoverflow.com/questions/77552572 (community pattern)
 */
async function syncLexicalSelectionAfterClick(x: number, y: number): Promise<void> {
  const expr = `(function() {
  var log = [];
  try {
    // 1. Find Lexical editor instance
    var editorEl = document.querySelector('[data-lexical-editor="true"]');
    if (!editorEl) { return { ok: false, log: ['no [data-lexical-editor] element found'] }; }
    log.push('[lexical-click] found editor element: ' + (editorEl.tagName || '?'));

    var editor = editorEl.__lexicalEditor;
    if (!editor) { return { ok: false, log: log.concat(['__lexicalEditor not attached to element']) }; }
    log.push('[lexical-click] editor instance found, editable=' + editor.isEditable());

    // 2. Resolve click coords to a DOM Range via caretRangeFromPoint
    var range = document.caretRangeFromPoint(${x}, ${y});
    if (!range) { return { ok: false, log: log.concat(['caretRangeFromPoint(' + ${x} + ',' + ${y} + ') returned null']) }; }
    var domNode = range.startContainer;
    var domOffset = range.startOffset;
    log.push('[lexical-click] caretRangeFromPoint(' + ${x} + ',' + ${y} + ') → node=' + (domNode.nodeName || '?') + ' nodeType=' + domNode.nodeType + ' offset=' + domOffset);
    log.push('[lexical-click] domNode textContent snippet: ' + String(domNode.textContent || '').slice(0, 60));

    // 3. Resolve DOM node → Lexical node key
    // Lexical stores __lexicalKey on text nodes and element nodes
    var keyNode = domNode.nodeType === 3 ? domNode.parentElement : domNode;
    var lexKey = keyNode && (keyNode.__lexicalKey || keyNode.getAttribute && keyNode.getAttribute('data-lexical-node-key'));
    log.push('[lexical-click] resolved keyNode tag=' + (keyNode && keyNode.tagName) + ' __lexicalKey=' + lexKey);

    if (!lexKey) {
      // Walk up to find nearest Lexical-keyed ancestor
      var walker = keyNode && keyNode.parentElement;
      var depth = 0;
      while (walker && depth < 8) {
        var k = walker.__lexicalKey || (walker.getAttribute && walker.getAttribute('data-lexical-node-key'));
        if (k) { lexKey = k; log.push('[lexical-click] found lexKey on ancestor (depth ' + depth + '): ' + k); break; }
        walker = walker.parentElement;
        depth++;
      }
    }

    if (!lexKey) { return { ok: false, log: log.concat(['could not resolve any Lexical node key from click point']) }; }

    // 4. Get current EditorState selection BEFORE update (for comparison logging)
    var stateBefore = editor.getEditorState().read(function() {
      var sel = window.__lexical && window.__lexical.$getSelection ? window.__lexical.$getSelection() : null;
      return sel ? JSON.stringify({ type: sel.constructor && sel.constructor.name }) : 'null';
    });
    log.push('[lexical-click] EditorState selection before update: ' + stateBefore);

    // 5. Derive offset: for text nodes use domOffset directly;
    //    for element nodes (paragraph etc) offset is child index
    var finalOffset = domOffset;
    if (domNode.nodeType !== 3) {
      // element node — offset is child position, not char offset
      log.push('[lexical-click] click landed on element node, using child-index offset=' + domOffset);
    }
    log.push('[lexical-click] will set Lexical selection → key=' + lexKey + ' offset=' + finalOffset + ' type=text');

    // 6. Call editor.update() to set the selection inside EditorState
    //    so the reconciler writes the correct position to the DOM.
    var updateScheduled = false;
    try {
      editor.update(function() {
        try {
          var lexical = editor._config && editor._config.namespace ? editor : null;
          // Access $createRangeSelection and $setSelection via editor helpers
          // Lexical attaches its module exports to the window in some builds,
          // but the safest path is through the editor's own read/write helpers.
          var editorState = editor.getEditorState();
          // Use the internal _nodeMap to verify the key exists
          var nodeMap = editorState._nodeMap;
          var targetNode = nodeMap && nodeMap.get(lexKey);
          if (!targetNode) {
            console.warn('[lexical-click] key ' + lexKey + ' not in nodeMap — skipping $setSelection');
            return;
          }
          console.log('[lexical-click] nodeMap entry for key=' + lexKey + ' type=' + (targetNode.constructor && targetNode.constructor.name));

          // Build selection via Lexical internals exposed on the editor object
          // editor._window gives us the frame context; Lexical's reconciler
          // reads selection from the active editor state during update().
          var sel = targetNode.select(finalOffset, finalOffset);
          if (sel) {
            console.log('[lexical-click] $setSelection via node.select() succeeded anchor=' + sel.anchor.key + ':' + sel.anchor.offset + ' focus=' + sel.focus.key + ':' + sel.focus.offset);
          } else {
            console.warn('[lexical-click] node.select() returned null/undefined');
          }
        } catch(innerErr) {
          console.error('[lexical-click] error inside editor.update callback:', String(innerErr));
        }
      }, { tag: 'set-caret', skipTransforms: true, onUpdate: function() {
        console.log('[lexical-click] editor.update onUpdate fired — reconciler ran');
      }});
      updateScheduled = true;
      log.push('[lexical-click] editor.update() scheduled successfully');
    } catch(updateErr) {
      log.push('[lexical-click] editor.update() threw: ' + String(updateErr));
    }

    return { ok: updateScheduled, log: log };
  } catch(e) {
    return { ok: false, log: log.concat(['top-level exception: ' + String(e)]) };
  }
})()`;

  const raw = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  }) as { result: { value: { ok: boolean; log: string[] } } };

  const val = raw?.result?.value;
  if (val?.log) {
    for (const line of val.log) console.log(line);
  }
  if (!val?.ok) {
    console.warn('[cdp] syncLexicalSelectionAfterClick: did not complete successfully');
  } else {
    console.log('[cdp] syncLexicalSelectionAfterClick: OK');
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
    console.log('[cdp] click sequence start at', x, y);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    console.log('[cdp] mouseMoved sent');
    await new Promise(r => setTimeout(r, 80));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    console.log('[cdp] mousePressed sent — native caret should now be at', x, y);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    console.log('[cdp] mouseReleased sent');
    // Small delay to let Lexical's mousedown handler + first reconcile run,
    // then override EditorState.selection with the correct position.
    await new Promise(r => setTimeout(r, 30));
    console.log('[cdp] calling syncLexicalSelectionAfterClick at', x, y);
    await syncLexicalSelectionAfterClick(x, y);
    lastClickAt = Date.now();
    setTimeout(() => refreshViewport(), 600);
    console.log('[cdp] click sequence complete at', x, y);
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
