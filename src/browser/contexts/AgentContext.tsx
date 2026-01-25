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
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  getAgentIdKey,
  getProjectScopeId,
  getDisableWorkspaceAgentsKey,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { sortAgentsStable } from "@/browser/utils/agents";

export interface AgentContextValue {
  agentId: string;
  setAgentId: Dispatch<SetStateAction<string>>;
  /** The current agent's descriptor, or undefined if agents haven't loaded yet */
  currentAgent: AgentDefinitionDescriptor | undefined;
  agents: AgentDefinitionDescriptor[];
  loaded: boolean;
  loadFailed: boolean;
  /** Reload agent definitions from the backend */
  refresh: () => Promise<void>;
  /** True while a refresh is in progress */
  refreshing: boolean;
  /**
   * When true, agents are loaded from projectPath only (ignoring workspace worktree).
   * Useful for unbricking when iterating on agent files in a workspace.
   */
  disableWorkspaceAgents: boolean;
  setDisableWorkspaceAgents: Dispatch<SetStateAction<boolean>>;
}

const AgentContext = createContext<AgentContextValue | undefined>(undefined);

type AgentProviderProps =
  | { value: AgentContextValue; children: ReactNode }
  | { workspaceId?: string; projectPath?: string; children: ReactNode };

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
}

function coerceAgentId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "exec";
}

export function AgentProvider(props: AgentProviderProps) {
  if ("value" in props) {
    return <AgentContext.Provider value={props.value}>{props.children}</AgentContext.Provider>;
  }

  return <AgentProviderWithState {...props} />;
}

function AgentProviderWithState(props: {
  workspaceId?: string;
  projectPath?: string;
  children: ReactNode;
}) {
  const { api } = useAPI();

  const scopeId = getScopeId(props.workspaceId, props.projectPath);

  const [agentId, setAgentIdRaw] = usePersistedState<string>(getAgentIdKey(scopeId), "exec", {
    listener: true,
  });

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

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);

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
      fetchParamsRef.current = {
        projectPath,
        workspaceId,
        disableWorkspaceAgents: workspaceAgentsDisabled,
      };

      if (!api || (!projectPath && !workspaceId)) {
        if (isMountedRef.current) {
          setAgents([]);
          setLoaded(true);
          setLoadFailed(false);
        }
        return;
      }

      try {
        const result = await api.agents.list({
          projectPath,
          workspaceId,
          disableWorkspaceAgents: workspaceAgentsDisabled || undefined,
        });
        const current = fetchParamsRef.current;
        if (
          current.projectPath === projectPath &&
          current.workspaceId === workspaceId &&
          current.disableWorkspaceAgents === workspaceAgentsDisabled &&
          isMountedRef.current
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
          current.disableWorkspaceAgents === workspaceAgentsDisabled &&
          isMountedRef.current
        ) {
          setAgents([]);
          setLoadFailed(true);
          setLoaded(true);
        }
      }
    },
    [api]
  );

  useEffect(() => {
    setAgents([]);
    setLoaded(false);
    setLoadFailed(false);
    void fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

  const refresh = useCallback(async () => {
    if (!props.projectPath && !props.workspaceId) return;
    if (!isMountedRef.current) return;

    setRefreshing(true);
    try {
      await fetchAgents(props.projectPath, props.workspaceId, disableWorkspaceAgents);
    } finally {
      if (isMountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [fetchAgents, props.projectPath, props.workspaceId, disableWorkspaceAgents]);

  const selectableAgents = useMemo(
    () => sortAgentsStable(agents.filter((a) => a.uiSelectable)),
    [agents]
  );

  const cycleToNextAgent = useCallback(() => {
    if (selectableAgents.length < 2) return;

    const currentIndex = selectableAgents.findIndex((a) => a.id === coerceAgentId(agentId));
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selectableAgents.length;
    const nextAgent = selectableAgents[nextIndex];
    if (nextAgent) {
      setAgentId(nextAgent.id);
    }
  }, [agentId, selectableAgents, setAgentId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_AGENT)) {
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

  const normalizedAgentId = coerceAgentId(agentId);
  const currentAgent = loaded ? agents.find((a) => a.id === normalizedAgentId) : undefined;

  const agentContextValue = useMemo(
    () => ({
      agentId: normalizedAgentId,
      setAgentId,
      currentAgent,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
    }),
    [
      normalizedAgentId,
      setAgentId,
      currentAgent,
      agents,
      loaded,
      loadFailed,
      refresh,
      refreshing,
      disableWorkspaceAgents,
      setDisableWorkspaceAgents,
    ]
  );

  return <AgentContext.Provider value={agentContextValue}>{props.children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return ctx;
}
