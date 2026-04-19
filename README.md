# pplx-bridge

Stream a live Chrome tab (`perplexity.ai`) as a JPEG feed to a local relay, then point **Comet** at `http://localhost:7001/live`. Comet Assistant sees the live page as a video stream and sends clicks, keystrokes, and scrolls back through the relay via **Chrome DevTools Protocol (CDP)**.

```
Chrome (perplexity.ai)                       Comet (live viewer)
┌──────────────────────┐                    ┌─────────────────────┐
│ CDP --remote-debugging  │◀──actions (WS)──│ canvas JPEG display  │
│ port 9222               │                │ keydown/click sender │
└──────────────────────┘                └─────────────────────┘
          │ JPEG frames (WS)                         ↑
          └─────────── localhost:7001 relay ───────────┘
```

---

## 1. Install system dependencies (bare macOS)

### 1a. Xcode Command Line Tools
```bash
xcode-select --install
```
A dialog appears — click **Install** and wait (~5 min).

### 1b. Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
At the end, run the two `echo` / `eval` commands it prints to add Homebrew to your PATH, then verify:
```bash
brew --version
```

### 1c. Node.js 20
```bash
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version   # should print v20.x.x
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
2. Go to **Settings → Assistant → Site access**
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

## 5. Start Chrome with remote debugging

Open a **new terminal tab** and run:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pplx-bridge-profile \
  https://perplexity.ai
```

This launches an isolated Chrome profile pointed at Perplexity. Keep this terminal open.

> **First run:** Chrome will be signed out — log in to Perplexity once. The session is saved in `/tmp/pplx-bridge-profile` and persists until you reboot. To keep your login across reboots use a permanent path:
> ```bash
> --user-data-dir=~/.pplx-bridge-profile
> ```

---

## 6. Start the relay

In a **second terminal tab**:

```bash
cd ~/pplx-bridge
pnpm start
```

You should see:
```
╔════════════════════════════════════════════╗
║  pplx-bridge relay  →  localhost:7001            ║
╚════════════════════════════════════════════╝
[cdp] connected → https://www.perplexity.ai/ (viewport 929x598)
[relay] CDP ready — input + screenshots active
```

If you see `[relay] CDP connect failed` — Chrome isn’t running with `--remote-debugging-port=9222`. Go back to step 5.

---

## 7. Open the viewer in Comet

Open **Comet** and navigate to:
```
http://localhost:7001/live
```

You should see a live JPEG stream of your Chrome tab. The status dot in the bottom-right reads **● live**.

Comet Assistant can now click, type, and scroll on the live Perplexity page.

---

## Individual commands

```bash
pnpm build      # build all packages
pnpm start      # build + start relay (requires Chrome already running)
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7001` | Relay HTTP/WS port (7000 is reserved by macOS AirPlay) |
| `PPLX_BRIDGE_CDP_PORT` | `9222` | Chrome remote debugging port |

---

## How it works

1. Chrome starts with `--remote-debugging-port=9222`, exposing the CDP WebSocket
2. The relay connects to CDP and starts capturing JPEG screenshots at 1 FPS
3. Each JPEG frame is broadcast over `ws://localhost:7001/stream` to all viewer tabs
4. `live.html` renders frames on a `<canvas>` — Comet sees the live page as a video feed
5. Comet clicks or types → `live.html` sends the action to `ws://localhost:7001/actions`
6. Relay receives the action and injects it into Chrome via CDP (`Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`)

---

## Action types

| Type | Payload | CDP method |
|---|---|---|
| `click` | `{x, y}` normalised 0–1 | `Input.dispatchMouseEvent` |
| `type` | `{value}` single char | `Input.insertText` |
| `keydown` | `{key, code, modifiers}` | `Input.dispatchKeyEvent` |
| `scroll` | `{x, y}` delta | `Input.dispatchMouseEvent` (mouseWheel) |
| `mousemove` | `{x, y}` normalised 0–1 | `Input.dispatchMouseEvent` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `command not found: pnpm` | `corepack enable && corepack prepare pnpm@latest --activate` |
| `command not found: node` | `brew install node@20` + add to PATH (step 1c) |
| `EADDRINUSE :::7001` | `lsof -ti :7001 \| xargs kill -9` then retry |
| `[relay] CDP connect failed` | Chrome isn’t running with `--remote-debugging-port=9222` — re-run step 5 |
| Viewer shows “disconnected” | Relay not running — run `pnpm start` in the pplx-bridge folder |
| Viewer shows blank / black | Chrome isn’t on a visible page — click any tab in Chrome |
| Comet Assistant does nothing | Set `localhost` to **Full access** in Comet → Settings → Site access |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | Run `cd ~/pplx-bridge` first |
| Login lost after reboot | Use `--user-data-dir=~/.pplx-bridge-profile` (permanent path) |

---

## Roadmap

[github.com/eonist/pplx-bridge/issues](https://github.com/eonist/pplx-bridge/issues)
