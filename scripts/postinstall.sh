#!/usr/bin/env bash
set -euo pipefail

# Only rebuild node-pty for Electron if Electron is installed (for dev or packaged app usage)
# For npm CLI installs, node-pty will use its default Node.js ABI which works fine
if [ -d "node_modules/electron" ]; then
  echo "Electron detected - rebuilding node-pty for Electron ABI..."

  # Use bun x or npx depending on what's available
  if command -v bun &>/dev/null; then
    bun x @electron/rebuild -f -m node_modules/node-pty
  elif command -v npx &>/dev/null; then
    npx @electron/rebuild -f -m node_modules/node-pty
  else
    echo "Warning: Neither bun nor npx found, skipping rebuild"
    echo "node-pty may not work correctly in Electron"
  fi
else
  echo "Electron not detected - using node-pty with Node.js ABI (CLI mode)"
fi
