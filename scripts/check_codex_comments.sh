#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

PR_NUMBER=$1
BOT_LOGIN_REST="chatgpt-codex-connector[bot]"
BOT_LOGIN_GRAPHQL="chatgpt-codex-connector"

echo "Checking for unresolved Codex comments in PR #${PR_NUMBER}..."

# Use GraphQL to get all comments (including minimized status)
GRAPHQL_QUERY='query($owner: String!, $repo: String!, $pr: Int!) {
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

REPO_INFO=$(gh repo view --json owner,name --jq '{owner: .owner.login, name: .name}')
OWNER=$(echo "$REPO_INFO" | jq -r '.owner')
REPO=$(echo "$REPO_INFO" | jq -r '.name')

# Depot runners sometimes hit transient network timeouts to api.github.com.
# Retry the GraphQL request a few times before failing the required check.
MAX_ATTEMPTS=5
BACKOFF_SECS=2

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  if RESULT=$(gh api graphql \
    -f query="$GRAPHQL_QUERY" \
    -F owner="$OWNER" \
    -F repo="$REPO" \
    -F pr="$PR_NUMBER"); then
    break
  fi

  if [ $attempt -eq $MAX_ATTEMPTS ]; then
    echo "❌ GraphQL query failed after ${MAX_ATTEMPTS} attempts"
    exit 1
  fi

  echo "⚠️ GraphQL query failed (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${BACKOFF_SECS}s..."
  sleep "$BACKOFF_SECS"
  BACKOFF_SECS=$((BACKOFF_SECS * 2))
done

# Filter regular comments from bot that aren't minimized, excluding:
# - "Didn't find any major issues" (no issues found)
# - "usage limits have been reached" (rate limit error, not a real review)
REGULAR_COMMENTS=$(echo "$RESULT" | jq "[.data.repository.pullRequest.comments.nodes[] | select(.author.login == \"${BOT_LOGIN_GRAPHQL}\" and .isMinimized == false and (.body | test(\"Didn't find any major issues|usage limits have been reached\") | not))]")
REGULAR_COUNT=$(echo "$REGULAR_COMMENTS" | jq 'length')

# Filter unresolved review threads from bot
UNRESOLVED_THREADS=$(echo "$RESULT" | jq "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .comments.nodes[0].author.login == \"${BOT_LOGIN_GRAPHQL}\")]")
UNRESOLVED_COUNT=$(echo "$UNRESOLVED_THREADS" | jq 'length')

TOTAL_UNRESOLVED=$((REGULAR_COUNT + UNRESOLVED_COUNT))

echo "Found ${REGULAR_COUNT} unminimized regular comment(s) from bot"
echo "Found ${UNRESOLVED_COUNT} unresolved review thread(s) from bot"

if [ $TOTAL_UNRESOLVED -gt 0 ]; then
  echo ""
  echo "❌ Found ${TOTAL_UNRESOLVED} unresolved comment(s) from Codex in PR #${PR_NUMBER}"
  echo ""
  echo "Codex comments:"

  if [ $REGULAR_COUNT -gt 0 ]; then
    echo "$REGULAR_COMMENTS" | jq -r '.[] | "  - [\(.created_at)] \(.body[0:100] | gsub("\\n"; " "))..."'
  fi

  if [ $UNRESOLVED_COUNT -gt 0 ]; then
    THREAD_SUMMARY=$(echo "$UNRESOLVED_THREADS" | jq '[.[] | {
      createdAt: .comments.nodes[0].createdAt,
      thread: .id,
      comment: .comments.nodes[0].id,
      path: (.comments.nodes[0].path // "comment"),
      line: (.comments.nodes[0].line // ""),
      snippet: (.comments.nodes[0].body[0:100] | gsub("\n"; " "))
    }]')

    echo "$THREAD_SUMMARY" | jq -r '.[] | "  - [\(.createdAt)] thread=\(.thread) comment=\(.comment) \(.path):\(.line) - \(.snippet)..."'
    echo ""
    echo "Resolve review threads with: ./scripts/resolve_pr_comment.sh <thread_id>"
  fi

  echo ""
  echo "Please address or resolve all Codex comments before merging."
  exit 1
else
  echo "✅ No unresolved Codex comments found"
  exit 0
fi
