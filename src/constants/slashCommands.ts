/**
 * Slash command constants shared between suggestion filtering and command execution.
 */

/**
 * Commands that only work in workspace context (not during creation).
 * These commands require an existing workspace with conversation history.
 */
export const WORKSPACE_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "clear",
  "truncate",
  "compact",
  "fork",
  "new",
  "plan-show",
  "plan-open",
]);
