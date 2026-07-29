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

# Workflow runtime and packaged skill workflow sources are executable JS embedded
# into the app; lint them alongside the TS sources (they get dedicated
# non-type-aware config blocks).
ESLINT_PATTERNS=(
  'src/**/*.{ts,tsx}'
  'src/node/builtinSkills/**/*.js'
  'src/node/workflowRuntime/*.js'
)

get_default_eslint_concurrency() {
  # Most local `make static-check` runs are warm-cache validation after a small
  # edit. ESLint's worker startup/merge overhead dominates that path, so keep it
  # single-process once the cache exists; cold caches still scale up for CI-like
  # first runs.
  if [ -f .eslintcache ]; then
    echo 1
    return
  fi

  # ESLint's --concurrency lanes are worker threads sharing one heap, so a cold
  # type-aware run scales memory, not just CPU. Size it against the cgroup's
  # actual headroom rather than the visible core count.
  # stderr is left attached so MUX_WORKER_BUDGET_DEBUG output and any real breakage stay visible;
  # the fallback below only covers the helper failing outright.
  local concurrency
  if concurrency="$(node "$SCRIPT_DIR/lib/worker_budget.js" eslint)" \
    && [[ "$concurrency" =~ ^[0-9]+$ ]] && [ "$concurrency" -gt 0 ]; then
    echo "$concurrency"
  else
    echo 2
  fi
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
  bun x eslint "${ESLINT_ARGS[@]}" "${ESLINT_PATTERNS[@]}" --fix
else
  echo "Running eslint (concurrency=$ESLINT_CONCURRENCY)..."
  bun x eslint "${ESLINT_ARGS[@]}" "${ESLINT_PATTERNS[@]}"
  echo "ESLint checks passed!"
fi
