#!/usr/bin/env bash
# Shared helpers for the optional coder-agents-review PR gate.

coder_agents_unresolved_threads_from_json() {
  local threads_json="$1"
  local bot_regex="$2"

  jq -rn --argjson threads "$threads_json" --arg bot_regex "$bot_regex" '
    $threads[]
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
  '
}

coder_agents_print_unresolved_threads() {
  local unresolved="$1"

  echo "❌ Unresolved coder-agents-review comments found:"
  echo "$unresolved" | jq -r '"  - [\(.created_at)] thread=\(.thread_id) \(.path):\(.line)\n    \(.user): \(.body)\n"'
  echo ""
  echo "To resolve a comment thread, use:"
  echo "$unresolved" | jq -r '"  ./scripts/resolve_pr_comment.sh \(.thread_id)"'
}
