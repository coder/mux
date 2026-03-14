/**
 * Validates workspace name format
 * - Must be 1-64 characters long
 * - Can only contain: lowercase letters, digits, underscore, hyphen, forward slash
 * - No leading, trailing, or consecutive slashes
 * - Pattern: [a-z0-9_-]+(?:\/[a-z0-9_-]+)* (1-64 characters)
 */
export function validateWorkspaceName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  if (name.length > 64) {
    return { valid: false, error: "Workspace name cannot exceed 64 characters" };
  }

  const validPattern = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
  if (!validPattern.test(name)) {
    return {
      valid: false,
      error:
        "Workspace names can only contain lowercase letters, numbers, hyphens, underscores, and forward slashes (no leading, trailing, or consecutive slashes)",
    };
  }

  return { valid: true };
}

/**
 * Convert a workspace name to a filesystem-safe path component by replacing
 * forward slashes with hyphens.
 */
export function sanitizeWorkspaceNameForPath(name: string): string {
  return name.replace(/\//g, "-");
}
