/**
 * Validates workspace name format (for non-git runtimes)
 * - Must be 1-64 characters long
 * - Can only contain: lowercase letters, digits, underscore, hyphen
 * - Pattern: [a-z0-9_-]{1,64}
 */
export function validateWorkspaceName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  if (name.length > 64) {
    return { valid: false, error: "Workspace name cannot exceed 64 characters" };
  }

  const validPattern = /^[a-z0-9_-]+$/;
  if (!validPattern.test(name)) {
    return {
      valid: false,
      error: "Use only: a-z, 0-9, _, -",
    };
  }

  return { valid: true };
}

/**
 * Validates git branch names for worktree/SSH runtimes
 * - Must be 1-64 characters long
 * - Can only contain: lowercase letters, digits, underscore, hyphen, forward slash
 * - Cannot start or end with slash
 * - Cannot have consecutive slashes
 * - Pattern: [a-z0-9_-]+(/[a-z0-9_-]+)*
 *
 * This allows common branch naming conventions like:
 * - feature/foo
 * - bugfix/issue-123
 * - release/v1_0 (note: dots are not supported, use underscores)
 */
export function validateGitBranchName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Branch name cannot be empty" };
  }

  if (name.length > 64) {
    return { valid: false, error: "Branch name cannot exceed 64 characters" };
  }

  // Check for leading/trailing slashes
  if (name.startsWith("/") || name.endsWith("/")) {
    return { valid: false, error: "Branch name cannot start or end with /" };
  }

  // Check for consecutive slashes
  if (name.includes("//")) {
    return { valid: false, error: "Branch name cannot contain consecutive slashes" };
  }

  // Pattern: one or more segments of [a-z0-9_-]+ separated by single slashes
  const validPattern = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
  if (!validPattern.test(name)) {
    return {
      valid: false,
      error: "Use only: a-z, 0-9, _, -, /",
    };
  }

  return { valid: true };
}
