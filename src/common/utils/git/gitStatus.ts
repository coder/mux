/**
 * Git status script and parsing utilities.
 * Frontend-safe (no Node.js imports).
 */

/**
 * Generate bash script to get git status for a workspace.
 * Returns structured output with base ref, show-branch, and dirty status.
 *
 * @param baseRef - The ref to compare against (e.g., "origin/main").
 *                  If not provided or not an origin/ ref, auto-detects.
 *                  "origin/HEAD" is treated as auto-detect because it can be stale
 *                  (e.g. in repos cloned from bundles).
 */
export function generateGitStatusScript(baseRef?: string): string {
  // Extract branch name if it's an origin/ ref, otherwise empty for auto-detect.
  // Note: origin/HEAD is ignored because it may point at a stale feature branch.
  const rawPreferredBranch = baseRef?.startsWith("origin/") ? baseRef.replace(/^origin\//, "") : "";
  const preferredBranch = rawPreferredBranch === "HEAD" ? "" : rawPreferredBranch;

  return `
# Determine primary branch to compare against
PRIMARY_BRANCH=""
PREFERRED_BRANCH="${preferredBranch}"

# Try preferred branch first if specified
if [ -n "$PREFERRED_BRANCH" ] && git rev-parse --verify "refs/remotes/origin/$PREFERRED_BRANCH" >/dev/null 2>&1; then
  PRIMARY_BRANCH="$PREFERRED_BRANCH"
fi

# Fall back to auto-detection
if [ -z "$PRIMARY_BRANCH" ]; then
  # symbolic-ref can be stale (e.g., when cloned from a bundle)
  SYMREF_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')

  # Trust symbolic-ref only if it looks like a default branch name
  case "$SYMREF_BRANCH" in
    main|master|develop|trunk|default|release)
      if git rev-parse --verify "refs/remotes/origin/$SYMREF_BRANCH" >/dev/null 2>&1; then
        PRIMARY_BRANCH="$SYMREF_BRANCH"
      fi
      ;;
  esac

  # Prefer origin/main or origin/master if present (handles stale origin/HEAD)
  if [ -z "$PRIMARY_BRANCH" ]; then
    if git rev-parse --verify "refs/remotes/origin/main" >/dev/null 2>&1; then
      PRIMARY_BRANCH="main"
    elif git rev-parse --verify "refs/remotes/origin/master" >/dev/null 2>&1; then
      PRIMARY_BRANCH="master"
    fi
  fi

  # Fallback: ask origin (may require network)
  if [ -z "$PRIMARY_BRANCH" ]; then
    PRIMARY_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d' ' -f5)
  fi
fi

# Exit if we can't determine primary branch
if [ -z "$PRIMARY_BRANCH" ]; then
  echo "ERROR: Could not determine primary branch"
  exit 1
fi

BASE_REF="origin/$PRIMARY_BRANCH"

# Get show-branch output for ahead/behind counts
SHOW_BRANCH=$(git show-branch --sha1-name HEAD "$BASE_REF" 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "ERROR: git show-branch failed"
  exit 1
fi

# Check for dirty (uncommitted changes)
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Compute line deltas (additions/deletions) vs merge-base with origin's primary branch.
#
# We emit *only* totals to keep output tiny (avoid output truncation in large repos).
MERGE_BASE=$(git merge-base HEAD "$BASE_REF" 2>/dev/null || echo "")

# Outgoing: local changes vs merge-base (working tree vs base, includes uncommitted changes)
OUTGOING_STATS="0 0"
if [ -n "$MERGE_BASE" ]; then
  OUTGOING_STATS=$(git diff --numstat "$MERGE_BASE" 2>/dev/null | awk '{ if ($1 == "-" || $2 == "-") next; add += $1; del += $2 } END { printf "%d %d", add+0, del+0 }')
  if [ -z "$OUTGOING_STATS" ]; then
    OUTGOING_STATS="0 0"
  fi
fi

# Incoming: remote primary branch changes vs merge-base
INCOMING_STATS="0 0"
if [ -n "$MERGE_BASE" ]; then
  INCOMING_STATS=$(git diff --numstat "$MERGE_BASE" "$BASE_REF" 2>/dev/null | awk '{ if ($1 == "-" || $2 == "-") next; add += $1; del += $2 } END { printf "%d %d", add+0, del+0 }')
  if [ -z "$INCOMING_STATS" ]; then
    INCOMING_STATS="0 0"
  fi
fi

# Output sections
echo "---PRIMARY---"
echo "$PRIMARY_BRANCH"
echo "---SHOW_BRANCH---"
echo "$SHOW_BRANCH"
echo "---DIRTY---"
echo "$DIRTY_COUNT"
echo "---LINE_DELTA---"
echo "$OUTGOING_STATS $INCOMING_STATS"
`;
}

/**
 * Bash script to get git status for a workspace (auto-detects primary branch).
 */
export const GIT_STATUS_SCRIPT = generateGitStatusScript();

/**
 * Parse the output from GIT_STATUS_SCRIPT.
 * Frontend-safe parsing function.
 */
export interface ParsedGitStatusOutput {
  primaryBranch: string;
  showBranchOutput: string;
  dirtyCount: number;
  outgoingAdditions: number;
  outgoingDeletions: number;
  incomingAdditions: number;
  incomingDeletions: number;
}

export function parseGitStatusScriptOutput(output: string): ParsedGitStatusOutput | null {
  // Split by section markers using regex to get content between markers
  const primaryRegex = /---PRIMARY---\s*([\s\S]*?)---SHOW_BRANCH---/;
  const showBranchRegex = /---SHOW_BRANCH---\s*([\s\S]*?)---DIRTY---/;
  const dirtyRegex = /---DIRTY---\s*(\d+)/;
  const lineDeltaRegex = /---LINE_DELTA---\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;

  const primaryMatch = primaryRegex.exec(output);
  const showBranchMatch = showBranchRegex.exec(output);
  const dirtyMatch = dirtyRegex.exec(output);
  const lineDeltaMatch = lineDeltaRegex.exec(output);

  if (!primaryMatch || !showBranchMatch || !dirtyMatch) {
    return null;
  }

  const outgoingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[1], 10) : 0;
  const outgoingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[2], 10) : 0;
  const incomingAdditions = lineDeltaMatch ? parseInt(lineDeltaMatch[3], 10) : 0;
  const incomingDeletions = lineDeltaMatch ? parseInt(lineDeltaMatch[4], 10) : 0;

  return {
    primaryBranch: primaryMatch[1].trim(),
    showBranchOutput: showBranchMatch[1].trim(),
    dirtyCount: parseInt(dirtyMatch[1], 10),
    outgoingAdditions,
    outgoingDeletions,
    incomingAdditions,
    incomingDeletions,
  };
}

