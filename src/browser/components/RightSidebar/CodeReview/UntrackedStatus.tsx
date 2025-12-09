/**
 * UntrackedStatus - Shows untracked files count with interactive tooltip
 */

import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
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
  const [showTooltip, setShowTooltip] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [popupPosition, setPopupPosition] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const hasLoadedOnce = useRef(false);
  const loadingRef = useRef(false); // Prevent concurrent loads

  // Calculate popup position when shown
  useLayoutEffect(() => {
    if (!showTooltip || !containerRef.current) {
      setPopupPosition(null);
      return;
    }

    const updatePosition = () => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      setPopupPosition({
        top: rect.bottom + 8, // 8px gap below anchor
        right: window.innerWidth - rect.right,
      });
    };

    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [showTooltip]);

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
        setIsLoading(false);
      }
    };

    void loadUntracked();

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, workspacePath, refreshTrigger]);

  // Close tooltip when clicking outside
  useEffect(() => {
    if (!showTooltip) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedContainer = containerRef.current?.contains(target);
      const clickedPopup = popupRef.current?.contains(target);
      if (!clickedContainer && !clickedPopup) {
        setShowTooltip(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTooltip]);

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
        // Close tooltip first
        setShowTooltip(false);
        // Trigger refresh - this will reload untracked files from git
        // Don't clear untrackedFiles optimistically to avoid flicker
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
  const hasUntracked = count > 0;

  return (
    <div ref={containerRef} className="inline-block">
      <div
        className={cn(
          "py-1 px-2.5 rounded font-medium text-[11px] whitespace-nowrap transition-all duration-200",
          hasUntracked
            ? "bg-review-bg-warning border border-review-warning text-info-yellow cursor-pointer hover:bg-review-warning-light hover:border-review-warning-medium"
            : "bg-transparent border border-transparent text-muted cursor-default"
        )}
        onClick={() => hasUntracked && setShowTooltip(!showTooltip)}
      >
        {isLoading ? "..." : `${count} Untracked`}
      </div>

      {showTooltip &&
        hasUntracked &&
        popupPosition &&
        createPortal(
          <div
            ref={popupRef}
            className="bg-modal-bg border-bg-medium animate-in fade-in slide-in-from-top-1 fixed z-[1000] max-w-96 min-w-48 rounded border p-2 shadow-[0_4px_12px_rgba(0,0,0,0.3)] duration-150"
            style={{ top: popupPosition.top, right: popupPosition.right }}
          >
            <div className="text-foreground border-border-light mb-2 border-b pb-1.5 text-[11px] font-semibold">
              Untracked Files ({count})
            </div>
            <div className="mb-2 max-h-[200px] overflow-y-auto">
              {untrackedFiles.map((file) => (
                <div
                  key={file}
                  className="text-label hover:bg-bg-subtle truncate px-1 py-0.5 font-mono text-[11px]"
                >
                  {file}
                </div>
              ))}
            </div>
            <button
              onClick={() => void handleTrackAll()}
              disabled={isTracking}
              className={cn(
                "w-full py-1 px-2 bg-transparent text-muted border border-border-medium rounded text-[11px] cursor-pointer transition-all duration-200 font-primary",
                "hover:bg-white-overlay-light hover:text-foreground hover:border-border-subtle",
                "active:bg-white-overlay",
                "disabled:text-border-darker disabled:border-border disabled:cursor-not-allowed disabled:bg-transparent"
              )}
            >
              {isTracking ? "Tracking..." : "Track All"}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};
