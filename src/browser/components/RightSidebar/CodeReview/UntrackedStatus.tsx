/**
 * UntrackedStatus - Shows untracked files as a prominent banner in the hunk viewer area
 */

import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";

interface UntrackedStatusProps {
  workspaceId: string;
  workspacePath: string;
  refreshTrigger?: number;
  onRefresh?: () => void;
}

export const UntrackedStatus: React.FC<UntrackedStatusProps> = ({
  workspaceId,
  workspacePath,
  refreshTrigger,
  onRefresh,
}) => {
  const { api } = useAPI();
  const [untrackedFiles, setUntrackedFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const hasLoadedOnce = useRef(false);
  const loadingRef = useRef(false); // Prevent concurrent loads

  // Load untracked files
  useEffect(() => {
    let cancelled = false;

    const loadUntracked = async () => {
      // Prevent concurrent loads
      if (loadingRef.current) return;
      loadingRef.current = true;

      // Only show loading on first load ever, not on subsequent refreshes
      if (!hasLoadedOnce.current) {
        setIsLoading(true);
      }

      try {
        const result = await api?.workspace.executeBash({
          workspaceId,
          script: "git ls-files --others --exclude-standard",
          options: { timeout_secs: 5 },
        });

        if (cancelled || !result) return;

        if (result.success) {
          const files = (result.data.output ?? "")
            .split("\n")
            .map((f: string) => f.trim())
            .filter(Boolean);
          setUntrackedFiles(files);
        }

        hasLoadedOnce.current = true;
      } catch (err) {
        console.error("Failed to load untracked files:", err);
      } finally {
        loadingRef.current = false;
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadUntracked();

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, workspacePath, refreshTrigger]);

  const handleTrackAll = async () => {
    if (untrackedFiles.length === 0 || isTracking) return;

    setIsTracking(true);
    try {
      // Use git add with -- to treat all arguments as file paths
      // Escape single quotes by replacing ' with '\'' for safe shell quoting
      const escapedFiles = untrackedFiles.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
      const result = await api?.workspace.executeBash({
        workspaceId,
        script: `git add -- ${escapedFiles}`,
        options: { timeout_secs: 10 },
      });

      if (result?.success) {
        // Collapse and trigger refresh
        setIsExpanded(false);
        onRefresh?.();
      } else if (result) {
        console.error("Failed to track files:", result.error);
      }
    } catch (err) {
      console.error("Failed to track files:", err);
    } finally {
      setIsTracking(false);
    }
  };

  const count = untrackedFiles.length;
  const MAX_DISPLAY_FILES = 20;
  const displayedFiles = untrackedFiles.slice(0, MAX_DISPLAY_FILES);
  const hiddenCount = count - displayedFiles.length;

  // Don't render anything if no untracked files (and not loading on first load)
  if (!isLoading && count === 0) {
    return null;
  }

  // Show loading state only on first load
  if (isLoading && !hasLoadedOnce.current) {
    return null;
  }

  return (
    <div className="bg-info-yellow/10 border-info-yellow/30 mx-3 mt-3 rounded border">
      {/* Banner header - always visible when there are untracked files */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left",
          "hover:bg-info-yellow/5 transition-colors duration-150"
        )}
      >
        <span
          className={cn("text-[10px] transition-transform duration-200", isExpanded && "rotate-90")}
        >
          ▶
        </span>
        <span className="text-info-yellow text-xs font-medium">
          {count} untracked {count === 1 ? "file" : "files"}
        </span>
        <span className="text-muted text-[11px]">not included in diff</span>
      </button>

      {/* Expandable file list */}
      {isExpanded && (
        <div className="border-info-yellow/20 border-t px-3 py-2">
          <div className="mb-2 max-h-[200px] overflow-y-auto">
            {displayedFiles.map((file) => (
              <div
                key={file}
                className="text-label hover:bg-bg-subtle truncate py-0.5 font-mono text-[11px]"
              >
                {file}
              </div>
            ))}
            {hiddenCount > 0 && (
              <div className="text-muted py-0.5 text-[11px] italic">
                and {hiddenCount} more {hiddenCount === 1 ? "file" : "files"}...
              </div>
            )}
          </div>
          <button
            onClick={() => void handleTrackAll()}
            disabled={isTracking}
            className={cn(
              "w-full py-1.5 px-2 bg-info-yellow/20 text-info-yellow border border-info-yellow/30 rounded text-[11px] cursor-pointer transition-all duration-200 font-medium",
              "hover:bg-info-yellow/30 hover:border-info-yellow/50",
              "active:bg-info-yellow/40",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {isTracking ? "Tracking..." : "Track All Files"}
          </button>
        </div>
      )}
    </div>
  );
};
