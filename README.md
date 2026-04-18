# pplx-bridge

Stream a live Chrome tab (`perplexity.ai`) to a local relay via **rrweb**, then point **Comet** at `http://localhost:7000/live`. Comet Assistant operates the replayed DOM — clicks, inputs, scrolls — and every action propagates back to the real Chrome tab in real time.

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

- **Node 20+** and **pnpm 9+**
- **Google Chrome** installed
- **[Comet browser](https://www.perplexity.ai/comet)** installed
- In Comet: **Settings → Assistant → Site access** — add `localhost` and set to **Full access**

## Install

```bash
git clone https://github.com/eonist/pplx-bridge
cd pplx-bridge
pnpm install
```

## Run

```bash
pnpm start
```

This will:
1. Build all packages
2. Run the prereq check
3. Start the relay on `http://localhost:7000`
4. Launch Chrome on `perplexity.ai` with the recorder extension sideloaded and CDP enabled

Then in **Comet**, open:
```
http://localhost:7000/live
```

You’ll see a live mirror of the pplx.ai tab. Open Comet Assistant and start interacting.

## Individual commands

```bash
pnpm build          # build all packages
pnpm check          # verify all prereqs are met
pnpm relay          # start relay only (Chrome separate)
pnpm chrome         # launch Chrome only (relay separate)
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PPLX_BRIDGE_PROFILE` | `/tmp/pplx-bridge-profile` | Chrome user data dir (isolated from your main profile) |
| `PPLX_BRIDGE_CDP_PORT` | `9222` | Chrome remote debugging port |
| `PORT` | `7000` | Relay HTTP/WS port |

## How it works

1. The MV3 extension injects `rrweb.record()` into the pplx.ai tab and streams DOM events to `ws://localhost:7000/ingest`.
2. The relay fans those events out to all viewer subscribers at `ws://localhost:7000/subscribe`.
3. `live.html` (opened in Comet) runs `rrweb.Replayer` in live mode — Comet Assistant sees the full, live pplx.ai DOM.
4. When Comet clicks something in the replayed iframe, the viewer resolves the rrweb node id and posts `{ type, id }` back through `ws://localhost:7000/actions`.
5. The relay forwards the action upstream to the recorder, which dispatches the real DOM event on the live node in Chrome.

## Action types

| Type | Description | Method |
|---|---|---|
| `click` | Button / link / menu | `dispatchEvent` via rrweb mirror id |
| `input` | Composer textarea / inputs | `execCommand('insertText')` for contenteditable, native setter for `<input>` |
| `keydown` | Enter, Escape, shortcuts | `dispatchEvent(KeyboardEvent)` |
| `scroll` | Thread list, sidebars | `element.scrollTo(x, y)` |
| `cdp` | File upload, clipboard, trusted gestures | `chrome.debugger` → `Input.*` CDP commands |

## Known limitations

- File upload and clipboard paste use the CDP path — a banner will appear in Chrome asking to confirm the debugger; click **Allow**
- Canvas / WebGL areas render as best-effort (`recordCanvas: true`)
- Comet `localhost` site access must be set to **Full access** (see Prerequisites)
- Cross-origin assets (images, fonts) are proxied through `/assets/*` on the relay
- First snapshot of a long pplx.ai thread may take 1–2 seconds

## Roadmap / issues

[github.com/eonist/pplx-bridge/issues](https://github.com/eonist/pplx-bridge/issues)
