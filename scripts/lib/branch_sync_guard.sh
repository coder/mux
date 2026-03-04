#!/usr/bin/env bash
# Shared branch-sync guard for wait_pr_*.sh scripts.
# Resolves the correct remote comparison target, fetches it,
# and optionally bootstraps a first push when no upstream exists.
#
# Usage: source this file, then call assert_branch_synced.
# Returns 0 if local HEAD matches remote; non-zero otherwise.
# Callers set CURRENT_BRANCH and REMOTE_BRANCH before proceeding.

set -euo pipefail

# Resolve which remote ref to compare HEAD against.
# Sets two variables in the caller's scope:
#   CURRENT_BRANCH  — local branch name
#   REMOTE_BRANCH   — remote tracking ref to compare against (e.g. origin/feature)
#
# Policy:
#   1. If @{u} exists and points to a non-default branch, honor it.
#      (Supports intentional cross-name tracking like local A -> origin/B.)
#   2. If @{u} points to origin/<default> but we're on a non-default branch
#      AND origin/<current_branch> exists on remote, use origin/<current_branch>.
#      (Worktree protection: branches created from origin/main inherit origin/main
#      as upstream, but the agent has already pushed origin/<feature>.)
#   3. If no upstream is configured, use origin/<current_branch>.
resolve_branch_sync_target() {
  local upstream_branch
  local default_branch

  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

  upstream_branch=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")
  default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo "")
  default_branch=${default_branch#origin/}

  # Default: compare against same-named remote branch.
  REMOTE_BRANCH="origin/$CURRENT_BRANCH"
  _BRANCH_SYNC_HAS_UPSTREAM=0

  if [[ -n "$upstream_branch" ]]; then
    _BRANCH_SYNC_HAS_UPSTREAM=1
    REMOTE_BRANCH="$upstream_branch"

    # Worktree protection: if upstream is origin/<default> but we're on a
    # non-default branch and origin/<current_branch> exists, prefer that.
    if [[ -n "$default_branch" ]] \
      && [[ "$upstream_branch" == "origin/$default_branch" ]] \
      && [[ "$CURRENT_BRANCH" != "$default_branch" ]] \
      && git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
      REMOTE_BRANCH="origin/$CURRENT_BRANCH"
    fi
  fi
}

# Fetch the resolved remote ref. If the branch doesn't exist on the remote
# AND no upstream is configured, bootstrap with git push -u.
# If an upstream IS configured and fetch fails, error out (never auto-push
# over an intentionally configured upstream).
fetch_or_bootstrap() {
  local remote_name
  local remote_ref

  remote_name="${REMOTE_BRANCH%%/*}"
  remote_ref="${REMOTE_BRANCH#*/}"

  if git fetch "$remote_name" "$remote_ref" --quiet 2>/dev/null; then
    return 0
  fi

  # Upstream exists but fetch failed — do not auto-push; the user configured
  # this tracking relationship intentionally.
  if [[ "$_BRANCH_SYNC_HAS_UPSTREAM" == "1" ]]; then
    echo "❌ Error: Failed to fetch upstream '$REMOTE_BRANCH'." >&2
    echo "This branch has a configured upstream; refusing to auto-push." >&2
    echo "You may need to push manually: git push -u origin $CURRENT_BRANCH" >&2
    return 1
  fi

  # No upstream — bootstrap first push.
  echo "⚠️  Branch '$CURRENT_BRANCH' has no upstream and does not exist on remote." >&2
  echo "Pushing to origin/$CURRENT_BRANCH..." >&2

  if git push -u origin "$CURRENT_BRANCH" 2>&1; then
    echo "✅ Pushed and upstream set successfully!" >&2
    REMOTE_BRANCH="origin/$CURRENT_BRANCH"
  else
    echo "❌ Error: Failed to push branch." >&2
    echo "You may need to push manually: git push -u origin $CURRENT_BRANCH" >&2
    return 1
  fi
}

# Full sync assertion: resolve target, fetch, compare hashes.
# Returns 0 if in sync, 1 otherwise (with diagnostic messages).
assert_branch_synced() {
  local local_hash
  local remote_hash

  resolve_branch_sync_target
  fetch_or_bootstrap || return 1

  local_hash=$(git rev-parse HEAD)
  remote_hash=$(git rev-parse "$REMOTE_BRANCH")

  if [[ "$local_hash" != "$remote_hash" ]]; then
    echo "❌ Error: Local branch is not in sync with remote." >&2
    echo "" >&2
    echo "Local:  $local_hash" >&2
    echo "Remote: $remote_hash" >&2
    echo "" >&2

    if git merge-base --is-ancestor "$remote_hash" HEAD 2>/dev/null; then
      local ahead
      ahead=$(git rev-list --count "$REMOTE_BRANCH"..HEAD)
      echo "Your branch is $ahead commit(s) ahead of '$REMOTE_BRANCH'." >&2
      echo "Push your changes with: git push" >&2
    elif git merge-base --is-ancestor HEAD "$remote_hash" 2>/dev/null; then
      local behind
      behind=$(git rev-list --count HEAD.."$REMOTE_BRANCH")
      echo "Your branch is $behind commit(s) behind '$REMOTE_BRANCH'." >&2
      echo "Pull the latest changes with: git pull" >&2
    else
      echo "Your branch has diverged from '$REMOTE_BRANCH'." >&2
      echo "You may need to rebase or merge." >&2
    fi

    return 1
  fi
}
