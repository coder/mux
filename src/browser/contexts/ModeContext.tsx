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
  getUseProjectAgentsOnlyKey,
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
  const [useProjectAgentsOnly, setUseProjectAgentsOnly] = usePersistedState<boolean>(
    getUseProjectAgentsOnlyKey(scopeId),
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

  // Track current project to avoid stale updates
  const projectPathRef = useRef(props.projectPath);
  projectPathRef.current = props.projectPath;

  const fetchAgents = useCallback(
    async (
      projectPath: string | undefined,
      workspaceId: string | undefined,
      projectAgentsOnly: boolean
    ) => {
      if (!api || !projectPath) {
        setAgents([]);
        setLoaded(true);
        setLoadFailed(false);
        return;
      }

      try {
        // When projectAgentsOnly is true or no workspaceId, load from projectPath only.
        // Otherwise, load from workspacePath (worktree) for iterating on agent files.
        const result = await api.agents.list({
          projectPath,
          workspaceId: projectAgentsOnly ? undefined : workspaceId,
        });
        // Guard against stale updates if project changed mid-fetch
        if (projectPathRef.current === projectPath) {
          setAgents(result);
          setLoadFailed(false);
          setLoaded(true);
        }
      } catch {
        if (projectPathRef.current === projectPath) {
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
    void fetchAgents(props.projectPath, props.workspaceId, useProjectAgentsOnly);
  }, [fetchAgents, props.projectPath, props.workspaceId, useProjectAgentsOnly]);

  // Manual refresh function
  const refresh = useCallback(async () => {
    if (!props.projectPath) return;
    setRefreshing(true);
    try {
      await fetchAgents(props.projectPath, props.workspaceId, useProjectAgentsOnly);
    } finally {
      setRefreshing(false);
    }
  }, [fetchAgents, props.projectPath, props.workspaceId, useProjectAgentsOnly]);

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
      useProjectAgentsOnly,
      setUseProjectAgentsOnly,
    }),
    [
      agentId,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      setAgentId,
      useProjectAgentsOnly,
      setUseProjectAgentsOnly,
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
