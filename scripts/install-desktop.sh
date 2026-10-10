#!/bin/bash
# Install dsh-think-zh into the desktop profile without pnpm.
#
# The plugin is a workspace package, so it is exposed to the profile with a symlink
# and switched on by appending one row to the profile's own patch layer. Idempotent:
# re-running replaces the symlink and leaves an already-present row alone.
set -euo pipefail

PLUGIN="${PLUGIN:-/Users/mac/Documents/deepseek-harness/default-workspace/dsh-think-zh}"
PROFILE="${PROFILE:-$HOME/.dsh/profiles/desktop}"
PATCH="$PROFILE/cordis.patch.yml"
ROW_ID="dsh-think-zh"

[ -f "$PLUGIN/package.json" ] || { echo "plugin package.json missing at $PLUGIN" >&2; exit 1; }

# Resolve a node binary explicitly: the smoke test is a hard gate, and silently
# skipping it because PATH lacks node would defeat the gate.
NODE="${DSH_NODE:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
    NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
  else
    echo "cannot find node to run the pre-install smoke test; set DSH_NODE=/path/to/node" >&2
    exit 1
  fi
fi
[ -f "$PLUGIN/lib/client.js" ] || { echo "client bundle missing — run node scripts/build-client.mjs first" >&2; exit 1; }

# A client bundle that throws while the shell loads it is a FATAL boot error on
# Desktop (and the app's recovery then resets the profile patch), so refuse to
# install one that fails the loader-less smoke test.
if ! "$NODE" "$PLUGIN/scripts/smoke-client.mjs"; then
  echo "refusing to install: fix the bundle first (see the failures above)" >&2
  exit 1
fi
[ -f "$PROFILE/package.json" ] || { echo "no desktop profile at $PROFILE — open the app once first" >&2; exit 1; }

mkdir -p "$PROFILE/node_modules"
ln -sfn "$PLUGIN" "$PROFILE/node_modules/$ROW_ID"
echo "linked: $PROFILE/node_modules/$ROW_ID -> $PLUGIN"

if [ -f "$PATCH" ] && grep -q "^    - id: $ROW_ID$" "$PATCH"; then
  echo "row already present in $PATCH"
else
  if [ -f "$PATCH" ]; then
    BACKUP="$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$PATCH" "$BACKUP"
    echo "backed up: $BACKUP"
  fi
  cat >> "$PATCH" <<YAML

# dsh-think-zh — 把模型思考过程实时翻译成中文显示（只作用于显示层）
- insert:
    - id: $ROW_ID
      name: $ROW_ID
YAML
  echo "row appended to $PATCH"
fi

echo
echo "installed. now fully quit and reopen the DeepSeek Harness app —"
echo "the desktop shell collects plugin rows once at host startup, so a page refresh is not enough."
echo
echo "config: \$DSH_HOME/dsh-think-zh/config.json"
echo "settings: the 「思」 chip at the top-right of the chat window"
