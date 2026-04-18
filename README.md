# pplx-bridge

Stream a live Chrome tab (`perplexity.ai`) to a local relay via **rrweb**, then point **Comet** at `http://localhost:7000/live`. Comet Assistant operates the replayed DOM — clicks, inputs, scrolls — and every action propagates back to the real Chrome tab.

```
Chrome tab (source)                          Comet tab (viewer)
┌──────────────────────┐                    ┌───────────────────────┐
│ rrweb.record()       │                    │ rrweb Replayer iframe │
│ + action executor    │◀──actions(WS)──────│ + click interceptor   │
└──────────▲───────────┘                    └──────────┬────────────┘
           │  events(WS)                               │
           └────────────── localhost:7000 relay ───────┘
```

## Prerequisites

- Node 20+, pnpm 9+
- Google Chrome
- [Comet browser](https://www.perplexity.ai/comet)
- **Comet → Settings → Assistant → Site access**: set `localhost` to **Full access**

## Install

```bash
git clone https://github.com/eonist/pplx-bridge
cd pplx-bridge
pnpm install
pnpm build
```

## Run

```bash
pnpm start
```

Then in **Comet**, open `http://localhost:7000/live`.

The relay also launches Chrome on `perplexity.ai` with the recorder extension sideloaded.

## How it works

1. `rrweb.record()` runs inside the Chrome pplx.ai tab (via MV3 extension) and streams DOM events to the relay at `ws://localhost:7000/ingest`.
2. The relay fans those events to all viewer subscribers at `ws://localhost:7000/subscribe`.
3. `live.html` (opened in Comet) runs `rrweb.Replayer` in live mode and applies each event — Comet Assistant sees the full, live pplx.ai DOM.
4. When Comet clicks something in the replayed iframe, the viewer resolves the rrweb node id and posts `{ type: 'click', id }` back through `ws://localhost:7000/actions`.
5. The relay forwards the action upstream to the recorder, which dispatches a real DOM event on the live node in Chrome.

## Known limitations

- File upload and clipboard paste require the CDP fallback path (`chrome.debugger`)
- Canvas / WebGL areas degrade; enable `recordCanvas: true` in recorder for partial support
- Comet `localhost` site access must be set to **Full access** (see Prerequisites)
- Cross-origin assets are proxied via `/assets/*`; toggle `inlineImages: true` in recorder for full offline fidelity at the cost of bandwidth

## Issues / roadmap

See [github.com/eonist/pplx-bridge/issues](https://github.com/eonist/pplx-bridge/issues)
