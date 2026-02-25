import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
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
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : WORKSPACE_DEFAULTS.agentId;
}

type AgentDiscoveryCacheMode = "enabled" | "disabled";

function getAgentDiscoveryCacheMode(disableWorkspaceAgents: boolean): AgentDiscoveryCacheMode {
  return disableWorkspaceAgents ? "disabled" : "enabled";
}

function getWorkspaceDiscoveryCacheKey(
  workspaceId: string | undefined,
  projectPath: string | undefined,
  mode: AgentDiscoveryCacheMode
): string | undefined {
  if (!workspaceId) {
    return undefined;
  }

  return projectPath ? `${projectPath}:${workspaceId}:${mode}` : `${workspaceId}:${mode}`;
}

function getProjectDiscoveryCacheKey(
  projectPath: string | undefined,
  mode: AgentDiscoveryCacheMode
): string | undefined {
  return projectPath ? `${projectPath}:${mode}` : undefined;
}

type ProjectDiscoveryCacheSource = "project" | "workspace";

interface ProjectDiscoveryCacheEntry {
  agents: AgentDefinitionDescriptor[];
  source: ProjectDiscoveryCacheSource;
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
  const isProjectScope = !props.workspaceId && Boolean(props.projectPath);

  const [globalDefaultAgentId] = usePersistedState<string>(
    getAgentIdKey(GLOBAL_SCOPE_ID),
    WORKSPACE_DEFAULTS.agentId,
    {
      listener: true,
    }
  );

  const [scopedAgentId, setAgentIdRaw] = usePersistedState<string | null>(
    getAgentIdKey(scopeId),
    isProjectScope ? null : WORKSPACE_DEFAULTS.agentId,
    {
      listener: true,
    }
  );

  const [disableWorkspaceAgents, setDisableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(scopeId),
    false,
    { listener: true }
  );

  // The UI toggle for disableWorkspaceAgents was removed — clear persisted
  // true values so users who had it enabled aren't stranded with no way to
  // re-enable workspace agents.
  useEffect(() => {
    if (disableWorkspaceAgents) {
      setDisableWorkspaceAgents(false);
    }
  }, [disableWorkspaceAgents, setDisableWorkspaceAgents]);

  const setAgentId: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      setAgentIdRaw((prev) => {
        const previousAgentId = coerceAgentId(
          isProjectScope ? (prev ?? globalDefaultAgentId) : prev
        );
        const next = typeof value === "function" ? value(previousAgentId) : value;
        return coerceAgentId(next);
      });
    },
    [globalDefaultAgentId, isProjectScope, setAgentIdRaw]
  );

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const isMountedRef = useRef(true);
  // Keep recently-discovered agents in memory so workspace switches can render
  // immediately while the backend refresh completes.
  const workspaceDiscoveryCacheRef = useRef(new Map<string, AgentDefinitionDescriptor[]>());
  const projectDiscoveryCacheRef = useRef(new Map<string, ProjectDiscoveryCacheEntry>());

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
      const cacheMode = getAgentDiscoveryCacheMode(workspaceAgentsDisabled);
      const workspaceCacheKey = getWorkspaceDiscoveryCacheKey(workspaceId, projectPath, cacheMode);
      const projectCacheKey = getProjectDiscoveryCacheKey(projectPath, cacheMode);

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
          if (workspaceCacheKey) {
            workspaceDiscoveryCacheRef.current.set(workspaceCacheKey, result);
          }
          if (projectCacheKey) {
            projectDiscoveryCacheRef.current.set(projectCacheKey, {
              agents: result,
              source: workspaceId ? "workspace" : "project",
            });
          }
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
    const cacheMode = getAgentDiscoveryCacheMode(disableWorkspaceAgents);
    const workspaceCacheKey = getWorkspaceDiscoveryCacheKey(
      props.workspaceId,
      props.projectPath,
      cacheMode
    );
    const projectCacheKey = getProjectDiscoveryCacheKey(props.projectPath, cacheMode);
    const workspaceCachedAgents = workspaceCacheKey
      ? workspaceDiscoveryCacheRef.current.get(workspaceCacheKey)
      : undefined;
    const projectCacheEntry = projectCacheKey
      ? projectDiscoveryCacheRef.current.get(projectCacheKey)
      : undefined;
    // Avoid hydrating project-scoped providers from workspace-sourced cache
    // entries; those can include workspace-only agent definitions.
    const projectCachedAgents =
      projectCacheEntry == null
        ? undefined
        : props.workspaceId == null && projectCacheEntry.source === "workspace"
          ? undefined
          : projectCacheEntry.agents;
    const optimisticAgents = workspaceCachedAgents ?? projectCachedAgents;

    if (optimisticAgents !== undefined) {
      const usingWorkspaceSourcedProjectFallbackForWorkspace =
        workspaceCachedAgents === undefined &&
        projectCachedAgents !== undefined &&
        props.workspaceId !== undefined &&
        projectCacheEntry?.source === "workspace";
      // Workspace-sourced project fallback is display-only until workspace
      // discovery resolves, so users can't persist cross-workspace agent IDs.
      setAgents(
        usingWorkspaceSourcedProjectFallbackForWorkspace
          ? optimisticAgents.map((agent) => ({
              ...agent,
              uiSelectable: false,
            }))
          : optimisticAgents
      );
      // Keep loading state while only display-only fallback data is available.
      setLoaded(!usingWorkspaceSourcedProjectFallbackForWorkspace);
    } else {
      setAgents([]);
      setLoaded(false);
    }
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

  const cycleableAgents = useMemo(
    // Keep keyboard cycling aligned with numbered quick-select behavior: auto is
    // selectable via explicit toggle only, not via cycle-next shortcuts.
    () => sortAgentsStable(agents.filter((agent) => agent.uiSelectable && agent.id !== "auto")),
    [agents]
  );

  const cycleToNextAgent = useCallback(() => {
    if (cycleableAgents.length === 0) return;

    const activeAgentId = coerceAgentId(
      isProjectScope ? (scopedAgentId ?? globalDefaultAgentId) : scopedAgentId
    );
    const currentIndex = cycleableAgents.findIndex((agent) => agent.id === activeAgentId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleableAgents.length;
    const nextAgent = cycleableAgents[nextIndex];
    if (nextAgent) {
      setAgentId(nextAgent.id);
    }
  }, [globalDefaultAgentId, isProjectScope, scopedAgentId, cycleableAgents, setAgentId]);

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

  useEffect(() => {
    const handleRefreshRequested = () => {
      void refresh();
    };

    window.addEventListener(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED, handleRefreshRequested);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED, handleRefreshRequested);
  }, [refresh]);

  // Project-scoped providers should inherit the global default agent until a
  // project-scoped preference is explicitly set.
  const normalizedAgentId = coerceAgentId(
    isProjectScope ? (scopedAgentId ?? globalDefaultAgentId) : scopedAgentId
  );
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
