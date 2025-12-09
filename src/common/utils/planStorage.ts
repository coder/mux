import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getMuxPlansDir } from "@/common/constants/paths";

/**
 * Get the plan file path for a workspace.
 * Plan files are stored in a dedicated directory: ~/.mux/plans/{workspaceId}.md
 */
export function getPlanFilePath(workspaceId: string): string {
  return join(getMuxPlansDir(), `${workspaceId}.md`);
}

/**
 * Read the plan file content for a workspace.
 * Returns null if the file doesn't exist or can't be read.
 */
export function readPlanFile(workspaceId: string): string | null {
  const planPath = getPlanFilePath(workspaceId);
  try {
    return readFileSync(planPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Check if a plan file exists for a workspace.
 */
export function planFileExists(workspaceId: string): boolean {
  return existsSync(getPlanFilePath(workspaceId));
}
