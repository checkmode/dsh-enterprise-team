#!/bin/sh
# Link the working tree into the profiles and the dsh source checkout so a
# restart (or Plugins reload) picks up local edits instead of the GitHub copy.
set -eu
DEV=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROFILE_WEB=${PROFILE_WEB:-$HOME/.dsh/profiles/web}
PROFILE_DESKTOP=${PROFILE_DESKTOP:-$HOME/.dsh/profiles/desktop}
SRC_REPO=${DSH_SRC_REPO:-/Volumes/code-vol/code/harness/deepseek-harness}

link() {
  target=$1
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  ln -s "$DEV" "$target"
  echo "linked $target -> $DEV"
}

link "$PROFILE_WEB/node_modules/dsh-enterprise-team"
[ -d "$PROFILE_DESKTOP" ] && link "$PROFILE_DESKTOP/node_modules/dsh-enterprise-team"
[ -d "$SRC_REPO/node_modules" ] && link "$SRC_REPO/node_modules/dsh-enterprise-team"
echo "done; restart the host (desktop app or scripts/dev-web.sh) to load edits"
