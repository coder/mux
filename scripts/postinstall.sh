#!/usr/bin/env sh
# Conditional postinstall script for node-pty
#
# Compatible with all environments (no node/bun required).
#
# Desktop mode (Electron present):
#   - Rebuilds node-pty for Electron's ABI
#
# Server mode (no Electron):
#   - Uses Node.js/Bun prebuilt binaries (no rebuild needed)

set -e

# Get script directory (works in both sh and bash)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_PATH="$PROJECT_ROOT/node_modules/electron"

if [ -d "$ELECTRON_PATH" ]; then
  echo "🔧 Electron detected - rebuilding node-pty for Electron..."

  # Try npx first, fallback to bunx
  if command -v npx >/dev/null 2>&1; then
    npx @electron/rebuild -f -m node_modules/node-pty || {
      echo "⚠️  Failed to rebuild native modules"
      echo "   Terminal functionality may not work in desktop mode."
      echo "   Run 'make rebuild-native' manually to fix."
      exit 0
    }
  elif command -v bunx >/dev/null 2>&1; then
    bunx @electron/rebuild -f -m node_modules/node-pty || {
      echo "⚠️  Failed to rebuild native modules"
      echo "   Terminal functionality may not work in desktop mode."
      echo "   Run 'make rebuild-native' manually to fix."
      exit 0
    }
  else
    echo "⚠️  Neither npx nor bunx found - cannot rebuild native modules"
    echo "   Terminal functionality may not work in desktop mode."
    echo "   Run 'make rebuild-native' manually to fix."
    exit 0
  fi

  echo "✅ Native modules rebuilt successfully"
else
  echo "🌐 Server mode detected - using prebuilt binaries"
fi
