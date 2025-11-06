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

const DEFAULT_MODE: WorkspaceMode = "plan";
const DEFAULT_REASONING: ThinkingLevel = "off";

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

/**
 * Hook to manage workspace defaults (mode and reasoning level).
 * These defaults are applied globally to all workspaces.
 */
export function useWorkspaceDefaults(): {
  defaultMode: WorkspaceMode;
  defaultReasoningLevel: ThinkingLevel;
  setDefaultMode: (mode: WorkspaceMode) => void;
  setDefaultReasoningLevel: (level: ThinkingLevel) => void;
  isLoading: boolean;
} {
  const [defaultMode, setDefaultModeState] = useState<WorkspaceMode>(DEFAULT_MODE);
  const [defaultReasoningLevel, setDefaultReasoningLevelState] =
    useState<ThinkingLevel>(DEFAULT_REASONING);
  const [isLoading, setIsLoading] = useState(true);

  // Load defaults on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([readWorkspaceMode(), readReasoningLevel()]).then(([mode, reasoning]) => {
      if (!cancelled) {
        setDefaultModeState(mode);
        setDefaultReasoningLevelState(reasoning);
        setIsLoading(false);
      }
    });
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

  return {
    defaultMode,
    defaultReasoningLevel,
    setDefaultMode,
    setDefaultReasoningLevel,
    isLoading,
  };
}
