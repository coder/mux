import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * Generate a comparison key for workspace sidebar display.
 * Used by useStableReference to detect when sidebar needs re-render.
 *
 * IMPORTANT: If you add a field to WorkspaceMetadata that affects how
 * workspaces appear in the sidebar, add it here to ensure UI updates.
 */
export function getWorkspaceSidebarKey(meta: FrontendWorkspaceMetadata): string {
  const initKey = meta.isInitializing === true ? "initializing" : "";
  const removingKey = meta.isRemoving === true ? "removing" : "";
  const heartbeatEnabledKey = meta.heartbeat?.enabled === true ? "heartbeat-enabled" : "";

  return [
    meta.id,
    meta.name,
    meta.title ?? "", // Display title (falls back to name in UI)
    initKey,
    removingKey,
    heartbeatEnabledKey, // Heartbeat icon replaces the seen-state archive affordance in the sidebar.
    meta.parentWorkspaceId ?? "", // Nested sidebar indentation/order
    meta.taskStatus ?? "", // Task lifecycle label/state for sub-agent rows
    meta.agentType ?? "", // Agent preset badge/label (future)
    meta.sectionId ?? "", // Section grouping for sidebar organization
  ].join("|");
}
