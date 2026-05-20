#!/usr/bin/env bash
# Shared helpers for the optional coder-agents-review PR gate.

MAX_ATTEMPTS=${MAX_ATTEMPTS:-5}
BACKOFF_SECS=${BACKOFF_SECS:-2}

# Sets OWNER and REPO from MUX_GH_* or gh repo view.
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

# Runs a PR GraphQL query with optional cursor using OWNER, REPO, and PR_NUMBER.
graphql_with_retries() {
  local query="$1"
  local cursor="${2-}"
  local attempt
  local backoff="$BACKOFF_SECS"
  local response

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    if [[ -n "$cursor" ]]; then
      response=$(gh api graphql \
        -f query="$query" \
        -F owner="$OWNER" \
        -F repo="$REPO" \
        -F pr="$PR_NUMBER" \
        -F cursor="$cursor") && {
        printf '%s\n' "$response"
        return 0
      }
    else
      response=$(gh api graphql \
        -f query="$query" \
        -F owner="$OWNER" \
        -F repo="$REPO" \
        -F pr="$PR_NUMBER") && {
        printf '%s\n' "$response"
        return 0
      }
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

# Emits unresolved coder-agents-review thread records as newline-delimited JSON.
coder_agents_unresolved_threads_from_json() {
  local threads_json="$1"
  local bot_regex="$2"
  local threads_file
  local output
  threads_file=$(mktemp)
  printf '%s\n' "$threads_json" >"$threads_file"

  if output=$(jq -rn --slurpfile threads "$threads_file" --arg bot_regex "$bot_regex" '
    $threads[0][]
    | select(.isResolved == false and any(.comments.nodes[]?; ((.author.login // "") | test($bot_regex))))
    | . as $thread
    | ([.comments.nodes[]? | select((.author.login // "") | test($bot_regex))] | first) as $bot_comment
    | {
        thread_id: $thread.id,
        user: ($bot_comment.author.login // "unknown"),
        body: ($bot_comment.body // ""),
        path: ($bot_comment.path // "comment"),
        line: ($bot_comment.line // ""),
        created_at: ($bot_comment.createdAt // "")
      }
  '); then
    rm -f "$threads_file"
    printf '%s\n' "$output"
    return 0
  else
    local rc=$?
    rm -f "$threads_file"
    return "$rc"
  fi
}

# Prints records emitted by coder_agents_unresolved_threads_from_json.
coder_agents_print_unresolved_threads() {
  local unresolved="$1"

  echo "❌ Unresolved coder-agents-review comments found:"
  echo "$unresolved" | jq -r '"  - [\(.created_at)] thread=\(.thread_id) \(.path):\(.line)\n    \(.user): \(.body)\n"'
  echo ""
  echo "Reply inline to the finding(s), or leave a PR comment summarizing each response, before resolving."
  echo ""
  echo "To resolve a comment thread, use:"
  echo "$unresolved" | jq -r '"  ./scripts/resolve_pr_comment.sh \(.thread_id)"'
}
