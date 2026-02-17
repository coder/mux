#!/usr/bin/env bash
# Check for unresolved PR review comments
# Usage: ./scripts/check_pr_reviews.sh <pr_number>
# Exits 0 if all resolved, 1 if unresolved comments exist

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER="$1"
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "❌ PR number must be numeric. Got: '$PR_NUMBER'" >&2
  exit 1
fi

PR_DATA_FILE="${MUX_PR_DATA_FILE:-}"
UNRESOLVED=""

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

load_unresolved_from_cache() {
  if [[ -z "$PR_DATA_FILE" || ! -s "$PR_DATA_FILE" ]]; then
    return 1
  fi

  if ! jq -e '.data.repository.pullRequest != null and .data.repository.pullRequest.reviewThreads.nodes != null' "$PR_DATA_FILE" >/dev/null 2>&1; then
    echo "⚠️ MUX_PR_DATA_FILE at '$PR_DATA_FILE' does not contain review thread data; falling back to API query." >&2
    return 1
  fi

  UNRESOLVED=$(jq -r '.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false) | {thread_id: .id, user: (.comments.nodes[0].author.login // "unknown"), body: (.comments.nodes[0].body // ""), diff_hunk: (.comments.nodes[0].diffHunk // ""), commit_id: (.comments.nodes[0].commit.oid // "")}' "$PR_DATA_FILE")
  return 0
}

fetch_unresolved_via_api() {
  # Query for unresolved review threads
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query, not shell expansion.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes {
                author { login }
                body
                diffHunk
                commit { oid }
              }
            }
          }
        }
      }
    }
  }'

  resolve_repo_context

  UNRESOLVED=$(gh api graphql \
    -f query="$graphql_query" \
    -F owner="$OWNER" \
    -F repo="$REPO" \
    -F pr="$PR_NUMBER" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false) | {thread_id: .id, user: (.comments.nodes[0].author.login // "unknown"), body: (.comments.nodes[0].body // ""), diff_hunk: (.comments.nodes[0].diffHunk // ""), commit_id: (.comments.nodes[0].commit.oid // "")}')
}

if ! load_unresolved_from_cache; then
  fetch_unresolved_via_api
fi

if [ -n "$UNRESOLVED" ]; then
  echo "❌ Unresolved review comments found:"
  echo "$UNRESOLVED" | jq -r '"  \(.user): \(.body)"'
  echo ""
  echo "To resolve a comment thread, use:"
  echo "$UNRESOLVED" | jq -r '"  ./scripts/resolve_pr_comment.sh \(.thread_id)"'
  echo ""

  # Best-effort PR link. If repo context wasn't resolved on this path, fall back to default.
  VIEW_OWNER="${MUX_GH_OWNER:-coder}"
  VIEW_REPO="${MUX_GH_REPO:-mux}"
  echo "View PR: https://github.com/${VIEW_OWNER}/${VIEW_REPO}/pull/$PR_NUMBER"
  exit 1
fi

echo "✅ All review comments resolved"
exit 0
