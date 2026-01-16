import type { Config } from "@/node/config";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceForkResult } from "@/node/runtime/Runtime";

export function resolveForkRuntimeConfigs(
  sourceRuntimeConfig: RuntimeConfig,
  forkResult: WorkspaceForkResult
): {
  forkedRuntimeConfig: RuntimeConfig;
  sourceRuntimeConfigUpdate?: RuntimeConfig;
} {
  return {
    forkedRuntimeConfig: forkResult.forkedRuntimeConfig ?? sourceRuntimeConfig,
    sourceRuntimeConfigUpdate: forkResult.sourceRuntimeConfig,
  };
}

/**
 * Apply runtime config updates returned by runtime.forkWorkspace().
 *
 * Runtimes may return updated runtimeConfig for:
 * - the new workspace (forkedRuntimeConfig)
 * - the source workspace (sourceRuntimeConfig)
 *
 * This helper centralizes the logic so WorkspaceService and TaskService stay consistent.
 */
export async function applyForkRuntimeUpdates(
  config: Config,
  sourceWorkspaceId: string,
  sourceRuntimeConfig: RuntimeConfig,
  forkResult: WorkspaceForkResult
): Promise<{ forkedRuntimeConfig: RuntimeConfig }> {
  const resolved = resolveForkRuntimeConfigs(sourceRuntimeConfig, forkResult);

  if (resolved.sourceRuntimeConfigUpdate) {
    await config.updateWorkspaceMetadata(sourceWorkspaceId, {
      runtimeConfig: resolved.sourceRuntimeConfigUpdate,
    });
  }

  return { forkedRuntimeConfig: resolved.forkedRuntimeConfig };
}
