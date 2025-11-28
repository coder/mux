import { useEffect, useMemo, useState } from "react";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { getSlashCommandSuggestions } from "@/browser/utils/slashCommands/suggestions";
import type { MuxMobileClient } from "../api/client";
import { filterSuggestionsForMobile, MOBILE_HIDDEN_COMMANDS } from "../utils/slashCommandHelpers";

interface UseSlashCommandSuggestionsOptions {
  input: string;
  api: MuxMobileClient;
  hiddenCommands?: ReadonlySet<string>;
  enabled?: boolean;
}

interface UseSlashCommandSuggestionsResult {
  suggestions: SlashSuggestion[];
}

export function useSlashCommandSuggestions(
  options: UseSlashCommandSuggestionsOptions
): UseSlashCommandSuggestionsResult {
  const { input, api, hiddenCommands = MOBILE_HIDDEN_COMMANDS, enabled = true } = options;
  const [providerNames, setProviderNames] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) {
      setProviderNames([]);
      return;
    }

    let cancelled = false;
    const loadProviders = async () => {
      try {
        const names = await api.providers.list();
        if (!cancelled && Array.isArray(names)) {
          setProviderNames(names);
        }
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("[useSlashCommandSuggestions] Failed to load provider names", error);
        }
      }
    };

    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  const suggestions = useMemo(() => {
    if (!enabled) {
      return [];
    }
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) {
      return [];
    }
    const raw = getSlashCommandSuggestions(trimmed, { providerNames }) ?? [];
    return filterSuggestionsForMobile(raw, hiddenCommands);
  }, [enabled, hiddenCommands, input, providerNames]);

  return { suggestions };
}
