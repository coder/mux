import type { ReactNode } from "react";
import React, { createContext, useContext } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { usePersistedState, readPersistedState } from "@/browser/hooks/usePersistedState";
import { getThinkingLevelByModelKey, getModelKey } from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // For existing workspaces
  projectPath?: string; // For workspace creation (uses project-scoped model key)
  children: ReactNode;
}

/**
 * Reads the current model from localStorage for the given scope.
 * Returns canonical model format (after gateway migration).
 */
function getScopedModel(workspaceId?: string, projectPath?: string): string {
  const defaultModel = getDefaultModel();
  // Use workspace-scoped model key if available, otherwise project-scoped
  const modelKey = workspaceId
    ? getModelKey(workspaceId)
    : projectPath
      ? getModelKey(`__project__/${projectPath}`)
      : null;

  if (!modelKey) {
    return defaultModel;
  }

  const rawModel = readPersistedState<string>(modelKey, defaultModel);
  // Normalize to canonical format (e.g., strip legacy gateway prefix)
  return migrateGatewayModel(rawModel || defaultModel);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = ({
  workspaceId,
  projectPath,
  children,
}) => {
  // Read current model from localStorage (non-reactive, re-reads on each render)
  const modelString = getScopedModel(workspaceId, projectPath);
  const key = getThinkingLevelByModelKey(modelString);
  const [thinkingLevel, setThinkingLevel] = usePersistedState<ThinkingLevel>(
    key,
    "off",
    { listener: true } // Listen for changes from command palette and other sources
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
