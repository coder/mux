import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getProjectScopeId,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import { useScopedAiSettings } from "@/browser/hooks/useWorkspaceAiSettings";
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

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const { agentId, agents } = useAgent();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const isWorkspaceScope = Boolean(props.workspaceId);

  // Read model and thinking level from the unified accessor (includes migration for project/global)
  const settings = useScopedAiSettings({
    scopeId,
    workspaceId: props.workspaceId,
    agentId,
    agents,
  });
  const { thinkingLevel } = settings;

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      // Project/global scope: write to the scoped key
      if (!isWorkspaceScope) {
        updatePersistedState<ThinkingLevel>(getThinkingLevelKey(scopeId), level);
        return;
      }

      // Workspace scope: write to cache + backend
      const workspaceId = props.workspaceId;
      if (!workspaceId) {
        return;
      }

      const model = settings.model;

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
    [agentId, api, isWorkspaceScope, props.workspaceId, scopeId, settings.model]
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

      const allowed = getThinkingPolicyForModel(settings.model);
      if (allowed.length <= 1) {
        return;
      }

      const effectiveThinkingLevel = enforceThinkingPolicy(settings.model, thinkingLevel);
      const currentIndex = allowed.indexOf(effectiveThinkingLevel);
      const nextIndex = (currentIndex + 1) % allowed.length;
      setThinkingLevel(allowed[nextIndex]);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settings.model, thinkingLevel, setThinkingLevel]);

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
