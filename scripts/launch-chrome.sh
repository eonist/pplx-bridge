#!/usr/bin/env bash
# macOS path — adjust for Linux: google-chrome or chromium-browser
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EXT_DIR="$(cd "$(dirname "$0")/../packages/extension/dist" && pwd)"
PROFILE_DIR="/tmp/pplx-bridge-profile"

echo "→ Launching Chrome with CDP on port 9222"
echo "  Extension: $EXT_DIR"
echo "  Profile:   $PROFILE_DIR"

"$CHROME" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --no-first-run \
  --no-default-browser-check \
  https://www.perplexity.ai
