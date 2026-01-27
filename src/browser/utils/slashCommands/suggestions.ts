/**
 * Slash command suggestions generation
 */

import { getSlashCommandDefinitions } from "./parser";
import { SLASH_COMMAND_DEFINITION_MAP } from "./registry";
import type {
  SlashCommandDefinition,
  SlashSuggestion,
  SlashSuggestionContext,
  SuggestionDefinition,
} from "./types";

export type { SlashSuggestion } from "./types";

import { WORKSPACE_ONLY_COMMAND_KEYS } from "@/constants/slashCommands";

const COMMAND_DEFINITIONS = getSlashCommandDefinitions();

function filterAndMapSuggestions<T extends SuggestionDefinition>(
  definitions: readonly T[],
  partial: string,
  build: (definition: T) => SlashSuggestion,
  filter?: (definition: T) => boolean
): SlashSuggestion[] {
  const normalizedPartial = partial.trim().toLowerCase();

  return definitions
    .filter((definition) => {
      if (filter && !filter(definition)) return false;
      return normalizedPartial ? definition.key.toLowerCase().startsWith(normalizedPartial) : true;
    })
    .map((definition) => build(definition));
}

function buildTopLevelSuggestions(
  partial: string,
  context: SlashSuggestionContext
): SlashSuggestion[] {
  const isCreation = context.variant === "creation";

  const commandSuggestions = filterAndMapSuggestions(
    COMMAND_DEFINITIONS,
    partial,
    (definition) => {
      const appendSpace = definition.appendSpace ?? true;
      const replacement = `/${definition.key}${appendSpace ? " " : ""}`;
      return {
        id: `command:${definition.key}`,
        display: `/${definition.key}`,
        description: definition.description,
        replacement,
      };
    },
    // In creation mode, filter out workspace-only commands
    isCreation ? (definition) => !WORKSPACE_ONLY_COMMAND_KEYS.has(definition.key) : undefined
  );

  const formatScopeLabel = (scope: string): string => {
    if (scope === "global") {
      return "user";
    }
    return scope;
  };

  const skillDefinitions: SuggestionDefinition[] = (context.agentSkills ?? [])
    .filter((skill) => !SLASH_COMMAND_DEFINITION_MAP.has(skill.name))
    .map((skill) => ({
      key: skill.name,
      description: `${skill.description} (${formatScopeLabel(skill.scope)})`,
      appendSpace: true,
    }));

  const skillSuggestions = filterAndMapSuggestions(skillDefinitions, partial, (definition) => {
    const replacement = `/${definition.key} `;
    return {
      id: `skill:${definition.key}`,
      display: `/${definition.key}`,
      description: definition.description,
      replacement,
    };
  });

  return [...commandSuggestions, ...skillSuggestions];
}

function buildSubcommandSuggestions(
  commandDefinition: SlashCommandDefinition,
  partial: string,
  prefixTokens: string[]
): SlashSuggestion[] {
  const subcommands = commandDefinition.children ?? [];

  return filterAndMapSuggestions(subcommands, partial, (definition) => {
    const appendSpace = definition.appendSpace ?? true;
    const replacementTokens = [...prefixTokens, definition.key];
    const replacementBase = `/${replacementTokens.join(" ")}`;
    return {
      id: `command:${replacementTokens.join(":")}`,
      display: definition.key,
      description: definition.description,
      replacement: `${replacementBase}${appendSpace ? " " : ""}`,
    };
  });
}

export function getSlashCommandSuggestions(
  input: string,
  context: SlashSuggestionContext = {}
): SlashSuggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }

  const remainder = input.slice(1);
  if (remainder.startsWith(" ")) {
    return [];
  }

  const parts = remainder.split(/\s+/);
  const tokens = parts.filter((part) => part.length > 0);
  const hasTrailingSpace = remainder.endsWith(" ") || remainder.length === 0;
  const completedTokens = hasTrailingSpace ? tokens : tokens.slice(0, -1);
  const partialToken = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const stage = completedTokens.length;

  if (stage === 0) {
    return buildTopLevelSuggestions(partialToken, context);
  }

  const rootKey = completedTokens[0] ?? tokens[0];
  if (!rootKey) {
    return [];
  }

  const rootDefinition = SLASH_COMMAND_DEFINITION_MAP.get(rootKey);
  if (!rootDefinition) {
    return [];
  }

  // In creation mode, don't show subcommand suggestions for workspace-only commands
  if (context.variant === "creation" && WORKSPACE_ONLY_COMMAND_KEYS.has(rootKey)) {
    return [];
  }

  const definitionPath: SlashCommandDefinition[] = [rootDefinition];
  let lastDefinition = rootDefinition;

  for (let i = 1; i < completedTokens.length; i++) {
    const token = completedTokens[i];
    const nextDefinition = (lastDefinition.children ?? []).find((child) => child.key === token);

    if (!nextDefinition) {
      break;
    }

    definitionPath.push(nextDefinition);
    lastDefinition = nextDefinition;
  }

  const matchedDefinitionCount = definitionPath.length;

  // Try custom suggestions handler from the last matched definition
  if (lastDefinition.suggestions) {
    const customSuggestions = lastDefinition.suggestions({
      stage,
      partialToken,
      definitionPath,
      completedTokens,
      context,
    });

    if (customSuggestions !== null) {
      return customSuggestions;
    }
  }

  // Fall back to subcommand suggestions if available
  if (stage <= matchedDefinitionCount) {
    const definitionForSuggestions = definitionPath[Math.max(0, stage - 1)];

    if (definitionForSuggestions && (definitionForSuggestions.children ?? []).length > 0) {
      const prefixTokens = completedTokens.slice(0, stage);
      return buildSubcommandSuggestions(definitionForSuggestions, partialToken, prefixTokens);
    }
  }

  return [];
}
