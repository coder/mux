#!/usr/bin/env bash
set -euo pipefail

# Wait for PR checks to complete.
# Usage: ./scripts/wait_pr_checks.sh <pr_number> [--once]
#
# Exits:
#   0 - PR checks and mergeability gates passed
#   1 - terminal failure (conflicts, failing checks, unresolved comments, etc.)
#  10 - still waiting for checks/mergeability (only in --once mode)

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <pr_number> [--once]"
  exit 1
fi

PR_NUMBER=$1
MODE="wait"

if [ $# -eq 2 ]; then
  if [ "$2" = "--once" ]; then
    MODE="once"
  else
    echo "❌ Unknown argument: '$2'" >&2
    echo "Usage: $0 <pr_number> [--once]" >&2
    exit 1
  fi
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_REVIEWS_SCRIPT="$SCRIPT_DIR/check_pr_reviews.sh"
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

for helper in "$CHECK_REVIEWS_SCRIPT" "$CHECK_CODEX_COMMENTS_SCRIPT"; do
  if [ ! -x "$helper" ]; then
    echo "❌ assertion failed: missing executable helper script: $helper" >&2
    exit 1
  fi
done

# Check for dirty working tree
if ! git diff-index --quiet HEAD --; then
  echo "❌ Error: You have uncommitted changes in your working directory." >&2
  echo "" >&2
  git status --short >&2
  echo "" >&2
  echo "Please commit or stash your changes before checking PR status." >&2
  exit 1
fi

# Get current branch name
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Get remote tracking branch
REMOTE_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")

if [[ -z "$REMOTE_BRANCH" ]]; then
  echo "⚠️  Current branch '$CURRENT_BRANCH' has no upstream branch." >&2
  echo "Setting upstream to origin/$CURRENT_BRANCH..." >&2

  # Try to set upstream
  if git push -u origin "$CURRENT_BRANCH" 2>&1; then
    echo "✅ Upstream set successfully!" >&2
    REMOTE_BRANCH="origin/$CURRENT_BRANCH"
  else
    echo "❌ Error: Failed to set upstream branch." >&2
    echo "You may need to push manually: git push -u origin $CURRENT_BRANCH" >&2
    exit 1
  fi
fi

# Fetch latest remote state before comparing
git fetch origin "$CURRENT_BRANCH" --quiet 2>/dev/null || true

# Check if local and remote are in sync
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse "$REMOTE_BRANCH")

if [[ "$LOCAL_HASH" != "$REMOTE_HASH" ]]; then
  echo "❌ Error: Local branch is not in sync with remote." >&2
  echo "" >&2
  echo "Local:  $LOCAL_HASH" >&2
  echo "Remote: $REMOTE_HASH" >&2
  echo "" >&2

  # Check if we're ahead, behind, or diverged
  if git merge-base --is-ancestor "$REMOTE_HASH" HEAD 2>/dev/null; then
    AHEAD=$(git rev-list --count "$REMOTE_BRANCH"..HEAD)
    echo "Your branch is $AHEAD commit(s) ahead of '$REMOTE_BRANCH'." >&2
    echo "Push your changes with: git push" >&2
  elif git merge-base --is-ancestor HEAD "$REMOTE_HASH" 2>/dev/null; then
    BEHIND=$(git rev-list --count HEAD.."$REMOTE_BRANCH")
    echo "Your branch is $BEHIND commit(s) behind '$REMOTE_BRANCH'." >&2
    echo "Pull the latest changes with: git pull" >&2
  else
    echo "Your branch has diverged from '$REMOTE_BRANCH'." >&2
    echo "You may need to rebase or merge." >&2
  fi

  exit 1
fi

LAST_MERGE_STATE="UNKNOWN"

