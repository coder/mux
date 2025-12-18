import React from "react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/ui/button";
import { Input } from "@/browser/components/ui/input";

export function TasksSection() {
  const { api } = useAPI();

  const [maxParallelAgentTasks, setMaxParallelAgentTasks] = React.useState<number>(3);
  const [maxTaskNestingDepth, setMaxTaskNestingDepth] = React.useState<number>(3);
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
        setMaxTaskNestingDepth(settings.maxTaskNestingDepth);
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

    setIsSaving(true);
    try {
      await api.tasks.setTaskSettings({
        maxParallelAgentTasks,
        maxTaskNestingDepth,
      });
    } finally {
      setIsSaving(false);
    }
  }, [api, maxParallelAgentTasks, maxTaskNestingDepth]);

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
              min={1}
              max={10}
              value={maxParallelAgentTasks}
              disabled={isLoading}
              onChange={(e) => setMaxParallelAgentTasks(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-sm">Max nesting depth</label>
            <Input
              type="number"
              min={1}
              max={5}
              value={maxTaskNestingDepth}
              disabled={isLoading}
              onChange={(e) => setMaxTaskNestingDepth(Number(e.target.value))}
            />
          </div>
        </div>

        <Button onClick={() => void onSave()} disabled={isLoading || isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
