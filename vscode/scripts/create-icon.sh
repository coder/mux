#!/usr/bin/env bash
# Create icon.png from the mux logo for the VS Code extension
# Create icon.png from the cmux logo for the VS Code extension
=======
#!/bin/bash
# Create icon.png from the mux logo for the VS Code extension
>>>>>>> 8dda7f224 (🤖 chore: rename cmux refs to mux)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VSCODE_DIR="$(dirname "$SCRIPT_DIR")"
LOGO_PATH="$VSCODE_DIR/../docs/img/logo.webp"
ICON_PATH="$VSCODE_DIR/icon.png"

if [ ! -f "$LOGO_PATH" ]; then
  echo "❌ Logo not found at $LOGO_PATH"
  exit 1
fi

# Try to find an image conversion tool
if command -v magick &> /dev/null; then
  CONVERT_CMD="magick"
elif command -v convert &> /dev/null; then
  CONVERT_CMD="convert"
else
  echo "❌ ImageMagick not found. Please install it:"
  echo "   macOS: brew install imagemagick"
  echo "   Linux: sudo apt-get install imagemagick"
  exit 1
fi

# Convert logo to PNG at 128x128 (VS Code recommended size)
echo "Converting logo to icon.png (128x128)..."
$CONVERT_CMD "$LOGO_PATH" -resize 128x128 "$ICON_PATH"

echo "✓ Created $ICON_PATH"
echo ""
echo "Now update package.json to include:"
echo '  "icon": "icon.png",'
