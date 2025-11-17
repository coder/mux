import { useCallback, useEffect } from "react";
import { usePersistedState, readPersistedState, updatePersistedState } from "./usePersistedState";
import { MODEL_ABBREVIATIONS } from "@/browser/utils/slashCommands/registry";
import { defaultModel } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const MAX_LRU_SIZE = 12;
const LRU_KEY = "model-lru";

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

/**
 * Get the default model from LRU (non-hook version for use outside React)
 * This is the ONLY place that reads from LRU outside of the hook.
 *
 * @returns The most recently used model, or WORKSPACE_DEFAULTS.model if LRU is empty
 */
export function getDefaultModelFromLRU(): string {
  const lru = readPersistedState<string[]>(LRU_KEY, DEFAULT_MODELS.slice(0, MAX_LRU_SIZE));
  return lru[0] ?? FALLBACK_MODEL;
}

/**
 * Hook to manage a Least Recently Used (LRU) cache of AI models.
 * Stores up to 8 recently used models in localStorage.
 * Initializes with default abbreviated models if empty.
 */
export function useModelLRU() {
  const [recentModels, setRecentModels] = usePersistedState<string[]>(
    LRU_KEY,
    DEFAULT_MODELS.slice(0, MAX_LRU_SIZE),
    { listener: true }
  );

  // Merge any new defaults from MODEL_ABBREVIATIONS (only once on mount)
  useEffect(() => {
    setRecentModels((prev) => {
      const merged = [...prev];
      for (const defaultModel of DEFAULT_MODELS) {
        if (!merged.includes(defaultModel)) {
          merged.push(defaultModel);
        }
      }
      return merged.slice(0, MAX_LRU_SIZE);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

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
    return recentModels;
  }, [recentModels]);

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
    recentModels,
  };
}
