/**
 * HunkViewer - Displays a single diff hunk with syntax highlighting
 */

import React, { useState, useMemo } from "react";
import type { DiffHunk } from "@/common/types/review";
import { SelectableDiffRenderer } from "../../shared/DiffRenderer";
import {
  type SearchHighlightConfig,
  highlightSearchInText,
} from "@/browser/utils/highlighting/highlightSearchTerms";
import { Tooltip, TooltipWrapper } from "../../Tooltip";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewExpandStateKey } from "@/common/constants/storage";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface HunkViewerProps {
  hunk: DiffHunk;
  hunkId: string;
  workspaceId: string;
  isSelected?: boolean;
  isRead?: boolean;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onToggleRead?: (e: React.MouseEvent<HTMLElement>) => void;
  onRegisterToggleExpand?: (hunkId: string, toggleFn: () => void) => void;
  onReviewNote?: (note: string) => void;
  searchConfig?: SearchHighlightConfig;
}

export const HunkViewer = React.memo<HunkViewerProps>(
  ({
    hunk,
    hunkId,
    workspaceId,
    isSelected,
    isRead = false,
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
        <div className="bg-separator border-border-light font-monospace flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          {isRead && (
            <TooltipWrapper inline>
              <span
                className="text-read mr-1 inline-flex items-center text-sm"
                aria-label="Marked as read"
              >
                ✓
              </span>
              <Tooltip align="center" position="top">
                Marked as read
              </Tooltip>
            </TooltipWrapper>
          )}
          <div
            className="text-foreground min-w-0 truncate font-medium"
            dangerouslySetInnerHTML={{ __html: highlightedFilePath }}
          />
          <div className="flex shrink-0 items-center gap-2 text-[11px] whitespace-nowrap">
            {!isPureRename && (
              <span className="flex gap-2 text-[11px]">
                {additions > 0 && <span className="text-success-light">+{additions}</span>}
                {deletions > 0 && <span className="text-warning-light">-{deletions}</span>}
              </span>
            )}
            <span className="text-muted">
              ({lineCount} {lineCount === 1 ? "line" : "lines"})
            </span>
            {onToggleRead && (
              <TooltipWrapper inline>
                <button
                  className="border-border-light text-muted hover:border-read hover:text-read flex cursor-pointer items-center gap-1 rounded-[3px] border bg-transparent px-1.5 py-0.5 text-[11px] transition-all duration-200 hover:bg-white/5 active:scale-95"
                  data-hunk-id={hunkId}
                  onClick={handleToggleRead}
                  aria-label={`Mark as read (${formatKeybind(KEYBINDS.TOGGLE_HUNK_READ)})`}
                >
                  {isRead ? "○" : "◉"}
                </button>
                <Tooltip align="right" position="top">
                  Mark as read ({formatKeybind(KEYBINDS.TOGGLE_HUNK_READ)}) · Mark file (
                  {formatKeybind(KEYBINDS.MARK_FILE_READ)})
                </Tooltip>
              </TooltipWrapper>
            )}
          </div>
        </div>

        {isPureRename ? (
          <div className="text-muted bg-code-keyword-overlay-light before:text-code-keyword flex items-center gap-2 p-3 text-[11px] before:text-sm before:content-['→']">
            Renamed from <code>{hunk.oldPath}</code>
          </div>
        ) : isExpanded ? (
          <div className="font-monospace bg-code-bg grid grid-cols-[minmax(min-content,1fr)] overflow-x-auto px-2 py-1.5 text-[11px] leading-[1.4]">
            <SelectableDiffRenderer
              content={hunk.content}
              filePath={hunk.filePath}
              oldStart={hunk.oldStart}
              newStart={hunk.newStart}
              maxHeight="none"
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
          </div>
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
