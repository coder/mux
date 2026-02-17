/**
 * ImmersiveReviewView — Full-screen, keyboard-first code review mode.
 * Rendered via portal into #review-immersive-root overlay.
 * Shows one file at a time with keyboard navigation for files, hunks, and lines.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { HunkViewer } from "./HunkViewer";
import { KeycapGroup } from "@/browser/components/ui/Keycap";
import {
  flattenFileTreeLeaves,
  getAdjacentFilePath,
  getFileHunks,
} from "@/browser/utils/review/navigation";
import { buildQuickHunkReviewNote } from "@/browser/utils/review/quickReviewNotes";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import type { DiffHunk, Review, ReviewNoteData } from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { ReviewActionCallbacks } from "../../shared/InlineReviewNote";

interface ImmersiveReviewViewProps {
  workspaceId: string;
  fileTree: FileTreeNode | null;
  /** Filtered hunks (respects current filters) */
  hunks: DiffHunk[];
  /** All hunks (unfiltered, for context) */
  allHunks: DiffHunk[];
  isRead: (hunkId: string) => boolean;
  onToggleRead: (hunkId: string) => void;
  selectedHunkId: string | null;
  onSelectHunk: (hunkId: string | null) => void;
  onExit: () => void;
  onReviewNote?: (data: ReviewNoteData) => void;
  reviewActions?: ReviewActionCallbacks;
  reviewsByFilePath: Map<string, Review[]>;
  /** Map of hunkId -> first-seen timestamp */
  firstSeenMap: Record<string, number>;
}

/** Quick feedback composer state */
interface ComposerState {
  prefill: string;
  hunkId: string;
}

