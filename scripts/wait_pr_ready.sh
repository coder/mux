#!/usr/bin/env bash
set -euo pipefail

# Wait for a PR to become merge-ready by enforcing the Codex + CI loop.
# Usage: ./scripts/wait_pr_ready.sh <pr_number>
#
# This script orchestrates Codex + checks in one polling loop:
#   1) wait_pr_codex.sh --once
#   2) wait_pr_checks.sh --once
#
# It exits immediately on the first terminal failure and succeeds only when
# both gates report success.

if [ $# -ne 1 ]; then
  echo "Usage: $0 <pr_number>" >&2
  exit 1
fi

PR_NUMBER="$1"
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WAIT_CODEX_SCRIPT="$SCRIPT_DIR/wait_pr_codex.sh"
WAIT_CHECKS_SCRIPT="$SCRIPT_DIR/wait_pr_checks.sh"

for required in "$WAIT_CODEX_SCRIPT" "$WAIT_CHECKS_SCRIPT"; do
  if [ ! -x "$required" ]; then
    echo "❌ Required executable script is missing or not executable: $required" >&2
    exit 1
  fi
done

for required_cmd in gh jq git; do
  if ! command -v "$required_cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $required_cmd" >&2
    exit 1
  fi
done

status_from_rc() {
  local rc="$1"

  case "$rc" in
    0)
      echo "passed"
      ;;
    10)
      echo "pending"
      ;;
    1)
      echo "failed"
      ;;
    *)
      echo "❌ assertion failed: unexpected phase status code '$rc'" >&2
      return 1
      ;;
  esac
}

echo "🚦 Waiting for PR #$PR_NUMBER to become ready (Codex + CI, fail-fast)..."
echo ""

while true; do
  if CODEX_OUT=$("$WAIT_CODEX_SCRIPT" "$PR_NUMBER" --once 2>&1); then
    CODEX_RC=0
  else
    CODEX_RC=$?
  fi

  CODEX_STATUS=$(status_from_rc "$CODEX_RC") || exit 1

  # True fail-fast behavior: if Codex is already terminal-failed, exit immediately
  # without waiting for the checks gate.
  if [ "$CODEX_RC" -eq 1 ]; then
    echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Checks=skipped    "
    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Codex gate output ---"
    if [ -n "$CODEX_OUT" ]; then
      echo "$CODEX_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Address Codex feedback (or retry if Codex was rate-limited), push, and request review again:"
    echo ""
    echo "  gh pr comment $PR_NUMBER --body-file - <<'EOF'"
    echo "  @codex review"
    echo ""
    echo "  Please take another look."
    echo "  EOF"
    exit 1
  fi

  if CHECKS_OUT=$("$WAIT_CHECKS_SCRIPT" "$PR_NUMBER" --once 2>&1); then
    CHECKS_RC=0
  else
    CHECKS_RC=$?
  fi

  CHECKS_STATUS=$(status_from_rc "$CHECKS_RC") || exit 1
  echo -ne "\r⏳ Gate status: Codex=${CODEX_STATUS} | Checks=${CHECKS_STATUS}    "

  if [ "$CHECKS_RC" -eq 1 ]; then
    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Checks gate output ---"
    if [ -n "$CHECKS_OUT" ]; then
      echo "$CHECKS_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Fix issues locally, push, and rerun this script."
    exit 1
  fi

  if [ "$CODEX_RC" -eq 0 ] && [ "$CHECKS_RC" -eq 0 ]; then
    echo ""
    echo ""
    echo "🎉 PR #$PR_NUMBER is ready: Codex approved and required checks passed."
    exit 0
  fi

  sleep 5
done
