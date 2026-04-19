<div align="center">
  <h1>🌉 pplx-bridge</h1>

  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D_20-brightgreen.svg?style=flat-square" alt="Node.js Version" /></a>
    <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-%3E%3D_9-orange.svg?style=flat-square" alt="pnpm" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License: MIT" /></a>
    <a href="https://github.com/eonist/pplx-bridge/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs Welcome" /></a>
  </p>

  <h3>A local relay to stream live Chrome tabs as interactive JPEG feeds for vision-based AI assistants.</h3>
</div>

---

Stream a live Chrome tab (`perplexity.ai`) as a continuous feed to a local relay. Point **Comet** at the relay, and the Comet Assistant can "see" the page as a video stream—sending clicks, keystrokes, and scrolls back via the **Chrome DevTools Protocol (CDP)**.

## 📸 See it in Action

<!-- REPLACE THIS PLACEHOLDER WITH A REAL GIF OR SCREENSHOT -->
<div align="center">
  <img src="https://via.placeholder.com/800x400/1a1a1a/ffffff?text=Demo+GIF:+Comet+controlling+Perplexity.ai" alt="pplx-bridge demo" width="100%" />
  <p><i>Comet Assistant interacting with a live Perplexity.ai tab via the local relay.</i></p>
</div>

---

## 📑 Table of Contents

