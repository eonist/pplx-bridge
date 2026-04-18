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

---

## 1. Install system dependencies (fresh macOS)

### 1a. Xcode Command Line Tools
Required for git and build tools.
```bash
xcode-select --install
```
A dialog will appear — click **Install** and wait for it to finish (~5 min).

### 1b. Homebrew
The macOS package manager.
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Follow the prompts. At the end it will print two commands to add brew to your PATH — run those too. Then verify:
```bash
brew --version
```

### 1c. Node.js 20
```bash
brew install node@20
```
After install, brew will print a line like:
```
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
```
Add that to your shell config:
```bash
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version   # should print v20.x.x
```

### 1d. pnpm
```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version   # should print 9.x.x
```

---

## 2. Install browsers

### 2a. Google Chrome
Download from [google.com/chrome](https://www.google.com/chrome/) and drag to `/Applications`.

### 2b. Comet
Download from [perplexity.ai/comet](https://www.perplexity.ai/comet) and drag to `/Applications`.

---

## 3. Configure Comet

Open Comet, then:
1. Click the **⚙️ Settings** icon
2. Go to **Assistant → Site access**
3. Click **Add site**, type `localhost`, set access to **Full access**
4. Close settings

> ⚠️ Without this step Comet Assistant cannot interact with the viewer page.

---

## 4. Clone and install pplx-bridge

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
1. Build all packages (TypeScript → JS, extension bundle)
2. Run a prereq check
3. Start the relay on `http://localhost:7000`
4. Launch a **separate isolated Chrome** on `perplexity.ai` with the recorder extension loaded

Then open **Comet** and navigate to:
```
http://localhost:7000/live
```

You will see a live mirror of the pplx.ai tab. Open **Comet Assistant** and start giving it instructions.

---

## 6. First-time Chrome setup (one time only)

The isolated Chrome profile (`/tmp/pplx-bridge-profile`) starts fresh, so you need to log in to Perplexity once:

1. The Chrome window opens on `perplexity.ai`
2. Sign in with your account
3. That session is saved in the profile — you won't need to log in again unless you delete `/tmp/pplx-bridge-profile`

Also: Chrome will show a banner saying **"a debugger is attached"** — that's expected, click **Keep** or ignore it.

---

## Individual commands

```bash
pnpm build          # build all packages
pnpm check          # verify all prereqs are met
pnpm relay          # start relay only (Chrome separate)
pnpm chrome         # launch Chrome only (relay separate)
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PPLX_BRIDGE_PROFILE` | `/tmp/pplx-bridge-profile` | Chrome user data dir (isolated from your main profile) |
| `PPLX_BRIDGE_CDP_PORT` | `9222` | Chrome remote debugging port |
| `PORT` | `7000` | Relay HTTP/WS port |

Example: use a persistent profile location so you don't have to log in after reboot:
```bash
PPLX_BRIDGE_PROFILE=~/.pplx-bridge-profile pnpm start
```

---

## How it works

1. The MV3 extension injects `rrweb.record()` into the pplx.ai tab and streams DOM events to `ws://localhost:7000/ingest`.
2. The relay fans those events out to all viewer subscribers at `ws://localhost:7000/subscribe`.
3. `live.html` (opened in Comet) runs `rrweb.Replayer` in live mode — Comet Assistant sees the full, live pplx.ai DOM.
4. When Comet clicks something in the replayed iframe, the viewer resolves the rrweb node id and posts `{ type, id }` back through `ws://localhost:7000/actions`.
5. The relay forwards the action upstream to the recorder, which dispatches the real DOM event on the live node in Chrome.

---

## Action types

| Type | Description | Method |
|---|---|---|
| `click` | Button / link / menu | `dispatchEvent` via rrweb mirror id |
| `input` | Composer textarea / inputs | `execCommand('insertText')` for contenteditable, native setter for `<input>` |
| `keydown` | Enter, Escape, shortcuts | `dispatchEvent(KeyboardEvent)` |
| `scroll` | Thread list, sidebars | `element.scrollTo(x, y)` |
| `cdp` | File upload, clipboard, trusted gestures | `chrome.debugger` → `Input.*` CDP commands |

---

## Known limitations

- File upload and clipboard paste use the CDP path — Chrome will show a "debugger attached" banner; click **Keep**
- Canvas / WebGL areas render as best-effort (`recordCanvas: true`)
- Comet `localhost` site access must be set to **Full access** (see step 3)
- Cross-origin assets (images, fonts) are proxied through `/assets/*` on the relay
- First snapshot of a long pplx.ai thread may take 1–2 seconds to appear in Comet

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `zsh: command not found: pnpm` | Run `corepack enable && corepack prepare pnpm@latest --activate` |
| `zsh: command not found: node` | Run `brew install node@20` and follow the PATH instructions |
| Comet shows blank page at localhost:7000/live | Make sure `pnpm start` is running and Chrome has loaded pplx.ai |
| Status says "disconnected" in viewer | Relay isn't running — check Terminal 1 for errors |
| Comet Assistant does nothing | Check Comet → Settings → Assistant → Site access for `localhost` |
| Chrome debugger banner keeps appearing | Normal — click Keep. Required for CDP fallback actions |
| `Extension not built` error | Run `pnpm build` first |

---

## Roadmap / issues

[github.com/eonist/pplx-bridge/issues](https://github.com/eonist/pplx-bridge/issues)
