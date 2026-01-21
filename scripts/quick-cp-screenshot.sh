#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check if filename argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <filename>"
  echo "Example: $0 command-palette"
  echo ""
  echo "This will find the latest screenshot, convert it to WebP, and save as docs/img/<filename>.webp"
  exit 1
fi

FILENAME="$1"

# Remove .webp or .png extension if provided
FILENAME="${FILENAME%.webp}"
FILENAME="${FILENAME%.png}"

# Find the latest screenshot - check custom location first, then Desktop
# Check for both WebP and PNG files
# shellcheck disable=SC2012 # ls -t is fine here for simple "most recent" lookup in known locations
LATEST_SCREENSHOT=$(ls -t ~/Documents/Screenshots/*.{webp,png} ~/Desktop/*.{webp,png} 2>/dev/null | head -1)

if [ -z "$LATEST_SCREENSHOT" ]; then
  echo "❌ Error: No screenshots found in ~/Documents/Screenshots/ or ~/Desktop/"
  exit 1
fi

echo "Found screenshot: $LATEST_SCREENSHOT"

# Ensure docs/img directory exists
mkdir -p "$PROJECT_ROOT/docs/img"

OUTPUT_FILE="$PROJECT_ROOT/docs/img/$FILENAME.webp"

# Check if the screenshot is already WebP
if [[ "$LATEST_SCREENSHOT" == *.webp ]]; then
  echo "Using existing WebP file..."
  cp "$LATEST_SCREENSHOT" "$OUTPUT_FILE"
else
  # Convert PNG to WebP using cwebp
  echo "Converting PNG to WebP..."
  if ! command -v cwebp &>/dev/null; then
    echo "❌ Error: cwebp not found. Install with: brew install webp"
    exit 1
  fi
  cwebp "$LATEST_SCREENSHOT" -o "$OUTPUT_FILE" -q 85
fi

# Remove the original screenshot
rm "$LATEST_SCREENSHOT"

echo "✅ Screenshot saved as: docs/img/$FILENAME.webp"
echo "   Original screenshot removed"
