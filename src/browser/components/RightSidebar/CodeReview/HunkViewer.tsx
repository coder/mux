/**
 * HunkViewer - Displays a single diff hunk with syntax highlighting
 * Includes read-more feature to expand context above/below the hunk.
 */

import React, { useState, useMemo } from "react";
import { Check, Circle } from "lucide-react";
import type { DiffHunk, Review, ReviewNoteData } from "@/common/types/review";
import { SelectableDiffRenderer } from "../../shared/DiffRenderer";
import type { ReviewActionCallbacks } from "../../shared/InlineReviewNote";
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
import { ContextCollapseIndicator } from "./ContextCollapseIndicator";
import { useReadMore } from "./useReadMore";

interface HunkViewerProps {
  hunk: DiffHunk;
  hunkId: string;
  workspaceId: string;
  /** Reviews for this file to render inline next to matching lines */
  inlineReviews?: Review[];
  isSelected?: boolean;
  isRead?: boolean;
  /** Timestamp when this hunk content was first seen (for "Last edit at" display) */
  firstSeenAt: number;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onToggleRead?: (e: React.MouseEvent<HTMLElement>) => void;
  onRegisterToggleExpand?: (hunkId: string, toggleFn: () => void) => void;
  onReviewNote?: (data: ReviewNoteData) => void;
  searchConfig?: SearchHighlightConfig;
  /** Callback when review note composition state changes (receives hunkId for stable reference) */
  onComposingChange?: (hunkId: string, isComposing: boolean) => void;
  /** Diff base for determining which git ref to read from */
  diffBase: string;
  /** Whether uncommitted changes are included in the diff */
  includeUncommitted: boolean;
  /** Action callbacks for inline review notes */
  reviewActions?: ReviewActionCallbacks;
  /** Callback to open a file in a new tab */
  onOpenFile?: (relativePath: string) => void;
}

