import type { Dispatch, ReactNode, SetStateAction } from "react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAPI } from "@/browser/contexts/API";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  getAgentIdKey,
  getModeKey,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { UIMode } from "@/common/types/mode";
import { isPlanLike } from "@/common/utils/agentInheritance";

type ModeContextType = [UIMode, (mode: UIMode) => void];

const ModeContext = createContext<ModeContextType | undefined>(undefined);

interface ModeProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

function coerceAgentId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "exec";
}

function resolveModeFromAgentId(agentId: string, agents: AgentDefinitionDescriptor[]): UIMode {
  const normalizedAgentId = coerceAgentId(agentId);
  // Use proper inheritance check for multi-level support
  return isPlanLike(normalizedAgentId, agents) ? "plan" : "exec";
}

export const ModeProvider: React.FC<ModeProviderProps> = (props) => {
  const { api } = useAPI();

  // Priority: workspace-scoped > project-scoped > global
  const scopeId = getScopeId(props.workspaceId, props.projectPath);

  const legacyMode = readPersistedState<UIMode>(getModeKey(scopeId), "exec");

  const [agentId, setAgentIdRaw] = usePersistedState<string>(getAgentIdKey(scopeId), legacyMode, {
    listener: true,
  });

  const setAgentId: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      setAgentIdRaw((prev) => {
        const next = typeof value === "function" ? value(prev) : value;
        return coerceAgentId(next);
      });
    },
    [setAgentIdRaw]
  );

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Track current workspace to avoid stale updates
  const workspaceIdRef = useRef(props.workspaceId);
  workspaceIdRef.current = props.workspaceId;

  const fetchAgents = useCallback(
    async (workspaceId: string | undefined) => {
      if (!api || !workspaceId) {
        setAgents([]);
        setLoaded(true);
        setLoadFailed(false);
        return;
      }

      try {
        const result = await api.agents.list({ workspaceId });
        // Guard against stale updates if workspace changed mid-fetch
        if (workspaceIdRef.current === workspaceId) {
          setAgents(result);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        if (workspaceIdRef.current === workspaceId) {
          setAgents([]);
          setLoadFailed(true);
          setLoaded(true);
        }
      }
    },
    [api]
  );

  // Initial fetch
  useEffect(() => {
    setLoaded(false);
    setLoadFailed(false);
    void fetchAgents(props.workspaceId);
  }, [fetchAgents, props.workspaceId]);

  // Manual refresh function
  const refresh = useCallback(async () => {
    if (!props.workspaceId) return;
    setRefreshing(true);
    try {
      await fetchAgents(props.workspaceId);
    } finally {
      setRefreshing(false);
    }
  }, [fetchAgents, props.workspaceId]);

  const mode = useMemo(() => resolveModeFromAgentId(agentId, agents), [agentId, agents]);

  // Keep legacy mode key in sync so older code paths (and downgrade clients) behave consistently.
  useEffect(() => {
    const modeKey = getModeKey(scopeId);
    const existing = readPersistedState<UIMode>(modeKey, "exec");
    if (existing !== mode) {
      updatePersistedState(modeKey, mode);
    }
  }, [mode, scopeId]);

  const setMode = useCallback(
    (nextMode: UIMode) => {
      setAgentId(nextMode);
    },
    [setAgentId]
  );

  // Global keybind handler - opens the agent picker dropdown
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_MODE)) {
        return;
      }

      e.preventDefault();
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const agentContextValue = useMemo(
    () => ({
      agentId: coerceAgentId(agentId),
      setAgentId,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
    }),
    [agentId, agents, loaded, loadFailed, refresh, refreshing, setAgentId]
  );

  const modeContextValue: ModeContextType = [mode, setMode];

  return (
    <AgentProvider value={agentContextValue}>
      <ModeContext.Provider value={modeContextValue}>{props.children}</ModeContext.Provider>
    </AgentProvider>
  );
};

export const useMode = (): ModeContextType => {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error("useMode must be used within a ModeProvider");
  }
  return context;
};
