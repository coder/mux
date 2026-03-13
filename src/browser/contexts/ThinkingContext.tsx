import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import { THINKING_LEVEL_OFF, type ThinkingLevel } from "@/common/types/thinking";
import { readPersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";
import {
  setWorkspaceAiSettings,
  useWorkspaceAiSettings,
} from "@/browser/services/workspaceAiSettings";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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
  return normalizeToCanonical(rawModel || fallbackModel);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);

  // Project/new-workspace flows still use the flat thinking key directly.
  const [persistedThinkingLevel, setPersistedThinkingLevelInternal] =
    usePersistedState<ThinkingLevel>(thinkingKey, THINKING_LEVEL_OFF, { listener: true });
  const [activeAgentId] = usePersistedState<string>(
    getAgentIdKey(scopeId),
    WORKSPACE_DEFAULTS.agentId,
    { listener: true }
  );
  const workspaceAiSettings = useWorkspaceAiSettings(props.workspaceId, activeAgentId);

  const thinkingLevel = useMemo(() => {
    if (!props.workspaceId) {
      return persistedThinkingLevel;
    }

    return workspaceAiSettings.thinkingLevel;
  }, [persistedThinkingLevel, props.workspaceId, workspaceAiSettings.thinkingLevel]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      if (!props.workspaceId) {
        setPersistedThinkingLevelInternal(level);
        return;
      }

      setWorkspaceAiSettings(
        props.workspaceId,
        activeAgentId,
        { thinkingLevel: level },
        api ?? undefined
      );
    },
    [activeAgentId, api, props.workspaceId, setPersistedThinkingLevelInternal]
  );

  // Global keybind: cycle thinking level (Ctrl/Cmd+Shift+T).
  // Implemented at the ThinkingProvider level so it works in both the workspace view
  // and the "New Workspace" creation screen (which doesn't mount AIView).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_THINKING)) {
        return;
      }

      e.preventDefault();

      const model = getCanonicalModelForScope(scopeId, defaultModel);
      const allowed = getThinkingPolicyForModel(model);
      if (allowed.length <= 1) {
        return;
      }

      const effectiveThinkingLevel = enforceThinkingPolicy(model, thinkingLevel);
      const currentIndex = allowed.indexOf(effectiveThinkingLevel);
      const nextIndex = (currentIndex + 1) % allowed.length;
      setThinkingLevel(allowed[nextIndex]);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [defaultModel, scopeId, thinkingLevel, setThinkingLevel]);

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
