#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
TRAINER="$PROJECT_DIR/scripts/evolve-autodraft-strategy.mjs"
ELECTRON_NODE="$PROJECT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

cd "$PROJECT_DIR"

if command -v node >/dev/null 2>&1; then
  exec node "$TRAINER" "$@"
fi

if [[ -x "$ELECTRON_NODE" ]]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$ELECTRON_NODE" "$TRAINER" "$@"
fi

echo "No Node.js runtime was found."
echo "Restore the project's node_modules folder or install Node.js 22 or newer."
exit 1
