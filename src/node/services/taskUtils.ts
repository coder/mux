/**
 * Small pure helpers shared by TaskService and GitPatchArtifactService.
 * Extracted to a standalone module to avoid circular imports.
 */
import assert from "node:assert/strict";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

export function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function tryReadGitHeadCommitSha(
  runtime: Runtime,
  workspacePath: string
): Promise<string | undefined> {
  assert(workspacePath.length > 0, "tryReadGitHeadCommitSha: workspacePath must be non-empty");

  try {
    const result = await execBuffered(runtime, "git rev-parse HEAD", {
      cwd: workspacePath,
      timeout: 10,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }

    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export function findWorkspaceEntry(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): { projectPath: string; workspace: WorkspaceConfigEntry } | null {
  for (const [projectPath, project] of config.projects) {
    for (const workspace of project.workspaces) {
      if (workspace.id === workspaceId) {
        return { projectPath, workspace };
      }
    }
  }
  return null;
}
