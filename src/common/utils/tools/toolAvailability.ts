import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";

export interface ToolAvailabilityContext {
  workspaceId: string;
  parentWorkspaceId?: string | null;
}

/**
 * Derive canonical tool-availability options from workspace context.
 * Single source of truth for which capability flags to pass to getAvailableTools().
 */
export function getToolAvailabilityOptions(context: ToolAvailabilityContext) {
  return {
    enableAgentReport: Boolean(context.parentWorkspaceId),
    enableSkillsCatalogTools: context.workspaceId === MUX_HELP_CHAT_WORKSPACE_ID,
  } as const;
}
