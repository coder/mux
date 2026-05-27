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

get_cpu_count() {
  local cpu_count=""

  if command -v getconf >/dev/null 2>&1; then
    cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  fi

  if [ -z "$cpu_count" ] && command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc 2>/dev/null || true)"
  fi

  if [ -z "$cpu_count" ] && command -v sysctl >/dev/null 2>&1; then
    cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  fi

  if [[ "$cpu_count" =~ ^[0-9]+$ ]] && [ "$cpu_count" -gt 0 ]; then
    echo "$cpu_count"
  else
    echo 2
  fi
}

get_default_eslint_concurrency() {
  local cpu_count
  local concurrency

  # Most local `make static-check` runs are warm-cache validation after a small
  # edit. ESLint's worker startup/merge overhead dominates that path, so keep it
  # single-process once the cache exists; cold caches still scale up for CI-like
  # first runs.
  if [ -f .eslintcache ]; then
    echo 1
    return
  fi

  cpu_count="$(get_cpu_count)"
  concurrency=$(((cpu_count + 1) / 2))

  # User rationale: local static-check should scale up on agent/desktop machines
  # without letting ESLint's auto concurrency spawn one worker per core.
  if [ "$concurrency" -lt 2 ]; then
    concurrency=2
  elif [ "$concurrency" -gt 8 ]; then
    concurrency=8
  fi

  echo "$concurrency"
}

ESLINT_CONCURRENCY="${MUX_ESLINT_CONCURRENCY:-$(get_default_eslint_concurrency)}"
ESLINT_ARGS=(
  --concurrency "$ESLINT_CONCURRENCY"
  --cache
  --cache-strategy content
  --max-warnings 0
)

if [ "${1:-}" = "--fix" ]; then
  echo "Running bun x eslint with --fix (concurrency=$ESLINT_CONCURRENCY)..."
  bun x eslint "${ESLINT_ARGS[@]}" "$ESLINT_PATTERN" --fix
else
  echo "Running eslint (concurrency=$ESLINT_CONCURRENCY)..."
  bun x eslint "${ESLINT_ARGS[@]}" "$ESLINT_PATTERN"
  echo "ESLint checks passed!"
fi
