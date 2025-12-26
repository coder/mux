/**
 * HunkViewer - Displays a single diff hunk with syntax highlighting
 */

import React, { useState, useMemo } from "react";
import type { DiffHunk, ReviewNoteData } from "@/common/types/review";
import { SelectableDiffRenderer } from "../../shared/DiffRenderer";
import {
  type SearchHighlightConfig,
  highlightSearchInText,
} from "@/browser/utils/highlighting/highlightSearchTerms";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../ui/tooltip";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewExpandStateKey } from "@/common/constants/storage";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";

interface HunkViewerProps {
  hunk: DiffHunk;
  hunkId: string;
  workspaceId: string;
  isSelected?: boolean;
  isRead?: boolean;
  /** Timestamp when this hunk content was first seen (for "Last edit at" display) */
  firstSeenAt: number;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onToggleRead?: (e: React.MouseEvent<HTMLElement>) => void;
  onRegisterToggleExpand?: (hunkId: string, toggleFn: () => void) => void;
  onReviewNote?: (data: ReviewNoteData) => void;
  searchConfig?: SearchHighlightConfig;
}

export const HunkViewer = React.memo<HunkViewerProps>(
  ({
    hunk,
    hunkId,
    workspaceId,
    isSelected,
    isRead = false,
    firstSeenAt,
    onClick,
    onToggleRead,
    onRegisterToggleExpand,
    onReviewNote,
    searchConfig,
  }) => {
    // Ref for the hunk container to track visibility
    const hunkRef = React.useRef<HTMLDivElement>(null);

    // Track if hunk is visible in viewport for lazy syntax highlighting
    // Use ref for visibility to avoid re-renders when visibility changes
    // Start as not visible to avoid eagerly highlighting off-screen hunks
    const isVisibleRef = React.useRef(false);
    const [isVisible, setIsVisible] = React.useState(false);

    // Use IntersectionObserver to track visibility
    React.useEffect(() => {
      const element = hunkRef.current;
      if (!element) return;

      // Create observer with generous root margin for pre-loading
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const newVisibility = entry.isIntersecting;
            // Only trigger re-render if transitioning from not-visible to visible
            // (to start highlighting). Transitions from visible to not-visible don't
            // need re-render because we cache the highlighting result.
            if (newVisibility && !isVisibleRef.current) {
              isVisibleRef.current = true;
              setIsVisible(true);
            } else if (!newVisibility && isVisibleRef.current) {
              isVisibleRef.current = false;
              // Don't update state when going invisible - keeps highlighted version
            }
          });
        },
        {
          rootMargin: "600px", // Pre-load hunks 600px before they enter viewport
        }
      );

      observer.observe(element);

      return () => {
        observer.disconnect();
      };
    }, []);

    // Parse diff lines (memoized - only recompute if hunk.content changes)
    // Must be done before state initialization to determine initial collapse state
    const { lineCount, additions, deletions, isLargeHunk } = React.useMemo(() => {
      const lines = hunk.content.split("\n").filter((line) => line.length > 0);
      const count = lines.length;
      return {
        lineCount: count,
        additions: lines.filter((line) => line.startsWith("+")).length,
        deletions: lines.filter((line) => line.startsWith("-")).length,
        isLargeHunk: count > 200, // Memoize to prevent useEffect re-runs
      };
    }, [hunk.content]);

    // Highlight filePath if search is active
    const highlightedFilePath = useMemo(() => {
      if (!searchConfig) {
        return hunk.filePath;
      }
      return highlightSearchInText(hunk.filePath, searchConfig);
    }, [hunk.filePath, searchConfig]);

    // Persist manual expand/collapse state across remounts per workspace
    // Maps hunkId -> isExpanded for user's manual preferences
    // Enable listener to synchronize updates across all HunkViewer instances
    const [expandStateMap, setExpandStateMap] = usePersistedState<Record<string, boolean>>(
      getReviewExpandStateKey(workspaceId),
      {},
      { listener: true }
    );

    // Check if user has manually set expand state for this hunk
    const hasManualState = hunkId in expandStateMap;
    const manualExpandState = expandStateMap[hunkId];

    // Determine initial expand state (priority: manual > read status > size)
    const [isExpanded, setIsExpanded] = useState(() => {
      if (hasManualState) {
        return manualExpandState;
      }
      return !isRead && !isLargeHunk;
    });

    // Auto-collapse when marked as read, auto-expand when unmarked (unless user manually set)
    React.useEffect(() => {
      // Don't override manual expand/collapse choices
      if (hasManualState) {
        return;
      }

      if (isRead) {
        setIsExpanded(false);
      } else if (!isLargeHunk) {
        setIsExpanded(true);
      }
      // Note: When unmarking as read, large hunks remain collapsed
    }, [isRead, isLargeHunk, hasManualState]);

    // Sync local state with persisted state when it changes
    React.useEffect(() => {
      if (hasManualState) {
        setIsExpanded(manualExpandState);
      }
    }, [hasManualState, manualExpandState]);

    const handleToggleExpand = React.useCallback(
      (e?: React.MouseEvent) => {
        e?.stopPropagation();
        const newExpandState = !isExpanded;
        setIsExpanded(newExpandState);
        // Persist manual expand/collapse choice
        setExpandStateMap((prev) => ({
          ...prev,
          [hunkId]: newExpandState,
        }));
      },
      [isExpanded, hunkId, setExpandStateMap]
    );

    // Register toggle method with parent component
    React.useEffect(() => {
      if (onRegisterToggleExpand) {
        onRegisterToggleExpand(hunkId, handleToggleExpand);
      }
    }, [hunkId, onRegisterToggleExpand, handleToggleExpand]);

    const handleToggleRead = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onToggleRead?.(e);
    };

    // Detect pure rename: if renamed and content hasn't changed (zero additions and deletions)
    const isPureRename =
      hunk.changeType === "renamed" && hunk.oldPath && additions === 0 && deletions === 0;

    return (
      <div
        ref={hunkRef}
        className={cn(
          "bg-dark border rounded mb-3 overflow-hidden cursor-pointer transition-all duration-200",
          "focus:outline-none focus-visible:outline-none",
          isRead ? "border-read" : "border-border-light",
          isSelected && "border-review-accent shadow-[0_0_0_1px_var(--color-review-accent)]"
        )}
        onClick={onClick}
        role="button"
        tabIndex={0}
        data-hunk-id={hunkId}
      >
        <div className="border-border-light font-monospace flex items-center gap-1.5 border-b px-2 py-1 text-[11px]">
          {onToggleRead && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "text-muted hover:text-read flex cursor-pointer items-center bg-transparent border-none p-0 text-[11px] transition-colors duration-150",
                    isRead && "text-read"
                  )}
                  data-hunk-id={hunkId}
                  onClick={handleToggleRead}
                  aria-label={`Mark as read (${formatKeybind(KEYBINDS.TOGGLE_HUNK_READ)})`}
                >
                  {isRead ? "✓" : "○"}
                </button>
              </TooltipTrigger>
              <TooltipContent align="start" side="top">
                Mark as read ({formatKeybind(KEYBINDS.TOGGLE_HUNK_READ)}) · Mark file (
                {formatKeybind(KEYBINDS.MARK_FILE_READ)})
              </TooltipContent>
            </Tooltip>
          )}
          <div
            className="text-foreground min-w-0 truncate"
            dangerouslySetInnerHTML={{ __html: highlightedFilePath }}
          />
          <div className="text-muted ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            {!isPureRename && (
              <>
                {additions > 0 && <span className="text-success-light">+{additions}</span>}
                {deletions > 0 && <span className="text-warning-light">−{deletions}</span>}
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-dim cursor-default">{formatRelativeTime(firstSeenAt)}</span>
              </TooltipTrigger>
              <TooltipContent align="center" side="top">
                First seen: {new Date(firstSeenAt).toLocaleString()}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {isPureRename ? (
          <div className="text-muted bg-code-keyword-overlay-light before:text-code-keyword flex items-center gap-2 p-3 text-[11px] before:text-sm before:content-['→']">
            Renamed from <code>{hunk.oldPath}</code>
          </div>
        ) : isExpanded ? (
          <SelectableDiffRenderer
            content={hunk.content}
            filePath={hunk.filePath}
            oldStart={hunk.oldStart}
            newStart={hunk.newStart}
            fontSize="11px"
            maxHeight="none"
            className="rounded-none border-0"
            onReviewNote={onReviewNote}
            onLineClick={() => {
              // Create synthetic event with data-hunk-id for parent handler
              const syntheticEvent = {
                currentTarget: { dataset: { hunkId } },
              } as unknown as React.MouseEvent<HTMLElement>;
              onClick?.(syntheticEvent);
            }}
            searchConfig={searchConfig}
            enableHighlighting={isVisible}
          />
        ) : (
          <div
            className="text-muted hover:text-foreground cursor-pointer px-3 py-2 text-center text-[11px] italic"
            onClick={handleToggleExpand}
          >
            {isRead && "Hunk marked as read. "}Click to expand ({lineCount} lines) or press{" "}
            {formatKeybind(KEYBINDS.TOGGLE_HUNK_COLLAPSE)}
          </div>
        )}

        {hasManualState && isExpanded && !isPureRename && (
          <div
            className="text-muted hover:text-foreground cursor-pointer px-3 py-2 text-center text-[11px] italic"
            onClick={handleToggleExpand}
          >
            Click here or press {formatKeybind(KEYBINDS.TOGGLE_HUNK_COLLAPSE)} to collapse
          </div>
        )}
      </div>
    );
  }
);

HunkViewer.displayName = "HunkViewer";
