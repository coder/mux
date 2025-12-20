import type { ReactNode } from "react";
import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { useAPI } from "@/browser/contexts/API";
import { persistedSettingsStore } from "@/browser/stores/PersistedSettingsStore";

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

  useEffect(() => {
    persistedSettingsStore.init(api);
  }, [api]);

  // Subscribe to persisted settings so we update thinking when the backend changes.
  const persistedSnapshot = useSyncExternalStore(
    (callback) => persistedSettingsStore.subscribe(callback),
    () => persistedSettingsStore.getSnapshot(),
    () => persistedSettingsStore.getSnapshot()
  );

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

  const thinkingLevel =
    persistedSnapshot.settings.ai?.thinkingLevelByModel?.[model] ??
    persistedSettingsStore.getThinkingLevelForModel(model);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      persistedSettingsStore.setAIThinkingLevel(model, level).catch(() => {
        // Best-effort. Store will heal on next refresh.
      });
    },
    [model]
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
