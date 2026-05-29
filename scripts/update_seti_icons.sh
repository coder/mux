#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSET_DIR="$ROOT_DIR/src/browser/assets/file-icons"
FONT_PATH="$ROOT_DIR/public/seti.woff"

mkdir -p "$ASSET_DIR"

curl -sSL "https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-seti/icons/seti.woff" \
  -o "$FONT_PATH"

curl -sSL "https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-seti/icons/vs-seti-icon-theme.json" \
  -o "$ASSET_DIR/seti-icon-theme.json"

echo "Updated Seti icon assets in $ASSET_DIR and font at $FONT_PATH"
