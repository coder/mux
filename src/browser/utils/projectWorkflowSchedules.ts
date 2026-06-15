import type { ProjectConfig, ProjectWorkflowSchedule } from "@/common/types/project";

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
