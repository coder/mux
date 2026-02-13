import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { Input } from "@/browser/components/ui/input";
import { Switch } from "@/browser/components/ui/switch";
import { Button } from "@/browser/components/ui/button";
import { ModelSelector } from "@/browser/components/ModelSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { getDefaultModel, useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY, getModelKey } from "@/common/constants/storage";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import {
  normalizeAgentAiDefaults,
  type AgentAiDefaults,
  type AgentAiDefaultsEntry,
} from "@/common/types/agentAiDefaults";
import {
  DEFAULT_TASK_SETTINGS,
  TASK_SETTINGS_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
import { getThinkingOptionLabel, type ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { getErrorMessage } from "@/common/utils/errors";

const INHERIT = "__inherit__";

const FALLBACK_AGENTS: AgentDefinitionDescriptor[] = [
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    description: "Create a plan before coding",
    uiSelectable: true,
    subagentRunnable: true,
    base: "plan",
  },
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    description: "Implement changes in the repository",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    // Keep Ask visible when workspace agent discovery is unavailable.
    id: "ask",
    scope: "built-in",
    name: "Ask",
    description: "Delegate questions to Explore sub-agents and synthesize an answer.",
    uiSelectable: true,
    subagentRunnable: false,
    base: "exec",
  },
  {
    id: "compact",
    scope: "built-in",
    name: "Compact",
    description: "History compaction (internal)",
    uiSelectable: false,
    subagentRunnable: false,
  },
  {
    id: "explore",
    scope: "built-in",
    name: "Explore",
    description: "Read-only repository exploration",
    uiSelectable: false,
    subagentRunnable: true,
    base: "exec",
  },
  {
    id: "mux",
    scope: "built-in",
    name: "Mux",
    description: "Configure mux global behavior (system workspace)",
    uiSelectable: false,
    subagentRunnable: false,
  },
  {
    // Keep every built-in agent ID in the fallback list so user overrides don't
    // get mislabeled as "Unknown agents" when workspace discovery is unavailable.
    id: "orchestrator",
    scope: "built-in",
    name: "Orchestrator",
    description: "Coordinate sub-agent implementation and apply patches",
    uiSelectable: true,
    subagentRunnable: false,
    base: "exec",
  },
  {
    id: "system1_bash",
    scope: "built-in",
    name: "System1 Bash",
    description: "Fast bash-output filtering (internal)",
    uiSelectable: false,
    subagentRunnable: false,
  },
];

function getAgentDefinitionPath(agent: AgentDefinitionDescriptor): string | null {
  switch (agent.scope) {
    case "project":
      return `.mux/agents/${agent.id}.md`;
    case "global":
      return `~/.mux/agents/${agent.id}.md`;
    default:
      return null;
  }
}

function updateAgentDefaultEntry(
  previous: AgentAiDefaults,
  agentId: string,
  update: (entry: AgentAiDefaultsEntry) => void
): AgentAiDefaults {
  const normalizedId = agentId.trim().toLowerCase();

  const next = { ...previous };
  const existing = next[normalizedId] ?? {};
  const updated: AgentAiDefaultsEntry = { ...existing };
  update(updated);

  if (updated.modelString && updated.thinkingLevel) {
    updated.thinkingLevel = enforceThinkingPolicy(updated.modelString, updated.thinkingLevel);
  }

  if (!updated.modelString && !updated.thinkingLevel && updated.enabled === undefined) {
    delete next[normalizedId];
  } else {
    next[normalizedId] = updated;
  }

  return next;
}