- [Architecture](#️-architecture)
- [Features](#-features)
- [Installation & Setup](#-installation--setup)
- [Configuration](#️-configuration)
- [Action Types](#️-action-types)
- [Project Structure](#️-project-structure)
- [FAQ & Troubleshooting](#-faq--troubleshooting)

---

## 🏗️ Architecture

The bridge operates by linking a debugging instance of Chrome to a local WebSocket relay, which then streams visual frames to the Comet viewer.

```mermaid
flowchart LR
    subgraph Browser ["🌐 Chrome Browser"]
        CDP["CDP (Port 9222)<br/>--remote-debugging"]
    end
    
    subgraph Relay ["⚡ Node.js Relay (localhost:7001)"]
        WS["WebSocket Server"]
    end
    
    subgraph Viewer ["🚀 Comet Browser"]
        Canvas["🖼️ live.html<br/>(Canvas JPEG Display)"]
    end
    
    CDP -- "1 FPS JPEG Frames" --> WS
    WS -- "Streams JPEG (WS)" --> Canvas
    Canvas -- "Mouse & Key Actions (WS)" --> WS
    WS -- "Injects Input via CDP" --> CDP
    
    style Browser fill:#f9f9f9,stroke:#333,stroke-width:2px
    style Relay fill:#e6f3ff,stroke:#0066cc,stroke-width:2px
    style Viewer fill:#f4fae8,stroke:#5c8a11,stroke-width:2px
```

---

## ✨ Features

- 🚀 **Live Streaming** — Captures Chrome tabs as a low-latency JPEG feed at 1 FPS.
- 🤖 **AI-Native** — Designed specifically for Comet Assistant to "see" live web pages.
- 🖱️ **Full Interaction** — Translates clicks, keystrokes, and scrolls back to the browser via CDP.
- 🔒 **Local & Secure** — Runs entirely on localhost, keeping browsing data and credentials private.
- 🛠️ **Developer Friendly** — Clean WebSockets architecture built on Node.js and TypeScript.

---

## 🚀 Installation & Setup

Follow these stages to configure your environment and run the bridge.

> [!WARNING]
> **Chrome must be running in remote debugging mode.** Normal instances of Chrome (launched via Spotlight or the Dock) do not expose the required CDP WebSocket.

### Stage 1: System Prerequisites (macOS)
*(Skip to Stage 2 if you already have Node 20+ and pnpm installed).*
```bash
xcode-select --install
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
corepack enable && corepack prepare pnpm@latest --activate
```

### Stage 2: Install & Configure Browsers
1. Download **[Google Chrome](https://www.google.com/chrome/)** and **[Comet](https://www.perplexity.ai/comet)**.
2. Open Comet and navigate to **Settings → Assistant → Site access**.
3. Click **Add site**, type `localhost`, and set it to **Full access**.

> [!IMPORTANT]
> Without granting full site access to `localhost`, Comet Assistant will be blocked from reading the canvas or interacting with the viewer page.

### Stage 3: Clone & Build
```bash
git clone https://github.com/eonist/pplx-bridge.git
cd pplx-bridge
pnpm install
```

### Stage 4: Launch Chrome (Debug Mode)
Open a **new terminal tab** and launch an isolated Chrome profile:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=~/.pplx-bridge-profile \
  https://perplexity.ai
```
*(Note: You will need to log into Perplexity on the first run. The custom user-data-dir ensures your session persists across reboots).*

### Stage 5: Start the Relay & Connect
In your **original terminal tab** (inside the `pplx-bridge` folder):
```bash
pnpm start
```
*When successful, the terminal will output:* `[relay] CDP ready — input + screenshots active`.

Finally, open **Comet** and navigate to `http://localhost:7001/live`. You will see the live JPEG stream with a **● live** status indicator in the bottom right.

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `7001` | Relay HTTP/WS port (7000 is reserved by macOS AirPlay) |
| `PPLX_BRIDGE_CDP_PORT` | `9222` | Chrome remote debugging port |

### NPM Scripts

| Command | Action |
| :--- | :--- |
| `pnpm build` | Compiles TypeScript for all workspace packages |
| `pnpm start` | Builds packages and starts the relay |
| `pnpm dev` | Runs the development server in parallel |
| `pnpm chrome` | Launches Chrome with the correct CDP flags |

---

## 🕹️ Action Types

The WebSocket relay translates incoming JSON payloads from the viewer into the following Chrome DevTools Protocol commands:

| Type | Payload | CDP Method |
| :--- | :--- | :--- |
| `click` | `{x, y}` normalised 0–1 | `Input.dispatchMouseEvent` |
| `type` | `{value}` single char | `Input.insertText` |
| `keydown` | `{key, code, modifiers}` | `Input.dispatchKeyEvent` |
| `scroll` | `{x, y}` delta | `Input.dispatchMouseEvent` (mouseWheel) |
| `mousemove` | `{x, y}` normalised 0–1 | `Input.dispatchMouseEvent` |

---

## 🗂️ Project Structure

```text
pplx-bridge/
├── .github/             # GitHub Actions & issue templates
├── packages/            # Monorepo packages
│   └── relay/           # Node.js WebSocket server & CDP client
├── scripts/             # Bash scripts for setup & launching Chrome
├── ACTION_PROTOCOL.md   # Documentation for action formatting
├── package.json         # Workspace configuration
└── pnpm-workspace.yaml  # pnpm workspace definition
```

---

## 🚑 FAQ & Troubleshooting

<details>
<summary><b>Viewer shows "disconnected"</b></summary>
<br/>
The relay is not running. Ensure you have run <code>pnpm start</code> in the <code>pplx-bridge</code> directory and that no errors were thrown.
</details>

<details>
<summary><b>Viewer shows a blank or black screen</b></summary>
<br/>
Chrome is likely not focused on a visible page. Click any tab within the debugged Chrome window to force a frame update.
</details>

<details>
<summary><b>Comet Assistant does nothing when prompted</b></summary>
<br/>
Comet does not have permission to interact with the local relay. Ensure <code>localhost</code> is set to <strong>Full access</strong> in Comet → Settings → Site access.
</details>

<details>
<summary><b>Error: <code>[relay] CDP connect failed</code></b></summary>
<br/>
Chrome is not running with the required debugging flags. Stop Chrome completely and relaunch it using the command provided in Stage 4.
</details>

<details>
<summary><b>Error: <code>EADDRINUSE :::7001</code></b></summary>
<br/>
The port is already in use by another process. Run <code>lsof -ti :7001 | xargs kill -9</code> to free the port, then retry.
</details>

<br/>

> **Still having issues?** Contributions and bug reports are welcome! Please check the [Issues page](https://github.com/eonist/pplx-bridge/issues) for our current roadmap and known bugs.
