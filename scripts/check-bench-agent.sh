#!/usr/bin/env bash
set -euo pipefail

# This script verifies that the terminal-bench agent entry point
# referenced in mux-run.sh is valid and can be executed (imports resolve).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MUX_RUN_SH="$REPO_ROOT/benchmarks/terminal_bench/mux-run.sh"

echo "Checking terminal-bench agent configuration..."

if [[ ! -f "$MUX_RUN_SH" ]]; then
  echo "❌ Error: $MUX_RUN_SH not found"
  exit 1
fi

# Extract the agent CLI path from mux-run.sh
# Looks for line like: cmd=(bun src/cli/run.ts
CLI_PATH_MATCH=$(grep -o "bun src/.*\.ts" "$MUX_RUN_SH" | head -1 | cut -d' ' -f2)

if [[ -z "$CLI_PATH_MATCH" ]]; then
  echo "❌ Error: Could not find agent CLI path in $MUX_RUN_SH"
  exit 1
fi

FULL_CLI_PATH="$REPO_ROOT/$CLI_PATH_MATCH"

echo "Found agent CLI path: $CLI_PATH_MATCH"

if [[ ! -f "$FULL_CLI_PATH" ]]; then
  echo "❌ Error: Referenced file $FULL_CLI_PATH does not exist"
  exit 1
fi

echo "Verifying agent CLI startup (checking imports)..."

# Run with --help or no args to check if it boots without crashing on imports
# We expect it to fail with "Unknown option" or "workspace-path required" but NOT with "Module not found" or "worker error"
if ! output=$(bun "$FULL_CLI_PATH" --help 2>&1); then
  # It failed, which is expected (no args/bad args), but we need to check WHY
  exit_code=$?

  # Check for known import/worker errors
  if echo "$output" | grep -qE "Module not found|Worker error|Cannot find module"; then
    echo "❌ Error: Agent CLI failed to start due to import/worker errors:"
    echo "$output"
    exit 1
  fi

  # If it failed just because of arguments, that's fine - it means the code loaded.
  echo "✅ Agent CLI loaded successfully (ignoring argument errors)"
else
  echo "✅ Agent CLI ran successfully"
fi

echo "Terminal-bench agent check passed."
