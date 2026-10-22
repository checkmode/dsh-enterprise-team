#!/bin/sh
# Enable full auto-reload for one or more profiles by pointing dsh-hmr at this
# working tree. Host modules reload on save; client-hmr swaps the browser half.
# Usage: scripts/dev-enable-hmr.sh [profile ...]   (default: web desktop)
set -eu
DEV=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
[ "$#" -gt 0 ] || set -- web desktop

for name in "$@"; do
  patch="$DSH_HOME/profiles/$name/cordis.patch.yml"
  if [ ! -f "$patch" ]; then
    echo "skip $name: no $patch" >&2
    continue
  fi
  if grep -q "$DEV" "$patch" 2>/dev/null; then
    echo "$name: already watching $DEV"
    continue
  fi
  cat >> "$patch" <<YAML

# Development auto-reload (scripts/dev-enable-hmr.sh)
- id: hmr
  disabled: false
  config:
    root:
      - "$DEV"
    debounce: 150
YAML
  echo "$name: added hmr root $DEV"
done
echo "restart the host once; afterwards saving lib/*.js reloads automatically"