export const HunkViewer = React.memo<HunkViewerProps>(
  ({
    hunk,
    hunkId,
    workspaceId,
    inlineReviews,
    isSelected,
    isRead = false,
    firstSeenAt,
    onClick,
    onToggleRead,
    onRegisterToggleExpand,
    onReviewNote,
    searchConfig,
    onComposingChange,
    diffBase,
    reviewActions,
    includeUncommitted,
    onOpenFile,
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

    const handleOpenFile = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onOpenFile?.(hunk.filePath);
      },
      [onOpenFile, hunk.filePath]
    );

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

    // Read-more context expansion
    const {
      upContent,
      downContent,
      upLoading,
      downLoading,
      atBOF,
      atEOF,
      readMore,
      handleExpandUp,
      handleExpandDown,
      handleCollapseUp,
      handleCollapseDown,
    } = useReadMore({ hunk, hunkId, workspaceId, diffBase, includeUncommitted });

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

    // Wrap onComposingChange to include hunkId - creates stable reference per-hunk
    // This allows parent to pass a single stable callback instead of inline arrow functions
    const handleComposingChange = React.useCallback(
      (isComposing: boolean) => {
        onComposingChange?.(hunkId, isComposing);
      },
      [hunkId, onComposingChange]
    );

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
                  {isRead ? (
                    <Check aria-hidden="true" className="h-3 w-3" />
                  ) : (
                    <Circle aria-hidden="true" className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent align="start" side="top">
                Mark as read ({formatKeybind(KEYBINDS.TOGGLE_HUNK_READ)}) · Mark file (
                {formatKeybind(KEYBINDS.MARK_FILE_READ)})
              </TooltipContent>
            </Tooltip>
          )}
          {onOpenFile ? (
            <button
              type="button"
              onClick={handleOpenFile}
              className={cn(
                "text-foreground min-w-0 truncate bg-transparent p-0 text-left",
                "hover:text-link focus-visible:text-link cursor-pointer border-none"
              )}
              title={hunk.filePath}
              aria-label={`Open ${hunk.filePath} in new tab`}
            >
              <span dangerouslySetInnerHTML={{ __html: highlightedFilePath }} />
            </button>
          ) : (
            <div
              className="text-foreground min-w-0 truncate"
              dangerouslySetInnerHTML={{ __html: highlightedFilePath }}
            />
          )}
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
          <div className="font-monospace bg-code-bg overflow-x-auto text-[11px] leading-[1.4]">
            {/* Expand up control - only show if not at BOF and not loading */}
            {!atBOF && !upLoading && (
              <div className="text-muted flex h-[18px] items-center justify-center text-[10px]">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleExpandUp}
                      className="text-link hover:text-link-hover cursor-pointer px-1"
                      aria-label="Show more context above"
                    >
                      ▲
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Show more context above</TooltipContent>
                </Tooltip>
              </div>
            )}
            {upLoading && (
              <div className="text-muted flex h-[18px] items-center justify-center text-[10px]">
                <span>Loading...</span>
              </div>
            )}

            {/* Expanded content above */}
            {upContent && (
              <>
                <SelectableDiffRenderer
                  content={upContent}
                  filePath={hunk.filePath}
                  inlineReviews={inlineReviews}
                  oldStart={Math.max(1, hunk.oldStart - readMore.up)}
                  newStart={Math.max(1, hunk.newStart - readMore.up)}
                  fontSize="11px"
                  maxHeight="none"
                  className="rounded-none border-0 [&>div]:overflow-x-visible"
                  enableHighlighting={isVisible}
                  reviewActions={reviewActions}
                />
                {/* Collapse indicator between expanded context and main hunk */}
                <ContextCollapseIndicator
                  lineCount={readMore.up}
                  onCollapse={handleCollapseUp}
                  position="above"
                />
              </>
            )}

            {/* Original hunk content */}
            <SelectableDiffRenderer
              content={hunk.content}
              filePath={hunk.filePath}
              inlineReviews={inlineReviews}
              oldStart={hunk.oldStart}
              newStart={hunk.newStart}
              fontSize="11px"
              maxHeight="none"
              className="rounded-none border-0 [&>div]:overflow-x-visible"
              onReviewNote={onReviewNote}
              onLineClick={() => {
                const syntheticEvent = {
                  currentTarget: { dataset: { hunkId } },
                } as unknown as React.MouseEvent<HTMLElement>;
                onClick?.(syntheticEvent);
              }}
              searchConfig={searchConfig}
              enableHighlighting={isVisible}
              onComposingChange={handleComposingChange}
              reviewActions={reviewActions}
            />

            {/* Expanded content below */}
            {downContent && (
              <>
                {/* Collapse indicator between main hunk and expanded context */}
                <ContextCollapseIndicator
                  lineCount={readMore.down}
                  onCollapse={handleCollapseDown}
                  position="below"
                />
                <SelectableDiffRenderer
                  content={downContent}
                  filePath={hunk.filePath}
                  inlineReviews={inlineReviews}
                  oldStart={hunk.oldStart + hunk.oldLines}
                  newStart={hunk.newStart + hunk.newLines}
                  fontSize="11px"
                  maxHeight="none"
                  className="rounded-none border-0 [&>div]:overflow-x-visible"
                  enableHighlighting={isVisible}
                  reviewActions={reviewActions}
                />
              </>
            )}

            {/* Expand down control - only show if not at EOF and not loading */}
            {!atEOF && !downLoading && (
              <div className="text-muted flex h-[18px] items-center justify-center text-[10px]">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleExpandDown}
                      className="text-link hover:text-link-hover cursor-pointer px-1"
                      aria-label="Show more context below"
                    >
                      ▼
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Show more context below</TooltipContent>
                </Tooltip>
              </div>
            )}
            {downLoading && (
              <div className="text-muted flex h-[18px] items-center justify-center text-[10px]">
                <span>Loading...</span>
              </div>
            )}
            {/* EOF indicator - show when at EOF with expanded content */}
            {atEOF && downContent && !downLoading && (
              <div className="text-dim flex h-[18px] items-center justify-center text-[10px]">
                — end of file —
              </div>
            )}
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
