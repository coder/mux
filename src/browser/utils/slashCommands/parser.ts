/**
 * Command parser for parsing chat commands
 */

import type { ParsedCommand, SlashCommandDefinition } from "./types";
import { SLASH_COMMAND_DEFINITION_MAP } from "./registry";

export { SLASH_COMMAND_DEFINITIONS } from "./registry";

/**
 * Parse a raw command string into a structured command
 * @param input The raw command string (e.g., "/providers set anthropic apiKey sk-xxx")
 * @returns Parsed command or null if not a command
 */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Remove leading slash and split by spaces (respecting quotes)
  // Parse tokens from full input to support multi-line commands like /providers
  const parts = (trimmed.substring(1).match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) as string[];
  if (parts.length === 0) {
    return null;
  }

  const [commandKey, ...restTokens] = parts;
  const definition = SLASH_COMMAND_DEFINITION_MAP.get(commandKey);

  if (!definition) {
    return {
      type: "unknown-command",
      command: commandKey ?? "",
      subcommand: restTokens[0],
    };
  }

  const path: SlashCommandDefinition[] = [definition];
  let remainingTokens = restTokens;

  while (remainingTokens.length > 0) {
    const currentDefinition = path[path.length - 1];
    const children = currentDefinition.children ?? [];
    const nextToken = remainingTokens[0];
    const nextDefinition = children.find((child) => child.key === nextToken);

    if (!nextDefinition) {
      break;
    }

    path.push(nextDefinition);
    remainingTokens = remainingTokens.slice(1);
  }

  const targetDefinition = path[path.length - 1];

  if (!targetDefinition.handler) {
    return {
      type: "unknown-command",
      command: commandKey ?? "",
      subcommand: remainingTokens[0],
    };
  }

  const cleanRemainingTokens = remainingTokens.map((token) => token.replace(/^"(.*)"$/, "$1"));

  // Calculate rawInput: everything after the command key, preserving newlines
  // For "/compact -t 5000\nContinue here", rawInput should be "-t 5000\nContinue here"
  // For "/compact\nContinue here", rawInput should be "\nContinue here"
  // We trim leading spaces on the first line only, not newlines
  const commandKeyWithSlash = `/${commandKey}`;
  let rawInput = trimmed.substring(commandKeyWithSlash.length);
  // Only trim spaces at the start, not newlines
  while (rawInput.startsWith(" ")) {
    rawInput = rawInput.substring(1);
  }

  return targetDefinition.handler({
    definition: targetDefinition,
    path,
    remainingTokens,
    cleanRemainingTokens,
    rawInput,
  });
}

/**
 * Get slash command definitions for use in suggestions
 */
export function getSlashCommandDefinitions(): readonly SlashCommandDefinition[] {
  return Array.from(SLASH_COMMAND_DEFINITION_MAP.values());
}