CHECK_PR_CHECKS_ONCE() {
  local status
  local pr_state
  local mergeable
  local merge_state
  local checks

  # Get PR status
  status=$(gh pr view "$PR_NUMBER" --json mergeable,mergeStateStatus,state 2>/dev/null || echo "error")

  if [ "$status" = "error" ]; then
    echo "❌ Failed to get PR status. Does PR #$PR_NUMBER exist?"
    return 1
  fi

  pr_state=$(echo "$status" | jq -r '.state')

  case "$pr_state" in
    MERGED)
      echo "✅ PR #$PR_NUMBER has been merged!"
      return 0
      ;;
    CLOSED)
      echo "❌ PR #$PR_NUMBER is closed (not merged)!"
      return 1
      ;;
    OPEN) ;;
    *)
      echo "❌ assertion failed: unexpected PR state '$pr_state' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  mergeable=$(echo "$status" | jq -r '.mergeable')
  merge_state=$(echo "$status" | jq -r '.mergeStateStatus')
  LAST_MERGE_STATE="$merge_state"

  case "$mergeable" in
    MERGEABLE | CONFLICTING | UNKNOWN) ;;
    *)
      echo "❌ assertion failed: unexpected mergeable status '$mergeable' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  case "$merge_state" in
    BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE) ;;
    *)
      echo "❌ assertion failed: unexpected merge state '$merge_state' for PR #$PR_NUMBER" >&2
      return 1
      ;;
  esac

  # Check for bad merge status
  if [ "$mergeable" = "CONFLICTING" ]; then
    echo "❌ PR has merge conflicts!"
    return 1
  fi

  if [ "$merge_state" = "DIRTY" ]; then
    echo "❌ PR has merge conflicts!"
    return 1
  fi

  if [ "$merge_state" = "BEHIND" ]; then
    echo "❌ PR is behind base branch. Rebase needed."
    echo ""
    echo "Run:"
    echo "  git fetch origin"
    echo "  git rebase origin/main"
    echo "  git push --force-with-lease"
    return 1
  fi

  # Get check status
  checks=$(gh pr checks "$PR_NUMBER" 2>&1 || echo "pending")

  local has_fail=0
  local has_pending=0
  local has_pass=0

  if echo "$checks" | grep -q "fail"; then
    has_fail=1
  fi

  if echo "$checks" | grep -q "pending"; then
    has_pending=1
  fi

  if echo "$checks" | grep -q "pass"; then
    has_pass=1
  fi

  if [ "$has_fail" -eq 0 ] && [ "$has_pending" -eq 0 ] && [ "$has_pass" -eq 0 ]; then
    echo "❌ assertion failed: unable to classify 'gh pr checks' output for PR #$PR_NUMBER" >&2
    echo "$checks" >&2
    return 1
  fi

  # Check for failures
  if [ "$has_fail" -eq 1 ]; then
    echo "❌ Some checks failed:"
    echo ""
    gh pr checks "$PR_NUMBER"
    echo ""
    echo "💡 To extract detailed logs from the failed run:"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER <job_pattern>"
    echo ""
    echo "💡 Common local repro commands for this repo:"
    echo "   make static-check"
    echo "   make test"
    echo ""
    echo "💡 To re-run a subset of integration tests faster with workflow_dispatch:"
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"tests/integration/specificTest.test.ts\""
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"-t 'specific test name'\""
    return 1
  fi

  # Check for unresolved review comments in the hot loop
  if ! "$CHECK_REVIEWS_SCRIPT" "$PR_NUMBER" >/dev/null 2>&1; then
    echo ""
    echo "❌ Unresolved review comments found!"
    echo "   👉 Tip: run ./scripts/check_pr_reviews.sh $PR_NUMBER to list them."
    "$CHECK_REVIEWS_SCRIPT" "$PR_NUMBER"
    return 1
  fi

  # Check if all checks passed and merge state is clean
  if [ "$has_pass" -eq 1 ] && [ "$has_pending" -eq 0 ] && [ "$has_fail" -eq 0 ]; then
    if [ "$merge_state" = "CLEAN" ]; then
      # Check for unresolved Codex comments
      echo "✅ All checks passed!"
      echo ""
      gh pr checks "$PR_NUMBER"
      echo ""
      echo "🤖 Checking for unresolved Codex comments..."
      if "$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER"; then
        echo ""
        echo "✅ PR is ready to merge!"
        return 0
      fi

      echo ""
      echo "❌ Please resolve Codex comments before merging."
      echo "   👉 Tip: use ./scripts/check_pr_reviews.sh $PR_NUMBER to list unresolved comments."
      return 1
    fi

    # GitHub can transiently report UNKNOWN/UNSTABLE/HAS_HOOKS even when checks have
    # passed; treat these as still-pending rather than a terminal assertion failure.
    case "$merge_state" in
      BLOCKED | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE)
        return 10
        ;;
      *)
        echo "❌ assertion failed: checks passed but merge state '$merge_state' is not supported" >&2
        return 1
        ;;
    esac
  fi

  return 10
}

if [ "$MODE" = "once" ]; then
  if CHECK_PR_CHECKS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0 | 1 | 10)
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected checks status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for PR #$PR_NUMBER checks to complete..."
echo ""

while true; do
  if CHECK_PR_CHECKS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0)
      exit 0
      ;;
    1)
      exit 1
      ;;
    10)
      echo -ne "\r⏳ Checks in progress... (${LAST_MERGE_STATE})  "
      sleep 5
      ;;
    *)
      echo "❌ assertion failed: unexpected checks status code '$rc'" >&2
      exit 1
      ;;
  esac
done
