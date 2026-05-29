import { useMemo } from "react";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import { filterSuggestionsForMobile, MOBILE_HIDDEN_COMMANDS } from "../utils/slashCommandHelpers";

interface UseSlashCommandSuggestionsOptions {
  input: string;
  hiddenCommands?: ReadonlySet<string>;
  enabled?: boolean;
}

interface UseSlashCommandSuggestionsResult {
  suggestions: SlashSuggestion[];
}

export function useSlashCommandSuggestions(
  options: UseSlashCommandSuggestionsOptions
): UseSlashCommandSuggestionsResult {
  const { input, hiddenCommands = MOBILE_HIDDEN_COMMANDS, enabled = true } = options;

  const suggestions = useMemo(() => {
    if (!enabled) {
      return [];
    }
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) {
      return [];
    }
    const raw = getSlashCommandSuggestions(trimmed) ?? [];
    return filterSuggestionsForMobile(raw, hiddenCommands);
  }, [enabled, hiddenCommands, input]);

  return { suggestions };
}
