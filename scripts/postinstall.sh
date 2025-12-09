#!/usr/bin/env sh
# Conditional postinstall script for node-pty
#
# Desktop mode (Electron present):
#   - Rebuilds node-pty for Electron's ABI (once per version/platform)
#
# Server mode (no Electron):
#   - Uses Node.js/Bun prebuilt binaries (no rebuild needed)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_PATH="$PROJECT_ROOT/node_modules/electron"
NODE_PTY_PATH="$PROJECT_ROOT/node_modules/node-pty"

# 1) Skip if this is not the mux repo root (installed as a dependency)
if [ "${INIT_CWD:-$PROJECT_ROOT}" != "$PROJECT_ROOT" ]; then
  echo "📦 mux installed as a dependency – skipping native rebuild"
  exit 0
fi

# 2) Skip if Electron or node-pty aren't installed
if [ ! -d "$ELECTRON_PATH" ] || [ ! -d "$NODE_PTY_PATH" ]; then
  echo "🌐 Server mode detected or Electron/node-pty missing – skipping native rebuild"
  exit 0
fi

# 3) Build a cache key (Electron version + node-pty version + platform + arch)
ELECTRON_VERSION="$(
  node -p "require('${ELECTRON_PATH}/package.json').version" 2>/dev/null || echo "unknown"
)"
NODE_PTY_VERSION="$(
  node -p "require('${NODE_PTY_PATH}/package.json').version" 2>/dev/null || echo "unknown"
)"

PLATFORM="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

STAMP_DIR="$PROJECT_ROOT/node_modules/.cache/mux-native"
STAMP_FILE="$STAMP_DIR/node-pty-${ELECTRON_VERSION}-${NODE_PTY_VERSION}-${PLATFORM}-${ARCH}.stamp"

mkdir -p "$STAMP_DIR"

# 4) Skip if we've already rebuilt for this combo
if [ -f "$STAMP_FILE" ]; then
  echo "✅ node-pty already rebuilt for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH} – skipping"
  exit 0
fi

echo "🔧 Rebuilding node-pty for Electron ${ELECTRON_VERSION} on ${PLATFORM}/${ARCH}..."

# 5) Run rebuild
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

# 6) Mark this combo as done
touch "$STAMP_FILE"
echo "✅ Native modules rebuilt successfully (cached at $STAMP_FILE)"
