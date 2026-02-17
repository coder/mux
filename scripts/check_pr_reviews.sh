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

append_unresolved_records() {
  local records="$1"

  if [[ -z "$records" ]]; then
    return 0
  fi

  if [[ -n "$UNRESOLVED" ]]; then
    UNRESOLVED+=$'\n'
  fi

  UNRESOLVED+="$records"
}

load_unresolved_from_cache() {
  if [[ -z "$PR_DATA_FILE" || ! -s "$PR_DATA_FILE" ]]; then
    return 1
  fi

  if ! jq -e '.data.repository.pullRequest != null and .data.repository.pullRequest.reviewThreads.nodes != null' "$PR_DATA_FILE" >/dev/null 2>&1; then
    echo "⚠️ MUX_PR_DATA_FILE at '$PR_DATA_FILE' does not contain review thread data; falling back to API query." >&2
    return 1
  fi

  # Cached data from wait_pr_codex uses reviewThreads(last: 100). If GitHub reports there
  # are older pages (hasPreviousPage=true), this cache is incomplete and cannot be trusted
  # for a clean "all resolved" result.
  local has_previous
  has_previous=$(jq -r '(.data.repository.pullRequest.reviewThreads.pageInfo.hasPreviousPage | if . == null then "unknown" else tostring end)' "$PR_DATA_FILE")

  case "$has_previous" in
    false) ;;
    true)
      echo "⚠️ Cached reviewThreads window is incomplete (hasPreviousPage=true); fetching full review-thread set." >&2
      return 1
      ;;
    unknown)
      echo "⚠️ Cached review-thread pageInfo is missing; fetching full review-thread set." >&2
      return 1
      ;;
    *)
      echo "❌ assertion failed: unexpected cached hasPreviousPage value '$has_previous'" >&2
      return 1
      ;;
  esac

  local cached_unresolved
  cached_unresolved=$(jq -r '.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false) | {thread_id: .id, user: (.comments.nodes[0].author.login // "unknown"), body: (.comments.nodes[0].body // ""), diff_hunk: (.comments.nodes[0].diffHunk // ""), commit_id: (.comments.nodes[0].commit.oid // "")}' "$PR_DATA_FILE")

  append_unresolved_records "$cached_unresolved"
  return 0
}

fetch_unresolved_via_api() {
  # Query all review thread pages so we don't miss unresolved threads on PRs with >100
  # threads. This is the authoritative path when cached data may be incomplete.
  # shellcheck disable=SC2016 # Single quotes are intentional - this is a GraphQL query.
  local graphql_query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
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

  UNRESOLVED=""

  local cursor="null"
  local page_data
  local unresolved_page
  local has_next
  local end_cursor

  while true; do
    page_data=$(gh api graphql \
      -f query="$graphql_query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor")

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    unresolved_page=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false) | {thread_id: .id, user: (.comments.nodes[0].author.login // "unknown"), body: (.comments.nodes[0].body // ""), diff_hunk: (.comments.nodes[0].diffHunk // ""), commit_id: (.comments.nodes[0].commit.oid // "")}')
    append_unresolved_records "$unresolved_page"

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: GraphQL reported hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done
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
  VIEW_OWNER="${OWNER:-${MUX_GH_OWNER:-coder}}"
  VIEW_REPO="${REPO:-${MUX_GH_REPO:-mux}}"
  echo "View PR: https://github.com/${VIEW_OWNER}/${VIEW_REPO}/pull/$PR_NUMBER"
  exit 1
fi

echo "✅ All review comments resolved"
exit 0
