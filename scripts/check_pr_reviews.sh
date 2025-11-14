#!/usr/bin/env bash
# Check for unresolved PR review comments
# Usage: ./scripts/check_pr_reviews.sh <pr_number>
# Exits 0 if all resolved, 1 if unresolved comments exist

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER="$1"

# Query for unresolved review threads
UNRESOLVED=$(gh api graphql -f query="
{
  repository(owner: \"coder\", name: \"mux\") {
    pullRequest(number: $PR_NUMBER) {
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
}" --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | {thread_id: .id, user: .comments.nodes[0].author.login, body: .comments.nodes[0].body, diff_hunk: .comments.nodes[0].diffHunk, commit_id: .comments.nodes[0].commit.oid}')

if [ -n "$UNRESOLVED" ]; then
  echo "❌ Unresolved review comments found:"
  echo "$UNRESOLVED" | jq -r '"  \(.user): \(.body)"'
  echo ""
  echo "To resolve a comment thread, use:"
  echo "$UNRESOLVED" | jq -r '"  ./scripts/resolve_pr_comment.sh \(.thread_id)"'
  echo ""
  echo "View PR: https://github.com/coder/mux/pull/$PR_NUMBER"
  exit 1
fi

echo "✅ All review comments resolved"
exit 0
