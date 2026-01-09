#!/usr/bin/env bash
set -euo pipefail

# Wait for PR checks to complete
# Usage: ./scripts/wait_pr_checks.sh <pr_number>

if [ $# -eq 0 ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER=$1

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

echo "⏳ Waiting for PR #$PR_NUMBER checks to complete..."
echo ""

while true; do
  # Get PR status
  STATUS=$(gh pr view "$PR_NUMBER" --json mergeable,mergeStateStatus,state 2>/dev/null || echo "error")

  if [ "$STATUS" = "error" ]; then
    echo "❌ Failed to get PR status. Does PR #$PR_NUMBER exist?"
    exit 1
  fi

  PR_STATE=$(echo "$STATUS" | jq -r '.state')

  # Check if PR is already merged
  if [ "$PR_STATE" = "MERGED" ]; then
    echo "✅ PR #$PR_NUMBER has been merged!"
    exit 0
  fi

  # Check if PR is closed without merging
  if [ "$PR_STATE" = "CLOSED" ]; then
    echo "❌ PR #$PR_NUMBER is closed (not merged)!"
    exit 1
  fi

  MERGEABLE=$(echo "$STATUS" | jq -r '.mergeable')
  MERGE_STATE=$(echo "$STATUS" | jq -r '.mergeStateStatus')

  # Check for bad merge status
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    echo "❌ PR has merge conflicts!"
    exit 1
  fi

  if [ "$MERGE_STATE" = "DIRTY" ]; then
    echo "❌ PR has merge conflicts!"
    exit 1
  fi

  if [ "$MERGE_STATE" = "BEHIND" ]; then
    echo "❌ PR is behind base branch. Rebase needed."
    echo ""
    echo "Run:"
    echo "  git fetch origin"
    echo "  git rebase origin/main"
    echo "  git push --force-with-lease"
    exit 1
  fi

  # Get check status
  CHECKS=$(gh pr checks "$PR_NUMBER" 2>&1 || echo "pending")

  # Check for failures
  if echo "$CHECKS" | grep -q "fail"; then
    echo "❌ Some checks failed:"
    echo ""
    gh pr checks "$PR_NUMBER"
    echo ""
    echo "💡 To extract detailed logs from the failed run:"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER"
    echo "   ./scripts/extract_pr_logs.sh $PR_NUMBER <job_pattern>  # e.g., Integration"
    echo ""
    echo "💡 To re-run a subset of integration tests faster with workflow_dispatch:"
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"tests/integration/specificTest.test.ts\""
    echo "   gh workflow run ci.yml --ref $(git rev-parse --abbrev-ref HEAD) -f test_filter=\"-t 'specific test name'\""
    exit 1
  fi

  # Check for unresolved review comments in the hot loop
  if ! ./scripts/check_pr_reviews.sh "$PR_NUMBER" >/dev/null 2>&1; then
    echo ""
    echo "❌ Unresolved review comments found!"
    echo "   👉 Tip: run ./scripts/check_pr_reviews.sh $PR_NUMBER to list them."
    ./scripts/check_pr_reviews.sh "$PR_NUMBER"
    exit 1
  fi

  # Check if all checks passed and merge state is clean
  if echo "$CHECKS" | grep -q "pass" && ! echo "$CHECKS" | grep -qE "pending|fail"; then
    if [ "$MERGE_STATE" = "CLEAN" ]; then
      # Check for unresolved Codex comments
      echo "✅ All checks passed!"
      echo ""
      gh pr checks "$PR_NUMBER"
      echo ""
      echo "🤖 Checking for unresolved Codex comments..."
      if ./scripts/check_codex_comments.sh "$PR_NUMBER"; then
        echo ""
        echo "✅ PR is ready to merge!"
        exit 0
      else
        echo ""
        echo "❌ Please resolve Codex comments before merging."
        echo "   👉 Tip: use ./scripts/check_pr_reviews.sh $PR_NUMBER to list unresolved comments."
        exit 1
      fi
    elif [ "$MERGE_STATE" = "BLOCKED" ]; then
      echo "⏳ All checks passed but still blocked (waiting for required checks)..."
    fi
  else
    # Show current status
    echo -ne "\r⏳ Checks in progress... (${MERGE_STATE})  "
  fi

  sleep 5
done
