import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  usePersistedState,
  readPersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getThinkingLevelKey,
  getProjectScopeId,
  getModelKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelLRU";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // Workspace-scoped storage for model selection
  projectPath?: string; // Project-scoped storage for model selection (fallback)
  children: ReactNode;
}

/**
 * ThinkingProvider manages thinking level state per model.
 *
 * The thinking level is stored per model (e.g., "thinkingLevel:claude-sonnet-4-20250514")
 * so users can set different levels for different models and have them remembered.
 *
 * When the selected model changes, the thinking level is loaded from that model's storage.
 */
export const ThinkingProvider: React.FC<ThinkingProviderProps> = ({
  workspaceId,
  projectPath,
  children,
}) => {
  // Derive model storage scope (workspace or project)
  const modelScopeId =
    workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
  const modelKey = getModelKey(modelScopeId);

  // Listen for model changes in this scope
  const [selectedModel] = usePersistedState<string | null>(modelKey, null, { listener: true });
  const currentModel = selectedModel ?? getDefaultModel();

  // Local state for thinking level (managed per model)
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>(() => {
    return readPersistedState<ThinkingLevel>(getThinkingLevelKey(currentModel), "off");
  });

  // When model changes, load that model's thinking level
  useEffect(() => {
    const modelThinkingKey = getThinkingLevelKey(currentModel);
    const modelThinkingLevel = readPersistedState<ThinkingLevel>(modelThinkingKey, "off");
    setThinkingLevelState(modelThinkingLevel);
  }, [currentModel]);

  // Listen for storage events (from command palette or other sources)
  useEffect(() => {
    const modelThinkingKey = getThinkingLevelKey(currentModel);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === modelThinkingKey && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as ThinkingLevel;
          setThinkingLevelState(parsed);
        } catch {
          // Invalid JSON, ignore
        }
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [currentModel]);

  // Save thinking level to current model's storage
  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelState(level);
      updatePersistedState(getThinkingLevelKey(currentModel), level);
    },
    [currentModel]
  );

  return (
    <ThinkingContext.Provider value={{ thinkingLevel, setThinkingLevel }}>
      {children}
    </ThinkingContext.Provider>
  );
};

export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};
