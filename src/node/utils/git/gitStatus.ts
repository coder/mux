/**
 * Git status script and parsing utilities.
 * Frontend-safe (no Node.js imports).
 */

/**
 * Bash script to get git status for a workspace.
 * Returns structured output with primary branch, show-branch, and dirty status.
 */
export const GIT_STATUS_SCRIPT = `
# Get primary branch - try multiple methods
PRIMARY_BRANCH=""

# Method 1: symbolic-ref (fastest)
PRIMARY_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')

# Method 2: remote show origin (fallback)
if [ -z "$PRIMARY_BRANCH" ]; then
  PRIMARY_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d' ' -f5)
fi

# Method 3: check for main or master
if [ -z "$PRIMARY_BRANCH" ]; then
  PRIMARY_BRANCH=$(git branch -r 2>/dev/null | grep -E 'origin/(main|master)$' | head -1 | sed 's@^.*origin/@@')
fi

# Exit if we can't determine primary branch
if [ -z "$PRIMARY_BRANCH" ]; then
  echo "ERROR: Could not determine primary branch"
  exit 1
fi

# Get show-branch output for ahead/behind counts
SHOW_BRANCH=$(git show-branch --sha1-name HEAD "origin/$PRIMARY_BRANCH" 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "ERROR: git show-branch failed"
  exit 1
fi

# Check for dirty (uncommitted changes)
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Output sections
echo "---PRIMARY---"
echo "$PRIMARY_BRANCH"
echo "---SHOW_BRANCH---"
echo "$SHOW_BRANCH"
echo "---DIRTY---"
echo "$DIRTY_COUNT"
`;

/**
 * Parse the output from GIT_STATUS_SCRIPT.
 * Frontend-safe parsing function.
 */
export interface ParsedGitStatusOutput {
  primaryBranch: string;
  showBranchOutput: string;
  dirtyCount: number;
}

export function parseGitStatusScriptOutput(output: string): ParsedGitStatusOutput | null {
  // Split by section markers using regex to get content between markers
  const primaryRegex = /---PRIMARY---\s*([\s\S]*?)---SHOW_BRANCH---/;
  const showBranchRegex = /---SHOW_BRANCH---\s*([\s\S]*?)---DIRTY---/;
  const dirtyRegex = /---DIRTY---\s*(\d+)/;

  const primaryMatch = primaryRegex.exec(output);
  const showBranchMatch = showBranchRegex.exec(output);
  const dirtyMatch = dirtyRegex.exec(output);

  if (!primaryMatch || !showBranchMatch || !dirtyMatch) {
    return null;
  }

  return {
    primaryBranch: primaryMatch[1].trim(),
    showBranchOutput: showBranchMatch[1].trim(),
    dirtyCount: parseInt(dirtyMatch[1], 10),
  };
}

/**
 * Optimized git fetch script with no prompts.
 *
 * Environment variables disable all interactive prompts (keychain, SSH, credentials).
 * Git flags optimize for speed - only fetch refs, not objects.
 */
export const GIT_FETCH_SCRIPT = `
# Disable ALL prompts
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=echo
export SSH_ASKPASS=echo
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Fast fetch with optimization flags
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
