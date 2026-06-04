import { useEffect, useState, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { HAS_CONFIGURED_PROVIDER_CACHE_KEY } from "@/common/constants/storage";
import type {
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";

function hasConfiguredProvider(config: ProvidersConfigMap): boolean {
  return Object.values(config).some((provider) => provider?.isConfigured);
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function getOptimisticConfiguredProvider(
  provider: string,
  info: ProviderConfigInfo
): ProviderConfigInfo {
  const hasBaseUrl = hasText(info.baseUrl) || hasText(info.baseUrlResolved);
  const hasModels = (info.models?.length ?? 0) > 0;
  const isEnabled = info.isEnabled !== false;

  const isConfigured = (() => {
    if (!isEnabled) return false;

    if (provider === "bedrock") {
      return hasText(info.aws?.region);
    }

    if (provider === "mux-gateway") {
      return info.couponCodeSet === true;
    }

    if (info.isCustom === true || info.providerType === "openai-compatible") {
      return hasBaseUrl;
    }

    if (provider === "ollama") {
      return hasBaseUrl || hasModels;
    }

    // This is a deliberately conservative browser-side mirror of the backend's
    // computed configuredness. The backend refresh remains authoritative, but the
    // local mirror prevents ProjectPage from hydrating through a stale provider branch.
    return (
      info.apiKeySet === true ||
      info.apiKeyFile != null ||
      info.apiKeySource === "env" ||
      info.codexOauthSet === true
    );
  })();

  return { ...info, isConfigured };
}

function updateHasConfiguredProviderCache(config: ProvidersConfigMap): void {
  updatePersistedState(HAS_CONFIGURED_PROVIDER_CACHE_KEY, hasConfiguredProvider(config));
}

/**
 * Hook to get provider config with automatic refresh on config changes.
 * Subscribes to the backend's onConfigChanged event for external changes.
 * Use updateOptimistically for instant UI feedback when saving.
 */
export function useProvidersConfig() {
  const { api } = useAPI();
  const [config, setConfig] = useState<ProvidersConfigMap | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep a synchronous reference to the latest config.
  //
  // React state updates are async, so values derived inside setState updaters
  // can't be returned reliably to the caller. (We need this for the custom
  // models UI, which computes an updated models array and persists it.)
  const configRef = useRef<ProvidersConfigMap | null>(null);
  // Version counter to ignore stale responses from out-of-order fetches
  const fetchVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!api) return;
    const myVersion = ++fetchVersionRef.current;
    try {
      const cfg = await api.providers.getConfig();
      // Only update if this is the latest fetch (ignore stale responses)
      if (myVersion === fetchVersionRef.current) {
        configRef.current = cfg;
        updateHasConfiguredProviderCache(cfg);
        setConfig(cfg);
      }
    } catch {
      // Ignore errors fetching config
    } finally {
      if (myVersion === fetchVersionRef.current) {
        setLoading(false);
      }
    }
  }, [api]);

  /**
   * Optimistically update local state for instant UI feedback.
   * Call this immediately when saving, before the API call completes.
   * Bumps the fetch version to invalidate any in-flight fetches that would
   * overwrite this optimistic state with stale data.
   */
  const updateOptimistically = useCallback(
    (provider: string, updates: Partial<ProviderConfigInfo>) => {
      // Invalidate any in-flight fetches so they don't overwrite our optimistic update
      fetchVersionRef.current++;

      const prev = configRef.current;
      if (!prev) return;

      const nextProvider = getOptimisticConfiguredProvider(provider, {
        ...prev[provider],
        ...updates,
      });
      const next: ProvidersConfigMap = {
        ...prev,
        [provider]: nextProvider,
      };

      configRef.current = next;
      updateHasConfiguredProviderCache(next);
      setConfig(next);
    },
    []
  );

  /**
   * Optimistically update models for a provider.
   * Returns the new models array for use in the API call.
   * Bumps the fetch version to invalidate any in-flight fetches.
   */
  const updateModelsOptimistically = useCallback(
    (
      provider: string,
      updater: (currentModels: ProviderModelEntry[]) => ProviderModelEntry[]
    ): ProviderModelEntry[] => {
      // Invalidate any in-flight fetches so they don't overwrite our optimistic update
      fetchVersionRef.current++;

      const prev = configRef.current;
      if (!prev) return [];

      const currentModels = prev[provider]?.models ?? [];
      const newModels = updater(currentModels);

      const nextProvider = getOptimisticConfiguredProvider(provider, {
        ...prev[provider],
        models: newModels,
      });
      const next: ProvidersConfigMap = {
        ...prev,
        [provider]: nextProvider,
      };

      configRef.current = next;
      updateHasConfiguredProviderCache(next);
      setConfig(next);
      return newModels;
    },
    []
  );

  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Some oRPC iterators don't eagerly close on abort alone.
    // Ensure we `return()` them so backend subscriptions clean up EventEmitter listeners.
    let iterator: AsyncIterator<unknown> | null = null;

    // Initial fetch
    void refresh();

    // Subscribe to provider config changes via oRPC (for external changes)
    (async () => {
      try {
        const subscribedIterator = await api.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void refresh();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refresh]);

  return { config, loading, refresh, updateOptimistically, updateModelsOptimistically };
}
