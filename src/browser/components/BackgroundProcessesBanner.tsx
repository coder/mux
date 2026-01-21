import React, { useState, useCallback, useEffect } from "react";
import { Terminal, X, ChevronDown, ChevronRight, Loader2, FileText } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { cn } from "@/common/lib/utils";
import { BackgroundBashOutputDialog } from "./BackgroundBashOutputDialog";
import { formatDuration } from "./tools/shared/toolUtils";
import {
  useBackgroundBashTerminatingIds,
  useBackgroundProcesses,
} from "@/browser/stores/BackgroundBashStore";
import { useBackgroundBashActions } from "@/browser/contexts/BackgroundBashContext";

/**
 * Truncate script to reasonable display length.
 */
function truncateScript(script: string, maxLength = 60): string {
  // First line only, truncated
  const firstLine = script.split("\n")[0] ?? script;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return firstLine.slice(0, maxLength - 3) + "...";
}

interface BackgroundProcessesBannerProps {
  workspaceId: string;
}

/**
 * Banner showing running background processes.
 * Displays "N running bashes" which expands on click to show details.
 */
export const BackgroundProcessesBanner: React.FC<BackgroundProcessesBannerProps> = (props) => {
  const [viewingProcessId, setViewingProcessId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setTick] = useState(0);
  const processes = useBackgroundProcesses(props.workspaceId);
  const terminatingIds = useBackgroundBashTerminatingIds(props.workspaceId);
  const { terminate } = useBackgroundBashActions();

  // Filter to only running processes
  const runningProcesses = processes.filter((p) => p.status === "running");
  const viewingProcess = processes.find((p) => p.id === viewingProcessId) ?? null;
  const count = runningProcesses.length;

  // Update duration display every second when expanded
  useEffect(() => {
    if (!isExpanded || count === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExpanded, count]);

  const handleViewOutput = useCallback((processId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setViewingProcessId(processId);
  }, []);

  const handleTerminate = useCallback(
    (processId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      terminate(processId);
    },
    [terminate]
  );

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Don't render if no running processes and no dialog open.
  if (count === 0 && !viewingProcessId) {
    return null;
  }

  return (
    <>
      {count > 0 && (
        <div className="border-border bg-dark border-t px-[15px]">
          {/* Collapsed banner - thin stripe, content aligned with chat */}
          <button
            type="button"
            onClick={handleToggle}
            className="group mx-auto flex w-full max-w-4xl items-center gap-2 px-2 py-1 text-xs transition-colors"
          >
            <Terminal className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
            <span className="text-muted group-hover:text-secondary transition-colors">
              <span className="font-medium">{count}</span>
              {" background bash"}
              {count !== 1 && "es"}
            </span>
            <div className="ml-auto">
              {isExpanded ? (
                <ChevronDown className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
              ) : (
                <ChevronRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
              )}
            </div>
          </button>

          {/* Expanded view - content aligned with chat */}
          {isExpanded && (
            <div className="border-border mx-auto max-h-48 max-w-4xl space-y-1.5 overflow-y-auto border-t py-2">
              {runningProcesses.map((proc) => {
                const isTerminating = terminatingIds.has(proc.id);
                return (
                  <div
                    key={proc.id}
                    className={cn(
                      "hover:bg-hover flex items-center justify-between gap-3 rounded px-2 py-1.5",
                      "transition-colors",
                      isTerminating && "pointer-events-none opacity-50"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-foreground truncate font-mono text-xs"
                        title={proc.script}
                      >
                        {proc.displayName ?? truncateScript(proc.script)}
                      </div>
                      <div className="text-muted font-mono text-[10px]">pid {proc.pid}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-muted text-[10px]">
                        {formatDuration(Date.now() - proc.startTime)}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={isTerminating}
                            onClick={(e) => handleViewOutput(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-secondary rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            <FileText size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>View output</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            disabled={isTerminating}
                            onClick={(e) => handleTerminate(proc.id, e)}
                            className={cn(
                              "text-muted hover:text-error rounded p-1 transition-colors",
                              isTerminating && "cursor-not-allowed"
                            )}
                          >
                            {isTerminating ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <X size={14} />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Terminate process</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {viewingProcessId && (
        <BackgroundBashOutputDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setViewingProcessId(null);
            }
          }}
          workspaceId={props.workspaceId}
          processId={viewingProcessId}
          displayName={viewingProcess?.displayName}
        />
      )}
    </>
  );
};
