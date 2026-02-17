#!/usr/bin/env bash
set -euo pipefail

# Wait for Codex to respond to a `@codex review` request.
#
# Usage: ./scripts/wait_pr_codex.sh <pr_number> [--once]
#
# Exits:
#   0 - Codex approved (posts an explicit approval comment)
#   1 - Codex left comments to address OR failed to review (e.g. rate limit)
#  10 - still waiting for Codex response (only in --once mode)

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

BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK_CODEX_COMMENTS_SCRIPT="$SCRIPT_DIR/check_codex_comments.sh"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'"
  exit 1
fi

if [ ! -x "$CHECK_CODEX_COMMENTS_SCRIPT" ]; then
  echo "❌ assertion failed: missing executable helper script: $CHECK_CODEX_COMMENTS_SCRIPT" >&2
  exit 1
fi

# Keep these regexes in sync with ./scripts/check_codex_comments.sh.
CODEX_APPROVAL_REGEX="Didn't find any major issues"
CODEX_RATE_LIMIT_REGEX="usage limits have been reached"

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

# shellcheck disable=SC2016 # Single quotes are intentional - these are GraphQL queries.
PR_STATE_QUERY='query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
    }
  }
}'

# shellcheck disable=SC2016 # Single quotes are intentional - these are GraphQL queries.
COMMENTS_QUERY='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      comments(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          author { login }
          body
          createdAt
          isMinimized
        }
      }
    }
  }
}'

# shellcheck disable=SC2016 # Single quotes are intentional - these are GraphQL queries.
THREADS_QUERY='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              id
              author { login }
              body
              createdAt
              path
              line
            }
          }
        }
      }
    }
  }
}'

REPO_INFO=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}')
OWNER=$(echo "$REPO_INFO" | jq -r '.owner')
REPO=$(echo "$REPO_INFO" | jq -r '.name')

# Depot runners sometimes hit transient network timeouts to api.github.com.
# Retry the GraphQL request a few times before failing.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

FETCH_GRAPHQL_WITH_RETRY() {
  local query="$1"
  shift

  local attempt
  local backoff
  backoff="$BACKOFF_SECS"

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if gh api graphql \
      -f query="$query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      "$@"; then
      return 0
    fi

    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "❌ GraphQL query failed after ${MAX_ATTEMPTS} attempts" >&2
      return 1
    fi

    echo "⚠️ GraphQL query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${backoff}s..." >&2
    sleep "$backoff"
    backoff=$((backoff * 2))
  done
}

FETCH_PR_STATE() {
  FETCH_GRAPHQL_WITH_RETRY "$PR_STATE_QUERY"
}

