import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { Input } from "@/browser/components/ui/input";
import { ModelSelector } from "@/browser/components/ModelSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY, MODE_AI_DEFAULTS_KEY } from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import {
  normalizeAgentAiDefaults,
  type AgentAiDefaults,
  type AgentAiDefaultsEntry,
} from "@/common/types/agentAiDefaults";
import { normalizeModeAiDefaults } from "@/common/types/modeAiDefaults";
import {
  DEFAULT_TASK_SETTINGS,
  TASK_SETTINGS_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";

const INHERIT = "__inherit__";
const ALL_THINKING_LEVELS = THINKING_LEVELS;

const FALLBACK_AGENTS: AgentDefinitionDescriptor[] = [
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    description: "Create a plan before coding",
    uiSelectable: true,
    subagentRunnable: false,
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

  if (!updated.modelString && !updated.thinkingLevel) {
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

export function TasksSection() {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();

  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [agentAiDefaults, setAgentAiDefaults] = useState<AgentAiDefaults>({});

  const [agents, setAgents] = useState<AgentDefinitionDescriptor[]>([]);
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

  const { models, hiddenModels } = useModelsFromSettings();

  useEffect(() => {
    if (!api) return;

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        setTaskSettings(normalizeTaskSettings(cfg.taskSettings));
        const normalizedAgentDefaults = normalizeAgentAiDefaults(cfg.agentAiDefaults);
        setAgentAiDefaults(normalizedAgentDefaults);
        updatePersistedState(AGENT_AI_DEFAULTS_KEY, normalizedAgentDefaults);

        // Keep a local cache for non-react readers (compaction handler, etc.)
        updatePersistedState(
          MODE_AI_DEFAULTS_KEY,
          normalizeModeAiDefaults(cfg.modeAiDefaults ?? {})
        );

        setLoadFailed(false);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
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
      setAgentsLoaded(true);
      setAgentsLoadFailed(false);
      return;
    }

    let cancelled = false;
    setAgentsLoaded(false);
    setAgentsLoadFailed(false);

    void api.agents
      .list({ projectPath, workspaceId })
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setAgentsLoadFailed(false);
        setAgentsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAgents([]);
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
    // Keep agent defaults cache up-to-date for any syncers/non-react readers.
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, agentAiDefaults);

    // Keep mode defaults cache up-to-date for non-react readers.
    updatePersistedState(
      MODE_AI_DEFAULTS_KEY,
      normalizeModeAiDefaults({
        plan: agentAiDefaults.plan,
        exec: agentAiDefaults.exec,
        compact: agentAiDefaults.compact,
      })
    );

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
          .catch((error: unknown) => {
            setSaveError(error instanceof Error ? error.message : String(error));
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

  const listedAgents = agents.length > 0 ? agents : FALLBACK_AGENTS;

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
    const allowedThinkingLevels =
      modelValue !== INHERIT ? getThinkingPolicyForModel(modelValue) : ALL_THINKING_LEVELS;

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
        <div className="flex items-baseline justify-between gap-3">
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
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-muted text-xs">Model</div>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={modelValue === INHERIT ? "" : modelValue}
                emptyLabel="Inherit"
                onChange={(value) => setAgentModel(agent.id, value)}
                models={models}
                hiddenModels={hiddenModels}
              />
              {modelValue !== INHERIT ? (
                <button
                  type="button"
                  className="text-muted hover:text-foreground text-xs"
                  onClick={() => setAgentModel(agent.id, INHERIT)}
                >
                  Reset
                </button>
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
                    {level}
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
    const allowedThinkingLevels =
      modelValue !== INHERIT ? getThinkingPolicyForModel(modelValue) : ALL_THINKING_LEVELS;

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
              <ModelSelector
                value={modelValue === INHERIT ? "" : modelValue}
                emptyLabel="Inherit"
                onChange={(value) => setAgentModel(agentId, value)}
                models={models}
                hiddenModels={hiddenModels}
              />
              {modelValue !== INHERIT ? (
                <button
                  type="button"
                  className="text-muted hover:text-foreground text-xs"
                  onClick={() => setAgentModel(agentId, INHERIT)}
                >
                  Reset
                </button>
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
                    {level}
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
