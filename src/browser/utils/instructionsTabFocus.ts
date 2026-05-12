import { focusRightSidebarTab } from "@/browser/utils/rightSidebarTabFocus";

/**
 * Programmatically reveal the right-sidebar Instructions tab for a workspace.
 * Used by the ChatInput decoration so clicking the inline preview brings the
 * user to the editor without having to know about layout helpers.
 *
 * If the tab is already present anywhere in the layout, it's focused in its
 * current tabset; otherwise it's added to the focused tabset.
 */
export function focusInstructionsTab(workspaceId: string): void {
  focusRightSidebarTab(workspaceId, "instructions");
}
