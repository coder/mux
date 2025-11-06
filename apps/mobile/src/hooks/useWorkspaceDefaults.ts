import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { ThinkingLevel } from "../contexts/ThinkingContext";

export type WorkspaceMode = "plan" | "exec";

export interface WorkspaceDefaults {
  defaultMode: WorkspaceMode;
  defaultReasoningLevel: ThinkingLevel;
}

const STORAGE_KEY_MODE = "cmux.workspace-defaults.mode";
const STORAGE_KEY_REASONING = "cmux.workspace-defaults.reasoning";
const STORAGE_KEY_MODEL = "cmux.workspace-defaults.model";
const STORAGE_KEY_1M_CONTEXT = "cmux.workspace-defaults.use1MContext";

const DEFAULT_MODE: WorkspaceMode = "plan";
const DEFAULT_REASONING: ThinkingLevel = "off";
const DEFAULT_MODEL = "anthropic:claude-sonnet-4-5";
const DEFAULT_1M_CONTEXT = false;

async function readWorkspaceMode(): Promise<WorkspaceMode> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_MODE);
    if (value === "plan" || value === "exec") {
      return value;
    }
    return DEFAULT_MODE;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read workspace mode", error);
    }
    return DEFAULT_MODE;
  }
}

async function writeWorkspaceMode(mode: WorkspaceMode): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_MODE, mode);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist workspace mode", error);
    }
  }
}

async function readReasoningLevel(): Promise<ThinkingLevel> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_REASONING);
    if (value === "off" || value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return DEFAULT_REASONING;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read reasoning level", error);
    }
    return DEFAULT_REASONING;
  }
}

async function writeReasoningLevel(level: ThinkingLevel): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_REASONING, level);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist reasoning level", error);
    }
  }
}

async function readModel(): Promise<string> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_MODEL);
    return value || DEFAULT_MODEL;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read model", error);
    }
    return DEFAULT_MODEL;
  }
}

async function writeModel(model: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_MODEL, model);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist model", error);
    }
  }
}

async function read1MContext(): Promise<boolean> {
  try {
    const value = await SecureStore.getItemAsync(STORAGE_KEY_1M_CONTEXT);
    return value === "true";
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read 1M context setting", error);
    }
    return DEFAULT_1M_CONTEXT;
  }
}

async function write1MContext(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY_1M_CONTEXT, enabled ? "true" : "false");
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist 1M context setting", error);
    }
  }
}

/**
 * Hook to manage workspace defaults (mode, reasoning level, model, and 1M context).
 * These defaults are applied globally to all workspaces.
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
    Promise.all([readWorkspaceMode(), readReasoningLevel(), readModel(), read1MContext()]).then(
      ([mode, reasoning, model, context1M]) => {
        if (!cancelled) {
          setDefaultModeState(mode);
          setDefaultReasoningLevelState(reasoning);
          setDefaultModelState(model);
          setUse1MContextState(context1M);
          setIsLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefaultMode = useCallback((mode: WorkspaceMode) => {
    setDefaultModeState(mode);
    void writeWorkspaceMode(mode);
  }, []);

  const setDefaultReasoningLevel = useCallback((level: ThinkingLevel) => {
    setDefaultReasoningLevelState(level);
    void writeReasoningLevel(level);
  }, []);

  const setDefaultModel = useCallback((model: string) => {
    setDefaultModelState(model);
    void writeModel(model);
  }, []);

  const setUse1MContext = useCallback((enabled: boolean) => {
    setUse1MContextState(enabled);
    void write1MContext(enabled);
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
