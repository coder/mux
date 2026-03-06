import assert from "node:assert/strict";

import { type RuntimeConfig, getSrcBaseDir } from "@/common/types/runtime";
import { type ProjectRef, type WorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch, listLocalBranches } from "@/node/git";
import { ContainerManager, type ProjectWorkspaceEntry } from "@/node/multiProject/containerManager";
import { getContainerName } from "@/node/runtime/DockerRuntime";
import {
  MultiProjectRuntime,
  type MultiProjectRuntimeEntry,
} from "@/node/runtime/multiProjectRuntime";
import type { InitLogger, Runtime, WorkspaceForkResult } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { applyForkRuntimeUpdates } from "@/node/services/utils/forkRuntimeUpdates";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

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
   * Parent workspace metadata (when available).
   * Used to detect multi-project workspaces and inherit child metadata fields.
   */
  parentMetadata?: WorkspaceMetadata;

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
  /** Inherited multi-project refs for child metadata (when parent is multi-project). */
  projects?: ProjectRef[];
}

function normalizeForkedRuntimeConfig(
  forkedRuntimeConfig: RuntimeConfig,
  projectPath: string,
  newWorkspaceName: string
): RuntimeConfig {
  // Forked workspace metadata must use destination identity, not inherited source state.
  // Docker containerName is derived from (projectPath, workspaceName); if the fork
  // inherits source config, the containerName would point at the wrong container.
  return forkedRuntimeConfig.type === "docker"
    ? {
        ...forkedRuntimeConfig,
        containerName: getContainerName(projectPath, newWorkspaceName),
      }
    : forkedRuntimeConfig;
}

async function resolveTrunkBranch(
  projectPath: string,
  sourceWorkspaceName: string,
  forkResult: WorkspaceForkResult,
  preferredTrunkBranch?: string
): Promise<string> {
  if (forkResult.success && forkResult.sourceBranch) {
    return forkResult.sourceBranch;
  }

  if (preferredTrunkBranch?.trim()) {
    // Caller-supplied fallback (e.g., queued task's persisted trunk branch).
    // Preferred over local git discovery, which may be unavailable in SSH/Docker.
    return preferredTrunkBranch.trim();
  }

  try {
    const localBranches = await listLocalBranches(projectPath);
    if (localBranches.includes(sourceWorkspaceName)) {
      return sourceWorkspaceName;
    }

    return detectDefaultTrunkBranch(projectPath, localBranches);
  } catch {
    return "main";
  }
}

async function resolveMultiProjectFallbackTrunkBranch(
  projectPath: string,
  sourceWorkspaceName: string,
  forkResult: WorkspaceForkResult,
  preferredTrunkBranch?: string
): Promise<string> {
  if (forkResult.success && forkResult.sourceBranch) {
    return forkResult.sourceBranch;
  }

  if (preferredTrunkBranch?.trim()) {
    // Respect caller-supplied fallback before local discovery to match single-project behavior.
    return preferredTrunkBranch.trim();
  }

  try {
    const localBranches = await listLocalBranches(projectPath);
    if (localBranches.includes(sourceWorkspaceName)) {
      return sourceWorkspaceName;
    }

    return detectDefaultTrunkBranch(projectPath, localBranches);
  } catch {
    return "main";
  }
}

async function rollbackCreatedProjectWorkspaces(
  createdProjectRuntimes: MultiProjectRuntimeEntry[],
  workspaceName: string,
  getProjectTrusted: (projectPath: string) => boolean | undefined,
  abortSignal?: AbortSignal
): Promise<string[]> {
  const rollbackErrors: string[] = [];

  for (const projectRuntime of [...createdProjectRuntimes].reverse()) {
    const projectTrusted = getProjectTrusted(projectRuntime.projectPath);
    try {
      // Rollback should only clean up the new workspace path; forcing deletion could
      // remove a pre-existing same-named branch in worktree runtimes.
      const deleteResult = await projectRuntime.runtime.deleteWorkspace(
        projectRuntime.projectPath,
        workspaceName,
        false,
        abortSignal,
        projectTrusted
      );

      if (!deleteResult.success) {
        rollbackErrors.push(
          `[${projectRuntime.projectName}] ${deleteResult.error ?? "Unknown rollback error"}`
        );
      }
    } catch (error: unknown) {
      rollbackErrors.push(`[${projectRuntime.projectName}] ${getErrorMessage(error)}`);
    }
  }

  return rollbackErrors;
}

