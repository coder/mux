import React, { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { Input } from "@/browser/components/ui/input";
import {
  DEFAULT_TASK_SETTINGS,
  TASK_SETTINGS_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
  type SubagentAiDefaults,
  type SubagentAiDefaultsEntry,
} from "@/common/types/tasks";
import { BUILT_IN_SUBAGENTS } from "@/common/constants/agents";
import type { ThinkingLevel } from "@/common/types/thinking";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import { ModelSelector } from "@/browser/components/ModelSelector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";

const INHERIT = "__inherit__";
const ALL_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"] as const;

function updateSubagentDefaultEntry(
  previous: SubagentAiDefaults,
  agentType: string,
  update: (entry: SubagentAiDefaultsEntry) => void
): SubagentAiDefaults {
  const next = { ...previous };
  const existing = next[agentType] ?? {};
  const updated: SubagentAiDefaultsEntry = { ...existing };
  update(updated);

  if (updated.modelString && updated.thinkingLevel) {
    updated.thinkingLevel = enforceThinkingPolicy(updated.modelString, updated.thinkingLevel);
  }

  if (!updated.modelString && !updated.thinkingLevel) {
    delete next[agentType];
  } else {
    next[agentType] = updated;
  }

  return next;
}

export function TasksSection() {
  const { api } = useAPI();
  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [subagentAiDefaults, setSubagentAiDefaults] = useState<SubagentAiDefaults>({});
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<{
    taskSettings: TaskSettings;
    subagentAiDefaults: SubagentAiDefaults;
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
        setSubagentAiDefaults(() => {
          const next: SubagentAiDefaults = {};
          const defaults = cfg.subagentAiDefaults ?? {};
          for (const [agentType, entry] of Object.entries(defaults)) {
            if (!entry) continue;
            if (!entry.modelString || !entry.thinkingLevel) {
              next[agentType] = entry;
              continue;
            }
            next[agentType] = {
              ...entry,
              thinkingLevel: enforceThinkingPolicy(entry.modelString, entry.thinkingLevel),
            };
          }
          return next;
        });
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
    if (!loaded) return;
    if (loadFailed) return;

    pendingSaveRef.current = { taskSettings, subagentAiDefaults };

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
          .saveConfig(payload)
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
  }, [api, loaded, loadFailed, subagentAiDefaults, taskSettings]);

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
        .saveConfig(payload)
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

  const setSubagentModel = (agentType: string, value: string) => {
    setSubagentAiDefaults((prev) =>
      updateSubagentDefaultEntry(prev, agentType, (updated) => {
        if (value === INHERIT) {
          delete updated.modelString;
        } else {
          updated.modelString = value;
        }
      })
    );
  };

  const setSubagentThinking = (agentType: string, value: string) => {
    setSubagentAiDefaults((prev) =>
      updateSubagentDefaultEntry(prev, agentType, (updated) => {
        if (value === INHERIT) {
          delete updated.thinkingLevel;
          return;
        }

        updated.thinkingLevel = value as ThinkingLevel;
      })
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Agents</h3>
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

        {saveError && <div className="text-danger-light mt-4 text-xs">{saveError}</div>}
      </div>

      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Sub-agents</h3>
        <div className="space-y-4">
          {BUILT_IN_SUBAGENTS.map((preset) => {
            const agentType = preset.agentType;
            const entry = subagentAiDefaults[agentType];
            const modelValue = entry?.modelString ?? INHERIT;
            const thinkingValue = entry?.thinkingLevel ?? INHERIT;
            const allowedThinkingLevels =
              modelValue !== INHERIT ? getThinkingPolicyForModel(modelValue) : ALL_THINKING_LEVELS;

            return (
              <div
                key={agentType}
                className="border-border-medium bg-background-secondary rounded-md border p-3"
              >
                <div className="text-foreground text-sm font-medium">{preset.label}</div>

                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <div className="text-muted text-xs">Model</div>
                    <div className="flex items-center gap-2">
                      <ModelSelector
                        value={modelValue === INHERIT ? "" : modelValue}
                        emptyLabel="Inherit"
                        onChange={(value) => setSubagentModel(agentType, value)}
                        models={models}
                        hiddenModels={hiddenModels}
                      />
                      {modelValue !== INHERIT ? (
                        <button
                          type="button"
                          className="text-muted hover:text-foreground text-xs"
                          onClick={() => setSubagentModel(agentType, INHERIT)}
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
                      onValueChange={(value) => setSubagentThinking(agentType, value)}
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
          })}
        </div>
      </div>
    </div>
  );
}
