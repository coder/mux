#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Check for PNG files in docs - suggest WebP instead
echo "Checking for PNG files in docs..."
PNG_FILES=$(git ls-files 'docs/*.png' 'docs/**/*.png' 2>/dev/null || true)
if [ -n "$PNG_FILES" ]; then
  echo "❌ Error: PNG files found in docs directory. Please use WebP format instead:"
  echo "$PNG_FILES"
  echo ""
  echo "Convert with:"
  for png in $PNG_FILES; do
    webp="${png%.png}.webp"
    echo "  cwebp '$png' -o '$webp' -q 85"
  done
  exit 1
fi

ESLINT_PATTERN='src/**/*.{ts,tsx}'

if [ "$1" = "--fix" ]; then
  echo "Running bun x eslint with --fix..."
  bun x eslint --cache --cache-strategy content --max-warnings 0 "$ESLINT_PATTERN" --fix
else
  echo "Running eslint..."
  bun x eslint --cache --cache-strategy content --max-warnings 0 "$ESLINT_PATTERN"
  echo "ESLint checks passed!"
fi
