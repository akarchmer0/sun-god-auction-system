#!/bin/zsh

set -e

PROJECT_DIR="${0:A:h}"
BUNDLED_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
PYTHON_BIN="/usr/bin/python3"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$BUNDLED_NODE" ]]; then
  NODE_BIN="$BUNDLED_NODE"
else
  echo "Gavel needs Node.js 18 or newer."
  echo "Install it from https://nodejs.org, then run this launcher again."
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Gavel needs macOS Python 3 to run its local speaker-recognition engine."
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/.runtime/python" || ! -f "$PROJECT_DIR/vendor/sherpa-models/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx" ]]; then
  echo "Gavel's local speaker-recognition files are missing. Restore the .runtime and vendor/sherpa-models folders, then run this launcher again."
  exit 1
fi

cd "$PROJECT_DIR"
export GAVEL_PYTHON="$PYTHON_BIN"
exec "$NODE_BIN" server.mjs
