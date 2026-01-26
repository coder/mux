import { WORKSPACE_NAME_MAX_LENGTH } from "@/constants/workspaceNaming";

/**
 * Build a workspace name with a suffix, trimming the base to fit length limits.
 */
export function buildWorkspaceNameWithSuffix(baseName: string, suffix: string | number): string {
  const suffixText = String(suffix);
  const reservedLength = suffixText.length + 1; // +1 for '-'
  const maxBaseLength = Math.max(1, WORKSPACE_NAME_MAX_LENGTH - reservedLength);
  const truncatedBase =
    baseName.length > maxBaseLength ? baseName.slice(0, maxBaseLength) : baseName;
  return `${truncatedBase}-${suffixText}`;
}
