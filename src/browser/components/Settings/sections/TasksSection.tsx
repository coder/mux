import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { Input } from "@/browser/components/ui/input";
import { Button } from "@/browser/components/ui/button";

const MAX_PARALLEL_AGENT_TASKS_MIN = 1;
const MAX_PARALLEL_AGENT_TASKS_MAX = 10;
const MAX_TASK_NESTING_DEPTH_MIN = 1;
const MAX_TASK_NESTING_DEPTH_MAX = 5;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseIntOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function TasksSection() {
  const { api } = useAPI();

  const [maxParallelAgentTasks, setMaxParallelAgentTasks] = React.useState<number>(3);
  const [maxParallelAgentTasksInput, setMaxParallelAgentTasksInput] = React.useState<string>("3");
  const [maxTaskNestingDepth, setMaxTaskNestingDepth] = React.useState<number>(3);
  const [maxTaskNestingDepthInput, setMaxTaskNestingDepthInput] = React.useState<string>("3");
  const [error, setError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    if (!api) {
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const settings = await api.tasks.getTaskSettings();
        if (cancelled) {
          return;
        }

        setMaxParallelAgentTasks(settings.maxParallelAgentTasks);
        setMaxParallelAgentTasksInput(String(settings.maxParallelAgentTasks));
        setMaxTaskNestingDepth(settings.maxTaskNestingDepth);
        setMaxTaskNestingDepthInput(String(settings.maxTaskNestingDepth));
        setError(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  const onSave = React.useCallback(async () => {
    if (!api) {
      return;
    }

    const parsedMaxParallelAgentTasks = parseIntOrNull(maxParallelAgentTasksInput);
    const parsedMaxTaskNestingDepth = parseIntOrNull(maxTaskNestingDepthInput);

    if (parsedMaxParallelAgentTasks === null || parsedMaxTaskNestingDepth === null) {
      setError("Please enter valid numbers for task limits.");
      setMaxParallelAgentTasksInput(String(maxParallelAgentTasks));
      setMaxTaskNestingDepthInput(String(maxTaskNestingDepth));
      return;
    }

    const nextMaxParallelAgentTasks = clampNumber(
      parsedMaxParallelAgentTasks,
      MAX_PARALLEL_AGENT_TASKS_MIN,
      MAX_PARALLEL_AGENT_TASKS_MAX
    );
    const nextMaxTaskNestingDepth = clampNumber(
      parsedMaxTaskNestingDepth,
      MAX_TASK_NESTING_DEPTH_MIN,
      MAX_TASK_NESTING_DEPTH_MAX
    );

    setMaxParallelAgentTasks(nextMaxParallelAgentTasks);
    setMaxParallelAgentTasksInput(String(nextMaxParallelAgentTasks));
    setMaxTaskNestingDepth(nextMaxTaskNestingDepth);
    setMaxTaskNestingDepthInput(String(nextMaxTaskNestingDepth));

    setIsSaving(true);
    setError(null);
    try {
      await api.tasks.setTaskSettings({
        maxParallelAgentTasks: nextMaxParallelAgentTasks,
        maxTaskNestingDepth: nextMaxTaskNestingDepth,
      });

      const saved = await api.tasks.getTaskSettings();
      setMaxParallelAgentTasks(saved.maxParallelAgentTasks);
      setMaxParallelAgentTasksInput(String(saved.maxParallelAgentTasks));
      setMaxTaskNestingDepth(saved.maxTaskNestingDepth);
      setMaxTaskNestingDepthInput(String(saved.maxTaskNestingDepth));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save task settings");
    } finally {
      setIsSaving(false);
    }
  }, [
    api,
    maxParallelAgentTasks,
    maxParallelAgentTasksInput,
    maxTaskNestingDepth,
    maxTaskNestingDepthInput,
  ]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Agent task limits</h3>
        <p className="text-muted-foreground text-sm">
          Control how many subagent workspaces can run at once and how deep nesting is allowed.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-sm">Max parallel subagents</label>
            <Input
              type="number"
              min={MAX_PARALLEL_AGENT_TASKS_MIN}
              max={MAX_PARALLEL_AGENT_TASKS_MAX}
              step={1}
              value={maxParallelAgentTasksInput}
              disabled={isLoading}
              onChange={(e) => {
                setMaxParallelAgentTasksInput(e.target.value);
                setError(null);
              }}
              onBlur={(e) => {
                const parsed = parseIntOrNull(e.target.value);
                if (parsed === null) {
                  setMaxParallelAgentTasksInput(String(maxParallelAgentTasks));
                  return;
                }

                const clamped = clampNumber(
                  parsed,
                  MAX_PARALLEL_AGENT_TASKS_MIN,
                  MAX_PARALLEL_AGENT_TASKS_MAX
                );
                setMaxParallelAgentTasks(clamped);
                setMaxParallelAgentTasksInput(String(clamped));
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-sm">Max nesting depth</label>
            <Input
              type="number"
              min={MAX_TASK_NESTING_DEPTH_MIN}
              max={MAX_TASK_NESTING_DEPTH_MAX}
              step={1}
              value={maxTaskNestingDepthInput}
              disabled={isLoading}
              onChange={(e) => {
                setMaxTaskNestingDepthInput(e.target.value);
                setError(null);
              }}
              onBlur={(e) => {
                const parsed = parseIntOrNull(e.target.value);
                if (parsed === null) {
                  setMaxTaskNestingDepthInput(String(maxTaskNestingDepth));
                  return;
                }

                const clamped = clampNumber(
                  parsed,
                  MAX_TASK_NESTING_DEPTH_MIN,
                  MAX_TASK_NESTING_DEPTH_MAX
                );
                setMaxTaskNestingDepth(clamped);
                setMaxTaskNestingDepthInput(String(clamped));
              }}
            />
          </div>
        </div>

        <Button onClick={() => void onSave()} disabled={isLoading || isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>

        {error && <div className="text-error text-sm">{error}</div>}
      </div>
    </div>
  );
}
