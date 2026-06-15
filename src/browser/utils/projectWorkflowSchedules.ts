import type { ProjectConfig, ProjectWorkflowSchedule } from "@/common/types/project";

export interface ExistingWorkspaceProjectWorkflowScheduleMatch {
  projectPath: string;
  schedule: ProjectWorkflowSchedule;
}

export function getExistingWorkspaceProjectWorkflowSchedule(input: {
  projectConfig: ProjectConfig | undefined;
  workspaceId: string;
}): ProjectWorkflowSchedule | undefined {
  const workspaceId = input.workspaceId.trim();
  if (workspaceId.length === 0) {
    return undefined;
  }

  return (input.projectConfig?.workflowSchedules ?? []).find(
    (schedule) =>
      schedule.target.type === "existing-workspace" && schedule.target.workspaceId === workspaceId
  );
}

export function getExistingWorkspaceProjectWorkflowScheduleMatch(input: {
  projectPath: string;
  projectConfig: ProjectConfig | undefined;
  userProjects: ReadonlyMap<string, ProjectConfig>;
  workspaceId: string;
}): ExistingWorkspaceProjectWorkflowScheduleMatch | undefined {
  const ownerProjectPath = input.projectConfig?.parentProjectPath ?? input.projectPath;
  const projectEntries =
    input.userProjects.size > 0
      ? input.userProjects.entries()
      : input.projectConfig != null
        ? new Map([[input.projectPath, input.projectConfig]]).entries()
        : new Map<string, ProjectConfig>().entries();

  for (const [projectPath, projectConfig] of projectEntries) {
    const projectOwnerPath = projectConfig.parentProjectPath ?? projectPath;
    if (projectOwnerPath !== ownerProjectPath) {
      continue;
    }
    const schedule = getExistingWorkspaceProjectWorkflowSchedule({
      projectConfig,
      workspaceId: input.workspaceId,
    });
    if (schedule != null) {
      return { projectPath, schedule };
    }
  }

  return undefined;
}
