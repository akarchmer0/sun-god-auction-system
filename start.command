#!/bin/zsh

set -e

PROJECT_DIR="${0:A:h}"
BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if command -v node >/dev/null 2>&1 && [[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>/dev/null)" == "true" ]]; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$BUNDLED_NODE" ]]; then
  NODE_BIN="$BUNDLED_NODE"
else
  echo "Sun God Auction Systems needs Node.js 22 or newer for realtime Cartesia speech."
  echo "Install it from https://nodejs.org, then run this launcher again."
  exit 1
fi

cd "$PROJECT_DIR"
exec "$NODE_BIN" server.mjs