export const ImmersiveReviewView: React.FC<ImmersiveReviewViewProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const {
    fileTree,
    hunks,
    allHunks,
    selectedHunkId,
    onSelectHunk,
    onToggleRead,
    onExit,
    onReviewNote,
  } = props;

  // Flatten file tree into ordered file list
  const fileList = useMemo(() => flattenFileTreeLeaves(fileTree), [fileTree]);

  // Determine active file from selected hunk or first file
  const activeFilePath = useMemo(() => {
    if (selectedHunkId) {
      const hunk = hunks.find((item) => item.id === selectedHunkId);
      if (hunk) return hunk.filePath;
    }
    // Fallback: first file that has hunks
    if (hunks.length > 0) return hunks[0].filePath;
    if (fileList.length > 0) return fileList[0];
    return null;
  }, [selectedHunkId, hunks, fileList]);

  // Hunks for the active file only
  const currentFileHunks = useMemo(
    () => (activeFilePath ? getFileHunks(hunks, activeFilePath) : []),
    [hunks, activeFilePath]
  );

  // Quick feedback composer
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [composerText, setComposerText] = useState("");

  // File index for display
  const fileIndex = activeFilePath ? fileList.indexOf(activeFilePath) : -1;
  const fileCount = fileList.length;

  // --- Navigation callbacks ---

  const navigateFile = useCallback(
    (direction: 1 | -1) => {
      if (!activeFilePath) return;
      const nextFile = getAdjacentFilePath(fileList, activeFilePath, direction);
      if (!nextFile || nextFile === activeFilePath) return;

      // Select first hunk in the new file
      const fileHunks = getFileHunks(hunks, nextFile);
      if (fileHunks.length > 0) {
        onSelectHunk(fileHunks[0].id);
      }
    },
    [activeFilePath, fileList, hunks, onSelectHunk]
  );

  const navigateHunk = useCallback(
    (direction: 1 | -1) => {
      if (currentFileHunks.length === 0) return;

      const currentIdx = selectedHunkId
        ? currentFileHunks.findIndex((hunk) => hunk.id === selectedHunkId)
        : -1;

      let nextIdx: number;
      if (currentIdx === -1) {
        nextIdx = direction === 1 ? 0 : currentFileHunks.length - 1;
      } else {
        nextIdx = currentIdx + direction;
        if (nextIdx < 0 || nextIdx >= currentFileHunks.length) return;
      }

      onSelectHunk(currentFileHunks[nextIdx].id);
    },
    [currentFileHunks, selectedHunkId, onSelectHunk]
  );

  // Quick feedback
  const openComposer = useCallback(
    (prefill: string) => {
      if (!selectedHunkId) return;
      setComposer({ prefill, hunkId: selectedHunkId });
      setComposerText(prefill);
    },
    [selectedHunkId]
  );

  const submitComposer = useCallback(() => {
    if (!composer || !composerText.trim()) return;

    // Use allHunks (unfiltered) so submission works even if the hunk was filtered out during editing
    const hunk = allHunks.find((item) => item.id === composer.hunkId);
    if (!hunk || !onReviewNote) return;

    const noteData = buildQuickHunkReviewNote({
      hunk,
      userNote: composerText.trim(),
    });
    onReviewNote(noteData);

    setComposer(null);
    setComposerText("");
    // Restore focus to container
    containerRef.current?.focus();
  }, [composer, composerText, allHunks, onReviewNote]);

  const cancelComposer = useCallback(() => {
    setComposer(null);
    setComposerText("");
    containerRef.current?.focus();
  }, []);

  // Focus composer when it opens
  useEffect(() => {
    if (composer) {
      composerRef.current?.focus();
      composerRef.current?.select();
    }
  }, [composer]);

  // Auto-focus container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Stable click handler for HunkViewer
  const handleHunkClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) onSelectHunk(hunkId);
    },
    [onSelectHunk]
  );

  const handleHunkToggleRead = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const hunkId = e.currentTarget.dataset.hunkId;
      if (hunkId) onToggleRead(hunkId);
    },
    [onToggleRead]
  );

  // --- Keyboard handler ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in composer or other editable elements
      if (isEditableElement(e.target)) return;

      // Esc: exit immersive
      if (matchesKeybind(e, KEYBINDS.CANCEL)) {
        e.preventDefault();
        onExit();
        return;
      }

      // J/K: prev/next file
      if (matchesKeybind(e, KEYBINDS.REVIEW_NEXT_FILE)) {
        e.preventDefault();
        navigateFile(1);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_PREV_FILE)) {
        e.preventDefault();
        navigateFile(-1);
        return;
      }

      // j/k: prev/next hunk
      if (matchesKeybind(e, KEYBINDS.REVIEW_NEXT_HUNK)) {
        e.preventDefault();
        navigateHunk(1);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_PREV_HUNK)) {
        e.preventDefault();
        navigateHunk(-1);
        return;
      }

      // L: quick like
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_LIKE)) {
        e.preventDefault();
        openComposer("I like this change");
        return;
      }

      // D: quick dislike
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_DISLIKE)) {
        e.preventDefault();
        openComposer("I don't like this change");
        return;
      }

      // Toggle hunk read
      if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_READ)) {
        e.preventDefault();
        if (selectedHunkId) onToggleRead(selectedHunkId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onExit, navigateFile, navigateHunk, openComposer, selectedHunkId, onToggleRead]);

  // Scroll selected hunk into view
  useEffect(() => {
    if (!selectedHunkId) return;
    const element = document.querySelector(
      `[data-testid="review-immersive-root"] [data-hunk-id="${selectedHunkId}"]`
    );
    // Use "auto" instead of "smooth" for keyboard nav — smooth creates queued animations during rapid j/k
    element?.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [selectedHunkId]);

  const currentHunkIdx = selectedHunkId
    ? currentFileHunks.findIndex((hunk) => hunk.id === selectedHunkId)
    : -1;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex h-full flex-col overflow-hidden outline-none"
      data-testid="immersive-review-view"
    >
      {/* Header */}
      <div className="border-border-light bg-dark flex items-center gap-2 border-b px-3 py-2">
        {/* Back button */}
        <button
          onClick={onExit}
          className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-xs transition-colors"
          aria-label="Exit immersive review"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>

        <div className="bg-border-light h-4 w-px" />

        {/* File navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigateFile(-1)}
            disabled={fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Previous file"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span
            className="text-foreground max-w-[400px] truncate font-mono text-xs"
            title={activeFilePath ?? undefined}
          >
            {activeFilePath ?? "No files"}
          </span>
          <span className="text-dim text-[10px]">
            {fileIndex >= 0 ? `${fileIndex + 1}/${fileCount}` : ""}
          </span>
          <button
            onClick={() => navigateFile(1)}
            disabled={fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Next file"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-border-light h-4 w-px" />

        {/* Hunk navigation */}
        <div className="text-muted flex items-center gap-1 text-[10px]">
          <span>
            Hunk {currentHunkIdx >= 0 ? currentHunkIdx + 1 : "–"}/{currentFileHunks.length}
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Quick feedback buttons */}
        {onReviewNote && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => openComposer("I like this change")}
              disabled={!selectedHunkId}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded border-none bg-transparent px-1.5 py-0.5 text-[11px] transition-colors",
                "text-muted hover:text-success-light disabled:text-dim disabled:cursor-default"
              )}
              aria-label="I like this change"
            >
              <ThumbsUp className="h-3 w-3" />
              <span className="hidden sm:inline">Like</span>
            </button>
            <button
              onClick={() => openComposer("I don't like this change")}
              disabled={!selectedHunkId}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded border-none bg-transparent px-1.5 py-0.5 text-[11px] transition-colors",
                "text-muted hover:text-warning-light disabled:text-dim disabled:cursor-default"
              )}
              aria-label="I don't like this change"
            >
              <ThumbsDown className="h-3 w-3" />
              <span className="hidden sm:inline">Dislike</span>
            </button>
          </div>
        )}
      </div>

      {/* Quick feedback composer */}
      {composer && (
        <div className="border-border-light bg-dark border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <div
              className="flex flex-1 overflow-hidden rounded border border-[var(--color-review-accent)]/30"
              style={{
                background: "hsl(from var(--color-review-accent) h s l / 0.08)",
              }}
            >
              <div
                className="w-[3px] shrink-0"
                style={{ background: "var(--color-review-accent)" }}
              />
              <textarea
                ref={composerRef}
                className="text-primary placeholder:text-muted/70 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[12px] leading-[1.5] focus:outline-none"
                style={{ minHeight: "calc(12px * 1.5 + 12px)" }}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  stopKeyboardPropagation(e);
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitComposer();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelComposer();
                  }
                }}
                placeholder="Add your note... (Enter to submit, Esc to cancel)"
              />
            </div>
            <button
              type="button"
              onClick={submitComposer}
              className="text-muted hover:text-primary shrink-0 cursor-pointer border-none bg-transparent px-1 text-xs"
              aria-label="Submit review note"
            >
              ↵
            </button>
          </div>
        </div>
      )}

      {/* Hunks list */}
      <div className="flex-1 overflow-y-auto p-3">
        {currentFileHunks.length === 0 ? (
          <div className="text-muted flex items-center justify-center py-12 text-sm">
            {activeFilePath ? "No hunks for this file" : "No files to review"}
          </div>
        ) : (
          currentFileHunks.map((hunk) => (
            <HunkViewer
              key={hunk.id}
              hunk={hunk}
              hunkId={hunk.id}
              workspaceId={props.workspaceId}
              inlineReviews={props.reviewsByFilePath.get(hunk.filePath)}
              isSelected={hunk.id === selectedHunkId}
              isRead={props.isRead(hunk.id)}
              firstSeenAt={props.firstSeenMap[hunk.id] ?? Date.now()}
              onClick={handleHunkClick}
              onToggleRead={handleHunkToggleRead}
              onReviewNote={onReviewNote}
              diffBase="HEAD"
              includeUncommitted={false}
              reviewActions={props.reviewActions}
            />
          ))
        )}
      </div>

      {/* Shortcut bar */}
      <div className="border-border-light bg-dark flex flex-wrap items-center justify-center gap-3 border-t px-3 py-1.5">
        <KeycapGroup keys={["Esc"]} label="back" />
        <KeycapGroup keys={["J", "K"]} label="file" />
        <KeycapGroup keys={["j", "k"]} label="hunk" />
        <KeycapGroup keys={["m"]} label="read" />
        <KeycapGroup keys={["Shift", "l"]} label="like" />
        <KeycapGroup keys={["Shift", "d"]} label="dislike" />
        {composer && <KeycapGroup keys={["Enter"]} label="submit" />}
      </div>
    </div>
  );
};
