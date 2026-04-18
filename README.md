# pplx-bridge

Stream a live Chrome tab (`perplexity.ai`) to a local relay via **rrweb**, then point **Comet** at `http://localhost:7001/live`. Comet Assistant operates the replayed DOM — clicks, inputs, scrolls — and every action propagates back to the real Chrome tab in real time.

```
Chrome tab (source)                          Comet tab (viewer)
┌──────────────────────┐                    ┌───────────────────────┐
│ rrweb.record()       │                    │ rrweb Replayer iframe │
│ + action executor    │◀──actions(WS)──────│ + click interceptor   │
└──────────▲───────────┘                    └──────────┬────────────┘
           │  events(WS)                               │
           └────────────── localhost:7001 relay ───────┘
```

---

## 1. Install system dependencies (fresh macOS)

### 1a. Xcode Command Line Tools
```bash
xcode-select --install
```
A dialog will appear — click **Install** and wait (~5 min).

### 1b. Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
At the end, run the two `echo` commands it prints to add brew to your PATH, then:
```bash
brew --version
```

### 1c. Node.js 20
```bash
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version   # v20.x.x
```

### 1d. pnpm
```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version   # 9+ or 10+
```

---

## 2. Install browsers

### 2a. Google Chrome
Download from [google.com/chrome](https://www.google.com/chrome/) and drag to `/Applications`.

### 2b. Comet
Download from [perplexity.ai/comet](https://www.perplexity.ai/comet) and drag to `/Applications`.

---

## 3. Configure Comet

1. Open Comet
2. **Settings → Assistant → Site access**
3. Click **Add site**, type `localhost`, set to **Full access**

> ⚠️ Without this step Comet Assistant cannot interact with the viewer page.

---

## 4. Clone and install

```bash
git clone https://github.com/eonist/pplx-bridge
cd pplx-bridge
pnpm install
```

---

## 5. Run

```bash
pnpm start
```

This will:
1. Build all packages
2. Run a prereq check (including port 7001 free check)
3. Start the relay on `http://localhost:7001`
4. Launch an isolated Chrome on `perplexity.ai` with the recorder extension loaded

Then open **Comet** and go to:
```
http://localhost:7001/live
```

---

## 6. First-time Chrome setup (one time only)

The isolated Chrome profile starts fresh — log in to Perplexity once, then the session persists.

Chrome will show a **"debugger is attached"** banner — click **Keep** or ignore it. This is expected.

---

## Individual commands

```bash
pnpm build          # build all packages
pnpm check          # verify prereqs (including port check)
pnpm relay          # start relay only
pnpm chrome         # launch Chrome only
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7001` | Relay HTTP/WS port (7000 is reserved by macOS AirPlay) |
| `PPLX_BRIDGE_PROFILE` | `/tmp/pplx-bridge-profile` | Chrome profile dir |
| `PPLX_BRIDGE_CDP_PORT` | `9222` | Chrome remote debugging port |

Persist your Chrome login across reboots:
```bash
PPLX_BRIDGE_PROFILE=~/.pplx-bridge-profile pnpm start
```

---

## How it works

1. MV3 extension injects `rrweb.record()` into pplx.ai → streams DOM events to `ws://localhost:7001/ingest`
2. Relay fans events to viewer at `ws://localhost:7001/subscribe`
3. `live.html` in Comet runs `rrweb.Replayer` in live mode — Comet Assistant sees the live pplx.ai DOM
4. Comet clicks something → viewer resolves rrweb node id → posts to `ws://localhost:7001/actions`
5. Relay forwards action to recorder → real DOM event dispatched in Chrome

---

## Action types

| Type | Description | Method |
|---|---|---|
| `click` | Button / link / menu | `dispatchEvent` via rrweb mirror id |
| `input` | Composer / textarea | `execCommand('insertText')` or native setter |
| `keydown` | Enter, Escape, shortcuts | `dispatchEvent(KeyboardEvent)` |
| `scroll` | Thread list / sidebars | `element.scrollTo(x, y)` |
| `cdp` | File upload, clipboard | `chrome.debugger` → `Input.*` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: pnpm` | `corepack enable && corepack prepare pnpm@latest --activate` |
| `command not found: node` | `brew install node@20` + add to PATH |
| `EADDRINUSE :::7001` | `lsof -ti :7001 \| xargs kill -9` then retry |
| `EADDRINUSE :::7000` | That's macOS AirPlay — don't kill it, use port 7001 instead |
| Comet shows blank page | Make sure `pnpm start` is running and Chrome loaded pplx.ai |
| Status says "disconnected" | Relay not running — check terminal for errors |
| Comet Assistant does nothing | Set `localhost` to Full access in Comet site settings |
| `Extension not built` error | Run `pnpm build` first |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | You're not in the pplx-bridge folder — run `cd ~/pplx-bridge` first |

---

## Roadmap

[github.com/eonist/pplx-bridge/issues](https://github.com/eonist/pplx-bridge/issues)
