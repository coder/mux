import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByModeKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

interface ThinkingContextType {
  model: string;
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

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);

  const [rawModel] = usePersistedState<string>(getModelKey(scopeId), defaultModel, {
    listener: true,
  });
  const canonicalModel = useMemo(
    () => migrateGatewayModel(rawModel || defaultModel),
    [rawModel, defaultModel]
  );

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

    const legacyKey = getThinkingLevelByModelKey(canonicalModel);
    const legacy = readPersistedState<ThinkingLevel | undefined>(legacyKey, undefined);
    if (legacy === undefined) {
      return;
    }

    const effective = enforceThinkingPolicy(canonicalModel, legacy);
    updatePersistedState(thinkingKey, effective);
  }, [canonicalModel, thinkingKey]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      const effective = enforceThinkingPolicy(canonicalModel, level);

      setThinkingLevelInternal(effective);

      // Workspace variant: persist to backend so settings follow the workspace across devices.
      if (!props.workspaceId) {
        return;
      }

      type WorkspaceAISettingsByModeCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const agentId = readPersistedState<string>(getAgentIdKey(scopeId), "exec");

      updatePersistedState<WorkspaceAISettingsByModeCache>(
        getWorkspaceAISettingsByModeKey(props.workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByModeCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [agentId]: { model: canonicalModel, thinkingLevel: effective },
          };
        },
        {}
      );

      // Only persist when the active agent is a base mode (exec/plan) so custom-agent overrides
      // don't clobber exec/plan defaults that other agents inherit.
      if (!api || (agentId !== "exec" && agentId !== "plan")) {
        return;
      }

      api.workspace
        .updateModeAISettings({
          workspaceId: props.workspaceId,
          mode: agentId,
          aiSettings: { model: canonicalModel, thinkingLevel: effective },
        })
        .catch(() => {
          // Best-effort only. If offline or backend is old, the next sendMessage will persist.
        });
    },
    [api, canonicalModel, props.workspaceId, scopeId, setThinkingLevelInternal]
  );

  // Global keybind: cycle thinking level (Ctrl/Cmd+Shift+T).
  // Implemented at the ThinkingProvider level so it works in both the workspace view
  // and the "New Workspace" creation screen (which doesn't mount AIView).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_THINKING)) {
        return;
      }

      if (e.repeat) {
        return;
      }

      e.preventDefault();

      const allowed = getThinkingPolicyForModel(canonicalModel);
      if (allowed.length <= 1) {
        return;
      }

      const currentIndex = allowed.indexOf(thinkingLevel);
      const nextIndex = (currentIndex + 1) % allowed.length;
      setThinkingLevel(allowed[nextIndex]);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canonicalModel, thinkingLevel, setThinkingLevel]);

  // Memoize context value to prevent unnecessary re-renders of consumers.
  const contextValue = useMemo(
    () => ({ model: canonicalModel, thinkingLevel, setThinkingLevel }),
    [canonicalModel, thinkingLevel, setThinkingLevel]
  );

  return <ThinkingContext.Provider value={contextValue}>{props.children}</ThinkingContext.Provider>;
};

export const useThinkingModel = () => {
  return useThinking().model;
};
export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};
