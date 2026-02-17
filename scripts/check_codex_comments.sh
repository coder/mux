#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER=$1
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"
PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
RESULT=""

load_result_from_cache() {
  if [[ -z "$PR_DATA_FILE" || ! -s "$PR_DATA_FILE" ]]; then
    return 1
  fi

  local cached
  if ! cached=$(cat "$PR_DATA_FILE"); then
    echo "⚠️ Unable to read MUX_PR_DATA_FILE at '$PR_DATA_FILE'; falling back to API query." >&2
    return 1
  fi

  if ! echo "$cached" | jq -e '.data.repository.pullRequest != null and .data.repository.pullRequest.comments.nodes != null and .data.repository.pullRequest.reviewThreads.nodes != null' >/dev/null 2>&1; then
    echo "⚠️ MUX_PR_DATA_FILE at '$PR_DATA_FILE' does not contain the expected PR payload; falling back to API query." >&2
    return 1
  fi

  RESULT="$cached"
  return 0
}

resolve_repo_context() {
  if [[ -n "${MUX_GH_OWNER:-}" || -n "${MUX_GH_REPO:-}" ]]; then
    if [[ -z "${MUX_GH_OWNER:-}" || -z "${MUX_GH_REPO:-}" ]]; then
      echo "❌ assertion failed: MUX_GH_OWNER and MUX_GH_REPO must both be set when one is provided" >&2
      return 1
    fi

    OWNER="$MUX_GH_OWNER"
    REPO="$MUX_GH_REPO"
  else
    local repo_info
    if ! repo_info=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}'); then
      echo "❌ Failed to resolve repository owner/name via 'gh repo view'." >&2
      return 1
    fi

    OWNER=$(echo "$repo_info" | jq -r '.owner // empty')
    REPO=$(echo "$repo_info" | jq -r '.name // empty')
  fi

  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    echo "❌ assertion failed: owner/repo must be non-empty" >&2
    return 1
  fi
}

fetch_result_via_api() {
  # Use GraphQL to get all comments (including minimized status)
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query, not shell expansion
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(first: 100) {
          nodes {
            id
            author { login }
            body
            createdAt
            isMinimized
          }
        }
        reviewThreads(first: 100) {
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

  resolve_repo_context

  # Depot runners sometimes hit transient network timeouts to api.github.com.
  # Retry the GraphQL request a few times before failing the required check.
  local max_attempts=5
  local backoff_secs=2
  local attempt

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if RESULT=$(gh api graphql \
      -f query="$graphql_query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER"); then
      return 0
    fi

    if [ "$attempt" -eq "$max_attempts" ]; then
      echo "❌ GraphQL query failed after ${max_attempts} attempts"
      return 1
    fi

    echo "⚠️ GraphQL query failed (attempt ${attempt}/${max_attempts}); retrying in ${backoff_secs}s..."
    sleep "$backoff_secs"
    backoff_secs=$((backoff_secs * 2))
  done

  return 1
}

echo "Checking for unresolved Codex comments in PR #${PR_NUMBER}..."

if ! load_result_from_cache; then
  fetch_result_via_api
fi

# Filter regular comments from bot that aren't minimized, excluding:
# - "Didn't find any major issues" (no issues found)
# - "usage limits have been reached" (rate limit error, not a real review)
REGULAR_COMMENTS=$(echo "$RESULT" | jq "[.data.repository.pullRequest.comments.nodes[]? | select(.author.login == \"${BOT_LOGIN_GRAPHQL}\" and .isMinimized == false and (.body | test(\"Didn't find any major issues|usage limits have been reached\") | not))]")
REGULAR_COUNT=$(echo "$REGULAR_COMMENTS" | jq 'length')

# Filter unresolved review threads from bot
UNRESOLVED_THREADS=$(echo "$RESULT" | jq "[.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false and .comments.nodes[0].author.login == \"${BOT_LOGIN_GRAPHQL}\")]")
UNRESOLVED_COUNT=$(echo "$UNRESOLVED_THREADS" | jq 'length')

TOTAL_UNRESOLVED=$((REGULAR_COUNT + UNRESOLVED_COUNT))

echo "Found ${REGULAR_COUNT} unminimized regular comment(s) from bot"
echo "Found ${UNRESOLVED_COUNT} unresolved review thread(s) from bot"

if [ "$TOTAL_UNRESOLVED" -gt 0 ]; then
  echo ""
  echo "❌ Found ${TOTAL_UNRESOLVED} unresolved comment(s) from Codex in PR #${PR_NUMBER}"
  echo ""
  echo "Codex comments:"

  if [ "$REGULAR_COUNT" -gt 0 ]; then
    echo "$REGULAR_COMMENTS" | jq -r '.[] | "  - [\(.createdAt)]\n\(.body)\n"'
  fi

  if [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    echo "$UNRESOLVED_THREADS" | jq -r '.[] | "  - [\(.comments.nodes[0].createdAt)] thread=\(.id) \(.comments.nodes[0].path // "comment"):\(.comments.nodes[0].line // "")\n\(.comments.nodes[0].body)\n"'
    echo ""
    echo "Resolve review threads with: ./scripts/resolve_pr_comment.sh <thread_id>"
  fi

  echo ""
  echo "Please address or resolve all Codex comments before merging."
  exit 1
fi

echo "✅ No unresolved Codex comments found"
exit 0
