import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { DevToolsRunCard } from "./DevToolsRunCard";
import { useDevToolsSubscription } from "./useDevToolsSubscription";

interface DevToolsTabProps {
  workspaceId: string;
}

export function DevToolsTab(props: DevToolsTabProps) {
  const { api } = useAPI();
  const { runs, error } = useDevToolsSubscription(props.workspaceId);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    if (!api || clearing) return;

    setClearing(true);
    try {
      await api.devtools.clear({ workspaceId: props.workspaceId });
    } catch (clearError) {
      console.warn("Failed to clear debug logs:", clearError);
    } finally {
      setClearing(false);
    }
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-destructive text-xs">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-light px-3 py-2">
        <h3 className="text-foreground text-xs font-semibold uppercase tracking-wide">
          Debug Logs
        </h3>
        {runs.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            disabled={clearing}
            className="text-muted hover:text-foreground rounded p-1 transition-colors disabled:opacity-50"
            aria-label="Clear debug logs"
          >
            {clearing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {runs.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-muted text-center text-xs">
              No debug logs yet.
              <br />
              Enable LLM Debug Logs in Settings to start recording.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {runs.map((run) => (
              <DevToolsRunCard
                key={run.id}
                run={run}
                workspaceId={props.workspaceId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