function renderPolicySummary(agent: AgentDefinitionDescriptor): React.ReactNode {
  const isCompact = agent.id === "compact";

  const baseDescription = (() => {
    if (isCompact) {
      return {
        title: "Base: compact",
        note: "Internal no-tools mode.",
      };
    }

    if (agent.base) {
      return {
        title: `Base: ${agent.base}`,
        note: "Inherits prompt/tools from base.",
      };
    }

    return {
      title: "Base: (none)",
      note: "No base agent configured.",
    };
  })();

  const pieces: React.ReactNode[] = [
    <Tooltip key="base-policy">
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">
          {baseDescription.title.toLowerCase()}
        </span>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-80 whitespace-normal">
        <div className="font-medium">{baseDescription.title}</div>
        <div className="text-muted mt-2 text-xs">{baseDescription.note}</div>
      </TooltipContent>
    </Tooltip>,
  ];

  const toolAdd = agent.tools?.add ?? [];
  const toolRemove = agent.tools?.remove ?? [];
  const toolRuleCount = toolAdd.length + toolRemove.length;

  if (toolRuleCount > 0 || agent.base) {
    pieces.push(
      <Tooltip key="tools">
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            {toolRuleCount > 0 ? `tools: ${toolRuleCount}` : "tools: inherited"}
          </span>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <div className="font-medium">Tools</div>
          {toolRuleCount > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {toolAdd.map((pattern) => (
                <li key={`add:${pattern}`}>
                  <span className="text-green-500">+</span> <code>{pattern}</code>
                </li>
              ))}
              {toolRemove.map((pattern) => (
                <li key={`remove:${pattern}`}>
                  <span className="text-red-500">−</span> <code>{pattern}</code>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-muted mt-1 text-xs">Inherited from base.</div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      {pieces.map((piece, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? " • " : null}
          {piece}
        </React.Fragment>
      ))}
    </>
  );
}

function areTaskSettingsEqual(a: TaskSettings, b: TaskSettings): boolean {
  return (
    a.maxParallelAgentTasks === b.maxParallelAgentTasks &&
    a.maxTaskNestingDepth === b.maxTaskNestingDepth &&
    a.proposePlanImplementReplacesChatHistory === b.proposePlanImplementReplacesChatHistory &&
    a.planSubagentDefaultsToOrchestrator === b.planSubagentDefaultsToOrchestrator &&
    a.bashOutputCompactionMinLines === b.bashOutputCompactionMinLines &&
    a.bashOutputCompactionMinTotalBytes === b.bashOutputCompactionMinTotalBytes &&
    a.bashOutputCompactionMaxKeptLines === b.bashOutputCompactionMaxKeptLines &&
    a.bashOutputCompactionTimeoutMs === b.bashOutputCompactionTimeoutMs &&
    a.bashOutputCompactionHeuristicFallback === b.bashOutputCompactionHeuristicFallback
  );
}

function areAgentAiDefaultsEqual(a: AgentAiDefaults, b: AgentAiDefaults): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }

  aKeys.sort();
  bKeys.sort();

  for (let i = 0; i < aKeys.length; i += 1) {
    const key = aKeys[i];
    if (key !== bKeys[i]) {
      return false;
    }

    const aEntry = a[key];
    const bEntry = b[key];
    if ((aEntry?.modelString ?? undefined) !== (bEntry?.modelString ?? undefined)) {
      return false;
    }
    if ((aEntry?.thinkingLevel ?? undefined) !== (bEntry?.thinkingLevel ?? undefined)) {
      return false;
    }
    if ((aEntry?.enabled ?? undefined) !== (bEntry?.enabled ?? undefined)) {
      return false;
    }
  }

  return true;
}

