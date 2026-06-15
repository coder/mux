import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { ProjectRef } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isWorkspaceArchived } from "@/common/utils/archive";

interface WorkflowScheduleTargetSource {
  sourceProjectPath?: string;
  projects?: readonly ProjectRef[];
  runtimeConfig?: RuntimeConfig;
}

export function getRuntimeConfigForScheduledNewWorkspaceTarget(
  sourceRuntimeConfig: RuntimeConfig | undefined
): RuntimeConfig | undefined {
  if (sourceRuntimeConfig?.type !== "ssh" || sourceRuntimeConfig.coder == null) {
    return sourceRuntimeConfig;
  }

  const {
    workspaceName: _workspaceName,
    existingWorkspace: _existingWorkspace,
    ...coder
  } = sourceRuntimeConfig.coder;
  return { ...sourceRuntimeConfig, coder };
}

export function getWorkflowScheduleNewWorkspaceTargetUnavailableReason(
  source: WorkflowScheduleTargetSource
): string | null {
  const runtimeConfig = source.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;

  if (source.sourceProjectPath === MULTI_PROJECT_CONFIG_KEY || (source.projects?.length ?? 0) > 1) {
    return "New-workspace scheduled runs are not supported for multi-project workspaces yet.";
  }

  if (runtimeConfig.type === "local" && !("srcBaseDir" in runtimeConfig)) {
    return "New-workspace scheduled runs are not supported for project-dir local workspaces yet.";
  }

  if (runtimeConfig.type === "ssh" && runtimeConfig.coder?.existingWorkspace === true) {
    return "New-workspace scheduled runs are not supported for existing Coder workspaces yet.";
  }

  return null;
}

export interface WorkflowScheduleNewWorkspaceTemplateCandidate {
  archivedAt?: string;
  unarchivedAt?: string;
  projects?: readonly ProjectRef[];
  runtimeConfig?: RuntimeConfig;
}

export function getSupportedWorkflowScheduleNewWorkspaceTemplate<
  T extends WorkflowScheduleNewWorkspaceTemplateCandidate,
>(input: {
  sourceProjectPath: string;
  workspaces: readonly T[];
}): { workspace: T | undefined; unavailableReason: string | null } {
  const activeWorkspaces = input.workspaces.filter(
    (workspace) => !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
  );
  const supportedWorkspace = activeWorkspaces.find(
    (workspace) =>
      getWorkflowScheduleNewWorkspaceTargetUnavailableReason({
        sourceProjectPath: input.sourceProjectPath,
        projects: workspace.projects,
        runtimeConfig: workspace.runtimeConfig,
      }) == null
  );
  if (supportedWorkspace != null || activeWorkspaces.length === 0) {
    return { workspace: supportedWorkspace, unavailableReason: null };
  }

  const unavailableReason = getWorkflowScheduleNewWorkspaceTargetUnavailableReason({
    sourceProjectPath: input.sourceProjectPath,
    projects: activeWorkspaces[0]?.projects,
    runtimeConfig: activeWorkspaces[0]?.runtimeConfig,
  });
  return {
    workspace: undefined,
    unavailableReason:
      unavailableReason ?? "New-workspace automations are unavailable for this project.",
  };
}
