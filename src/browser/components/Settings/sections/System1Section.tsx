import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/browser/components/ui/input";
import { Switch } from "@/browser/components/ui/switch";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/contexts/ExperimentsContext";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  DEFAULT_TASK_SETTINGS,
  SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS,
  SYSTEM1_MEMORY_WRITER_LIMITS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";

function mergeSystem1Settings(base: TaskSettings, override: TaskSettings): TaskSettings {
  return {
    ...base,
    bashOutputCompactionMinLines:
      override.bashOutputCompactionMinLines ?? base.bashOutputCompactionMinLines,
    bashOutputCompactionMinTotalBytes:
      override.bashOutputCompactionMinTotalBytes ?? base.bashOutputCompactionMinTotalBytes,
    bashOutputCompactionMaxKeptLines:
      override.bashOutputCompactionMaxKeptLines ?? base.bashOutputCompactionMaxKeptLines,
    bashOutputCompactionTimeoutMs:
      override.bashOutputCompactionTimeoutMs ?? base.bashOutputCompactionTimeoutMs,
    bashOutputCompactionHeuristicFallback:
      override.bashOutputCompactionHeuristicFallback ?? base.bashOutputCompactionHeuristicFallback,
    memoryWriterIntervalMessages:
      override.memoryWriterIntervalMessages ?? base.memoryWriterIntervalMessages,
  };
}

function areSystem1SettingsEqual(a: TaskSettings, b: TaskSettings): boolean {
  return (
    a.bashOutputCompactionMinLines === b.bashOutputCompactionMinLines &&
    a.bashOutputCompactionMinTotalBytes === b.bashOutputCompactionMinTotalBytes &&
    a.bashOutputCompactionMaxKeptLines === b.bashOutputCompactionMaxKeptLines &&
    a.bashOutputCompactionTimeoutMs === b.bashOutputCompactionTimeoutMs &&
    a.bashOutputCompactionHeuristicFallback === b.bashOutputCompactionHeuristicFallback &&
    a.memoryWriterIntervalMessages === b.memoryWriterIntervalMessages
  );
}

export function System1Section() {
  const { api } = useAPI();
  const system1Enabled = useExperimentValue(EXPERIMENT_IDS.SYSTEM_1);

  const [taskSettings, setTaskSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const lastSyncedRef = useRef<TaskSettings | null>(null);
  const pendingSaveRef = useRef<TaskSettings | null>(null);

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
    if (lastSynced && areSystem1SettingsEqual(lastSynced, taskSettings)) {
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
          .getConfig()
          .then((cfg) => {
            const latest = normalizeTaskSettings(cfg.taskSettings);
            const merged = normalizeTaskSettings(mergeSystem1Settings(latest, payload));
            return api.config.saveConfig({ taskSettings: merged });
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
        .getConfig()
        .then((cfg) => {
          const latest = normalizeTaskSettings(cfg.taskSettings);
          const merged = normalizeTaskSettings(mergeSystem1Settings(latest, payload));
          return api.config.saveConfig({ taskSettings: merged });
        })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const setBashOutputCompactionMinLines = (rawValue: string) => {
    const parsed = rawValue.trim() === "" ? undefined : Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMinLines: parsed,
      })
    );
  };

  const setBashOutputCompactionMinTotalKb = (rawValue: string) => {
    const parsedKb = rawValue.trim() === "" ? undefined : Math.floor(Number(rawValue));
    const bytes = parsedKb === undefined ? undefined : parsedKb * 1024;
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionMinTotalBytes: bytes,
      })
    );
  };

  const setBashOutputCompactionMaxKeptLines = (rawValue: string) => {
    const parsed = rawValue.trim() === "" ? undefined : Number(rawValue);
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
    const parsedSeconds = rawValue.trim() === "" ? undefined : Math.floor(Number(rawValue));
    const ms = parsedSeconds === undefined ? undefined : parsedSeconds * 1000;
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        bashOutputCompactionTimeoutMs: ms,
      })
    );
  };

  const setMemoryWriterIntervalMessages = (rawValue: string) => {
    const parsed = rawValue.trim() === "" ? undefined : Number(rawValue);
    setTaskSettings((prev) =>
      normalizeTaskSettings({
        ...prev,
        memoryWriterIntervalMessages: parsed,
      })
    );
  };

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
  const bashOutputCompactionHeuristicFallback =
    taskSettings.bashOutputCompactionHeuristicFallback ??
    DEFAULT_TASK_SETTINGS.bashOutputCompactionHeuristicFallback ??
    true;

  const bashOutputCompactionMinTotalKb = Math.floor(bashOutputCompactionMinTotalBytes / 1024);
  const bashOutputCompactionTimeoutSeconds = Math.floor(bashOutputCompactionTimeoutMs / 1000);

  const memoryWriterIntervalMessages =
    taskSettings.memoryWriterIntervalMessages ??
    SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.default;

  if (!api) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Connecting...</span>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!system1Enabled ? (
        <div className="border-border-medium bg-background-secondary/50 text-muted rounded-md border p-3 text-xs">
          System 1 is disabled. Enable it in Settings → Experiments to activate these features.
        </div>
      ) : null}

      {/* Memories */}
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Memories</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-foreground text-sm">Write Interval (messages)</div>
              <div className="text-muted text-xs">
                Run the background memory writer every N assistant messages. Range{" "}
                {SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.min}–
                {SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.max}.
              </div>
            </div>
            <Input
              type="number"
              value={memoryWriterIntervalMessages}
              min={SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.min}
              max={SYSTEM1_MEMORY_WRITER_LIMITS.memoryWriterIntervalMessages.max}
              step={1}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMemoryWriterIntervalMessages(e.target.value)
              }
              className="border-border-medium bg-background-secondary h-9 w-28"
            />
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
