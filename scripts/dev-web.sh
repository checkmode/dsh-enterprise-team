#!/bin/sh
# Restart the source Web host so host and client halves reload from this tree.
set -eu
SRC_REPO=${DSH_SRC_REPO:-/Volumes/code-vol/code/harness/deepseek-harness}
LOG=${DSH_WEB_LOG:-/tmp/dsh-web.log}
cd "$SRC_REPO"
pkill -f "apps/cli/src/bin.ts web" 2>/dev/null || true
sleep 1
nohup pnpm start:web --no-open > "$LOG" 2>&1 &
sleep 12
grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" | tail -1
if grep -q "did not activate" "$LOG"; then
  echo "WARNING: an entry did not activate:" >&2
  grep -A3 "did not activate" "$LOG" >&2
fi
