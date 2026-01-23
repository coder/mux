import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Switch } from "@/browser/components/ui/switch";
import { Input } from "@/browser/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { useAPI } from "@/browser/contexts/API";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { getDefaultModel, getSuggestedModels } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import {
  DEFAULT_TASK_SETTINGS,
  SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { THINKING_LEVELS, coerceThinkingLevel } from "@/common/types/thinking";

import { SearchableModelSelect } from "../components/SearchableModelSelect";

export function System1Section() {
  const { api } = useAPI();
  const { config: providersConfig, loading: providersLoading } = useProvidersConfig();

  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const lastSyncedRef = useRef<TaskSettings | null>(null);
  const pendingSaveRef = useRef<TaskSettings | null>(null);

  const [system1ModelRaw, setSystem1ModelRaw] = usePersistedState<unknown>(
    PREFERRED_SYSTEM_1_MODEL_KEY,
    "",
    {
      listener: true,
    }
  );

  const system1Model = typeof system1ModelRaw === "string" ? system1ModelRaw : "";

  const setSystem1Model = (value: string) => {
    setSystem1ModelRaw(value);
  };

  const [system1ThinkingLevelRaw, setSystem1ThinkingLevelRaw] = usePersistedState<unknown>(
    PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
    "off",
    { listener: true }
  );

  const system1ThinkingLevel = coerceThinkingLevel(system1ThinkingLevelRaw) ?? "off";

  const workspaceContext = useOptionalWorkspaceContext();
  const selectedWorkspaceId = workspaceContext?.selectedWorkspace?.workspaceId ?? null;
  const defaultModel = getDefaultModel();

  const workspaceModelStorageKey = selectedWorkspaceId
    ? getModelKey(selectedWorkspaceId)
    : "__system1_workspace_model_fallback__";

  const [workspaceModelRaw] = usePersistedState<unknown>(workspaceModelStorageKey, defaultModel, {
    listener: true,
  });

  const system1ModelTrimmed = system1Model.trim();
  const workspaceModelTrimmed =
    typeof workspaceModelRaw === "string" ? workspaceModelRaw.trim() : "";

  const effectiveSystem1ModelStringForThinking =
    system1ModelTrimmed || workspaceModelTrimmed || defaultModel;

  const policyThinkingLevels = getThinkingPolicyForModel(effectiveSystem1ModelStringForThinking);
  const allowedThinkingLevels =
    policyThinkingLevels.length > 0 ? policyThinkingLevels : THINKING_LEVELS;

  const effectiveSystem1ThinkingLevel = enforceThinkingPolicy(
    effectiveSystem1ModelStringForThinking,
    system1ThinkingLevel
  );
  const setSystem1ThinkingLevel = (value: string) => {
    setSystem1ThinkingLevelRaw(coerceThinkingLevel(value) ?? "off");
  };

  useEffect(() => {
    if (!api) {
      return;
    }

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        const normalized = normalizeTaskSettings(cfg.taskSettings);
        setTaskSettings(normalized);
        lastSyncedRef.current = normalized;
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
    if (!api) {
      return;
    }
    if (!loaded) {
      return;
    }
    if (loadFailed) {
      return;
    }

    // Debounce settings writes so typing doesn't thrash the disk.
    const lastSynced = lastSyncedRef.current;
    if (lastSynced && areTaskSettingsEqual(lastSynced, taskSettings)) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    pendingSaveRef.current = taskSettings;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      const flush = () => {
        if (savingRef.current) {
          return;
        }

        const payload = pendingSaveRef.current;
        if (!payload) {
          return;
        }

        pendingSaveRef.current = null;
        savingRef.current = true;

        void api.config
          .saveConfig({
            taskSettings: payload,
          })
          .then(() => {
            lastSyncedRef.current = payload;
            setSaveError(null);
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
  }, [api, loaded, loadFailed, taskSettings]);

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
          taskSettings: payload,
        })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const setBashOutputCompactionMinLines = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMinLines: parsed,
      })
    );
  };

  const setBashOutputCompactionMinTotalKb = (rawValue: string) => {
    const parsedKb = Math.floor(Number(rawValue));
    const bytes = parsedKb * 1024;
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMinTotalBytes: bytes,
      })
    );
  };

  const setBashOutputCompactionMaxKeptLines = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMaxKeptLines: parsed,
      })
    );
  };

  const setBashOutputCompactionHeuristicFallback = (value: boolean) => {
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionHeuristicFallback: value,
      })
    );
  };

  const setBashOutputCompactionTimeoutSeconds = (rawValue: string) => {
    const parsedSeconds = Math.floor(Number(rawValue));
    const ms = parsedSeconds * 1000;
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionTimeoutMs: ms,
      })
    );
  };

  if (!loaded || providersLoading || !providersConfig) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Loading settings...</span>
      </div>
    );
  }

  const allModels = getSuggestedModels(providersConfig);

  const bashOutputCompactionMinLines =
    taskSettings.bashOutputCompactionMinLines ??
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.default;
  const bashOutputCompactionMinTotalBytes =
    taskSettings.bashOutputCompactionMinTotalBytes ??
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.default;
  const bashOutputCompactionMaxKeptLines =
    taskSettings.bashOutputCompactionMaxKeptLines ??
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.default;
  const bashOutputCompactionHeuristicFallback =
    taskSettings.bashOutputCompactionHeuristicFallback ??
    DEFAULT_TASK_SETTINGS.bashOutputCompactionHeuristicFallback ??
    true;

  const bashOutputCompactionTimeoutMs =
    taskSettings.bashOutputCompactionTimeoutMs ??
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.default;

  const bashOutputCompactionMinTotalKb = Math.floor(bashOutputCompactionMinTotalBytes / 1024);
  const bashOutputCompactionTimeoutSeconds = Math.floor(bashOutputCompactionTimeoutMs / 1000);

  return (
    <div className="space-y-6">
      {/* Model Defaults */}
      <div className="border-border-medium overflow-hidden rounded-md border">
        <div className="border-border-medium bg-background-secondary/50 border-b px-2 py-1.5 md:px-3">
          <span className="text-muted text-xs font-medium">System 1 Defaults</span>
        </div>
        <div className="divide-border-medium divide-y">
          <div className="flex items-center gap-4 px-2 py-2 md:px-3">
            <div className="w-32 shrink-0">
              <div className="text-muted text-xs">System 1 Model</div>
              <div className="text-muted-light text-[10px]">Context optimization</div>
            </div>
            <div className="min-w-0 flex-1">
              <SearchableModelSelect
                value={system1Model}
                onChange={setSystem1Model}
                models={allModels}
                emptyOption={{ value: "", label: "Use workspace model" }}
              />
            </div>
          </div>

          <div className="flex items-center gap-4 px-2 py-2 md:px-3">
            <div className="w-32 shrink-0">
              <div className="text-muted text-xs">System 1 Reasoning</div>
              <div className="text-muted-light text-[10px]">Log filtering</div>
            </div>
            <div className="min-w-0 flex-1">
              <Select
                value={effectiveSystem1ThinkingLevel}
                onValueChange={setSystem1ThinkingLevel}
                disabled={allowedThinkingLevels.length <= 1}
              >
                <SelectTrigger className="border-border-medium bg-modal-bg h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
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
      </div>

      {/* Bash output compaction */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Bash Output Compaction</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Heuristic Fallback</div>
              <div className="text-muted text-xs">
                If System 1 returns invalid keep_ranges, fall back to deterministic filtering
                instead of showing full output.
              </div>
            </div>
            <Switch
              checked={bashOutputCompactionHeuristicFallback}
              onCheckedChange={setBashOutputCompactionHeuristicFallback}
              aria-label="Toggle heuristic fallback for bash output compaction"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Min Lines</div>
              <div className="text-muted text-xs">
                Filter when output has more than this many lines. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.min}–
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.max}.
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionMinLines}
              min={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.min}
              max={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionMinLines(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Min Total (KB)</div>
              <div className="text-muted text-xs">
                Filter when output exceeds this many kilobytes. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min / 1024}
                –
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max / 1024}
                .
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionMinTotalKb}
              min={
                SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min / 1024
              }
              max={
                SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max / 1024
              }
              step={1}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionMinTotalKb(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Max Kept Lines</div>
              <div className="text-muted text-xs">
                Keep at most this many lines. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.min}–
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.max}.
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionMaxKeptLines}
              min={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.min}
              max={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionMaxKeptLines(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Timeout (seconds)</div>
              <div className="text-muted text-xs">
                Abort filtering if it takes longer than this many seconds. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min / 1000}–
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max / 1000}.
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionTimeoutSeconds}
              min={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min / 1000}
              max={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max / 1000}
              step={1}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionTimeoutSeconds(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
          </div>
        </div>

        {saveError ? <div className="text-danger-light mt-4 text-xs">{saveError}</div> : null}
      </div>
    </div>
  );
}

function areTaskSettingsEqual(a: TaskSettings, b: TaskSettings): boolean {
  return (
    a.maxParallelAgentTasks === b.maxParallelAgentTasks &&
    a.maxTaskNestingDepth === b.maxTaskNestingDepth &&
    a.bashOutputCompactionMinLines === b.bashOutputCompactionMinLines &&
    a.bashOutputCompactionMinTotalBytes === b.bashOutputCompactionMinTotalBytes &&
    a.bashOutputCompactionMaxKeptLines === b.bashOutputCompactionMaxKeptLines &&
    a.bashOutputCompactionTimeoutMs === b.bashOutputCompactionTimeoutMs &&
    a.bashOutputCompactionHeuristicFallback === b.bashOutputCompactionHeuristicFallback
  );
}
