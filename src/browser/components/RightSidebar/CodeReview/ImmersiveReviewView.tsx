/**
 * ImmersiveReviewView — Full-screen, keyboard-first code review mode.
 * Rendered via portal into #review-immersive-root overlay.
 * Shows one file at a time with keyboard navigation for files, hunks, and lines.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Circle } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SelectableDiffRenderer } from "../../shared/DiffRenderer";
import { KeycapGroup } from "@/browser/components/ui/Keycap";
import { useAPI } from "@/browser/contexts/API";
import {
  flattenFileTreeLeaves,
  getAdjacentFilePath,
  getFileHunks,
} from "@/browser/utils/review/navigation";
import { isEditableElement, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { buildReadFileScript, processFileContents } from "@/browser/utils/fileExplorer";
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

interface InlineComposerRequest {
  requestId: number;
  prefill: string;
  hunkId: string;
  startIndex: number;
  endIndex: number;
}

interface SelectedLineRange {
  startIndex: number;
  endIndex: number;
}

interface HunkLineRange {
  startIndex: number;
  endIndex: number;
  firstModifiedIndex: number | null;
}

interface ImmersiveOverlayData {
  content: string;
  lineHunkIds: Array<string | null>;
  hunkLineRanges: Map<string, HunkLineRange>;
}

const LINE_JUMP_SIZE = 10;

function splitDiffLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function normalizeFileLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.filter((line, idx) => idx < lines.length - 1 || line !== "");
}

function sortHunksInFileOrder(hunks: DiffHunk[]): DiffHunk[] {
  return [...hunks].sort((a, b) => {
    const newStartDelta = a.newStart - b.newStart;
    if (newStartDelta !== 0) {
      return newStartDelta;
    }

    const oldStartDelta = a.oldStart - b.oldStart;
    if (oldStartDelta !== 0) {
      return oldStartDelta;
    }

    return a.id.localeCompare(b.id);
  });
}

function buildOverlayFromFileContent(
  fileContent: string,
  sortedHunks: DiffHunk[]
): ImmersiveOverlayData {
  const fileLines = normalizeFileLines(fileContent);
  const contentLines: string[] = [];
  const lineHunkIds: Array<string | null> = [];
  const hunkLineRanges = new Map<string, HunkLineRange>();

  let newLineIdx = 0;

  const pushDisplayLine = (line: string, hunkId: string | null) => {
    contentLines.push(line);
    lineHunkIds.push(hunkId);
  };

  for (const hunk of sortedHunks) {
    const hunkStartInNew = Math.max(0, hunk.newStart - 1);

    while (newLineIdx < hunkStartInNew && newLineIdx < fileLines.length) {
      pushDisplayLine(` ${fileLines[newLineIdx]}`, null);
      newLineIdx += 1;
    }

    const hunkStartIndex = lineHunkIds.length;
    let firstModifiedIndex: number | null = null;

    for (const line of splitDiffLines(hunk.content)) {
      const prefix = line[0] ?? " ";
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
        continue;
      }

      if (firstModifiedIndex === null && (prefix === "+" || prefix === "-")) {
        firstModifiedIndex = lineHunkIds.length;
      }

      pushDisplayLine(`${prefix}${line.slice(1)}`, hunk.id);
      if (prefix !== "-") {
        newLineIdx += 1;
      }
    }

    if (lineHunkIds.length > hunkStartIndex) {
      hunkLineRanges.set(hunk.id, {
        startIndex: hunkStartIndex,
        endIndex: lineHunkIds.length - 1,
        firstModifiedIndex,
      });
    }
  }

  while (newLineIdx < fileLines.length) {
    pushDisplayLine(` ${fileLines[newLineIdx]}`, null);
    newLineIdx += 1;
  }

  return {
    content: contentLines.join("\n"),
    lineHunkIds,
    hunkLineRanges,
  };
}

function buildOverlayFromHunks(sortedHunks: DiffHunk[]): ImmersiveOverlayData {
  const contentLines: string[] = [];
  const lineHunkIds: Array<string | null> = [];
  const hunkLineRanges = new Map<string, HunkLineRange>();

  const pushDisplayLine = (line: string, hunkId: string | null) => {
    contentLines.push(line);
    lineHunkIds.push(hunkId);
  };

  const pushHeaderLine = (line: string) => {
    contentLines.push(line);
  };

  sortedHunks.forEach((hunk, index) => {
    if (index > 0) {
      pushDisplayLine(" ", null);
    }

    pushHeaderLine(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

    const hunkStartIndex = lineHunkIds.length;
    let firstModifiedIndex: number | null = null;

    for (const line of splitDiffLines(hunk.content)) {
      const prefix = line[0] ?? " ";
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
        continue;
      }

      if (firstModifiedIndex === null && (prefix === "+" || prefix === "-")) {
        firstModifiedIndex = lineHunkIds.length;
      }

      pushDisplayLine(`${prefix}${line.slice(1)}`, hunk.id);
    }

    if (lineHunkIds.length > hunkStartIndex) {
      hunkLineRanges.set(hunk.id, {
        startIndex: hunkStartIndex,
        endIndex: lineHunkIds.length - 1,
        firstModifiedIndex,
      });
    }
  });

  return {
    content: contentLines.join("\n"),
    lineHunkIds,
    hunkLineRanges,
  };
}

function isSelectionInsideRange(selection: SelectedLineRange, range: HunkLineRange): boolean {
  const start = Math.min(selection.startIndex, selection.endIndex);
  const end = Math.max(selection.startIndex, selection.endIndex);
  return start >= range.startIndex && end <= range.endIndex;
}

export const ImmersiveReviewView: React.FC<ImmersiveReviewViewProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hunkJumpRef = useRef(false);
  const { api } = useAPI();

  const { fileTree, hunks, selectedHunkId, onSelectHunk, onToggleRead, onExit, onReviewNote } =
    props;

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

  // Hunks for the active file only, always sorted in file order
  const currentFileHunks = useMemo(
    () => (activeFilePath ? sortHunksInFileOrder(getFileHunks(hunks, activeFilePath)) : []),
    [hunks, activeFilePath]
  );

  const selectedHunk = useMemo(() => {
    if (selectedHunkId) {
      const matchingHunk = currentFileHunks.find((hunk) => hunk.id === selectedHunkId);
      if (matchingHunk) {
        return matchingHunk;
      }
    }

    return currentFileHunks[0] ?? null;
  }, [selectedHunkId, currentFileHunks]);

  // Ensure we always have a selected hunk when the active file has hunks.
  useEffect(() => {
    if (currentFileHunks.length === 0) {
      return;
    }

    if (!selectedHunkId || !currentFileHunks.some((hunk) => hunk.id === selectedHunkId)) {
      onSelectHunk(currentFileHunks[0].id);
    }
  }, [currentFileHunks, selectedHunkId, onSelectHunk]);

  const [activeFileContent, setActiveFileContent] = useState<string | null>(null);

  // Load full file content so immersive mode can render one coherent file with hunk overlays.
  useEffect(() => {
    const apiClient = api;
    const filePath = activeFilePath;

    if (!filePath || !apiClient) {
      setActiveFileContent(null);
      return;
    }

    const resolvedApi: NonNullable<typeof api> = apiClient;
    const resolvedFilePath: string = filePath;

    let cancelled = false;
    setActiveFileContent(null);

    async function loadActiveFileContent() {
      try {
        const fileResult = await resolvedApi.workspace.executeBash({
          workspaceId: props.workspaceId,
          script: buildReadFileScript(resolvedFilePath),
        });

        if (cancelled) {
          return;
        }

        if (!fileResult.success) {
          setActiveFileContent(null);
          return;
        }

        const bashResult = fileResult.data;

        if (!bashResult.success && !bashResult.output) {
          setActiveFileContent(null);
          return;
        }

        const data = processFileContents(bashResult.output ?? "", bashResult.exitCode);
        setActiveFileContent(data.type === "text" ? data.content : null);
      } catch {
        if (!cancelled) {
          setActiveFileContent(null);
        }
      }
    }

    void loadActiveFileContent();

    return () => {
      cancelled = true;
    };
  }, [api, props.workspaceId, activeFilePath]);

  const overlayData = useMemo<ImmersiveOverlayData>(() => {
    if (currentFileHunks.length === 0) {
      return {
        content: "",
        lineHunkIds: [],
        hunkLineRanges: new Map<string, HunkLineRange>(),
      };
    }

    if (activeFileContent != null) {
      return buildOverlayFromFileContent(activeFileContent, currentFileHunks);
    }

    return buildOverlayFromHunks(currentFileHunks);
  }, [activeFileContent, currentFileHunks]);

  const selectedHunkRange = useMemo(
    () => (selectedHunk ? (overlayData.hunkLineRanges.get(selectedHunk.id) ?? null) : null),
    [selectedHunk, overlayData]
  );

  const selectedHunkLineCount = selectedHunkRange
    ? selectedHunkRange.endIndex - selectedHunkRange.startIndex + 1
    : 0;

  const [inlineComposerRequest, setInlineComposerRequest] = useState<InlineComposerRequest | null>(
    null
  );
  const nextComposerRequestIdRef = useRef(0);

  // Keyboard line cursor state within the whole rendered file.
  const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  // Keep cursor and selection aligned to the selected hunk when hunk navigation changes.
  useEffect(() => {
    if (!selectedHunkRange) {
      setActiveLineIndex(null);
      setSelectedLineRange(null);
      return;
    }

    setActiveLineIndex((previousLineIndex) => {
      if (
        previousLineIndex !== null &&
        previousLineIndex >= selectedHunkRange.startIndex &&
        previousLineIndex <= selectedHunkRange.endIndex
      ) {
        return previousLineIndex;
      }
      return selectedHunkRange.firstModifiedIndex ?? selectedHunkRange.startIndex;
    });

    setSelectedLineRange((previousSelection) => {
      if (!previousSelection) {
        return null;
      }

      if (isSelectionInsideRange(previousSelection, selectedHunkRange)) {
        return previousSelection;
      }

      return null;
    });
  }, [
    selectedHunk?.id,
    selectedHunkRange?.startIndex,
    selectedHunkRange?.endIndex,
    selectedHunkRange,
  ]);

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
      const fileHunks = sortHunksInFileOrder(getFileHunks(hunks, nextFile));
      if (fileHunks.length > 0) {
        hunkJumpRef.current = true;
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

      hunkJumpRef.current = true;
      onSelectHunk(currentFileHunks[nextIdx].id);
    },
    [currentFileHunks, selectedHunkId, onSelectHunk]
  );

  const getCurrentLineSelection = useCallback((): SelectedLineRange | null => {
    if (activeLineIndex === null) {
      return null;
    }

    if (!selectedLineRange) {
      return { startIndex: activeLineIndex, endIndex: activeLineIndex };
    }

    return {
      startIndex: Math.min(selectedLineRange.startIndex, selectedLineRange.endIndex),
      endIndex: Math.max(selectedLineRange.startIndex, selectedLineRange.endIndex),
    };
  }, [activeLineIndex, selectedLineRange]);

  const selectedLineSummary = getCurrentLineSelection();

  const openComposer = useCallback(
    (prefill: string) => {
      if (!selectedHunk || !selectedHunkRange) {
        return;
      }

      const selection = getCurrentLineSelection();
      const effectiveSelection =
        selection && isSelectionInsideRange(selection, selectedHunkRange)
          ? selection
          : {
              startIndex: selectedHunkRange.startIndex,
              endIndex: selectedHunkRange.startIndex,
            };

      nextComposerRequestIdRef.current += 1;
      setInlineComposerRequest({
        requestId: nextComposerRequestIdRef.current,
        prefill,
        hunkId: selectedHunk.id,
        startIndex: effectiveSelection.startIndex,
        endIndex: effectiveSelection.endIndex,
      });
    },
    [getCurrentLineSelection, selectedHunk, selectedHunkRange]
  );

  const moveLineCursor = useCallback(
    (delta: number, extendRange: boolean) => {
      const lineCount = overlayData.lineHunkIds.length;
      if (lineCount === 0) {
        return;
      }

      const currentIndex = activeLineIndex ?? selectedHunkRange?.startIndex ?? 0;
      const nextIndex = Math.max(0, Math.min(lineCount - 1, currentIndex + delta));

      setActiveLineIndex(nextIndex);

      if (extendRange) {
        const anchorIndex = selectedLineRange?.startIndex ?? currentIndex;
        setSelectedLineRange({ startIndex: anchorIndex, endIndex: nextIndex });
      } else {
        setSelectedLineRange(null);
      }

      const lineHunkId = overlayData.lineHunkIds[nextIndex];
      if (lineHunkId && lineHunkId !== selectedHunkId) {
        onSelectHunk(lineHunkId);
      }
    },
    [
      overlayData.lineHunkIds,
      activeLineIndex,
      selectedHunkRange?.startIndex,
      selectedLineRange,
      selectedHunkId,
      onSelectHunk,
    ]
  );

  const handleLineIndexSelect = useCallback(
    (lineIndex: number, shiftKey: boolean) => {
      const lineHunkId = overlayData.lineHunkIds[lineIndex];
      if (lineHunkId && selectedHunkId !== lineHunkId) {
        onSelectHunk(lineHunkId);
      }

      const anchorIndex = shiftKey
        ? (selectedLineRange?.startIndex ?? activeLineIndex ?? lineIndex)
        : lineIndex;
      setActiveLineIndex(lineIndex);

      if (shiftKey) {
        setSelectedLineRange({ startIndex: anchorIndex, endIndex: lineIndex });
      } else {
        setSelectedLineRange(null);
      }
    },
    [overlayData.lineHunkIds, selectedHunkId, onSelectHunk, selectedLineRange, activeLineIndex]
  );

  // Auto-focus container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // --- Keyboard handler ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing in editable elements
      if (isEditableElement(e.target)) return;

      // Esc: exit immersive
      if (matchesKeybind(e, KEYBINDS.CANCEL)) {
        e.preventDefault();
        onExit();
        return;
      }

      // n/p: next/prev file
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

      // k/j: next/prev hunk
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

      // Arrow line cursor controls
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_JUMP_DOWN)) {
        e.preventDefault();
        moveLineCursor(LINE_JUMP_SIZE, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_JUMP_UP)) {
        e.preventDefault();
        moveLineCursor(-LINE_JUMP_SIZE, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_DOWN)) {
        e.preventDefault();
        moveLineCursor(1, e.shiftKey);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.REVIEW_CURSOR_UP)) {
        e.preventDefault();
        moveLineCursor(-1, e.shiftKey);
        return;
      }

      // Shift+L: add comment
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_LIKE)) {
        e.preventDefault();
        openComposer("");
        return;
      }

      // Shift+D: quick dislike
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
  }, [
    onExit,
    navigateFile,
    navigateHunk,
    moveLineCursor,
    openComposer,
    selectedHunkId,
    onToggleRead,
  ]);

  // Keep the active line visible while moving with keyboard shortcuts.
  useEffect(() => {
    if (activeLineIndex === null) {
      return;
    }

    const lineElement = document.querySelector(
      `[data-testid="review-immersive-root"] [data-line-index="${activeLineIndex}"]`
    );

    const block = hunkJumpRef.current ? "center" : "nearest";
    hunkJumpRef.current = false;

    lineElement?.scrollIntoView({ behavior: "auto", block });
  }, [activeLineIndex]);

  const currentHunkIdx = selectedHunkId
    ? currentFileHunks.findIndex((hunk) => hunk.id === selectedHunkId)
    : -1;

  const selectedLineSummaryLabel = useMemo(() => {
    if (!selectedLineSummary) {
      return "–";
    }

    if (!selectedHunkRange || !isSelectionInsideRange(selectedLineSummary, selectedHunkRange)) {
      return `${selectedLineSummary.startIndex + 1}-${selectedLineSummary.endIndex + 1}`;
    }

    const relativeStart = selectedLineSummary.startIndex - selectedHunkRange.startIndex + 1;
    const relativeEnd = selectedLineSummary.endIndex - selectedHunkRange.startIndex + 1;
    return `${relativeStart}-${relativeEnd}`;
  }, [selectedLineSummary, selectedHunkRange]);

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

        {/* Hunk and line selection summary */}
        <div className="text-muted flex items-center gap-1 text-[10px]">
          {selectedHunk && (
            <button
              type="button"
              className={cn(
                "text-muted hover:text-read flex cursor-pointer items-center border-none bg-transparent p-0 transition-colors duration-150",
                props.isRead(selectedHunk.id) && "text-read"
              )}
              onClick={() => onToggleRead(selectedHunk.id)}
              aria-label={
                props.isRead(selectedHunk.id) ? "Mark hunk as unread" : "Mark hunk as read"
              }
            >
              {props.isRead(selectedHunk.id) ? (
                <Check aria-hidden="true" className="h-3 w-3" />
              ) : (
                <Circle aria-hidden="true" className="h-3 w-3" />
              )}
            </button>
          )}
          <span>
            Hunk {currentHunkIdx >= 0 ? currentHunkIdx + 1 : "–"}/{currentFileHunks.length}
          </span>
          <span className="text-dim">·</span>
          <span>Lines {selectedLineSummaryLabel}</span>
          {selectedHunkLineCount > 0 && (
            <>
              <span className="text-dim">·</span>
              <span>{selectedHunkLineCount} lines</span>
            </>
          )}
        </div>
      </div>

      {/* Unified whole-file diff with hunk overlays */}
      <div className="flex-1 overflow-y-auto p-3">
        {currentFileHunks.length === 0 ? (
          <div className="text-muted flex items-center justify-center py-12 text-sm">
            {activeFilePath ? "No hunks for this file" : "No files to review"}
          </div>
        ) : (
          <div className="border-border-light bg-dark overflow-hidden rounded border">
            <SelectableDiffRenderer
              content={overlayData.content}
              filePath={activeFilePath ?? currentFileHunks[0].filePath}
              inlineReviews={
                activeFilePath ? props.reviewsByFilePath.get(activeFilePath) : undefined
              }
              oldStart={1}
              newStart={1}
              fontSize="11px"
              maxHeight="none"
              className="rounded-none border-0 [&>div]:overflow-x-visible"
              onReviewNote={onReviewNote}
              reviewActions={props.reviewActions}
              activeLineIndex={activeLineIndex}
              selectedLineRange={selectedLineRange}
              onLineIndexSelect={handleLineIndexSelect}
              externalSelectionRequest={
                inlineComposerRequest?.hunkId != null &&
                inlineComposerRequest.hunkId === selectedHunk?.id
                  ? {
                      requestId: inlineComposerRequest.requestId,
                      selection: {
                        startIndex: inlineComposerRequest.startIndex,
                        endIndex: inlineComposerRequest.endIndex,
                      },
                      initialNoteText: inlineComposerRequest.prefill,
                    }
                  : null
              }
            />
          </div>
        )}
      </div>

      {/* Shortcut bar */}
      <div className="border-border-light bg-dark flex flex-wrap items-center justify-center gap-3 border-t px-3 py-1.5">
        <KeycapGroup keys={["Esc"]} label="back" />
        <KeycapGroup keys={["n", "p"]} label="file" />
        <KeycapGroup keys={["k", "j"]} label="hunk" />
        <KeycapGroup keys={["↑", "↓"]} label="line" />
        <KeycapGroup keys={["Shift", "↑", "↓"]} label="select" />
        <KeycapGroup keys={["Ctrl", "↑", "↓"]} label="jump 10" />
        <KeycapGroup keys={["m"]} label="read" />
        <KeycapGroup keys={["Shift", "l"]} label="comment" />
        <KeycapGroup keys={["Shift", "d"]} label="dislike" />
        <KeycapGroup keys={["Enter"]} label="submit" />
      </div>
    </div>
  );
};
