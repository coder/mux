import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

/**
 * Generate a comparison key for workspace sidebar display.
 * Used by useStableReference to detect when sidebar needs re-render.
 *
 * IMPORTANT: If you add a field to WorkspaceMetadata that affects how
 * workspaces appear in the sidebar, add it here to ensure UI updates.
 */
export function getWorkspaceSidebarKey(meta: FrontendWorkspaceMetadata): string {
  return [
    meta.id,
    meta.name,
    meta.title ?? "", // Display title (falls back to name in UI)
    meta.status ?? "", // Working/idle status indicator
    meta.parentWorkspaceId ?? "", // Nested sidebar indentation/order
    meta.agentType ?? "", // Agent preset badge/label (future)
  ].join("|");
}
