import React, { useState, useCallback, useRef, useEffect } from "react";
import { Terminal, X, ChevronDown, ChevronUp } from "lucide-react";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import { cn } from "@/common/lib/utils";

/**
 * Format duration from startTime to now in human-readable form.
 * Shows "Xs" for seconds, "Xm Ys" for minutes, "Xh Ym" for hours.
 */
function formatDuration(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  if (elapsed < 60) {
    return `${elapsed}s`;
  }
  if (elapsed < 3600) {
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

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
    <div className="relative mx-4 mt-2 mb-1" ref={panelRef}>
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
            {count} running bash{count !== 1 ? "es" : ""}
          </span>
        </span>
        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* Expanded panel */}
      {isExpanded && (
        <div
          className={cn(
            "absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-md",
            "bg-[var(--color-bg-secondary)] shadow-lg",
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
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-[var(--color-text-tertiary)]">
                      {proc.id}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-quaternary)]">
                      pid:{proc.pid}
                    </span>
                  </div>
                  <div
                    className="truncate font-mono text-xs text-[var(--color-text-secondary)]"
                    title={proc.script}
                  >
                    {proc.displayName ?? truncateScript(proc.script)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    {formatDuration(proc.startTime)}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => handleTerminate(proc.id, e)}
                    className={cn(
                      "rounded p-1 transition-colors",
                      "text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-quaternary)] hover:text-[var(--color-error)]"
                    )}
                    title="Terminate process"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
