/**
 * Filtering logic for command palette
 * Separates workspace switching from all other commands
 */

import { CommandIdMatchers } from "@/browser/utils/commandIds";

export interface CommandActionMinimal {
  id: string;
}

/**
 * Filters commands based on query prefix
 *
 * @param query - User's search query
 * @param actions - All available actions
 * @returns Filtered actions based on mode:
 *   - Default (no prefix): Only workspace switching commands (ws:switch:*)
 *   - ">" prefix: All commands EXCEPT workspace switching
 *   - "/" prefix: Empty (slash commands handled separately)
 */
export function filterCommandsByPrefix<T extends CommandActionMinimal>(
  query: string,
  actions: T[]
): T[] {
  const q = query.trim();

  // Slash commands are handled separately in the component
  if (q.startsWith("/")) {
    return [];
  }

  const showAllCommands = q.startsWith(">");

  // Default: show only workspace switching commands
  // With ">": show all commands EXCEPT workspace switching
  return showAllCommands
    ? actions.filter((action) => !CommandIdMatchers.isWorkspaceSwitch(action.id))
    : actions.filter((action) => CommandIdMatchers.isWorkspaceSwitch(action.id));
}
