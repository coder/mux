export interface ToolAvailabilityContext {
  workspaceId: string;
  parentWorkspaceId?: string | null;
  enableLspQuery?: boolean;
}

/**
 * Derive canonical tool-availability options from workspace context.
 * Single source of truth for which capability flags to pass to getAvailableTools().
 */
export function getToolAvailabilityOptions(context: ToolAvailabilityContext) {
  return {
    enableAgentReport: Boolean(context.parentWorkspaceId),
    enableLspQuery: context.enableLspQuery === true,
    // skills_catalog_* tools are always available; agent tool policy controls access.
  } as const;
}
