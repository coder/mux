/**
 * Canonical argument-syntax hints for slash commands.
 * Used by: browser ghost-text overlay, ACP available-commands, and error-message usage strings.
 * Keyed by command name (without the leading "/").
 */
export const SLASH_COMMAND_HINTS = {
  truncate: "<0-100>",
  compact: "[-t <tokens>] [-m <model>] [continue message]",
  model: "<abbreviation|full-id>",
  fork: "[start message]",
  new: "<name> [-t <trunk-branch>] [-r <runtime>] [start message]",
  idle: "<hours>|off",
} as const satisfies Readonly<Record<string, string>>;