FETCH_ALL_COMMENTS() {
  local comments_cursor=""
  local all_comments='[]'
  local result
  local page_comments
  local has_next

  while true; do
    if [ -n "$comments_cursor" ]; then
      result=$(FETCH_GRAPHQL_WITH_RETRY "$COMMENTS_QUERY" -F cursor="$comments_cursor")
    else
      result=$(FETCH_GRAPHQL_WITH_RETRY "$COMMENTS_QUERY")
    fi

    if [ "$(echo "$result" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_comments=$(echo "$result" | jq '.data.repository.pullRequest.comments.nodes')
    all_comments=$(jq -cn --argjson all "$all_comments" --argjson page "$page_comments" '$all + $page')

    has_next=$(echo "$result" | jq -r '.data.repository.pullRequest.comments.pageInfo.hasNextPage')
    if [ "$has_next" != "true" ]; then
      break
    fi

    comments_cursor=$(echo "$result" | jq -r '.data.repository.pullRequest.comments.pageInfo.endCursor')
    if [ -z "$comments_cursor" ] || [ "$comments_cursor" = "null" ]; then
      echo "❌ Assertion failed: comments pagination cursor missing while hasNextPage=true" >&2
      return 1
    fi
  done

  echo "$all_comments"
}

FETCH_ALL_THREADS() {
  local threads_cursor=""
  local all_threads='[]'
  local result
  local page_threads
  local has_next

  while true; do
    if [ -n "$threads_cursor" ]; then
      result=$(FETCH_GRAPHQL_WITH_RETRY "$THREADS_QUERY" -F cursor="$threads_cursor")
    else
      result=$(FETCH_GRAPHQL_WITH_RETRY "$THREADS_QUERY")
    fi

    if [ "$(echo "$result" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #${PR_NUMBER} does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_threads=$(echo "$result" | jq '.data.repository.pullRequest.reviewThreads.nodes')
    all_threads=$(jq -cn --argjson all "$all_threads" --argjson page "$page_threads" '$all + $page')

    has_next=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    if [ "$has_next" != "true" ]; then
      break
    fi

    threads_cursor=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
    if [ -z "$threads_cursor" ] || [ "$threads_cursor" = "null" ]; then
      echo "❌ Assertion failed: review thread pagination cursor missing while hasNextPage=true" >&2
      return 1
    fi
  done

  echo "$all_threads"
}

LAST_REQUEST_AT=""

CHECK_CODEX_STATUS_ONCE() {
  local pr_state_result
  local pr_state
  local all_comments
  local all_threads
  local request_at
  local rate_limit_comment
  local approval_comment
  local codex_response_count_comments
  local codex_response_count_threads
  local codex_response_count
  local check_output

  pr_state_result=$(FETCH_PR_STATE)
  pr_state=$(echo "$pr_state_result" | jq -r '.data.repository.pullRequest.state // empty')

  if [[ -z "$pr_state" ]]; then
    echo "❌ Unable to fetch PR state for #$PR_NUMBER in ${OWNER}/${REPO}." >&2
    return 1
  fi

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

  all_comments=$(FETCH_ALL_COMMENTS)
  all_threads=$(FETCH_ALL_THREADS)

  # Ignore Codex's own comments since they mention "@codex review" in boilerplate.
  request_at=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" '[.[] | select(.author.login != $bot and (.body | contains("@codex review")))] | sort_by(.createdAt) | last | .createdAt // empty')

  if [[ -z "$request_at" ]]; then
    echo "❌ No '@codex review' comment found on PR #$PR_NUMBER." >&2
    echo "" >&2
    echo "Post one (example):" >&2
    echo "  gh pr comment $PR_NUMBER --body-file - <<'EOF'" >&2
    echo "  @codex review" >&2
    echo "  " >&2
    echo "  Please take another look." >&2
    echo "  EOF" >&2
    return 1
  fi

  LAST_REQUEST_AT="$request_at"

  # If Codex can't run (usage limits, etc) it posts a comment we shouldn't treat as "approval".
  rate_limit_comment=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_RATE_LIMIT_REGEX" '[.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex))) | {createdAt, body}] | sort_by(.createdAt) | last // empty | .body // empty')

  if [[ -n "$rate_limit_comment" ]]; then
    echo ""
    echo "❌ Codex was unable to review (usage limits)."
    echo ""
    echo "$rate_limit_comment"
    return 1
  fi

  approval_comment=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" --arg regex "$CODEX_APPROVAL_REGEX" '[.[] | select(.author.login == $bot and .createdAt > $request_at and (.body | test($regex))) | {createdAt, body}] | sort_by(.createdAt) | last // empty | .body // empty')

  if [[ -n "$approval_comment" ]]; then
    echo ""
    echo "✅ Codex approved PR #$PR_NUMBER"
    echo ""
    echo "$approval_comment"
    return 0
  fi

  codex_response_count_comments=$(echo "$all_comments" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select(.author.login == $bot and .createdAt > $request_at)] | length')
  codex_response_count_threads=$(echo "$all_threads" | jq -r --arg bot "$BOT_LOGIN_GRAPHQL" --arg request_at "$request_at" '[.[] | select((.comments.nodes | length) > 0 and .comments.nodes[0].author.login == $bot and .comments.nodes[0].createdAt > $request_at)] | length')
  codex_response_count=$((codex_response_count_comments + codex_response_count_threads))

  if [ "$codex_response_count" -eq 0 ]; then
    return 10
  fi

  # Codex responded to the latest @codex review request; defer to check_codex_comments.sh for
  # unresolved comment/thread detection so we don't duplicate filtering logic here.
  if ! check_output=$("$CHECK_CODEX_COMMENTS_SCRIPT" "$PR_NUMBER" 2>&1); then
    echo ""
    echo "$check_output"
    return 1
  fi

  echo ""
  echo "❌ Codex responded, but no explicit approval comment was found after the latest '@codex review'."
  echo "   👉 If you expected approval, re-comment '@codex review' and run this script again."
  return 1
}

if [ "$MODE" = "once" ]; then
  if CHECK_CODEX_STATUS_ONCE; then
    rc=0
  else
    rc=$?
  fi

  case "$rc" in
    0 | 1 | 10)
      exit "$rc"
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
fi

echo "⏳ Waiting for Codex review on PR #$PR_NUMBER..."
echo ""
echo "Tip: after you comment '@codex review', Codex will respond with either:"
echo "  - review comments / threads to address (script exits 1)"
echo "  - an explicit approval comment (script exits 0)"
echo ""

while true; do
  if CHECK_CODEX_STATUS_ONCE; then
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
      echo -ne "\r⏳ Waiting for Codex response... (requested at ${LAST_REQUEST_AT})  "
      sleep 5
      ;;
    *)
      echo "❌ assertion failed: unexpected Codex status code '$rc'" >&2
      exit 1
      ;;
  esac
done
