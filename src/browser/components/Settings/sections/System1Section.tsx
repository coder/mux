import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/browser/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { useAPI } from "@/browser/contexts/API";
import { getSuggestedModels } from "@/browser/hooks/useModelsFromSettings";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  PREFERRED_SYSTEM_1_MODEL_KEY,
  PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
} from "@/common/constants/storage";
import {
  DEFAULT_TASK_SETTINGS,
  SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";
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
  const pendingSaveRef = useRef<TaskSettings | null>(null);

  const [system1Model, setSystem1Model] = usePersistedState<string>(
    PREFERRED_SYSTEM_1_MODEL_KEY,
    "",
    {
      listener: true,
    }
  );

  const [system1ThinkingLevelRaw, setSystem1ThinkingLevelRaw] = usePersistedState<unknown>(
    PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY,
    "off",
    { listener: true }
  );

  const system1ThinkingLevel = coerceThinkingLevel(system1ThinkingLevelRaw) ?? "off";

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
        setTaskSettings(normalizeTaskSettings(cfg.taskSettings));
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

  const setBashOutputCompactionMinTotalBytes = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMinTotalBytes: parsed,
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

  const setBashOutputCompactionTimeoutMs = (rawValue: string) => {
    const parsed = Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionTimeoutMs: parsed,
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
  const bashOutputCompactionTimeoutMs =
    taskSettings.bashOutputCompactionTimeoutMs ??
    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.default;

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
              <Select value={system1ThinkingLevel} onValueChange={setSystem1ThinkingLevel}>
                <SelectTrigger className="border-border-medium bg-modal-bg h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVELS.map((level) => (
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
              <div className="text-foreground text-sm">Min Total Bytes</div>
              <div className="text-muted text-xs">
                Filter when output exceeds this many bytes. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min}–
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max}.
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionMinTotalBytes}
              min={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.min}
              max={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionMinTotalBytes(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-36"
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
              <div className="text-foreground text-sm">Timeout (ms)</div>
              <div className="text-muted text-xs">
                Abort filtering if it takes longer than this many milliseconds. Range{" "}
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min}–
                {SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max}.
              </div>
            </div>
            <Input
              type="number"
              value={bashOutputCompactionTimeoutMs}
              min={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.min}
              max={SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.max}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setBashOutputCompactionTimeoutMs(e.target.value)
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
