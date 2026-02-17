#!/usr/bin/env bash
set -euo pipefail

# Wait for a PR to become merge-ready by enforcing the Codex + CI loop.
# Usage: ./scripts/wait_pr_ready.sh <pr_number>
#
# This script orchestrates Codex + checks in one polling loop:
#   1) wait_pr_codex.sh --once
#   2) wait_pr_checks.sh --once
#   3) check_codex_comments.sh (only when both gates pass)
#
# It exits immediately on the first terminal failure and succeeds only when
# all gates report success.

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
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"

for required in "$WAIT_CODEX_SCRIPT" "$WAIT_CHECKS_SCRIPT" "$CHECK_CODEX_COMMENTS_SCRIPT"; do
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

load_repo_context() {
  local repo_info

  if ! repo_info=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}' 2>/dev/null); then
    echo "❌ Failed to resolve repository owner/name via 'gh repo view'." >&2
    return 1
  fi

  MUX_GH_OWNER=$(echo "$repo_info" | jq -r '.owner // empty')
  MUX_GH_REPO=$(echo "$repo_info" | jq -r '.name // empty')

  if [[ -z "$MUX_GH_OWNER" || -z "$MUX_GH_REPO" ]]; then
    echo "❌ assertion failed: unable to parse repository owner/name from gh output" >&2
    echo "$repo_info" >&2
    return 1
  fi
}

assert_clean_and_synced_branch() {
  local current_branch
  local remote_branch
  local local_hash
  local remote_hash

  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes in your working directory." >&2
    echo "" >&2
    git status --short >&2
    echo "" >&2
    echo "Please commit or stash your changes before checking PR status." >&2
    return 1
  fi

  current_branch=$(git rev-parse --abbrev-ref HEAD)
  remote_branch=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")

  if [[ -z "$remote_branch" ]]; then
    echo "⚠️  Current branch '$current_branch' has no upstream branch." >&2
    echo "Setting upstream to origin/$current_branch..." >&2

    if git push -u origin "$current_branch" 2>&1; then
      echo "✅ Upstream set successfully!" >&2
      remote_branch="origin/$current_branch"
    else
      echo "❌ Error: Failed to set upstream branch." >&2
      echo "You may need to push manually: git push -u origin $current_branch" >&2
      return 1
    fi
  fi

  # Perform one fetch per orchestrator iteration context and let child scripts reuse it.
  git fetch origin "$current_branch" --quiet 2>/dev/null || true

  local_hash=$(git rev-parse HEAD)
  remote_hash=$(git rev-parse "$remote_branch")

  if [[ "$local_hash" != "$remote_hash" ]]; then
    echo "❌ Error: Local branch is not in sync with remote." >&2
    echo "" >&2
    echo "Local:  $local_hash" >&2
    echo "Remote: $remote_hash" >&2
    echo "" >&2

    if git merge-base --is-ancestor "$remote_hash" HEAD 2>/dev/null; then
      local ahead
      ahead=$(git rev-list --count "$remote_branch"..HEAD)
      echo "Your branch is $ahead commit(s) ahead of '$remote_branch'." >&2
      echo "Push your changes with: git push" >&2
    elif git merge-base --is-ancestor HEAD "$remote_hash" 2>/dev/null; then
      local behind
      behind=$(git rev-list --count HEAD.."$remote_branch")
      echo "Your branch is $behind commit(s) behind '$remote_branch'." >&2
      echo "Pull the latest changes with: git pull" >&2
    else
      echo "Your branch has diverged from '$remote_branch'." >&2
      echo "You may need to rebase or merge." >&2
    fi

    return 1
  fi
}

load_repo_context
assert_clean_and_synced_branch

# Child scripts reuse this context to avoid repeated gh repo lookups and duplicate git fetch calls.
export MUX_GH_OWNER
export MUX_GH_REPO
export MUX_SKIP_FETCH_SYNC=1

PR_DATA_FILE=$(mktemp)
cleanup() {
  rm -f "$PR_DATA_FILE"
}
trap cleanup EXIT

# Share the latest PR GraphQL payload across child scripts to avoid duplicate API calls.
export MUX_PR_DATA_FILE="$PR_DATA_FILE"

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
    # Avoid a false "not ready" result for already-merged PRs: historical unresolved
    # Codex threads should not block a merged terminal state.
    PR_STATE=$(gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null || echo "error")

    case "$PR_STATE" in
      MERGED)
        echo ""
        echo ""
        echo "🎉 PR #$PR_NUMBER is already merged."
        exit 0
        ;;
      OPEN) ;;
      *)
        echo ""
        echo ""
        echo "❌ assertion failed: unable to classify PR state '$PR_STATE' for PR #$PR_NUMBER" >&2
        exit 1
        ;;
    esac

    if CODEX_COMMENTS_OUT=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
      echo ""
      echo ""
      echo "🎉 PR #$PR_NUMBER is ready: Codex approved, required checks passed, and no unresolved Codex comments remain."
      exit 0
    fi

    echo ""
    echo ""
    echo "❌ PR #$PR_NUMBER is not ready."
    echo ""
    echo "--- Codex comment gate output ---"
    if [ -n "$CODEX_COMMENTS_OUT" ]; then
      echo "$CODEX_COMMENTS_OUT"
    else
      echo "(no output)"
    fi
    echo ""
    echo "Resolve outstanding Codex comments (or request another @codex review) and rerun this script."
    exit 1
  fi

  sleep 5
done
