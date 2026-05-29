#!/usr/bin/env bash
# Detects eager imports of AI SDK packages in main process
# These packages are large and must be lazy-loaded to maintain fast startup time

set -euo pipefail

# Files that should NOT have eager AI SDK imports
CRITICAL_FILES=(
  "src/main.ts"
  "src/config.ts"
  "src/preload.ts"
)

# Packages that should be lazily loaded
BANNED_IMPORTS=(
  "@ai-sdk/anthropic"
  "@ai-sdk/openai"
  "@ai-sdk/google"
  "@duckdb/node-api"
  "ai"
)

failed=0

echo "Checking for eager AI SDK imports in critical startup files..."

for file in "${CRITICAL_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    continue
  fi

  for pkg in "${BANNED_IMPORTS[@]}"; do
    # Check for top-level imports (not dynamic)
    if grep -E "^import .* from ['\"]$pkg" "$file" >/dev/null 2>&1; then
      echo "❌ EAGER IMPORT DETECTED: $file imports '$pkg'"
      echo "   AI SDK packages must use dynamic import() in critical path"
      failed=1
    fi
  done
done

# Also check dist/main.js for require() calls (if it exists)
if [ -f "dist/main.js" ]; then
  echo "Checking bundled main.js for eager requires..."
  for pkg in "${BANNED_IMPORTS[@]}"; do
    if grep "require(\"$pkg\")" dist/main.js >/dev/null 2>&1; then
      echo "❌ BUNDLED EAGER IMPORT: dist/main.js requires '$pkg'"
      echo "   This means a critical file is importing AI SDK eagerly"
      failed=1
    fi
  done
fi

if [ $failed -eq 1 ]; then
  echo ""
  echo "To fix: Use dynamic imports instead:"
  echo "  ✅ const { createAnthropic } = await import('@ai-sdk/anthropic');"
  echo "  ❌ import { createAnthropic } from '@ai-sdk/anthropic';"
  exit 1
fi

echo "✅ No eager AI SDK imports detected"
