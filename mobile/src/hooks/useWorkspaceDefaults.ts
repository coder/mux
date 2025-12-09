import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { ThinkingLevel, WorkspaceMode } from "../types/settings";
import { DEFAULT_MODEL_ID, assertKnownModelId, isKnownModelId } from "../utils/modelCatalog";

export interface GlobalDefaults {
  defaultMode: WorkspaceMode;
  defaultReasoningLevel: ThinkingLevel;
  defaultModel: string;
  default1MContext: boolean;
}

// New storage keys for global defaults (new tier 2 in the fallback)
const STORAGE_KEY_MODE = "com.coder.mux.defaults.mode";
const STORAGE_KEY_REASONING = "com.coder.mux.defaults.reasoning";
const STORAGE_KEY_MODEL = "com.coder.mux.defaults.model";
const STORAGE_KEY_1M_CONTEXT = "com.coder.mux.defaults.use1MContext";

const DEFAULT_MODE: WorkspaceMode = "exec";
const DEFAULT_REASONING: ThinkingLevel = "off";
const DEFAULT_MODEL = DEFAULT_MODEL_ID;
const DEFAULT_1M_CONTEXT = false;

async function readGlobalMode(): Promise<WorkspaceMode> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_MODE);
    if (value === "plan" || value === "exec") {
      return value;
    }
    return DEFAULT_MODE;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read global default mode", error);
    }
    return DEFAULT_MODE;
  }
}

async function writeGlobalMode(mode: WorkspaceMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_MODE, mode);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist global default mode", error);
    }
  }
}

async function readGlobalReasoning(): Promise<ThinkingLevel> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_REASONING);
    if (value === "off" || value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return DEFAULT_REASONING;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read global default reasoning level", error);
    }
    return DEFAULT_REASONING;
  }
}

async function writeGlobalReasoning(level: ThinkingLevel): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_REASONING, level);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist global default reasoning level", error);
    }
  }
}

async function readGlobalModel(): Promise<string> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_MODEL);
    if (value && isKnownModelId(value)) {
      return value;
    }
    return DEFAULT_MODEL;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read global default model", error);
    }
    return DEFAULT_MODEL;
  }
}

async function writeGlobalModel(model: string): Promise<void> {
  try {
    assertKnownModelId(model);
    await SecureStore.setItemAsync(STORAGE_KEY_MODEL, model);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist global default model", error);
    }
  }
}

async function readGlobal1MContext(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_1M_CONTEXT);
    if (value !== null) {
      return value === "true";
    }
    return DEFAULT_1M_CONTEXT;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read global default 1M context setting", error);
    }
    return DEFAULT_1M_CONTEXT;
  }
}

async function writeGlobal1MContext(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_1M_CONTEXT, enabled ? "true" : "false");
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist global default 1M context setting", error);
    }
  }
}

/**
 * Hook to manage global defaults (mode, reasoning level, model, and 1M context).
 * These defaults serve as fallback values when workspaces don't have their own settings.
 *
 * Note: Individual workspaces can override these defaults using useWorkspaceSettings.
 */
export function useWorkspaceDefaults(): {
  defaultMode: WorkspaceMode;
  defaultReasoningLevel: ThinkingLevel;
  defaultModel: string;
  use1MContext: boolean;
  setDefaultMode: (mode: WorkspaceMode) => void;
  setDefaultReasoningLevel: (level: ThinkingLevel) => void;
  setDefaultModel: (model: string) => void;
  setUse1MContext: (enabled: boolean) => void;
  isLoading: boolean;
} {
  const [defaultMode, setDefaultModeState] = useState<WorkspaceMode>(DEFAULT_MODE);
  const [defaultReasoningLevel, setDefaultReasoningLevelState] =
    useState<ThinkingLevel>(DEFAULT_REASONING);
  const [defaultModel, setDefaultModelState] = useState<string>(DEFAULT_MODEL);
  const [use1MContext, setUse1MContextState] = useState<boolean>(DEFAULT_1M_CONTEXT);
  const [isLoading, setIsLoading] = useState(true);

  // Load defaults on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readGlobalMode(),
      readGlobalReasoning(),
      readGlobalModel(),
      readGlobal1MContext(),
    ]).then(([mode, reasoning, model, context1M]) => {
      if (!cancelled) {
        setDefaultModeState(mode);
        setDefaultReasoningLevelState(reasoning);
        setDefaultModelState(model);
        setUse1MContextState(context1M);
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefaultMode = useCallback((mode: WorkspaceMode) => {
    setDefaultModeState(mode);
    void writeGlobalMode(mode);
  }, []);

  const setDefaultReasoningLevel = useCallback((level: ThinkingLevel) => {
    setDefaultReasoningLevelState(level);
    void writeGlobalReasoning(level);
  }, []);

  const setDefaultModel = useCallback((model: string) => {
    assertKnownModelId(model);
    setDefaultModelState(model);
    void writeGlobalModel(model);
  }, []);

  const setUse1MContext = useCallback((enabled: boolean) => {
    setUse1MContextState(enabled);
    void writeGlobal1MContext(enabled);
  }, []);

  return {
    defaultMode,
    defaultReasoningLevel,
    defaultModel,
    use1MContext,
    setDefaultMode,
    setDefaultReasoningLevel,
    setDefaultModel,
    setUse1MContext,
    isLoading,
  };
}
