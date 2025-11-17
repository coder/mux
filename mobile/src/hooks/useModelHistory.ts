import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_MODEL_ID, assertKnownModelId, sanitizeModelSequence } from "../utils/modelCatalog";

const STORAGE_KEY = "mux.models.recent";
const MAX_RECENT_MODELS = 8;
const FALLBACK_RECENTS = [DEFAULT_MODEL_ID];

async function readStoredModels(): Promise<string[]> {
  try {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!stored) {
      return FALLBACK_RECENTS.slice();
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return FALLBACK_RECENTS.slice();
    }
    return sanitizeModelSequence(parsed).slice(0, MAX_RECENT_MODELS);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read model history", error);
    }
    return FALLBACK_RECENTS.slice();
  }
}

async function persistModels(models: string[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(models.slice(0, MAX_RECENT_MODELS)));
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist model history", error);
    }
  }
}

export function useModelHistory() {
  const [recentModels, setRecentModels] = useState<string[]>(FALLBACK_RECENTS.slice());
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readStoredModels().then((models) => {
      if (cancelled) {
        return;
      }
      setRecentModels(models);
      setIsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateModels = useCallback((updater: (current: string[]) => string[]) => {
    setRecentModels((prev) => {
      const next = updater(prev);
      void persistModels(next);
      return next;
    });
  }, []);

  const addRecentModel = useCallback(
    (modelId: string) => {
      assertKnownModelId(modelId);
      updateModels((prev) => sanitizeModelSequence([modelId, ...prev]).slice(0, MAX_RECENT_MODELS));
    },
    [updateModels]
  );

  const replaceRecentModels = useCallback(
    (models: string[]) => {
      updateModels(() => sanitizeModelSequence(models).slice(0, MAX_RECENT_MODELS));
    },
    [updateModels]
  );

  return {
    recentModels,
    isLoaded,
    addRecentModel,
    replaceRecentModels,
  };
}
