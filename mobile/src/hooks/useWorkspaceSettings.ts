import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { ThinkingLevel, WorkspaceMode } from "../types/settings";
import { DEFAULT_MODEL_ID, assertKnownModelId, isKnownModelId } from "../utils/modelCatalog";

interface WorkspaceSettings {
  mode: WorkspaceMode;
  thinkingLevel: ThinkingLevel;
  model: string;
  use1MContext: boolean;
}

// Default values (hardcoded tier 3)
const DEFAULT_MODE: WorkspaceMode = "plan";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "off";
const WORKSPACE_PREFIX = "mux.workspace";
const DEFAULT_PREFIX = "mux.defaults";
const DEFAULT_MODEL = DEFAULT_MODEL_ID;
const DEFAULT_1M_CONTEXT = false;

/**
 * Sanitize workspace ID to be compatible with SecureStore key requirements.
 * SecureStore keys must contain only alphanumeric characters, ".", "-", and "_".
 */
function sanitizeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Get the storage key for a workspace-specific setting
 * Format: "mux.workspace.{sanitizedWorkspaceId}.{setting}"
 */
function getWorkspaceSettingKey(workspaceId: string, setting: string): string {
  return `${WORKSPACE_PREFIX}.${sanitizeWorkspaceId(workspaceId)}.${setting}`;
}

/**
 * Get the storage key for a global default setting
 * Format: "mux.defaults.{setting}"
 */
function getDefaultSettingKey(setting: string): string {
  return `${DEFAULT_PREFIX}.${setting}`;
}

/**
 * Read a setting with three-tier fallback:
 * 1. Workspace-specific setting
 * 2. Global default
 * 3. Hardcoded default
 */
async function readSetting<T>(
  workspaceId: string,
  setting: string,
  hardcodedDefault: T,
  validator?: (value: string) => T | null
): Promise<T> {
  try {
    // Tier 1: Try workspace-specific setting first
    const workspaceKey = getWorkspaceSettingKey(workspaceId, setting);
    const workspaceValue = await SecureStore.getItemAsync(workspaceKey);

    if (workspaceValue !== null) {
      if (validator) {
        const validated = validator(workspaceValue);
        if (validated !== null) {
          return validated;
        }
      } else {
        return workspaceValue as T;
      }
    }

    // Tier 2: Fallback to global default
    const defaultKey = getDefaultSettingKey(setting);
    const defaultValue = await SecureStore.getItemAsync(defaultKey);
    if (defaultValue !== null) {
      if (validator) {
        const validated = validator(defaultValue);
        if (validated !== null) {
          return validated;
        }
      } else {
        return defaultValue as T;
      }
    }

    // Tier 3: Use hardcoded default
    return hardcodedDefault;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Failed to read setting ${setting}:`, error);
    }
    return hardcodedDefault;
  }
}

/**
 * Write a workspace-specific setting
 */
async function writeSetting(workspaceId: string, setting: string, value: string): Promise<void> {
  try {
    const key = getWorkspaceSettingKey(workspaceId, setting);
    await SecureStore.setItemAsync(key, value);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Failed to write setting ${setting}:`, error);
    }
  }
}

/**
 * Delete a workspace-specific setting (revert to default)
 */
async function deleteSetting(workspaceId: string, setting: string): Promise<void> {
  try {
    const key = getWorkspaceSettingKey(workspaceId, setting);
    await SecureStore.deleteItemAsync(key);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Failed to delete setting ${setting}:`, error);
    }
  }
}

// Validators
function validateMode(value: string): WorkspaceMode | null {
  if (value === "plan" || value === "exec") {
    return value;
  }
  return null;
}

function validateThinkingLevel(value: string): ThinkingLevel | null {
  if (value === "off" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return null;
}

function validateModel(value: string): string | null {
  return isKnownModelId(value) ? value : null;
}
function validateBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Hook to manage workspace-specific settings with three-tier fallback:
 * 1. Workspace-specific setting (highest priority)
 * 2. Global default
 * 3. Hardcoded default (lowest priority)
 *
 * Settings are automatically loaded on mount and when workspace ID changes.
 */
export function useWorkspaceSettings(workspaceId: string): {
  mode: WorkspaceMode;
  thinkingLevel: ThinkingLevel;
  model: string;
  use1MContext: boolean;
  setMode: (mode: WorkspaceMode) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setUse1MContext: (enabled: boolean) => Promise<void>;
  isLoading: boolean;
} {
  const [mode, setModeState] = useState<WorkspaceMode>(DEFAULT_MODE);
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL);
  const [model, setModelState] = useState<string>(DEFAULT_MODEL);
  const [use1MContext, setUse1MContextState] = useState<boolean>(DEFAULT_1M_CONTEXT);
  const [isLoading, setIsLoading] = useState(true);

  // Load settings when workspace ID changes
  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      setIsLoading(true);
      try {
        const [loadedMode, loadedThinking, loadedModel, loaded1M] = await Promise.all([
          readSetting(workspaceId, "mode", DEFAULT_MODE, validateMode),
          readSetting(workspaceId, "reasoning", DEFAULT_THINKING_LEVEL, validateThinkingLevel),
          readSetting(workspaceId, "model", DEFAULT_MODEL, validateModel),
          readSetting(
            workspaceId,
            "use1MContext",
            DEFAULT_1M_CONTEXT,
            (v) => validateBoolean(v) ?? DEFAULT_1M_CONTEXT
          ),
        ]);

        if (!cancelled) {
          setModeState(loadedMode);
          setThinkingLevelState(loadedThinking);
          setModelState(loadedModel);
          setUse1MContextState(loaded1M);
          setIsLoading(false);
        }
      } catch (error) {
        if (!cancelled && process.env.NODE_ENV !== "production") {
          console.error("Failed to load workspace settings:", error);
        }
        setIsLoading(false);
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Setters
  const setMode = useCallback(
    async (newMode: WorkspaceMode) => {
      setModeState(newMode);
      await writeSetting(workspaceId, "mode", newMode);
    },
    [workspaceId]
  );

  const setThinkingLevel = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingLevelState(level);
      await writeSetting(workspaceId, "reasoning", level);
    },
    [workspaceId]
  );

  const setModel = useCallback(
    async (newModel: string) => {
      assertKnownModelId(newModel);
      setModelState(newModel);
      await writeSetting(workspaceId, "model", newModel);
    },
    [workspaceId]
  );

  const setUse1MContext = useCallback(
    async (enabled: boolean) => {
      setUse1MContextState(enabled);
      await writeSetting(workspaceId, "use1MContext", enabled ? "true" : "false");
    },
    [workspaceId]
  );

  return {
    mode,
    thinkingLevel,
    model,
    use1MContext,
    setMode,
    setThinkingLevel,
    setModel,
    setUse1MContext,
    isLoading,
  };
}
