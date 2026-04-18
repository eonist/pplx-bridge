// cdp.ts — helper for sending CDP commands from the content script
// Wraps chrome.runtime.sendMessage so recorder.ts stays clean.

export interface CdpParams {
  method: string;
  params?: Record<string, unknown>;
}

export function cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'cdp', method, params }, (res) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (res?.ok) resolve(res.result);
      else reject(new Error(res?.error ?? 'cdp unknown error'));
    });
  });
}

// Typed helpers for the specific CDP commands we use

/** Dispatch a real trusted mouse event via CDP (bypasses isTrusted check) */
export function cdpClick(x: number, y: number): Promise<unknown> {
  return cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  }).then(() => cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  }));
}

/** Type text as real trusted keyboard input via CDP */
export function cdpInsertText(text: string): Promise<unknown> {
  return cdp('Input.insertText', { text });
}

/** Press a key combo via CDP (e.g. Enter to submit the composer) */
export function cdpKey(key: string, code: string, modifiers = 0): Promise<unknown> {
  return cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
    .then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp',   key, code, modifiers }));
}
