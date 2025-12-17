import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceWithNesting } from "@/browser/utils/ui/workspaceFiltering";

/**
 * Generate a comparison key for workspace sidebar display.
 * Used by useStableReference to detect when sidebar needs re-render.
 *
 * IMPORTANT: If you add a field to WorkspaceMetadata that affects how
 * workspaces appear in the sidebar, add it here to ensure UI updates.
 */
export function getWorkspaceSidebarKey(
  meta: FrontendWorkspaceMetadata | WorkspaceWithNesting
): string {
  const nestingDepth = "nestingDepth" in meta ? meta.nestingDepth : 0;
  return [
    meta.id,
    meta.name,
    meta.title ?? "", // Display title (falls back to name in UI)
    meta.status ?? "", // Working/idle status indicator
    meta.parentWorkspaceId ?? "", // Parent ID for agent task workspaces
    String(nestingDepth), // Nesting depth for indentation
  ].join("|");
}
