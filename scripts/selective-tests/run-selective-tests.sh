#!/bin/bash
# Run integration tests selectively based on changed files.
#
# This script wraps the TypeScript selection logic and handles CI-specific
# concerns like caching, fallback behavior, and output formatting.
#
# Usage: ./scripts/selective-tests/run-selective-tests.sh [--verbose] [--shadow-mode]
#
# Environment variables:
#   COVERAGE_MAP_PATH     Path to coverage map (default: coverage-map.json)
#   FORCE_ALL_TESTS       If set to "true", skip selection and run all tests
#   GITHUB_BASE_REF       Base ref for PR comparison (set by GitHub Actions)
#   GITHUB_HEAD_REF       Head ref for PR comparison (set by GitHub Actions)
#
# Exit codes:
#   0 - Tests passed (or no tests to run)
#   1 - Tests failed or error
#   2 - Fallback to all tests was triggered (informational in shadow mode)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Defaults
COVERAGE_MAP_PATH="${COVERAGE_MAP_PATH:-$PROJECT_ROOT/coverage-map.json}"
FORCE_ALL_TESTS="${FORCE_ALL_TESTS:-false}"
VERBOSE=""
SHADOW_MODE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --verbose)
      VERBOSE="--verbose"
      shift
      ;;
    --shadow-mode)
      SHADOW_MODE="true"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

log() {
  echo "[run-selective-tests] $1" >&2
}

# Determine git refs for comparison
if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
  BASE_REF="origin/$GITHUB_BASE_REF"
else
  BASE_REF="origin/main"
fi

if [[ -n "${GITHUB_SHA:-}" ]]; then
  HEAD_REF="$GITHUB_SHA"
else
  HEAD_REF="HEAD"
fi

log "Base ref: $BASE_REF"
log "Head ref: $HEAD_REF"
log "Coverage map: $COVERAGE_MAP_PATH"

# Check for force-all flag
FORCE_FLAG=""
if [[ "$FORCE_ALL_TESTS" == "true" ]]; then
  log "FORCE_ALL_TESTS is set, will run all tests"
  FORCE_FLAG="--force-all"
fi

# Run the selection script
log "Selecting affected tests..."

set +e
SELECTED_TESTS=$(bun "$SCRIPT_DIR/select-affected-tests.ts" \
  --map "$COVERAGE_MAP_PATH" \
  --base "$BASE_REF" \
  --head "$HEAD_REF" \
  --output jest \
  $VERBOSE \
  $FORCE_FLAG)
SELECT_EXIT_CODE=$?
set -e

log "Selection exit code: $SELECT_EXIT_CODE"
log "Selected tests: $SELECTED_TESTS"

# Handle shadow mode - run selection but always run all tests
if [[ -n "$SHADOW_MODE" ]]; then
  log "Shadow mode enabled - will run all tests regardless of selection"

  # Log what would have happened
  if [[ $SELECT_EXIT_CODE -eq 0 ]]; then
    log "SHADOW: Would have run selective tests: $SELECTED_TESTS"
  else
    log "SHADOW: Would have fallen back to all tests (exit code $SELECT_EXIT_CODE)"
  fi

  # Run all tests
  log "Running all integration tests..."
  TEST_INTEGRATION=1 bun x jest --coverage --maxWorkers=100% --silent tests
  exit $?
fi

# Handle the selection result
if [[ $SELECT_EXIT_CODE -eq 2 ]]; then
  # Fallback triggered - run all tests
  log "Fallback triggered, running all integration tests..."
  TEST_INTEGRATION=1 bun x jest --coverage --maxWorkers=100% --silent tests
  exit $?
elif [[ $SELECT_EXIT_CODE -ne 0 ]]; then
  # Error in selection script
  log "Error in selection script (exit code $SELECT_EXIT_CODE), falling back to all tests"
  TEST_INTEGRATION=1 bun x jest --coverage --maxWorkers=100% --silent tests
  exit $?
fi

# Check if no tests need to run
if [[ "$SELECTED_TESTS" == "--testPathPattern=^$" ]]; then
  log "No tests affected by changes, skipping integration tests"
  echo "::notice::No integration tests affected by changes - skipping"
  exit 0
fi

# Run selected tests
log "Running selected tests: $SELECTED_TESTS"
TEST_INTEGRATION=1 bun x jest --coverage --maxWorkers=100% --silent $SELECTED_TESTS
