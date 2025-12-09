import { useEffect, useState, useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { ProvidersConfigMap, ProviderConfigInfo } from "@/common/orpc/types";

/**
 * Hook to get provider config with automatic refresh on config changes.
 * Subscribes to the backend's onConfigChanged event for external changes.
 * Use updateOptimistically for instant UI feedback when saving.
 */
export function useProvidersConfig() {
  const { api } = useAPI();
  const [config, setConfig] = useState<ProvidersConfigMap | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const cfg = await api.providers.getConfig();
      setConfig(cfg);
    } catch {
      // Ignore errors fetching config
    } finally {
      setLoading(false);
    }
  }, [api]);

  /**
   * Optimistically update local state for instant UI feedback.
   * Call this immediately when saving, before the API call completes.
   */
  const updateOptimistically = useCallback(
    (provider: string, updates: Partial<ProviderConfigInfo>) => {
      setConfig((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          [provider]: { ...prev[provider], ...updates },
        };
      });
    },
    []
  );

  /**
   * Optimistically update models for a provider.
   * Returns the new models array for use in the API call.
   */
  const updateModelsOptimistically = useCallback(
    (provider: string, updater: (currentModels: string[]) => string[]): string[] => {
      let newModels: string[] = [];
      setConfig((prev) => {
        if (!prev) return prev;
        const currentModels = prev[provider]?.models ?? [];
        newModels = updater(currentModels);
        return {
          ...prev,
          [provider]: { ...prev[provider], models: newModels },
        };
      });
      return newModels;
    },
    []
  );

  useEffect(() => {
    if (!api) return;
    const abortController = new AbortController();
    const signal = abortController.signal;

    // Initial fetch
    void refresh();

    // Subscribe to provider config changes via oRPC (for external changes)
    (async () => {
      try {
        const iterator = await api.providers.onConfigChanged(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          void refresh();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => abortController.abort();
  }, [api, refresh]);

  return { config, loading, refresh, updateOptimistically, updateModelsOptimistically };
}
