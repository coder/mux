/**
 * Validates workspace name format
 * - Must be 1-64 characters long
 * - Can only contain: lowercase letters, digits, underscore, hyphen
 * - Pattern: [a-z0-9_-]{1,64}
 */
import { WORKSPACE_NAME_MAX_LENGTH } from "@/constants/workspaceNaming";

export function validateWorkspaceName(name: string): { valid: boolean; error?: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: "Workspace name cannot be empty" };
  }

  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Workspace name cannot exceed ${WORKSPACE_NAME_MAX_LENGTH} characters`,
    };
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
