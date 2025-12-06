import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";
import { MODEL_ABBREVIATIONS } from "@/browser/utils/slashCommands/registry";
import { defaultModel } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { useAPI } from "@/browser/contexts/API";
import { migrateGatewayModel, isGatewayFormat } from "./useGatewayModels";

const MAX_LRU_SIZE = 12;
const LRU_KEY = "model-lru";
const DEFAULT_MODEL_KEY = "model-default";

// Ensure defaultModel is first, then fill with other abbreviations (deduplicated)
const FALLBACK_MODEL = WORKSPACE_DEFAULTS.model ?? defaultModel;
const DEFAULT_MODELS = [
  FALLBACK_MODEL,
  ...Array.from(new Set(Object.values(MODEL_ABBREVIATIONS))).filter((m) => m !== FALLBACK_MODEL),
].slice(0, MAX_LRU_SIZE);

function persistModels(models: string[]): void {
  updatePersistedState(LRU_KEY, models.slice(0, MAX_LRU_SIZE));
}

export function evictModelFromLRU(model: string): void {
  const normalized = model.trim();
  if (!normalized) {
    return;
  }
  const current = readPersistedState<string[]>(LRU_KEY, DEFAULT_MODELS.slice(0, MAX_LRU_SIZE));
  const filtered = current.filter((m) => m !== normalized);
  if (filtered.length === current.length) {
    return;
  }
  const nextList = filtered.length > 0 ? filtered : DEFAULT_MODELS.slice(0, MAX_LRU_SIZE);
  persistModels(nextList);
}

export function getDefaultModel(): string {
  const persisted = readPersistedState<string | null>(DEFAULT_MODEL_KEY, null);
  if (!persisted) return FALLBACK_MODEL;
  // Migrate legacy mux-gateway format to canonical form
  return migrateGatewayModel(persisted);
}

/**
 * Hook to manage a Least Recently Used (LRU) cache of AI models.
 * Stores up to 8 recently used models in localStorage.
 * Initializes with default abbreviated models if empty.
 * Also includes custom models configured in Settings.
 */
export function useModelLRU() {
  const { api } = useAPI();
  const [recentModels, setRecentModels] = usePersistedState<string[]>(
    LRU_KEY,
    DEFAULT_MODELS.slice(0, MAX_LRU_SIZE),
    { listener: true }
  );
  const [customModels, setCustomModels] = useState<string[]>([]);

  const [defaultModel, setDefaultModel] = usePersistedState<string>(
    DEFAULT_MODEL_KEY,
    FALLBACK_MODEL,
    { listener: true }
  );

  // Merge any new defaults from MODEL_ABBREVIATIONS and migrate legacy gateway models (only once on mount)
  useEffect(() => {
    setRecentModels((prev) => {
      // Migrate any mux-gateway:provider/model entries to canonical form
      const migrated = prev.map((m) => migrateGatewayModel(m));
      // Remove any remaining mux-gateway entries that couldn't be migrated
      const filtered = migrated.filter((m) => !isGatewayFormat(m));
      // Deduplicate (migration might create duplicates)
      const deduped = [...new Set(filtered)];

      // Merge defaults
      const merged = [...deduped];
      for (const defaultModel of DEFAULT_MODELS) {
        if (!merged.includes(defaultModel)) {
          merged.push(defaultModel);
        }
      }
      return merged.slice(0, MAX_LRU_SIZE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Fetch custom models from providers config
  useEffect(() => {
    const abortController = new AbortController();
    if (!api) return;
    const signal = abortController.signal;

    const fetchCustomModels = async () => {
      try {
        const providerConfig = await api.providers.getConfig();
        const models: string[] = [];
        for (const [provider, config] of Object.entries(providerConfig)) {
          // Skip mux-gateway - those models are accessed via the cloud toggle, not listed separately
          if (provider === "mux-gateway") continue;
          if (config.models) {
            for (const modelId of config.models) {
              // Format as provider:modelId for consistency
              models.push(`${provider}:${modelId}`);
            }
          }
        }
        setCustomModels(models);
      } catch {
        // Ignore errors fetching custom models
      }
    };

    // Initial fetch
    void fetchCustomModels();

    // Subscribe to provider config changes via oRPC
    (async () => {
      try {
        const iterator = await api.providers.onConfigChanged(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          void fetchCustomModels();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => abortController.abort();
  }, [api]);

  // Combine LRU models with custom models (custom models appended, deduplicated)
  const allModels = useMemo(() => {
    const combined = [...recentModels];
    for (const model of customModels) {
      if (!combined.includes(model)) {
        combined.push(model);
      }
    }
    return combined;
  }, [recentModels, customModels]);

  /**
   * Add a model to the LRU cache. If it already exists, move it to the front.
   * If the cache is full, remove the least recently used model.
   */
  const addModel = useCallback(
    (modelString: string) => {
      setRecentModels((prev) => {
        // Remove model if it already exists
        const filtered = prev.filter((m) => m !== modelString);

        // Add to front
        const updated = [modelString, ...filtered];

        // Limit to MAX_LRU_SIZE
        return updated.slice(0, MAX_LRU_SIZE);
      });
    },
    [setRecentModels]
  );

  /**
   * Get the list of recently used models, most recent first.
   */
  const getRecentModels = useCallback(() => {
    return allModels;
  }, [allModels]);

  const evictModel = useCallback((modelString: string) => {
    if (!modelString.trim()) {
      return;
    }
    evictModelFromLRU(modelString);
  }, []);

  return {
    addModel,
    evictModel,
    getRecentModels,
    recentModels: allModels,
    defaultModel,
    setDefaultModel,
  };
}
