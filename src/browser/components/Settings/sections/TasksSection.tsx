import React, { useEffect, useState, useCallback } from "react";
import { Input } from "@/browser/components/ui/input";
import { useAPI } from "@/browser/contexts/API";
import type { TaskSettings } from "@/common/types/task";

const DEFAULT_TASK_SETTINGS: TaskSettings = {
  maxParallelAgentTasks: 3,
  maxTaskNestingDepth: 3,
};

// Limits for task settings
const MIN_PARALLEL = 1;
const MAX_PARALLEL = 10;
const MIN_DEPTH = 1;
const MAX_DEPTH = 5;

export function TasksSection() {
  const { api } = useAPI();
  const [settings, setSettings] = useState<TaskSettings>(DEFAULT_TASK_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Load settings on mount
  useEffect(() => {
    if (api) {
      void api.general.getTaskSettings().then((taskSettings) => {
        setSettings({
          maxParallelAgentTasks:
            taskSettings.maxParallelAgentTasks ?? DEFAULT_TASK_SETTINGS.maxParallelAgentTasks,
          maxTaskNestingDepth:
            taskSettings.maxTaskNestingDepth ?? DEFAULT_TASK_SETTINGS.maxTaskNestingDepth,
        });
        setLoaded(true);
      });
    }
  }, [api]);

  const updateSetting = useCallback(
    async (key: keyof TaskSettings, value: number) => {
      const newSettings = { ...settings, [key]: value };
      setSettings(newSettings);

      // Persist to config
      try {
        await api?.general.setTaskSettings(newSettings);
      } catch (error) {
        console.error("Failed to save task settings:", error);
      }
    },
    [api, settings]
  );

  const handleParallelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value)) {
        const clamped = Math.max(MIN_PARALLEL, Math.min(MAX_PARALLEL, value));
        void updateSetting("maxParallelAgentTasks", clamped);
      }
    },
    [updateSetting]
  );

  const handleDepthChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value)) {
        const clamped = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, value));
        void updateSetting("maxTaskNestingDepth", clamped);
      }
    },
    [updateSetting]
  );

  if (!loaded) {
    return <div className="text-muted text-sm">Loading task settings...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-4 text-sm font-medium">Agent Tasks</h3>
        <p className="text-muted mb-4 text-xs">
          Configure limits for agent subworkspaces spawned via the task tool.
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Max Parallel Tasks</div>
              <div className="text-muted text-xs">
                Maximum agent tasks running at once ({MIN_PARALLEL}–{MAX_PARALLEL})
              </div>
            </div>
            <Input
              type="number"
              min={MIN_PARALLEL}
              max={MAX_PARALLEL}
              value={settings.maxParallelAgentTasks}
              onChange={handleParallelChange}
              className="border-border-medium bg-background-secondary h-9 w-20 text-center"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Max Nesting Depth</div>
              <div className="text-muted text-xs">
                Maximum depth of nested agent tasks ({MIN_DEPTH}–{MAX_DEPTH})
              </div>
            </div>
            <Input
              type="number"
              min={MIN_DEPTH}
              max={MAX_DEPTH}
              value={settings.maxTaskNestingDepth}
              onChange={handleDepthChange}
              className="border-border-medium bg-background-secondary h-9 w-20 text-center"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
