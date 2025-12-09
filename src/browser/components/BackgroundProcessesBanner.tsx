import React, { useState, useCallback, useRef, useEffect } from "react";
import { Terminal, X, ChevronDown, ChevronUp } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import { cn } from "@/common/lib/utils";
import { formatDuration } from "./tools/shared/toolUtils";

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
  processes: BackgroundProcessInfo[];
  onTerminate: (processId: string) => void;
}

/**
 * Banner showing running background processes.
 * Displays "N running bashes" which expands on click to show details.
 */
export const BackgroundProcessesBanner: React.FC<BackgroundProcessesBannerProps> = (props) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Filter to only running processes
  const runningProcesses = props.processes.filter((p) => p.status === "running");
  const count = runningProcesses.length;

  // Update duration display every second when expanded
  useEffect(() => {
    if (!isExpanded || count === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExpanded, count]);

  // Close panel when clicking outside
  useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const { onTerminate } = props;
  const handleTerminate = useCallback(
    (processId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      onTerminate(processId);
    },
    [onTerminate]
  );

  // Don't render if no running processes
  if (count === 0) {
    return null;
  }

  return (
    <div className="relative mt-2 mb-1 px-[15px]" ref={panelRef}>
      {/* Collapsed banner - click to expand */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5",
          "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]",
          "text-xs transition-colors hover:bg-[var(--color-bg-quaternary)]"
        )}
      >
        <span className="flex items-center gap-2">
          <Terminal size={14} className="text-[var(--color-text-tertiary)]" />
          <span>
            {count} background bash{count !== 1 ? "es" : ""}
          </span>
        </span>
        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* Expanded panel */}
      {isExpanded && (
        <div
          className={cn(
            "absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-md",
            "bg-modal-bg shadow-lg",
            "border border-[var(--color-border)]"
          )}
        >
          <div className="max-h-48 overflow-y-auto">
            {runningProcesses.map((proc) => (
              <div
                key={proc.id}
                className={cn(
                  "flex items-center justify-between gap-3 px-3 py-2",
                  "border-b border-[var(--color-border)] last:border-b-0",
                  "hover:bg-[var(--color-bg-tertiary)]"
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-foreground truncate font-mono text-xs" title={proc.script}>
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
                        onClick={(e) => handleTerminate(proc.id, e)}
                        className={cn(
                          "rounded p-1 transition-colors",
                          "text-muted hover:bg-[var(--color-bg-quaternary)] hover:text-[var(--color-error)]"
                        )}
                      >
                        <X size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Terminate process</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
