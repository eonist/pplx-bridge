// offscreen.ts — persistent WebSocket host
// Offscreen documents are regular pages: Chrome does NOT apply the 30s SW kill timer.
const RELAY = 'ws://localhost:7001';

let actWs:    WebSocket | null = null;
let streamWs: WebSocket | null = null;

// Actions WS: relay -> offscreen -> background SW -> CDP
function connectActions() {
  actWs = new WebSocket(`${RELAY}/actions`);
  actWs.onopen = () => {
    actWs!.send(JSON.stringify({ register: 'extension' }));
    console.log('[offscreen] actions WS connected');
  };
  actWs.onmessage = (msg) => {
    chrome.runtime.sendMessage({ type: 'action', payload: msg.data })
      .catch(() => {});
  };
  actWs.onclose = () => {
    console.warn('[offscreen] actions WS closed — reconnecting in 1s');
    setTimeout(connectActions, 1000);
  };
  actWs.onerror = () => console.error('[offscreen] actions WS error');
}

// Stream WS: background SW -> offscreen -> relay
function connectStream() {
  streamWs = new WebSocket(`${RELAY}/stream/push`);
  streamWs.onopen  = () => console.log('[offscreen] stream WS connected');
  streamWs.onclose = () => {
    console.warn('[offscreen] stream WS closed — reconnecting in 1s');
    setTimeout(connectStream, 1000);
  };
  streamWs.onerror = () => console.error('[offscreen] stream WS error');
}

// Receive JPEG frames from background SW and push to relay
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'frame' && streamWs?.readyState === WebSocket.OPEN) {
    streamWs.send(msg.data as ArrayBuffer);
  }
});

connectActions();
connectStream();
