#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-write}"
if [[ "$MODE" != "write" && "$MODE" != "check" ]]; then
  echo "Usage: $0 [write|check]" >&2
  exit 1
fi

bun scripts/gen_builtin_workflow_actions.ts "$MODE"
