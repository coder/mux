import type { WorkspaceMetadata } from "@/common/types/workspace";

type WorkspaceClassificationMetadata = Pick<
  WorkspaceMetadata,
  "executionId" | "parentWorkspaceId" | "taskStatus"
>;

/** Canonical task executions keep lifecycle identity in the execution registry. */
export function isCanonicalExecutionWorkspace(workspace: WorkspaceClassificationMetadata): boolean {
  return workspace.executionId != null;
}

/** Legacy agent rows are identified only by pre-execution task/parent metadata. */
export function isLegacyAgentWorkspace(workspace: WorkspaceClassificationMetadata): boolean {
  return (
    !isCanonicalExecutionWorkspace(workspace) &&
    (workspace.parentWorkspaceId != null || workspace.taskStatus != null)
  );
}
