#!/bin/sh
# Run fit-probe.html in headless Chrome and print one line per case. Needs: esbuild (npx), a Chrome/Chromium
# binary ($CHROME, or Playwright's chrome-headless-shell under ~/.cache/ms-playwright), python3.
#   probe/run.sh            # DOM renderer, dpr 1
#   probe/run.sh 2 canvas   # dpr 2, Canvas renderer (what mirrors use on real devices)
set -eu
cd "$(dirname "$0")/.."
DPR="${1:-1}"; MODE="${2:-dom}"
mkdir -p probe/dist
npx --yes esbuild src/fitFont.ts --bundle --format=iife --global-name=FF --outfile=probe/dist/fitFont.js --log-level=error
CANVAS=""
for c in node_modules/xterm-addon-canvas/lib/xterm-addon-canvas.js "$HOME/shmorganism/core/hq/frontend/node_modules/xterm-addon-canvas/lib/xterm-addon-canvas.js"; do
  [ -f "$c" ] && { CANVAS="$c"; break; }
done
[ -n "$CANVAS" ] && cp "$CANVAS" probe/dist/ || echo "(no xterm-addon-canvas found; canvas mode will fall back to DOM)" >&2
CHROME="${CHROME:-$(find "$HOME/.cache/ms-playwright" -name 'chrome-headless-shell' -type f 2>/dev/null | sort | tail -1)}"
[ -x "$CHROME" ] || { echo "no headless Chrome found; set CHROME=" >&2; exit 2; }
HASH=""; [ "$MODE" = canvas ] && HASH="#canvas"
timeout 90 "$CHROME" --headless --no-sandbox --disable-gpu --allow-file-access-from-files --force-device-scale-factor="$DPR" \
  --window-size=3600,1600 --virtual-time-budget=30000 --dump-dom "file://$PWD/probe/fit-probe.html$HASH" 2>/dev/null \
  | grep -o '<pre id="out">[^<]*' | sed 's/<pre id="out">//' | python3 probe/report.py
