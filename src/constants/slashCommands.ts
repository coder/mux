/**
 * Slash command availability shared between suggestion filtering and command execution.
 */

export type SlashCommandVariant = "workspace" | "creation";

/**
 * Commands that are safe to run before a workspace exists (creation flow).
 * Keep this list intentionally small so unsupported commands never appear.
 */
export const CREATION_SUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "model",
  "providers",
  "vim",
]);

export function isCommandAvailableInVariant(
  commandKey: string,
  variant: SlashCommandVariant
): boolean {
  if (variant === "workspace") {
    return true;
  }

  return CREATION_SUPPORTED_COMMANDS.has(commandKey);
}
