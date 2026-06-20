import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export function canUseScheduledPromptsInWorkspace(
  meta: FrontendWorkspaceMetadata | null | undefined
): boolean {
  if (!meta || meta.incompatibleRuntime || meta.transcriptOnly) {
    return false;
  }

  // Queued/starting delegated task workspaces have no active composer/dispatcher yet.
  return !(
    Boolean(meta.parentWorkspaceId) &&
    (meta.taskStatus === "queued" || meta.taskStatus === "starting")
  );
}
