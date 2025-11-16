/**
 * Validates workspace name format
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
      error: "Workspace name can only contain lowercase letters, digits, underscore, and hyphen",
    };
  }

  return { valid: true };
}
