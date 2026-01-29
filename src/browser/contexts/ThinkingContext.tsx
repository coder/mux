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
  getWorkspaceAISettingsByAgentKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import { useWorkspaceAiSettings } from "@/browser/hooks/useWorkspaceAiSettings";
import { KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";

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
  const { agentId, agents } = useAgent();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);
  const isWorkspaceScope = Boolean(props.workspaceId);
  const workspaceId = props.workspaceId ?? "__workspace_ai_settings_fallback__";

  const workspaceSettings = useWorkspaceAiSettings({
    workspaceId,
    agentId,
    agents,
    defaultModel,
    enabled: isWorkspaceScope,
  });

  const [storedThinkingLevel, setStoredThinkingLevel] = usePersistedState<ThinkingLevel>(
    thinkingKey,
    "off",
    { listener: true }
  );
  const thinkingLevel = isWorkspaceScope ? workspaceSettings.thinkingLevel : storedThinkingLevel;

  // One-time migration: if the project/global key is missing, seed from the legacy per-model key.
  useEffect(() => {
    if (props.workspaceId) {
      return;
    }

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

    updatePersistedState(thinkingKey, legacy);
  }, [defaultModel, props.workspaceId, scopeId, thinkingKey]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      if (!isWorkspaceScope) {
        setStoredThinkingLevel(level);
        return;
      }

      const workspaceId = props.workspaceId;
      if (!workspaceId) {
        return;
      }

      const model = workspaceSettings.model;

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const normalizedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0
          ? agentId.trim().toLowerCase()
          : "exec";

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model, thinkingLevel: level },
          };
        },
        {}
      );

      if (!api) {
        return;
      }

      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: normalizedAgentId,
          aiSettings: { model, thinkingLevel: level },
        })
        .catch(() => {
          // Best-effort only. If offline or backend is old, the next sendMessage will persist.
        });
    },
    [
      agentId,
      api,
      isWorkspaceScope,
      props.workspaceId,
      setStoredThinkingLevel,
      workspaceSettings.model,
    ]
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

      const model = isWorkspaceScope
        ? workspaceSettings.model
        : getCanonicalModelForScope(scopeId, defaultModel);
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
  }, [
    defaultModel,
    isWorkspaceScope,
    scopeId,
    thinkingLevel,
    setThinkingLevel,
    workspaceSettings.model,
  ]);

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