function withRollbackErrors(errorMessage: string, rollbackErrors: string[]): string {
  if (rollbackErrors.length === 0) {
    return errorMessage;
  }

  return `${errorMessage} Rollback errors: ${rollbackErrors.join("; ")}`;
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
    parentMetadata,
  } = params;

  if (parentMetadata && isMultiProject(parentMetadata)) {
    const projects = getProjects(parentMetadata);
    assert(projects.length > 1, "Multi-project fork requires at least two projects");

    const runtimeType = sourceRuntimeConfig.type;
    assert(
      runtimeType === "local" || runtimeType === "worktree",
      `Multi-project workspaces currently require local or worktree runtime, got: ${runtimeType}`
    );

    const containerSrcBaseDir = getSrcBaseDir(sourceRuntimeConfig) ?? config.srcDir;
    const containerManager = new ContainerManager(containerSrcBaseDir);

    const configSnapshot = config.loadConfigOrDefault();
    const getProjectTrusted = (projectPath: string): boolean =>
      configSnapshot.projects.get(stripTrailingSlashes(projectPath))?.trusted ?? false;

    // Trust gate: multi-project forks must fail before any fork/create work starts
    // if any project is untrusted. Parent workspaces can outlive trust changes,
    // so re-check each project at fork time.
    for (const project of projects) {
      const projectTrusted = getProjectTrusted(project.projectPath);
      if (!projectTrusted) {
        return Err(`Project ${project.projectPath} is not trusted`);
      }
    }

    const sourceProjectRuntimes: MultiProjectRuntimeEntry[] = projects.map((project) => ({
      projectPath: project.projectPath,
      projectName: project.projectName,
      runtime: createRuntime(sourceRuntimeConfig, {
        projectPath: project.projectPath,
        workspaceName: sourceWorkspaceName,
      }),
    }));

    const createdProjectRuntimes: MultiProjectRuntimeEntry[] = [];
    const projectWorkspaces: ProjectWorkspaceEntry[] = [];

    let normalizedForkedRuntimeConfig: RuntimeConfig = sourceRuntimeConfig;
    let sourceRuntimeConfigUpdate: RuntimeConfig | undefined;
    let sourceRuntimeConfigUpdated = false;
    let trunkBranch: string | undefined;
    let forkedFromSource = true;
    let primaryWorkspacePath: string | undefined;

    for (const [runtimeIndex, projectRuntime] of sourceProjectRuntimes.entries()) {
      const projectTrusted = getProjectTrusted(projectRuntime.projectPath);
      const forkResult = await projectRuntime.runtime.forkWorkspace({
        projectPath: projectRuntime.projectPath,
        sourceWorkspaceName,
        newWorkspaceName,
        initLogger,
        abortSignal,
        trusted: projectTrusted,
      });

      if (runtimeIndex === 0) {
        const runtimeUpdates = await applyForkRuntimeUpdates(
          config,
          sourceWorkspaceId,
          sourceRuntimeConfig,
          forkResult,
          { persistSourceRuntimeConfigUpdate: false }
        );
        normalizedForkedRuntimeConfig = normalizeForkedRuntimeConfig(
          runtimeUpdates.forkedRuntimeConfig,
          projectPath,
          newWorkspaceName
        );
        sourceRuntimeConfigUpdate = runtimeUpdates.sourceRuntimeConfigUpdate;
        sourceRuntimeConfigUpdated = sourceRuntimeConfigUpdate != null;

        trunkBranch = await resolveTrunkBranch(
          projectPath,
          sourceWorkspaceName,
          forkResult,
          params.preferredTrunkBranch
        );
      }

      assert(trunkBranch, "Multi-project fork requires trunkBranch after primary fork attempt");

      if (forkResult.success) {
        if (!forkResult.workspacePath) {
          const rollbackErrors = await rollbackCreatedProjectWorkspaces(
            [...createdProjectRuntimes, projectRuntime],
            newWorkspaceName,
            getProjectTrusted,
            abortSignal
          );
          return Err(
            withRollbackErrors(
              `Failed to fork project ${projectRuntime.projectName}: fork succeeded without workspace path`,
              rollbackErrors
            )
          );
        }

        if (runtimeIndex === 0) {
          primaryWorkspacePath = forkResult.workspacePath;
        }

        createdProjectRuntimes.push(projectRuntime);
        projectWorkspaces.push({
          projectName: projectRuntime.projectName,
          workspacePath: forkResult.workspacePath,
        });
        continue;
      }

      if (forkResult.failureIsFatal) {
        const rollbackErrors = await rollbackCreatedProjectWorkspaces(
          createdProjectRuntimes,
          newWorkspaceName,
          getProjectTrusted,
          abortSignal
        );
        return Err(
          withRollbackErrors(
            `Failed to fork project ${projectRuntime.projectName}: ${
              forkResult.error ?? "Fork failed (fatal)"
            }`,
            rollbackErrors
          )
        );
      }

      if (!allowCreateFallback) {
        const rollbackErrors = await rollbackCreatedProjectWorkspaces(
          createdProjectRuntimes,
          newWorkspaceName,
          getProjectTrusted,
          abortSignal
        );
        return Err(
          withRollbackErrors(
            `Failed to fork project ${projectRuntime.projectName}: ${
              forkResult.error ?? "Failed to fork workspace"
            }`,
            rollbackErrors
          )
        );
      }

      const projectTrunkBranch = await resolveMultiProjectFallbackTrunkBranch(
        projectRuntime.projectPath,
        sourceWorkspaceName,
        forkResult,
        params.preferredTrunkBranch
      );
      assert(
        projectTrunkBranch.length > 0,
        `Expected non-empty fallback trunk branch for project ${projectRuntime.projectPath}`
      );

      if (runtimeIndex === 0) {
        // Keep the returned trunk branch aligned with the branch used for primary fallback create.
        trunkBranch = projectTrunkBranch;
      }

      const createResult = await projectRuntime.runtime.createWorkspace({
        projectPath: projectRuntime.projectPath,
        branchName: newWorkspaceName,
        trunkBranch: projectTrunkBranch,
        directoryName: newWorkspaceName,
        initLogger,
        abortSignal,
        trusted: projectTrusted,
      });

      if (!createResult.success || !createResult.workspacePath) {
        const rollbackErrors = await rollbackCreatedProjectWorkspaces(
          createdProjectRuntimes,
          newWorkspaceName,
          getProjectTrusted,
          abortSignal
        );
        return Err(
          withRollbackErrors(
            `Failed to create workspace for project ${projectRuntime.projectName}: ${
              createResult.error ?? "Failed to create workspace"
            }`,
            rollbackErrors
          )
        );
      }

      if (runtimeIndex === 0) {
        primaryWorkspacePath = createResult.workspacePath;
      }

      forkedFromSource = false;
      createdProjectRuntimes.push(projectRuntime);
      projectWorkspaces.push({
        projectName: projectRuntime.projectName,
        workspacePath: createResult.workspacePath,
      });
    }

    assert(trunkBranch, "Expected trunkBranch to be resolved for multi-project fork");
    assert(
      primaryWorkspacePath,
      "Expected primary project workspace path to be resolved for multi-project fork"
    );

    try {
      await containerManager.createContainer(newWorkspaceName, projectWorkspaces);
    } catch (error: unknown) {
      const rollbackErrors = await rollbackCreatedProjectWorkspaces(
        createdProjectRuntimes,
        newWorkspaceName,
        getProjectTrusted,
        abortSignal
      );
      try {
        await containerManager.removeContainer(newWorkspaceName);
      } catch (cleanupError: unknown) {
        rollbackErrors.push(`[container] ${getErrorMessage(cleanupError)}`);
      }

      return Err(
        withRollbackErrors(
          `Failed to create child workspace container: ${getErrorMessage(error)}`,
          rollbackErrors
        )
      );
    }

    const targetProjectRuntimes: MultiProjectRuntimeEntry[] = projects.map((project) => ({
      projectPath: project.projectPath,
      projectName: project.projectName,
      runtime: createRuntime(normalizedForkedRuntimeConfig, {
        projectPath: project.projectPath,
        workspaceName: newWorkspaceName,
      }),
    }));

    const targetRuntime = new MultiProjectRuntime(
      containerManager,
      targetProjectRuntimes,
      newWorkspaceName
    );

    return Ok({
      // Persist the primary project git root for downstream patch artifacts; the
      // MultiProjectRuntime still targets the container path for command execution.
      workspacePath: primaryWorkspacePath,
      trunkBranch,
      forkedRuntimeConfig: normalizedForkedRuntimeConfig,
      targetRuntime,
      forkedFromSource,
      projects,
      ...(sourceRuntimeConfigUpdate ? { sourceRuntimeConfigUpdate } : {}),
      sourceRuntimeConfigUpdated,
    });
  }

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

  const normalizedForkedRuntimeConfig = normalizeForkedRuntimeConfig(
    forkedRuntimeConfig,
    projectPath,
    newWorkspaceName
  );

  if (!forkResult.success) {
    if (forkResult.failureIsFatal) {
      return Err(forkResult.error ?? "Fork failed (fatal)");
    }

    if (!allowCreateFallback) {
      return Err(forkResult.error ?? "Failed to fork workspace");
    }
  }

  const trunkBranch = await resolveTrunkBranch(
    projectPath,
    sourceWorkspaceName,
    forkResult,
    params.preferredTrunkBranch
  );

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
