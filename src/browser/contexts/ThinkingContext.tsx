import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect, useMemo, useCallback } from "react";
import { THINKING_LEVEL_OFF, type ThinkingLevel } from "@/common/types/thinking";
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
  getWorkspaceAISettingsByAgentKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { useAPI } from "@/browser/contexts/API";
import {
  clearPendingWorkspaceAiSettings,
  getWorkspaceAiSettingsFromMetadata,
  markPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
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

function getModelForThinkingUpdate(
  scopeId: string,
  metadataModel: string | undefined,
  fallbackModel: string
): string {
  const persistedModel = readPersistedState<string | undefined>(getModelKey(scopeId), undefined);
  // Prefer localStorage, then metadata, then the default model to avoid clobbering startup metadata.
  return normalizeToCanonical(persistedModel ?? metadataModel ?? fallbackModel);
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = (props) => {
  const { api } = useAPI();
  const workspaceContext = useOptionalWorkspaceContext();
  const defaultModel = getDefaultModel();
  const scopeId = getScopeId(props.workspaceId, props.projectPath);
  const thinkingKey = getThinkingLevelKey(scopeId);
  const metadataAgentId = readPersistedState<string>(
    getAgentIdKey(scopeId),
    WORKSPACE_DEFAULTS.agentId
  );
  const metadataSettings = getWorkspaceAiSettingsFromMetadata(
    props.workspaceId ? workspaceContext?.workspaceMetadata.get(props.workspaceId) : undefined,
    metadataAgentId
  );

  // Workspace-scoped thinking. Null means no explicit user choice has been persisted yet.
  const [persistedThinkingLevel, setThinkingLevelInternal] =
    usePersistedState<ThinkingLevel | null>(thinkingKey, null, { listener: true });
  const thinkingLevel =
    persistedThinkingLevel ?? metadataSettings.thinkingLevel ?? THINKING_LEVEL_OFF;

  // One-time migration: if the new workspace-scoped key is missing, seed from the legacy per-model key.
  useEffect(() => {
    const existing = readPersistedState<ThinkingLevel | null | undefined>(thinkingKey, undefined);
    if (existing != null) {
      return;
    }

    const model = getCanonicalModelForScope(scopeId, defaultModel);
    const legacyKey = getThinkingLevelByModelKey(model);
    const legacy = readPersistedState<ThinkingLevel | undefined>(legacyKey, undefined);
    if (legacy === undefined) {
      return;
    }

    updatePersistedState(thinkingKey, legacy);
  }, [defaultModel, scopeId, thinkingKey]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      const model = getModelForThinkingUpdate(scopeId, metadataSettings.model, defaultModel);

      setThinkingLevelInternal(level);

      // Workspace variant: persist to backend so settings follow the workspace across devices.
      if (!props.workspaceId) {
        return;
      }

      const workspaceId = props.workspaceId;

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const normalizedAgentId =
        readPersistedState<string>(getAgentIdKey(scopeId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;

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

      // Avoid stale backend metadata clobbering newer local preferences when users
      // click through levels quickly (tests reproduce this by cycling to xhigh).
      markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
        model,
        thinkingLevel: level,
      });

      api.workspace
        .updateAgentAISettings({
          workspaceId,
          agentId: normalizedAgentId,
          aiSettings: { model, thinkingLevel: level },
        })
        .then((result) => {
          if (!result.success) {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          }
        })
        .catch(() => {
          clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
          // Best-effort only. If offline or backend is old, the next sendMessage will persist.
        });
    },
    [
      api,
      defaultModel,
      metadataSettings.model,
      props.workspaceId,
      scopeId,
      setThinkingLevelInternal,
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

      // Keep cycling aligned with setThinkingLevel so startup metadata uses the matching policy.
      const model = getModelForThinkingUpdate(scopeId, metadataSettings.model, defaultModel);
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
  }, [defaultModel, metadataSettings.model, scopeId, thinkingLevel, setThinkingLevel]);

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
