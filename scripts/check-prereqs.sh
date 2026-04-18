#!/usr/bin/env bash
# Run before pnpm start to catch common setup mistakes
set -euo pipefail

OK=true

check() {
  local label="$1" cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo "  ✅  $label"
  else
    echo "  ❌  $label"
    OK=false
  fi
}

echo ""
echo "pplx-bridge prereq check"
echo "────────────────────────"
check "Node >= 20"       "node -e 'if(+process.versions.node.split(\".\")[0]<20)process.exit(1)'"
check "pnpm installed"   "pnpm --version"
check "Extension built"  "test -f packages/extension/dist/recorder.js"
check "Relay built"      "test -f packages/relay/dist/index.js"
check "viewer HTML"      "test -f packages/relay/dist/public/live.html"

if [[ "$(uname)" == "Darwin" ]]; then
  check "Chrome (macOS)" "test -f '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'"
else
  check "Chrome (Linux)" "command -v google-chrome || command -v chromium-browser"
fi

echo ""
if [ "$OK" = true ]; then
  echo "✔  All checks passed — run: pnpm start"
else
  echo "⚠️  Fix the above before running pnpm start"
  exit 1
fi
echo ""