/**
 * Smart git fetch script that minimizes lock contention.
 *
 * Uses ls-remote to check if remote has new commits before fetching.
 * This avoids locks in the common case where remote SHA is already local
 * (e.g., IDE or user already fetched).
 *
 * Flow:
 * 1. ls-remote --symref origin HEAD to get default branch + SHA (no lock, network only)
 * 2. rev-parse to check local remote-tracking SHA (no lock)
 * 3. If local already matches: skip fetch (no lock needed)
 * 4. If not: fetch updates (lock, but rare)
 */
export const GIT_FETCH_SCRIPT = `
# Disable ALL prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=echo
export SSH_ASKPASS=echo
export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Determine remote default branch + SHA via ls-remote (no lock, network only)
REMOTE_INFO=$(git ls-remote --symref origin HEAD 2>/dev/null || echo "")
PRIMARY_BRANCH=$(printf '%s\n' "$REMOTE_INFO" | awk '$1=="ref:" && $3=="HEAD" {sub("^refs/heads/","",$2); print $2; exit}')
REMOTE_SHA=$(printf '%s\n' "$REMOTE_INFO" | awk '$2=="HEAD" && $1!="ref:" {print $1; exit}')

if [ -z "$PRIMARY_BRANCH" ] || [ -z "$REMOTE_SHA" ]; then
  echo "SKIP: Could not get remote HEAD"
  exit 0
fi

# Check current local remote-tracking ref (no lock)
LOCAL_SHA=$(git rev-parse --verify "refs/remotes/origin/$PRIMARY_BRANCH" 2>/dev/null || echo "")

# If local tracking ref already matches remote, skip fetch
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "SKIP: Remote SHA already fetched"
  exit 0
fi

# Remote has new commits or ref moved - fetch updates
git -c protocol.version=2 \\
    -c fetch.negotiationAlgorithm=skipping \\
    fetch origin \\
    --prune \\
    --no-tags \\
    --no-recurse-submodules \\
    --no-write-fetch-head \\
    --filter=blob:none \\
    2>&1
`;
