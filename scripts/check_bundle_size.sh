#!/usr/bin/env bash
# Tracks bundle sizes and fails if main.js grows too much
# Large main.js usually indicates eager imports of heavy dependencies

set -euo pipefail

MAIN_JS_MAX_KB=${MAIN_JS_MAX_KB:-20} # 20KB for main.js (currently ~15KB)

if [ ! -f "dist/main.js" ]; then
  echo "❌ dist/main.js not found. Run 'make build' first."
  exit 1
fi

# Get file size (cross-platform: macOS and Linux)
if stat -f%z dist/main.js >/dev/null 2>&1; then
  # macOS
  main_size=$(stat -f%z dist/main.js)
else
  # Linux
  main_size=$(stat -c%s dist/main.js)
fi

main_kb=$((main_size / 1024))

echo "Bundle sizes:"
echo "  dist/main.js: ${main_kb}KB (max: ${MAIN_JS_MAX_KB}KB)"

if [ "$main_kb" -gt "$MAIN_JS_MAX_KB" ]; then
  echo "❌ BUNDLE SIZE REGRESSION: main.js (${main_kb}KB) exceeds ${MAIN_JS_MAX_KB}KB"
  echo ""
  echo "This usually means new eager imports were added to main process."
  echo "Check for imports in src/main.ts, src/config.ts, or src/preload.ts"
  echo ""
  echo "Run './scripts/check_eager_imports.sh' to identify the issue."
  exit 1
fi

echo "✅ Bundle size OK"
