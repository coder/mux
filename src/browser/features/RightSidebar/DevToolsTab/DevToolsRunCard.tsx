import { useState } from "react";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { cn } from "@/common/lib/utils";
import type { DevToolsRunSummary, DevToolsStep } from "@/common/types/devtools";
import { DevToolsStepCard } from "./DevToolsStepCard";

interface DevToolsRunCardProps {
  run: DevToolsRunSummary;
  workspaceId: string;
}

export function DevToolsRunCard(props: DevToolsRunCardProps) {
  const { api } = useAPI();

  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<DevToolsStep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);

    if (!nextExpanded || steps !== null || !api) {
      return;
    }

    setLoading(true);
    setError(null);
    api.devtools
      .getRunDetail({
        workspaceId: props.workspaceId,
        runId: props.run.id,
      })
      .then((result) => {
        if (!result) {
          setSteps([]);
          return;
        }
        setSteps(result.steps);
      })
      .catch((detailError: unknown) => {
        setError(
          detailError instanceof Error ? detailError.message : "Failed to load run detail",
        );
      })
      .finally(() => {
        setLoading(false);
      });
  };

  return (
    <div className="rounded border border-border-light bg-background-secondary">
      <button
        type="button"
        onClick={handleToggle}
        className="hover:bg-hover flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="flex-1 truncate text-xs text-foreground">
          {props.run.firstMessage || "\u2014"}
        </span>
        {props.run.modelId && (
          <span className="text-muted shrink-0 text-[10px]">{props.run.modelId}</span>
        )}
        <span className="text-muted shrink-0 text-[10px]">
          {props.run.stepCount} step{props.run.stepCount !== 1 ? "s" : ""}
        </span>
        {props.run.isInProgress && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted" />
        )}
        {props.run.hasError && (
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border-light px-2 py-1.5">
          {loading ? (
            <div className="flex justify-center py-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted" />
            </div>
          ) : error ? (
            <p className="text-destructive py-1 text-[10px]">{error}</p>
          ) : steps && steps.length > 0 ? (
            <div className="flex flex-col gap-1">
              {steps.map((step) => (
                <DevToolsStepCard key={step.id} step={step} />
              ))}
            </div>
          ) : (
            <p className="text-muted py-1 text-[10px]">No steps recorded</p>
          )}
        </div>
      )}
    </div>
  );
}
