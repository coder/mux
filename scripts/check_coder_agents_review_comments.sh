#!/usr/bin/env bash
# Check for unresolved coder-agents-review review comments.
# Usage: ./scripts/check_coder_agents_review_comments.sh <pr_number>
# Exits 0 if all bot-authored review threads are resolved, 1 otherwise.

set -euo pipefail

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
# shellcheck source=./lib/coder_agents_review.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/coder_agents_review.sh"
BOT_LOGIN_REGEX="${CODER_AGENTS_REVIEW_BOT_LOGIN_REGEX:-^coder-agents-review(\[bot\])?$}"
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

MAX_ATTEMPTS=5
BACKOFF_SECS=2

graphql_with_retries() {
  local query="$1"
  local cursor="$2"
  local attempt
  local backoff="$BACKOFF_SECS"
  local response

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if response=$(gh api graphql \
      -f query="$query" \
      -F owner="$OWNER" \
      -F repo="$REPO" \
      -F pr="$PR_NUMBER" \
      -F cursor="$cursor"); then
      printf '%s\n' "$response"
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

fetch_unresolved_via_api() {
  # Query all review-thread pages so older unresolved bot feedback cannot be missed.
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
            comments(first: 100) {
              nodes {
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

  local cursor="null"
  local page_data
  local page_threads
  local unresolved_page
  local has_next
  local end_cursor

  while true; do
    if ! page_data=$(graphql_with_retries "$graphql_query" "$cursor"); then
      return 1
    fi

    if [ "$(echo "$page_data" | jq -r '.data.repository.pullRequest == null')" = "true" ]; then
      echo "❌ PR #$PR_NUMBER does not exist in ${OWNER}/${REPO}." >&2
      return 1
    fi

    page_threads=$(echo "$page_data" | jq -c '.data.repository.pullRequest.reviewThreads.nodes // []')
    unresolved_page=$(coder_agents_unresolved_threads_from_json "$page_threads" "$BOT_LOGIN_REGEX")
    append_unresolved_records "$unresolved_page"

    has_next=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    end_cursor=$(echo "$page_data" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')

    case "$has_next" in
      false)
        break
        ;;
      true)
        if [[ -z "$end_cursor" ]]; then
          echo "❌ assertion failed: reviewThreads hasNextPage=true with empty endCursor" >&2
          return 1
        fi
        cursor="$end_cursor"
        ;;
      *)
        echo "❌ assertion failed: unexpected reviewThreads hasNextPage value '$has_next'" >&2
        return 1
        ;;
    esac
  done
}

echo "Checking for unresolved coder-agents-review comments in PR #${PR_NUMBER}..."

fetch_unresolved_via_api

if [ -n "$UNRESOLVED" ]; then
  coder_agents_print_unresolved_threads "$UNRESOLVED"
  echo ""

  VIEW_OWNER="${OWNER:-${MUX_GH_OWNER:-coder}}"
  VIEW_REPO="${REPO:-${MUX_GH_REPO:-mux}}"
  echo "View PR: https://github.com/${VIEW_OWNER}/${VIEW_REPO}/pull/$PR_NUMBER"
  exit 1
fi

echo "✅ No unresolved coder-agents-review comments found"
exit 0
