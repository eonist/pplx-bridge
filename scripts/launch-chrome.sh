#!/usr/bin/env bash
set -euo pipefail

# ── Detect Chrome path ────────────────────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  # Linux — try common paths
  CHROME=$(command -v google-chrome || command -v chromium-browser || command -v chromium || echo "")
fi

if [[ -z "$CHROME" || ! -f "$CHROME" ]]; then
  echo "❌ Chrome not found. Set CHROME env var to the binary path."
  exit 1
fi

# ── Paths ───────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/packages/extension/dist"
PROFILE_DIR="${PPLX_BRIDGE_PROFILE:-/tmp/pplx-bridge-profile}"
DEBUG_PORT="${PPLX_BRIDGE_CDP_PORT:-9222}"

if [[ ! -d "$EXT_DIR" ]]; then
  echo "❌ Extension not built. Run: pnpm build"
  exit 1
fi

echo ""
echo "▶  pplx-bridge: launching Chrome"
echo "   Binary:   $CHROME"
echo "   Profile:  $PROFILE_DIR"
echo "   CDP port: $DEBUG_PORT"
echo "   Extension: $EXT_DIR"
echo ""

"$CHROME" \
  --remote-debugging-port="$DEBUG_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="$EXT_DIR" \
  https://www.perplexity.ai
