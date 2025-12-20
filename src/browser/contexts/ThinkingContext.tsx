import type { ReactNode } from "react";
import React, { createContext, useContext, useMemo, useCallback } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { useAPI } from "@/browser/contexts/API";

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

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);

  // Subscribe to model changes so we update thinking level when model changes.
  const [rawModel] = usePersistedState<string>(getModelKey(scopeId), defaultModel, {
    listener: true,
  });

  const model = useMemo(
    () => migrateGatewayModel(rawModel || defaultModel),
    [rawModel, defaultModel]
  );

  // Per-model thinking level (restored behavior).
  const thinkingKey = useMemo(() => getThinkingLevelByModelKey(model), [model]);
  const [thinkingLevel, setThinkingLevelInternal] = usePersistedState<ThinkingLevel>(
    thinkingKey,
    "off",
    { listener: true }
  );

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelInternal(level);

      // Workspace variant: persist to backend so settings follow the workspace across devices.
      if (!props.workspaceId || !api) {
        return;
      }

      api.workspace
        .updateAISettings({
          workspaceId: props.workspaceId,
          aiSettings: { model, thinkingLevel: level },
        })
        .catch(() => {
          // Best-effort only. If offline or backend is old, the next sendMessage will persist.
        });
    },
    [api, model, props.workspaceId, setThinkingLevelInternal]
  );

  // Memoize context value to prevent unnecessary re-renders of consumers.
  const contextValue = useMemo(
    () => ({ thinkingLevel, setThinkingLevel }),
    [thinkingLevel, setThinkingLevel]
  );

  return <ThinkingContext.Provider value={contextValue}>{props.children}</ThinkingContext.Provider>;
};

export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};
