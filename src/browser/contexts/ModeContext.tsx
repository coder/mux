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
  getDisableWorkspaceAgentsKey,
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

  // Toggle to use project agents only (ignore workspace worktree agents)
  const [disableWorkspaceAgents, setDisableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(scopeId),
    false,
    { listener: true }
  );

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

  // Track current fetch parameters to avoid stale updates from slow responses.
  // All three values must match to apply a response - guards against:
  // - Project changed mid-fetch
  // - Workspace changed mid-fetch (different worktree)
  // - disableWorkspaceAgents toggled mid-fetch
  const fetchParamsRef = useRef({
    projectPath: props.projectPath,
    workspaceId: props.workspaceId,
    disableWorkspaceAgents,
  });

  const fetchAgents = useCallback(
    async (
      projectPath: string | undefined,
      workspaceId: string | undefined,
      workspaceAgentsDisabled: boolean
    ) => {
      // Update ref before fetch so we can compare after
      fetchParamsRef.current = {
        projectPath,
        workspaceId,
        disableWorkspaceAgents: workspaceAgentsDisabled,
      };

      // Need at least one of projectPath or workspaceId
      if (!api || (!projectPath && !workspaceId)) {
        setAgents([]);
        setLoaded(true);
        setLoadFailed(false);
        return;
      }

      try {
        // Pass workspaceId to use correct runtime (important for SSH), and
        // disableWorkspaceAgents flag to skip worktree and discover from projectPath.
        const result = await api.agents.list({
          projectPath,
          workspaceId,
          disableWorkspaceAgents: workspaceAgentsDisabled || undefined,
        });
        // Guard against stale updates: only apply if all params still match
        const current = fetchParamsRef.current;
        if (
          current.projectPath === projectPath &&
          current.workspaceId === workspaceId &&
          current.disableWorkspaceAgents === workspaceAgentsDisabled
        ) {
          setAgents(result);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        const current = fetchParamsRef.current;
        if (
          current.projectPath === projectPath &&
          current.workspaceId === workspaceId &&
          current.disableWorkspaceAgents === workspaceAgentsDisabled
        ) {
          setAgents([]);
          setLoadFailed(true);
          setLoaded(true);
        }
      }
    },
    [api]
  );

  // Initial fetch and re-fetch when toggle changes
  useEffect(() => {
    setLoaded(false);
    setLoadFailed(false);
    void fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

  // Manual refresh function
  const refresh = useCallback(async () => {
    if (!props.projectPath && !props.workspaceId) return;
    setRefreshing(true);
    try {
      await fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
    } finally {
      setRefreshing(false);
    }
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

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

  // Get UI-selectable agents for cycling
  const selectableAgents = useMemo(() => agents.filter((a) => a.uiSelectable), [agents]);

  // Cycle to next agent
  const cycleToNextAgent = useCallback(() => {
    if (selectableAgents.length < 2) return;

    const currentIndex = selectableAgents.findIndex((a) => a.id === coerceAgentId(agentId));
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selectableAgents.length;
    const nextAgent = selectableAgents[nextIndex];
    if (nextAgent) {
      setAgentId(nextAgent.id);
    }
  }, [agentId, selectableAgents, setAgentId]);

  // Global keybind handler - opens the agent picker dropdown
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_MODE)) {
        e.preventDefault();
        window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
        return;
      }

      if (matchesKeybind(e, KEYBINDS.CYCLE_AGENT)) {
        e.preventDefault();
        cycleToNextAgent();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cycleToNextAgent]);

  const agentContextValue = useMemo(
    () => ({
      agentId: coerceAgentId(agentId),
      setAgentId,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
    }),
    [
      agentId,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      setAgentId,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
    ]
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
