import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { enforceThinkingPolicy } from "@/browser/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

function getCanonicalModelForScope(scopeId: string, fallbackModel: string): string {
  const rawModel = readPersistedState<string>(getModelKey(scopeId), fallbackModel);
  return migrateGatewayModel(rawModel || fallbackModel);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);

  // Workspace-scoped thinking. (No longer per-model.)
  const [thinkingLevel, setThinkingLevelInternal] = usePersistedState<ThinkingLevel>(
    thinkingKey,
    "off",
    { listener: true }
  );

  // One-time migration: if the new workspace-scoped key is missing, seed from the legacy per-model key.
  useEffect(() => {
    const existing = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
    if (existing !== undefined) {
      return;
    }

    const model = getCanonicalModelForScope(scopeId, defaultModel);
    const legacyKey = getThinkingLevelByModelKey(model);
    const legacy = readPersistedState<ThinkingLevel | undefined>(legacyKey, undefined);
    if (legacy === undefined) {
      return;
    }

    const effective = enforceThinkingPolicy(model, legacy);
    updatePersistedState(thinkingKey, effective);
  }, [defaultModel, scopeId, thinkingKey]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      const model = getCanonicalModelForScope(scopeId, defaultModel);
      const effective = enforceThinkingPolicy(model, level);

      setThinkingLevelInternal(effective);

      // Workspace variant: persist to backend so settings follow the workspace across devices.
      if (!props.workspaceId || !api) {
        return;
      }

      api.workspace
        .updateAISettings({
          workspaceId: props.workspaceId,
          aiSettings: { model, thinkingLevel: effective },
        })
        .catch(() => {
          // Best-effort only. If offline or backend is old, the next sendMessage will persist.
        });
    },
    [api, defaultModel, props.workspaceId, scopeId, setThinkingLevelInternal]
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
