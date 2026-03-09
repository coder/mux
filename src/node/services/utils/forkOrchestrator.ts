import { Err, Ok, type Result } from "@/common/types/result";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch, listLocalBranches } from "@/node/git";
import type { InitLogger, Runtime } from "@/node/runtime/Runtime";
import { getContainerName } from "@/node/runtime/DockerRuntime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { applyForkRuntimeUpdates } from "@/node/services/utils/forkRuntimeUpdates";

interface OrchestrateForkParams {
  /** Runtime for the source workspace (used to call forkWorkspace + optional create fallback) */
  sourceRuntime: Runtime;
  projectPath: string;
  sourceWorkspaceName: string;
  newWorkspaceName: string;
  initLogger: InitLogger;

  /** For applying runtime config updates */
  config: Config;
  sourceWorkspaceId: string;
  sourceRuntimeConfig: RuntimeConfig;

  /**
   * If true, fall back to createWorkspace when fork fails (task mode).
   * If false, return error on fork failure (interactive mode).
   */
  allowCreateFallback: boolean;

  /**
   * Caller-supplied trunk fallback, preferred over local git discovery.
   * Useful when local git metadata is unavailable (e.g. SSH/Docker queues).
   */
  preferredTrunkBranch?: string;

  abortSignal?: AbortSignal;
  /** Whether the project is trusted — when false, git hooks are disabled */
  trusted?: boolean;
}

interface OrchestrateForkSuccess {
  /** Path to the new workspace on disk */
  workspacePath: string;
  /** Trunk branch for init */
  trunkBranch: string;
  /** Resolved runtime config for the forked workspace */
  forkedRuntimeConfig: RuntimeConfig;
  /** Fresh runtime handle targeting the new workspace */
  targetRuntime: Runtime;
  /** Whether the fork succeeded (false = fell back to createWorkspace) */
  forkedFromSource: boolean;
  /** Resolved runtime config update for the source workspace (persisted by caller). */
  sourceRuntimeConfigUpdate?: RuntimeConfig;
  /** Whether source runtime config was updated (caller should emit metadata) */
  sourceRuntimeConfigUpdated: boolean;
}

export async function orchestrateFork(
  params: OrchestrateForkParams
): Promise<Result<OrchestrateForkSuccess>> {
  const {
    sourceRuntime,
    projectPath,
    sourceWorkspaceName,
    newWorkspaceName,
    initLogger,
    config,
    sourceWorkspaceId,
    sourceRuntimeConfig,
    allowCreateFallback,
    abortSignal,
  } = params;

  const forkResult = await sourceRuntime.forkWorkspace({
    projectPath,
    sourceWorkspaceName,
    newWorkspaceName,
    initLogger,
    abortSignal,
    trusted: params.trusted,
  });

  const { forkedRuntimeConfig, sourceRuntimeConfigUpdate } = await applyForkRuntimeUpdates(
    config,
    sourceWorkspaceId,
    sourceRuntimeConfig,
    forkResult,
    { persistSourceRuntimeConfigUpdate: false }
  );
  const sourceRuntimeConfigUpdated = sourceRuntimeConfigUpdate != null;

  // Forked workspace metadata must use destination identity, not inherited source state.
  // Docker containerName is derived from (projectPath, workspaceName); if the fork
  // inherits source config, the containerName would point at the wrong container.
  const normalizedForkedRuntimeConfig: RuntimeConfig =
    forkedRuntimeConfig.type === "docker"
      ? {
          ...forkedRuntimeConfig,
          containerName: getContainerName(projectPath, newWorkspaceName),
        }
      : forkedRuntimeConfig;

  if (!forkResult.success) {
    if (forkResult.failureIsFatal) {
      return Err(forkResult.error ?? "Fork failed (fatal)");
    }

    if (!allowCreateFallback) {
      return Err(forkResult.error ?? "Failed to fork workspace");
    }
  }

  let trunkBranch: string;
  if (forkResult.success && forkResult.sourceBranch) {
    trunkBranch = forkResult.sourceBranch;
  } else if (params.preferredTrunkBranch?.trim()) {
    // Caller-supplied fallback (e.g., queued task's persisted trunk branch).
    // Preferred over local git discovery, which may be unavailable in SSH/Docker.
    trunkBranch = params.preferredTrunkBranch.trim();
  } else {
    try {
      const localBranches = await listLocalBranches(projectPath);
      if (localBranches.includes(sourceWorkspaceName)) {
        trunkBranch = sourceWorkspaceName;
      } else {
        trunkBranch = await detectDefaultTrunkBranch(projectPath, localBranches);
      }
    } catch {
      trunkBranch = "main";
    }
  }

  let workspacePath: string;
  let forkedFromSource: boolean;
  if (forkResult.success) {
    if (!forkResult.workspacePath) {
      return Err("Fork succeeded but returned no workspace path");
    }
    workspacePath = forkResult.workspacePath;
    forkedFromSource = true;
  } else {
    const createResult = await sourceRuntime.createWorkspace({
      projectPath,
      branchName: newWorkspaceName,
      trunkBranch,
      directoryName: newWorkspaceName,
      initLogger,
      abortSignal,
      trusted: params.trusted,
    });

    if (!createResult.success || !createResult.workspacePath) {
      return Err(createResult.error ?? "Failed to create workspace");
    }

    workspacePath = createResult.workspacePath;
    forkedFromSource = false;
  }

  const targetRuntime = createRuntime(normalizedForkedRuntimeConfig, {
    projectPath,
    workspaceName: newWorkspaceName,
  });

  return Ok({
    workspacePath,
    trunkBranch,
    forkedRuntimeConfig: normalizedForkedRuntimeConfig,
    targetRuntime,
    forkedFromSource,
    ...(sourceRuntimeConfigUpdate ? { sourceRuntimeConfigUpdate } : {}),
    sourceRuntimeConfigUpdated,
  });
}
