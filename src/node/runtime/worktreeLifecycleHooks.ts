import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import { Ok, type Result } from "@/common/types/result";
import { isWorktreeRuntime as isCommonWorktreeRuntime } from "@/common/types/runtime";
import type { AfterArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { log } from "@/node/services/log";
import { removeManagedGitWorktree } from "@/node/worktree/removeManagedGitWorktree";

function hasNamedWorkspacePath(
  workspaceMetadata: WorkspaceMetadata
): workspaceMetadata is FrontendWorkspaceMetadata {
  return typeof (workspaceMetadata as FrontendWorkspaceMetadata).namedWorkspacePath === "string";
}

export const isWorktreeRuntime = isCommonWorktreeRuntime;

export function createWorktreeArchiveHook(options: {
  getDeleteWorktreeOnArchive: () => boolean;
}): AfterArchiveHook {
  return async ({ workspaceMetadata }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isWorktreeRuntime(runtimeConfig)) {
      return Ok(undefined);
    }

    if (!options.getDeleteWorktreeOnArchive()) {
      return Ok(undefined);
    }

    if (!hasNamedWorkspacePath(workspaceMetadata)) {
      log.debug(
        "Skipping managed worktree cleanup during archive because persisted path is missing",
        {
          workspaceId: workspaceMetadata.id,
        }
      );
      return Ok(undefined);
    }

    const managedPath = workspaceMetadata.namedWorkspacePath;

    try {
      // Use the persisted workspace path so archive cleanup also works for layouts like _workspaces.
      // Archive should stay non-blocking even if managed worktree cleanup fails.
      await removeManagedGitWorktree(workspaceMetadata.projectPath, managedPath);
    } catch (error) {
      log.debug("Failed to delete managed worktree during archive", {
        managedPath,
        error,
      });
    }

    return Ok(undefined);
  };
}
