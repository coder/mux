import type { Config } from "@/node/config";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { WorkspaceForkResult } from "@/node/runtime/Runtime";

/**
 * Apply runtime config updates returned by runtime.forkWorkspace().
 *
 * Runtimes may return updated runtimeConfig for:
 * - the new workspace (forkedRuntimeConfig)
 * - the source workspace (sourceRuntimeConfig)
 *
 * This helper centralizes the logic so WorkspaceService and TaskService stay consistent.
 */
interface ApplyForkRuntimeUpdatesOptions {
  persistSourceRuntimeConfigUpdate?: boolean;
}

export async function applyForkRuntimeUpdates(
  config: Config,
  sourceWorkspaceId: string,
  sourceRuntimeConfig: RuntimeConfig,
  forkResult: WorkspaceForkResult,
  options: ApplyForkRuntimeUpdatesOptions = {}
): Promise<{ forkedRuntimeConfig: RuntimeConfig; sourceRuntimeConfigUpdate?: RuntimeConfig }> {
  // Inline: resolve fork runtime configs from the fork result
  const resolved = {
    forkedRuntimeConfig: forkResult.forkedRuntimeConfig ?? sourceRuntimeConfig,
    sourceRuntimeConfigUpdate: forkResult.sourceRuntimeConfig,
  };
  const persistSourceRuntimeConfigUpdate = options.persistSourceRuntimeConfigUpdate ?? true;

  if (persistSourceRuntimeConfigUpdate && resolved.sourceRuntimeConfigUpdate) {
    await config.updateWorkspaceMetadata(sourceWorkspaceId, {
      runtimeConfig: resolved.sourceRuntimeConfigUpdate,
    });
  }

  return resolved;
}
