import * as fs from "node:fs";
import * as path from "node:path";
import { Ok, type Result } from "@/common/types/result";
import { isWorktreeRuntime as isCommonWorktreeRuntime } from "@/common/types/runtime";
import type { BeforeArchiveHook } from "@/node/services/workspaceLifecycleHooks";
import { log } from "@/node/services/log";

export const isWorktreeRuntime = isCommonWorktreeRuntime;

export function createWorktreeArchiveHook(options: {
  getDeleteWorktreeOnArchive: () => boolean;
}): BeforeArchiveHook {
  return async ({ workspaceMetadata }): Promise<Result<void>> => {
    const runtimeConfig = workspaceMetadata.runtimeConfig;
    if (!isWorktreeRuntime(runtimeConfig)) {
      return Ok(undefined);
    }

    if (!options.getDeleteWorktreeOnArchive()) {
      return Ok(undefined);
    }

    const managedPath = path.join(
      runtimeConfig.srcBaseDir,
      workspaceMetadata.projectName,
      workspaceMetadata.name
    );

    const managedPathExists = await fs.promises
      .access(managedPath)
      .then(() => true)
      .catch(() => false);
    if (!managedPathExists) {
      return Ok(undefined);
    }

    try {
      // Archive should stay non-blocking even if managed worktree cleanup fails.
      await fs.promises.rm(managedPath, { recursive: true, force: true });
    } catch (error) {
      log.debug("Failed to delete managed worktree during archive", {
        managedPath,
        error,
      });
    }

    return Ok(undefined);
  };
}