export function TasksSection() {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();

  const selectedWorkspaceRef = useRef(selectedWorkspace);
  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [agentAiDefaults, setAgentAiDefaults] = useState<AgentAiDefaults>({});

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
  const [enabledAgentIds, setEnabledAgentIds] = useState<string[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsLoadFailed, setAgentsLoadFailed] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<{
    taskSettings: TaskSettings;
    agentAiDefaults: AgentAiDefaults;
  } | null>(null);

  const { models, hiddenModelsForSelector } = useModelsFromSettings();

  // Resolve the workspace's active model so that when a sub-agent's model is
  // "Inherit", we show thinking levels for the workspace model (falling back to
  // the global default). This mirrors the resolution chain in System1Section.
  const selectedWorkspaceId = selectedWorkspace?.workspaceId ?? null;
  const defaultModel = getDefaultModel();
  const workspaceModelStorageKey = selectedWorkspaceId
    ? getModelKey(selectedWorkspaceId)
    : "__tasks_workspace_model_fallback__";
  const [workspaceModelRaw] = usePersistedState<unknown>(workspaceModelStorageKey, defaultModel, {
    listener: true,
  });
  const inheritedEffectiveModel =
    (typeof workspaceModelRaw === "string" ? workspaceModelRaw.trim() : "") || defaultModel;

  const lastSyncedTaskSettingsRef = useRef<TaskSettings | null>(null);
  const lastSyncedAgentAiDefaultsRef = useRef<AgentAiDefaults | null>(null);

  useEffect(() => {
    if (!api) return;

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        const normalizedTaskSettings = normalizeTaskSettings(cfg.taskSettings);
        setTaskSettings(normalizedTaskSettings);
        const normalizedAgentDefaults = normalizeAgentAiDefaults(cfg.agentAiDefaults);
        setAgentAiDefaults(normalizedAgentDefaults);
        updatePersistedState(AGENT_AI_DEFAULTS_KEY, normalizedAgentDefaults);

        setLoadFailed(false);
        lastSyncedTaskSettingsRef.current = normalizedTaskSettings;
        lastSyncedAgentAiDefaultsRef.current = normalizedAgentDefaults;

        setLoaded(true);
      })
      .catch((error: unknown) => {
        setSaveError(getErrorMessage(error));
        setLoadFailed(true);
        setLoaded(true);
      });
  }, [api]);

  useEffect(() => {
    if (!api) return;

    const projectPath = selectedWorkspace?.projectPath;
    const workspaceId = selectedWorkspace?.workspaceId;
    if (!projectPath) {
      setAgents([]);
      setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
      setAgentsLoaded(true);
      setAgentsLoadFailed(false);
      return;
    }

    let cancelled = false;
    setAgentsLoaded(false);
    setAgentsLoadFailed(false);

    void Promise.all([
      api.agents.list({ projectPath, workspaceId }),
      api.agents.list({ projectPath, workspaceId, includeDisabled: true }),
    ])
      .then(([enabled, all]) => {
        if (cancelled) return;
        setAgents(all);
        setEnabledAgentIds(enabled.map((agent) => agent.id));
        setAgentsLoadFailed(false);
        setAgentsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
        setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
        setAgentsLoadFailed(true);
        setAgentsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedWorkspace?.projectPath, selectedWorkspace?.workspaceId]);

  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    pendingSaveRef.current = { taskSettings, agentAiDefaults };
    const lastTaskSettings = lastSyncedTaskSettingsRef.current;
    const lastAgentDefaults = lastSyncedAgentAiDefaultsRef.current;

    if (
      lastTaskSettings &&
      lastAgentDefaults &&
      areTaskSettingsEqual(lastTaskSettings, taskSettings) &&
      areAgentAiDefaultsEqual(lastAgentDefaults, agentAiDefaults)
    ) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    // Keep agent defaults cache up-to-date for any syncers/non-react readers.
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, agentAiDefaults);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      const flush = () => {
        if (savingRef.current) return;
        if (!api) return;

        const payload = pendingSaveRef.current;
        if (!payload) return;

        pendingSaveRef.current = null;
        savingRef.current = true;
        void api.config
          .saveConfig({
            taskSettings: payload.taskSettings,
            agentAiDefaults: payload.agentAiDefaults,
          })
          .then(() => {
            const previousAgentDefaults = lastSyncedAgentAiDefaultsRef.current;
            const agentDefaultsChanged =
              !previousAgentDefaults ||
              !areAgentAiDefaultsEqual(previousAgentDefaults, payload.agentAiDefaults);

            lastSyncedTaskSettingsRef.current = payload.taskSettings;
            lastSyncedAgentAiDefaultsRef.current = payload.agentAiDefaults;
            setSaveError(null);

            if (agentDefaultsChanged) {
              window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED));

              const projectPath = selectedWorkspaceRef.current?.projectPath;
              const workspaceId = selectedWorkspaceRef.current?.workspaceId;
              if (!projectPath) {
                return;
              }

              // Refresh in the background so enablement inheritance stays accurate after saving
              // defaults, but keep the existing list rendered to avoid a "Loading agents…" flash
              // while the user tweaks values.
              setAgentsLoadFailed(false);
              void Promise.all([
                api.agents.list({ projectPath, workspaceId }),
                api.agents.list({ projectPath, workspaceId, includeDisabled: true }),
              ])
                .then(([enabled, all]) => {
                  setAgents(all);
                  setEnabledAgentIds(enabled.map((agent) => agent.id));
                  setAgentsLoadFailed(false);
                  setAgentsLoaded(true);
                })
                .catch(() => {
                  setAgents([]);
                  setEnabledAgentIds(FALLBACK_AGENTS.map((agent) => agent.id));
                  setAgentsLoadFailed(true);
                  setAgentsLoaded(true);
                });
            }
          })
          .catch((error: unknown) => {
            setSaveError(getErrorMessage(error));
          })
          .finally(() => {
            savingRef.current = false;
            flush();
          });
      };

      flush();
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [api, agentAiDefaults, loaded, loadFailed, taskSettings]);

  // Flush any pending debounced save on unmount so changes aren't lost.
  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (savingRef.current) return;
      const payload = pendingSaveRef.current;
      if (!payload) return;

      pendingSaveRef.current = null;
      savingRef.current = true;
      void api.config
        .saveConfig({
          taskSettings: payload.taskSettings,
          agentAiDefaults: payload.agentAiDefaults,
        })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const setMaxParallelAgentTasks = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) => normalizeTaskSettings({ ...prev, maxParallelAgentTasks: parsed }));
  };

  const setMaxTaskNestingDepth = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) => normalizeTaskSettings({ ...prev, maxTaskNestingDepth: parsed }));
  };

  const setProposePlanImplementReplacesChatHistory = (value: boolean) => {
    setTaskSettings((prev) =>
      normalizeTaskSettings({ ...prev, proposePlanImplementReplacesChatHistory: value })
    );
  };

  const setPlanSubagentDefaultsToOrchestrator = (value: boolean) => {
    setTaskSettings((prev) =>
      normalizeTaskSettings({ ...prev, planSubagentDefaultsToOrchestrator: value })
    );
  };

  const setAgentModel = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        if (value === INHERIT) {
          delete updated.modelString;
        } else {
          updated.modelString = value;
        }
      })
    );
  };

  const setAgentThinking = (agentId: string, value: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        if (value === INHERIT) {
          delete updated.thinkingLevel;
          return;
        }

        updated.thinkingLevel = value as ThinkingLevel;
      })
    );
  };

  const setAgentEnabled = (agentId: string, value: boolean) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        updated.enabled = value;
      })
    );
  };

  const resetAgentEnabled = (agentId: string) => {
    setAgentAiDefaults((prev) =>
      updateAgentDefaultEntry(prev, agentId, (updated) => {
        delete updated.enabled;
      })
    );
  };

  const listedAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;
  const enabledAgentIdSet = new Set(enabledAgentIds);

  const uiAgents = useMemo(
    () =>
      [...listedAgents]
        .filter((agent) => agent.uiSelectable)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [listedAgents]
  );

  const subagents = useMemo(
    () =>
      [...listedAgents]
        // Keep the sections mutually exclusive: UI agents belong under "UI agents" even if they
        // can also run as sub-agents.
        .filter((agent) => agent.subagentRunnable && !agent.uiSelectable)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [listedAgents]
  );

  const internalAgents = useMemo(
    () =>
      [...listedAgents]
        .filter((agent) => !agent.uiSelectable && !agent.subagentRunnable)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [listedAgents]
  );

  const unknownAgentIds = useMemo(() => {
    const known = new Set(listedAgents.map((agent) => agent.id));
    return Object.keys(agentAiDefaults)
      .filter((id) => !known.has(id))
      .sort((a, b) => a.localeCompare(b));
  }, [agentAiDefaults, listedAgents]);

  const renderAgentDefaults = (agent: AgentDefinitionDescriptor) => {
    const entry = agentAiDefaults[agent.id];
    const modelValue = entry?.modelString ?? INHERIT;
    const thinkingValue = entry?.thinkingLevel ?? INHERIT;
    const enabledOverride = entry?.enabled;

    const enablementLocked =
      agent.id === "exec" || agent.id === "plan" || agent.id === "compact" || agent.id === "mux";

    const enabledValue = enablementLocked
      ? true
      : typeof enabledOverride === "boolean"
        ? enabledOverride
        : enabledAgentIdSet.has(agent.id);

    const enablementTitle = enablementLocked
      ? "Core agent. Can't be disabled."
      : enabledOverride === undefined
        ? enabledValue
          ? "Enabled by agent definition."
          : "Disabled by agent definition."
        : enabledOverride
          ? "Enabled (local override)."
          : "Disabled (local override).";

    const enablementHint =
      !enablementLocked && enabledOverride === undefined && !enabledValue
        ? "Disabled by default"
        : null;
    // When model is "Inherit", resolve the effective model so the dropdown
    // shows the correct thinking levels (e.g. "max" for Opus 4.6, not "xhigh").
    const effectiveModel = modelValue !== INHERIT ? modelValue : inheritedEffectiveModel;
    const allowedThinkingLevels = getThinkingPolicyForModel(effectiveModel);

    const agentDefinitionPath = getAgentDefinitionPath(agent);
    const scopeNode = agentDefinitionPath ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="hover:text-foreground cursor-copy bg-transparent p-0 underline decoration-dotted underline-offset-2"
            onClick={(e) => {
              e.stopPropagation();
              void copyToClipboard(agentDefinitionPath);
            }}
          >
            {agent.scope}
          </button>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-80 whitespace-normal">
          <div className="font-medium">Agent file</div>
          <div className="mt-1">
            <code>{agentDefinitionPath}</code>
          </div>
          <div className="text-muted mt-2 text-xs">Click to copy</div>
        </TooltipContent>
      </Tooltip>
    ) : (
      <span>{agent.scope}</span>
    );

    return (
      <div
        key={agent.id}
        className="border-border-medium bg-background-secondary rounded-md border p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-sm font-medium">{agent.name}</div>
            <div className="text-muted text-xs">
              {agent.id} • {scopeNode} • {renderPolicySummary(agent)}
              {agent.uiSelectable && agent.subagentRunnable ? (
                <>
                  {" "}
                  •{" "}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                        sub-agent
                      </span>
                    </TooltipTrigger>
                    <TooltipContent align="start" className="max-w-80 whitespace-normal">
                      Can be invoked as a sub-agent.
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </div>

            {agent.description ? (
              <div className="text-muted mt-1 text-xs">{agent.description}</div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {enablementHint ? <div className="text-muted text-xs">{enablementHint}</div> : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2">
                  <div className="text-muted text-xs">Enabled</div>
                  <Switch
                    checked={enabledValue}
                    disabled={enablementLocked}
                    onCheckedChange={(checked) => setAgentEnabled(agent.id, checked)}
                    aria-label={`Toggle ${agent.id} enabled`}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>{enablementTitle}</TooltipContent>
            </Tooltip>
            {enabledOverride !== undefined ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="px-2"
                onClick={() => resetAgentEnabled(agent.id)}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-muted text-xs">Model</div>
            <div className="flex items-center gap-2">
              {/* Match the Reasoning dropdown styling for inherit defaults. */}
              <ModelSelector
                value={modelValue === INHERIT ? "" : modelValue}
                emptyLabel="Inherit"
                onChange={(value) => setAgentModel(agent.id, value)}
                models={models}
                hiddenModels={hiddenModelsForSelector}
                variant="box"
                className="bg-modal-bg"
              />
              {modelValue !== INHERIT ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 px-2"
                  onClick={() => setAgentModel(agent.id, INHERIT)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-muted text-xs">Reasoning</div>
            <Select
              value={thinkingValue}
              onValueChange={(value) => setAgentThinking(agent.id, value)}
            >
              <SelectTrigger className="border-border-medium bg-modal-bg h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Inherit</SelectItem>
                {allowedThinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {getThinkingOptionLabel(level, effectiveModel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    );
  };

  const renderUnknownAgentDefaults = (agentId: string) => {
    const entry = agentAiDefaults[agentId];
    const modelValue = entry?.modelString ?? INHERIT;
    const thinkingValue = entry?.thinkingLevel ?? INHERIT;
    const effectiveModel = modelValue !== INHERIT ? modelValue : inheritedEffectiveModel;
    const allowedThinkingLevels = getThinkingPolicyForModel(effectiveModel);

    return (
      <div
        key={agentId}
        className="border-border-medium bg-background-secondary rounded-md border p-3"
      >
        <div className="text-foreground text-sm font-medium">{agentId}</div>
        <div className="text-muted text-xs">Not discovered in the current workspace</div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-muted text-xs">Model</div>
            <div className="flex items-center gap-2">
              {/* Match the Reasoning dropdown styling for inherit defaults. */}
              <ModelSelector
                value={modelValue === INHERIT ? "" : modelValue}
                emptyLabel="Inherit"
                onChange={(value) => setAgentModel(agentId, value)}
                models={models}
                hiddenModels={hiddenModelsForSelector}
                variant="box"
                className="bg-modal-bg"
              />
              {modelValue !== INHERIT ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 px-2"
                  onClick={() => setAgentModel(agentId, INHERIT)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-muted text-xs">Reasoning</div>
            <Select
              value={thinkingValue}
              onValueChange={(value) => setAgentThinking(agentId, value)}
            >
              <SelectTrigger className="border-border-medium bg-modal-bg h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>Inherit</SelectItem>
                {allowedThinkingLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {getThinkingOptionLabel(level, effectiveModel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Task Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Max Parallel Agent Tasks</div>
              <div className="text-muted text-xs">
                Default {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.default}, range{" "}
                {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min}–
                {TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max}
              </div>
            </div>
            <Input
              type="number"
              value={taskSettings.maxParallelAgentTasks}
              min={TASK_SETTINGS_LIMITS.maxParallelAgentTasks.min}
              max={TASK_SETTINGS_LIMITS.maxParallelAgentTasks.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMaxParallelAgentTasks(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Max Task Nesting Depth</div>
              <div className="text-muted text-xs">
                Default {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.default}, range{" "}
                {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min}–
                {TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max}
              </div>
            </div>
            <Input
              type="number"
              value={taskSettings.maxTaskNestingDepth}
              min={TASK_SETTINGS_LIMITS.maxTaskNestingDepth.min}
              max={TASK_SETTINGS_LIMITS.maxTaskNestingDepth.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMaxTaskNestingDepth(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">
                Plan: Implement replaces conversation with plan
              </div>
              <div className="text-muted text-xs">
                When enabled, clicking Implement on a plan proposal clears previous messages and
                shows the plan before switching to Exec.
              </div>
            </div>
            <Switch
              checked={taskSettings.proposePlanImplementReplacesChatHistory ?? false}
              onCheckedChange={setProposePlanImplementReplacesChatHistory}
              aria-label="Toggle plan Implement replaces conversation with plan"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">
                Plan sub-agents: default to Orchestrator
              </div>
              <div className="text-muted text-xs">
                When enabled, plan sub-agent tasks switch to Orchestrator after propose_plan.
                Otherwise they switch to Exec.
              </div>
            </div>
            <Switch
              checked={taskSettings.planSubagentDefaultsToOrchestrator ?? false}
              onCheckedChange={setPlanSubagentDefaultsToOrchestrator}
              aria-label="Toggle plan sub-agents default to Orchestrator"
            />
          </div>
        </div>

        {saveError ? <div className="text-danger-light mt-4 text-xs">{saveError}</div> : null}
      </div>

      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Agent Defaults</h3>
        <div className="text-muted text-xs">
          Defaults apply globally. Changing model/reasoning in a workspace creates a workspace
          override.
        </div>
        {agentsLoadFailed ? (
          <div className="text-danger-light mt-3 text-xs">
            Failed to load agent definitions for this workspace.
          </div>
        ) : null}
        {!agentsLoaded ? <div className="text-muted mt-3 text-xs">Loading agents…</div> : null}
      </div>

      {uiAgents.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">UI agents</h4>
          <div className="space-y-4">{uiAgents.map(renderAgentDefaults)}</div>
        </div>
      ) : null}

      {subagents.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Sub-agents</h4>
          <div className="space-y-4">{subagents.map(renderAgentDefaults)}</div>
        </div>
      ) : null}

      {internalAgents.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Internal</h4>
          <div className="space-y-4">{internalAgents.map(renderAgentDefaults)}</div>
        </div>
      ) : null}

      {unknownAgentIds.length > 0 ? (
        <div>
          <h4 className="text-foreground mb-3 text-sm font-medium">Unknown agents</h4>
          <div className="space-y-4">{unknownAgentIds.map(renderUnknownAgentDefaults)}</div>
        </div>
      ) : null}
    </div>
  );
}
