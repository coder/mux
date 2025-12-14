import type { ReactNode } from "react";
import React, { createContext, useContext, useMemo } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
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
 * Hook to get the model key for the current scope.
 */
function useModelKey(workspaceId?: string, projectPath?: string): string | null {
  return workspaceId
    ? getModelKey(workspaceId)
    : projectPath
      ? getModelKey(`__project__/${projectPath}`)
      : null;
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = ({
  workspaceId,
  projectPath,
  children,
}) => {
  const defaultModel = getDefaultModel();
  const modelKey = useModelKey(workspaceId, projectPath);

  // Subscribe to model changes so we update thinking level when model changes
  const [rawModel] = usePersistedState<string>(modelKey ?? "model:__unused__", defaultModel, {
    listener: true,
  });

  // Derive the thinking level key from the current model
  const thinkingKey = useMemo(() => {
    const model = migrateGatewayModel(rawModel || defaultModel);
    return getThinkingLevelByModelKey(model);
  }, [rawModel, defaultModel]);

  const [thinkingLevel, setThinkingLevel] = usePersistedState<ThinkingLevel>(
    thinkingKey,
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
