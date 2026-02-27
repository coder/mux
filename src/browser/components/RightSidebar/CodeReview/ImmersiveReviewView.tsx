/**
 * ImmersiveReviewView — Full-screen, keyboard-first code review mode.
 * Rendered via portal into #review-immersive-root overlay.
 * Shows one file at a time with keyboard navigation for files, hunks, and lines.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  MessageSquare,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { cn } from "@/common/lib/utils";
import { SelectableDiffRenderer } from "../../shared/DiffRenderer";
import { ImmersiveMinimap } from "./ImmersiveMinimap";
import { buildNewLineNumberToIndexMap, buildOldLineNumberToIndexMap } from "./immersiveMinimapMath";
import { KeycapGroup } from "@/browser/components/Keycap/Keycap";
import { useAPI } from "@/browser/contexts/API";
import { formatLineRangeCompact } from "@/browser/utils/review/lineRange";
import {
  flattenFileTreeLeaves,
  getAdjacentFilePath,
  getFileHunks,
} from "@/browser/utils/review/navigation";
import {
  isDialogOpen,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { buildReadFileScript, processFileContents } from "@/browser/utils/fileExplorer";
import {
  parseReviewLineRange,
  type DiffHunk,
  type Review,
  type ReviewNoteData,
} from "@/common/types/review";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { ReviewActionCallbacks } from "../../shared/InlineReviewNote";

interface ImmersiveReviewViewProps {
  workspaceId: string;
  fileTree: FileTreeNode | null;
  /** Filtered hunks (respects current filters) */
  hunks: DiffHunk[];
  /** All hunks (unfiltered, for context) */
  allHunks: DiffHunk[];
  /** True while diff/tree payload for this workspace is still loading. */
  isLoading?: boolean;
  isRead: (hunkId: string) => boolean;
  onToggleRead: (hunkId: string) => void;
  selectedHunkId: string | null;
  onSelectHunk: (hunkId: string | null) => void;
  /** Whether immersive review should use touch/mobile UX affordances. */
  isTouchImmersive?: boolean;
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
  /** Absolute overlay indices so composer placement stays locked to marked rows. */
  startIndex: number;
  endIndex: number;
  /** Absolute overlay index for composer placement (cursor position). */
  cursorIndex: number;
}

interface InlineReviewEditRequest {
  requestId: number;
  reviewId: string;
}

interface SelectedLineRange {
  startIndex: number;
  endIndex: number;
}

interface PendingComposerHunkSwitch {
  fromHunkId: string | null;
  toHunkId: string;
}

interface HunkLineRange {
  startIndex: number;
  endIndex: number;
  firstModifiedIndex: number | null;
  lastModifiedIndex: number | null;
}

interface ImmersiveOverlayData {
  content: string;
  lineHunkIds: Array<string | null>;
  hunkLineRanges: Map<string, HunkLineRange>;
}

const LINE_JUMP_SIZE = 10;
// Keep syntax highlighting on for larger review files now that per-line tooltip overhead is gone,
// but still cap it to avoid pathological DOM costs on extremely large diffs.
const MAX_HIGHLIGHTED_DIFF_LINES = 4000;
const ACTIVE_LINE_OUTLINE = "1px solid hsl(from var(--color-review-accent) h s l / 0.45)";
const LIKE_NOTE_PREFIX = "I like this change";
const DISLIKE_NOTE_PREFIX = "I don't like this change";

function getFileBaseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

function getReviewStatusSidebarClasses(status: Review["status"]): {
  accent: string;
  badge: string;
  icon: string;
} {
  if (status === "checked") {
    return {
      accent: "bg-success",
      badge: "bg-success/20 text-success",
      icon: "text-success",
    };
  }

  if (status === "attached") {
    return {
      accent: "bg-warning",
      badge: "bg-warning/20 text-warning",
      icon: "text-warning",
    };
  }

  return {
    accent: "bg-muted",
    badge: "bg-muted/25 text-muted",
    icon: "text-muted",
  };
}

function splitDiffLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function normalizeFileLines(content: string): string[] {
  // Normalize Windows CRLF to LF-equivalent lines so rows stay single-height in
  // whitespace-preserving diff cells (embedded "\r" can render as extra breaks).
  const lines = content
    .split(/\r?\n/)
    .map((line) => (line.endsWith("\r") ? line.slice(0, Math.max(0, line.length - 1)) : line));
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
    let lastModifiedIndex: number | null = null;

    for (const line of splitDiffLines(hunk.content)) {
      const prefix = line[0] ?? " ";
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
        continue;
      }

      if (prefix === "+" || prefix === "-") {
        firstModifiedIndex ??= lineHunkIds.length;
        lastModifiedIndex = lineHunkIds.length;
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
        lastModifiedIndex,
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
    // Header rows are intentionally excluded from lineHunkIds because DiffRenderer
    // does not render @@ header lines in selectable output.
    contentLines.push(line);
  };

  sortedHunks.forEach((hunk, index) => {
    if (index > 0) {
      pushDisplayLine(" ", null);
    }

    pushHeaderLine(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

    const hunkStartIndex = lineHunkIds.length;
    let firstModifiedIndex: number | null = null;
    let lastModifiedIndex: number | null = null;

    for (const line of splitDiffLines(hunk.content)) {
      const prefix = line[0] ?? " ";
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
        continue;
      }

      if (prefix === "+" || prefix === "-") {
        firstModifiedIndex ??= lineHunkIds.length;
        lastModifiedIndex = lineHunkIds.length;
      }

      pushDisplayLine(`${prefix}${line.slice(1)}`, hunk.id);
    }

    if (lineHunkIds.length > hunkStartIndex) {
      hunkLineRanges.set(hunk.id, {
        startIndex: hunkStartIndex,
        endIndex: lineHunkIds.length - 1,
        firstModifiedIndex,
        lastModifiedIndex,
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

function isLineInsideSelection(lineIndex: number, selection: SelectedLineRange): boolean {
  const start = Math.min(selection.startIndex, selection.endIndex);
  const end = Math.max(selection.startIndex, selection.endIndex);
  return lineIndex >= start && lineIndex <= end;
}

/** Resolve the hunk that contains a given overlay line index using the lineHunkIds lookup. */
function findHunkAtLine(
  lineIndex: number,
  overlayData: ImmersiveOverlayData,
  fileHunks: DiffHunk[]
): { hunk: DiffHunk; range: HunkLineRange } | null {
  const hunkId = overlayData.lineHunkIds[lineIndex];
  if (!hunkId) {
    return null;
  }
  const hunk = fileHunks.find((h) => h.id === hunkId);
  const range = overlayData.hunkLineRanges.get(hunkId);
  if (!hunk || !range) {
    return null;
  }
  return { hunk, range };
}

function getLineSpan(start: number, lineCount: number): { start: number; end: number } | null {
  if (lineCount <= 0) {
    return null;
  }

  return {
    start,
    end: start + lineCount - 1,
  };
}

function rangesOverlap(
  lhs: { start: number; end: number } | undefined,
  rhs: { start: number; end: number } | null
): boolean {
  if (!lhs || !rhs) {
    return false;
  }

  return lhs.start <= rhs.end && rhs.start <= lhs.end;
}

function findReviewHunkId(review: Review, fileHunks: DiffHunk[]): string | null {
  const parsedRange = parseReviewLineRange(review.data.lineRange);
  if (!parsedRange) {
    return null;
  }

  const matchingHunk = fileHunks.find((hunk) => {
    const oldSpan = getLineSpan(hunk.oldStart, hunk.oldLines);
    const newSpan = getLineSpan(hunk.newStart, hunk.newLines);

    return rangesOverlap(parsedRange.old, oldSpan) || rangesOverlap(parsedRange.new, newSpan);
  });

  return matchingHunk?.id ?? null;
}

export const ImmersiveReviewView: React.FC<ImmersiveReviewViewProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const notesSidebarRef = useRef<HTMLDivElement>(null);
  const hunkJumpRef = useRef(false);
  const pendingJumpSelectAllHunkIdRef = useRef<string | null>(null);
  const { api } = useAPI();

  const {
    fileTree,
    hunks,
    allHunks,
    selectedHunkId,
    onSelectHunk,
    onToggleRead,
    onExit,
    onReviewNote,
    isTouchImmersive,
  } = props;
  const isTouchExperience = isTouchImmersive === true;

  // Flatten file tree into ordered file list
  const fileList = useMemo(() => flattenFileTreeLeaves(fileTree), [fileTree]);

  // Determine active file from selected hunk or first file
  const activeFilePath = useMemo(() => {
    if (selectedHunkId) {
      const selectedHunk =
        hunks.find((item) => item.id === selectedHunkId) ??
        allHunks.find((item) => item.id === selectedHunkId);
      if (selectedHunk) {
        return selectedHunk.filePath;
      }
    }

    // Fallback: first file that has currently visible hunks.
    if (hunks.length > 0) {
      return hunks[0].filePath;
    }

    if (fileList.length > 0) {
      return fileList[0];
    }

    return null;
  }, [selectedHunkId, hunks, allHunks, fileList]);

  const selectedHunkFromAll = useMemo(
    () => (selectedHunkId ? (allHunks.find((item) => item.id === selectedHunkId) ?? null) : null),
    [selectedHunkId, allHunks]
  );

  const selectedHunkIsFilteredOut = Boolean(
    selectedHunkFromAll && !hunks.some((item) => item.id === selectedHunkFromAll.id)
  );

  const activeFileHunks = selectedHunkIsFilteredOut ? allHunks : hunks;

  // Hunks for the active file only, always sorted in file order.
  // When the selected hunk is filtered out, keep using unfiltered hunks so
  // note-driven navigation can still land on the review context.
  const currentFileHunks = useMemo(
    () =>
      activeFilePath ? sortHunksInFileOrder(getFileHunks(activeFileHunks, activeFilePath)) : [],
    [activeFileHunks, activeFilePath]
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
      pendingJumpSelectAllHunkIdRef.current = null;
      onSelectHunk(currentFileHunks[0].id);
    }
  }, [currentFileHunks, selectedHunkId, onSelectHunk]);

  const [activeFileContentState, setActiveFileContentState] = useState<{
    filePath: string | null;
    content: string | null;
    isSettled: boolean;
  }>({
    filePath: null,
    content: null,
    isSettled: true,
  });

  // Hold diff reveal during file switches until loading + initial scroll are complete.
  const [pendingRevealFilePath, setPendingRevealFilePath] = useState<string | null>(null);
  const revealAnimationFrameRef = useRef<number | null>(null);

  // Load full file content so immersive mode can render one coherent file with hunk overlays.
  // Keep a per-file loading state so switches can show a splash until loading settles,
  // which avoids a visible fallback-overlay -> full-content jump.
  useEffect(() => {
    const apiClient = api;
    const filePath = activeFilePath;

    if (!filePath || !apiClient) {
      setActiveFileContentState({
        filePath: filePath ?? null,
        content: null,
        isSettled: true,
      });
      return;
    }

    const resolvedApi: NonNullable<typeof api> = apiClient;
    const resolvedFilePath: string = filePath;

    let cancelled = false;
    setActiveFileContentState({
      filePath: resolvedFilePath,
      content: null,
      isSettled: false,
    });

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
          setActiveFileContentState({
            filePath: resolvedFilePath,
            content: null,
            isSettled: true,
          });
          return;
        }

        const bashResult = fileResult.data;

        if (!bashResult.success && !bashResult.output) {
          setActiveFileContentState({
            filePath: resolvedFilePath,
            content: null,
            isSettled: true,
          });
          return;
        }

        const data = processFileContents(bashResult.output ?? "", bashResult.exitCode);
        setActiveFileContentState({
          filePath: resolvedFilePath,
          content: data.type === "text" ? data.content : null,
          isSettled: true,
        });
      } catch {
        if (!cancelled) {
          setActiveFileContentState({
            filePath: resolvedFilePath,
            content: null,
            isSettled: true,
          });
        }
      }
    }

    void loadActiveFileContent();

    return () => {
      cancelled = true;
    };
  }, [api, props.workspaceId, activeFilePath]);

  const isActiveFileContentSettled =
    !activeFilePath ||
    (activeFileContentState.filePath === activeFilePath && activeFileContentState.isSettled);

  const resolvedActiveFileContent = isActiveFileContentSettled
    ? activeFileContentState.content
    : null;

  const isActiveFileContentLoading = Boolean(
    activeFilePath && currentFileHunks.length > 0 && !isActiveFileContentSettled
  );

  const overlayData = useMemo<ImmersiveOverlayData>(() => {
    if (currentFileHunks.length === 0) {
      return {
        content: "",
        lineHunkIds: [],
        hunkLineRanges: new Map<string, HunkLineRange>(),
      };
    }

    if (resolvedActiveFileContent != null) {
      return buildOverlayFromFileContent(resolvedActiveFileContent, currentFileHunks);
    }

    return buildOverlayFromHunks(currentFileHunks);
  }, [resolvedActiveFileContent, currentFileHunks]);

  const selectedHunkRange = useMemo(
    () => (selectedHunk ? (overlayData.hunkLineRanges.get(selectedHunk.id) ?? null) : null),
    [selectedHunk, overlayData]
  );

  const selectedHunkLineCount = selectedHunkRange
    ? selectedHunkRange.endIndex - selectedHunkRange.startIndex + 1
    : 0;

  const allReviews = useMemo(
    () =>
      Array.from(props.reviewsByFilePath.values())
        .flat()
        .sort((a, b) => {
          const createdAtDelta = b.createdAt - a.createdAt;
          if (createdAtDelta !== 0) {
            return createdAtDelta;
          }

          return a.id.localeCompare(b.id);
        }),
    [props.reviewsByFilePath]
  );

  // Map review line ranges → diff line indices for minimap comment indicators
  const commentLineIndices: ReadonlySet<number> = (() => {
    if (!activeFilePath || overlayData.content.length === 0) return new Set<number>();
    const reviews = props.reviewsByFilePath.get(activeFilePath);
    if (!reviews || reviews.length === 0) return new Set<number>();

    const newLineMap = buildNewLineNumberToIndexMap(overlayData.content);
    let oldLineMap: Map<number, number> | null = null;
    const indices = new Set<number>();
    for (const review of reviews) {
      const parsed = parseReviewLineRange(review.data.lineRange);
      if (!parsed) continue;

      let lineMap: Map<number, number>;
      let range: { start: number; end: number } | undefined;

      if (parsed.new) {
        lineMap = newLineMap;
        range = parsed.new;
      } else if (parsed.old) {
        oldLineMap ??= buildOldLineNumberToIndexMap(overlayData.content);
        lineMap = oldLineMap;
        range = parsed.old;
      } else {
        continue;
      }

      for (let ln = range.start; ln <= range.end; ln++) {
        const idx = lineMap.get(ln);
        if (idx != null) indices.add(idx);
      }
    }
    return indices;
  })();

  const [inlineComposerRequest, setInlineComposerRequest] = useState<InlineComposerRequest | null>(
    null
  );
  const [inlineReviewEditRequest, setInlineReviewEditRequest] =
    useState<InlineReviewEditRequest | null>(null);
  const nextComposerRequestIdRef = useRef(0);
  const nextInlineReviewEditRequestIdRef = useRef(0);
  const pendingComposerHunkSwitchRef = useRef<PendingComposerHunkSwitch | null>(null);

  // Keyboard line cursor state within the whole rendered file.
  const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [boundaryToast, setBoundaryToast] = useState<string | null>(null);

  // Which panel has keyboard focus while in immersive mode.
  const [focusedPanel, setFocusedPanel] = useState<"diff" | "notes">("diff");
  const [focusedNoteIndex, setFocusedNoteIndex] = useState(0);

  useEffect(() => {
    if (revealAnimationFrameRef.current !== null) {
      cancelAnimationFrame(revealAnimationFrameRef.current);
      revealAnimationFrameRef.current = null;
    }

    if (!activeFilePath) {
      setPendingRevealFilePath(null);
      return;
    }

    // Keep the splash visible for each file switch until we have scrolled to the target hunk.
    setPendingRevealFilePath(activeFilePath);
    hunkJumpRef.current = true;
  }, [activeFilePath]);

  useEffect(() => {
    return () => {
      if (revealAnimationFrameRef.current !== null) {
        cancelAnimationFrame(revealAnimationFrameRef.current);
      }
    };
  }, []);

  const selectedHunkRevealTargetLineIndex =
    selectedHunkRange?.firstModifiedIndex ?? selectedHunkRange?.startIndex ?? null;
  const isActiveFileRevealPending = pendingRevealFilePath === activeFilePath;
  const revealTargetLineIndex = isActiveFileRevealPending
    ? selectedHunkRevealTargetLineIndex
    : (activeLineIndex ?? selectedHunkRevealTargetLineIndex);
  const hasResolvedSelectedHunkForReveal =
    selectedHunkId !== null && currentFileHunks.some((hunk) => hunk.id === selectedHunkId);

  useEffect(() => {
    if (!isActiveFileRevealPending || !isActiveFileContentSettled) {
      return;
    }

    // Fail open so the UI cannot get stuck if a file has no hunks.
    if (currentFileHunks.length === 0) {
      setPendingRevealFilePath(null);
      return;
    }

    // Avoid dropping the reveal gate while selected hunk state is still settling.
    if (!hasResolvedSelectedHunkForReveal) {
      return;
    }

    // Fail open once selection is stable if we still cannot resolve a reveal target.
    if (selectedHunkRevealTargetLineIndex === null) {
      setPendingRevealFilePath(null);
    }
  }, [
    currentFileHunks.length,
    hasResolvedSelectedHunkForReveal,
    isActiveFileRevealPending,
    isActiveFileContentSettled,
    selectedHunkRevealTargetLineIndex,
  ]);

  useEffect(() => {
    if (!boundaryToast) return;
    const timer = setTimeout(() => setBoundaryToast(null), 2500);
    return () => clearTimeout(timer);
  }, [boundaryToast]);

  useEffect(() => {
    if (focusedNoteIndex < allReviews.length) {
      return;
    }

    setFocusedNoteIndex(Math.max(0, allReviews.length - 1));
  }, [allReviews.length, focusedNoteIndex]);

  useEffect(() => {
    if (focusedPanel !== "notes") {
      return;
    }

    const noteEl = notesSidebarRef.current?.querySelector<HTMLElement>(
      `[data-note-index="${focusedNoteIndex}"]`
    );
    noteEl?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [focusedPanel, focusedNoteIndex]);

  useEffect(() => {
    if (!inlineComposerRequest) {
      pendingComposerHunkSwitchRef.current = null;
      return;
    }

    if (selectedHunk?.id === inlineComposerRequest.hunkId) {
      pendingComposerHunkSwitchRef.current = null;
      return;
    }

    const pendingSwitch = pendingComposerHunkSwitchRef.current;
    const isAwaitingRequestedHunk =
      pendingSwitch?.toHunkId === inlineComposerRequest.hunkId &&
      (selectedHunkId === pendingSwitch.fromHunkId || selectedHunkId === null);

    if (isAwaitingRequestedHunk) {
      const requestedHunkStillExists = currentFileHunks.some(
        (hunk) => hunk.id === inlineComposerRequest.hunkId
      );
      if (requestedHunkStillExists) {
        return;
      }
    }

    pendingComposerHunkSwitchRef.current = null;
    setInlineComposerRequest(null);
  }, [currentFileHunks, inlineComposerRequest, selectedHunk, selectedHunkId]);

  // Refs keep hot-path callbacks stable so cursor movement doesn't trigger expensive re-renders.
  const activeLineIndexRef = useRef<number | null>(null);
  const selectedLineRangeRef = useRef<SelectedLineRange | null>(null);
  const selectedHunkIdRef = useRef<string | null>(selectedHunkId);
  const highlightedLineElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    activeLineIndexRef.current = activeLineIndex;
  }, [activeLineIndex]);

  useEffect(() => {
    selectedLineRangeRef.current = selectedLineRange;
  }, [selectedLineRange]);

  useEffect(() => {
    selectedHunkIdRef.current = selectedHunkId;
  }, [selectedHunkId]);

  // Keep cursor and selection aligned to the selected hunk when hunk navigation changes.
  useEffect(() => {
    const resolvedSelectedHunkId = selectedHunk?.id ?? null;

    if (!selectedHunkRange || !resolvedSelectedHunkId) {
      pendingJumpSelectAllHunkIdRef.current = null;
      setActiveLineIndex(null);
      setSelectedLineRange(null);
      return;
    }

    const shouldSelectEntireHunk = pendingJumpSelectAllHunkIdRef.current === resolvedSelectedHunkId;
    if (shouldSelectEntireHunk) {
      pendingJumpSelectAllHunkIdRef.current = null;
      // Use actual modified boundaries (without context padding) for the highlight
      const modifiedStart = selectedHunkRange.firstModifiedIndex ?? selectedHunkRange.startIndex;
      const modifiedEnd = selectedHunkRange.lastModifiedIndex ?? selectedHunkRange.endIndex;
      setActiveLineIndex(modifiedEnd);
      setSelectedLineRange({
        startIndex: modifiedStart,
        endIndex: modifiedEnd,
      });
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

      const cursorLineIndex = activeLineIndexRef.current;
      if (cursorLineIndex !== null && isLineInsideSelection(cursorLineIndex, previousSelection)) {
        // Keep cross-hunk Shift selections alive while the moving cursor edge
        // tracks into the next hunk.
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
      if (!activeFilePath || fileList.length <= 1) {
        return;
      }

      // Skip files with no currently visible hunks (e.g. filtered out by read/search filters).
      // This keeps file navigation moving forward instead of getting stuck on empty files.
      let candidatePath = activeFilePath;
      for (let step = 0; step < fileList.length - 1; step += 1) {
        const nextPath = getAdjacentFilePath(fileList, candidatePath, direction);
        if (!nextPath) {
          return;
        }

        candidatePath = nextPath;
        const fileHunks = sortHunksInFileOrder(getFileHunks(hunks, candidatePath));
        if (fileHunks.length > 0) {
          pendingJumpSelectAllHunkIdRef.current = null;
          hunkJumpRef.current = true;
          onSelectHunk(fileHunks[0].id);
          return;
        }
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
        if (nextIdx < 0 || nextIdx >= currentFileHunks.length) {
          setBoundaryToast("No more hunks in this file — use H / L to move between files");
          return;
        }
      }

      const targetHunkId = currentFileHunks[nextIdx].id;
      pendingJumpSelectAllHunkIdRef.current = targetHunkId;
      hunkJumpRef.current = true;
      onSelectHunk(targetHunkId);
    },
    [currentFileHunks, selectedHunkId, onSelectHunk]
  );

  const navigateToReview = useCallback(
    (review: Review, options?: { startEditing?: boolean }) => {
      const fileHunks = sortHunksInFileOrder(getFileHunks(allHunks, review.data.filePath));
      if (fileHunks.length === 0) {
        return;
      }

      const targetHunkId = findReviewHunkId(review, fileHunks) ?? fileHunks[0].id;
      pendingJumpSelectAllHunkIdRef.current = null;
      hunkJumpRef.current = true;
      onSelectHunk(targetHunkId);
      // Force scroll effect to re-fire even when activeLineIndex is unchanged
      // (for example when the cursor is already inside the selected hunk).
      setScrollNonce((previousNonce) => previousNonce + 1);

      if (options?.startEditing && props.reviewActions?.onEditComment) {
        nextInlineReviewEditRequestIdRef.current += 1;
        setInlineReviewEditRequest({
          requestId: nextInlineReviewEditRequestIdRef.current,
          reviewId: review.id,
        });
      }
    },
    [allHunks, onSelectHunk, props.reviewActions?.onEditComment]
  );

  const diffReviewActions = useMemo<ReviewActionCallbacks | undefined>(() => {
    if (!props.reviewActions) {
      return undefined;
    }

    return {
      ...props.reviewActions,
      onEditingChange: (reviewId: string, isEditing: boolean) => {
        props.reviewActions?.onEditingChange?.(reviewId, isEditing);
        if (isEditing) {
          setInlineReviewEditRequest((currentRequest) =>
            currentRequest?.reviewId === reviewId ? null : currentRequest
          );
        }
      },
    };
  }, [props.reviewActions]);

  const getCurrentLineSelection = useCallback((): SelectedLineRange | null => {
    if (selectedLineRange) {
      return selectedLineRange;
    }

    if (activeLineIndex === null) {
      return null;
    }

    return { startIndex: activeLineIndex, endIndex: activeLineIndex };
  }, [activeLineIndex, selectedLineRange]);

  const selectedLineSummary = useMemo(() => {
    const selection = getCurrentLineSelection();
    if (!selection) {
      return null;
    }

    return {
      startIndex: Math.min(selection.startIndex, selection.endIndex),
      endIndex: Math.max(selection.startIndex, selection.endIndex),
    };
  }, [getCurrentLineSelection]);

  const openComposer = useCallback(
    (prefill: string, selectionOverride?: SelectedLineRange) => {
      const lineCount = overlayData.lineHunkIds.length;
      if (lineCount === 0) {
        return;
      }

      const clampToOverlay = (lineIndex: number): number =>
        Math.max(0, Math.min(lineCount - 1, lineIndex));

      const selection = selectionOverride ??
        getCurrentLineSelection() ?? {
          startIndex: activeLineIndexRef.current ?? 0,
          endIndex: activeLineIndexRef.current ?? 0,
        };
      const effectiveSelection: SelectedLineRange = {
        startIndex: clampToOverlay(selection.startIndex),
        endIndex: clampToOverlay(selection.endIndex),
      };
      // Keep a single cursor source of truth: the moving edge of the selection.
      const cursorIndex = clampToOverlay(effectiveSelection.endIndex);

      pendingComposerHunkSwitchRef.current = null;

      const resolvedTarget =
        findHunkAtLine(cursorIndex, overlayData, currentFileHunks) ??
        findHunkAtLine(effectiveSelection.startIndex, overlayData, currentFileHunks);
      const targetHunk = resolvedTarget?.hunk ?? selectedHunk;
      if (!targetHunk) {
        return;
      }

      const currentSelectedHunkId = selectedHunkIdRef.current;
      if (targetHunk.id !== currentSelectedHunkId) {
        // Record the in-flight hunk switch so mismatch guards do not clear
        // this composer request before onSelectHunk propagates.
        pendingJumpSelectAllHunkIdRef.current = null;
        pendingComposerHunkSwitchRef.current = {
          fromHunkId: currentSelectedHunkId,
          toHunkId: targetHunk.id,
        };
        onSelectHunk(targetHunk.id);
      }

      // Keep the keyboard cursor on the last selected line so comment placement,
      // selection visuals, and subsequent actions all share the same anchor.
      setActiveLineIndex(cursorIndex);

      nextComposerRequestIdRef.current += 1;
      setInlineComposerRequest({
        requestId: nextComposerRequestIdRef.current,
        prefill,
        hunkId: targetHunk.id,
        startIndex: effectiveSelection.startIndex,
        endIndex: effectiveSelection.endIndex,
        cursorIndex,
      });
    },
    [getCurrentLineSelection, selectedHunk, overlayData, currentFileHunks, onSelectHunk]
  );

  const handleReviewNoteSubmit = useCallback(
    (data: ReviewNoteData) => {
      onReviewNote?.(data);
      // DiffRenderer clears its internal selection after submit, but immersive mode may
      // still keep an external selection request active. Clear it to close the composer
      // and prevent accidental duplicate submissions on repeated Enter presses.
      setInlineComposerRequest(null);
      // Clear the line selection so the next Shift+C targets the current keyboard
      // cursor (activeLineIndex) rather than the stale range from this comment.
      setSelectedLineRange(null);
      containerRef.current?.focus();
    },
    [onReviewNote]
  );

  const handleInlineComposerCancel = useCallback(() => {
    // Keep immersive parent state aligned with child composer teardown so canceled
    // keyboard-initiated requests do not linger or steal focus.
    setInlineComposerRequest(null);
    setSelectedLineRange(null);
    containerRef.current?.focus();
  }, []);

  const moveLineCursor = useCallback(
    (delta: number, extendRange: boolean) => {
      const lineCount = overlayData.lineHunkIds.length;
      if (lineCount === 0) {
        return;
      }

      const currentIndex = activeLineIndexRef.current ?? selectedHunkRange?.startIndex ?? 0;
      const nextIndex = Math.max(0, Math.min(lineCount - 1, currentIndex + delta));

      setActiveLineIndex(nextIndex);

      if (extendRange) {
        const anchorIndex = selectedLineRangeRef.current?.startIndex ?? currentIndex;
        setSelectedLineRange({ startIndex: anchorIndex, endIndex: nextIndex });
      } else {
        setSelectedLineRange(null);
      }

      const lineHunkId = overlayData.lineHunkIds[nextIndex];
      if (lineHunkId && lineHunkId !== selectedHunkIdRef.current) {
        pendingJumpSelectAllHunkIdRef.current = null;
        onSelectHunk(lineHunkId);
      }
    },
    [overlayData.lineHunkIds, selectedHunkRange, onSelectHunk]
  );

  const handleLineIndexSelect = useCallback(
    (lineIndex: number, shiftKey: boolean) => {
      const resolvedHunk = findHunkAtLine(lineIndex, overlayData, currentFileHunks);
      if (resolvedHunk && selectedHunkIdRef.current !== resolvedHunk.hunk.id) {
        pendingJumpSelectAllHunkIdRef.current = null;
        onSelectHunk(resolvedHunk.hunk.id);
      }

      const anchorIndex = shiftKey
        ? (selectedLineRangeRef.current?.startIndex ?? activeLineIndexRef.current ?? lineIndex)
        : lineIndex;
      setActiveLineIndex((previousLineIndex) =>
        previousLineIndex === lineIndex ? previousLineIndex : lineIndex
      );

      if (shiftKey) {
        setSelectedLineRange((previousRange) => {
          if (previousRange?.startIndex === anchorIndex && previousRange?.endIndex === lineIndex) {
            return previousRange;
          }

          return { startIndex: anchorIndex, endIndex: lineIndex };
        });
      } else {
        setSelectedLineRange((previousRange) => (previousRange === null ? previousRange : null));
      }

      if (isTouchExperience && !shiftKey && resolvedHunk) {
        // Mobile row tap should only open a composer for lines backed by a diff hunk.
        openComposer("", { startIndex: lineIndex, endIndex: lineIndex });
      }
    },
    [overlayData, currentFileHunks, isTouchExperience, onSelectHunk, openComposer]
  );

  const handleMinimapSelectLine = useCallback(
    (lineIndex: number) => {
      const hunkId = overlayData.lineHunkIds[lineIndex] ?? null;
      if (hunkId && hunkId !== selectedHunkIdRef.current) {
        onSelectHunk(hunkId);
      }

      setActiveLineIndex(lineIndex);
      setSelectedLineRange(null);
    },
    [overlayData.lineHunkIds, onSelectHunk]
  );

  // Auto-focus only for keyboard-first immersive mode.
  useEffect(() => {
    if (isTouchExperience) {
      return;
    }

    containerRef.current?.focus();
  }, [isTouchExperience]);

  // --- Keyboard handler ---
  useEffect(() => {
    if (isTouchExperience) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Tab: toggle between diff and notes panels.
      if (matchesKeybind(e, KEYBINDS.REVIEW_FOCUS_NOTES)) {
        // Keep normal tab behavior when typing in inline note editors.
        if (isEditableElement(e.target)) return;
        e.preventDefault();
        if (focusedPanel === "diff") {
          if (allReviews.length > 0) {
            setFocusedPanel("notes");
          }
        } else {
          setFocusedPanel("diff");
          containerRef.current?.focus();
        }
        return;
      }

      // --- Notes sidebar keyboard mode ---
      if (focusedPanel === "notes") {
        // Don't intercept when typing in editable elements.
        if (isEditableElement(e.target)) return;

        // Esc: return to diff panel (not exit immersive).
        if (matchesKeybind(e, KEYBINDS.CANCEL)) {
          e.preventDefault();
          stopKeyboardPropagation(e);
          setFocusedPanel("diff");
          containerRef.current?.focus();
          return;
        }

        // J / ArrowDown: next note.
        if (e.key === "j" || e.key === "ArrowDown") {
          e.preventDefault();
          const maxNoteIndex = Math.max(0, allReviews.length - 1);
          setFocusedNoteIndex((previousIndex) => Math.min(maxNoteIndex, previousIndex + 1));
          return;
        }

        // K / ArrowUp: previous note.
        if (e.key === "k" || e.key === "ArrowUp") {
          e.preventDefault();
          setFocusedNoteIndex((previousIndex) => Math.max(0, previousIndex - 1));
          return;
        }

        // Enter: navigate to focused note in diff and return to diff panel.
        if (e.key === "Enter") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note) {
            navigateToReview(note);
            setFocusedPanel("diff");
            containerRef.current?.focus();
          }
          return;
        }

        if (e.key === "e" || e.key === "E") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note) {
            // Keep note triage keyboard-first: jump directly from notes list into
            // editing the exact inline note comment in the diff pane.
            navigateToReview(note, { startEditing: true });
            setFocusedPanel("diff");
            containerRef.current?.focus();
          }
          return;
        }

        // Backspace/Delete: delete focused note.
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          const note = allReviews[focusedNoteIndex];
          if (note && props.reviewActions?.onDelete) {
            props.reviewActions.onDelete(note.id);
          }
          return;
        }

        // Swallow all other keys in notes mode so diff shortcuts do not fire.
        return;
      }

      // --- Diff panel keyboard mode ---
      // Don't intercept when typing in editable elements
      if (isEditableElement(e.target)) return;

      // Don't intercept Escape (or any shortcut) while a modal dialog is open.
      // This handler runs in capture phase, so bubble-phase stopPropagation
      // from dialog onKeyDown can't block it; check the DOM directly.
      if (isDialogOpen()) return;

      // Esc: exit immersive
      if (matchesKeybind(e, KEYBINDS.CANCEL)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        onExit();
        return;
      }

      // L/H: next/prev file
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

      // J/K: next/prev hunk
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

      // Shift+C: add comment
      if (matchesKeybind(e, KEYBINDS.REVIEW_COMMENT)) {
        e.preventDefault();
        openComposer("");
        return;
      }

      // Shift+L: quick like
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_LIKE)) {
        e.preventDefault();
        openComposer(LIKE_NOTE_PREFIX);
        return;
      }

      // Shift+D: quick dislike
      if (matchesKeybind(e, KEYBINDS.REVIEW_QUICK_DISLIKE)) {
        e.preventDefault();
        openComposer(DISLIKE_NOTE_PREFIX);
        return;
      }

      // Toggle hunk read
      if (matchesKeybind(e, KEYBINDS.TOGGLE_HUNK_READ)) {
        e.preventDefault();
        if (selectedHunkId) onToggleRead(selectedHunkId);
      }
    };

    // Run in capture phase so immersive Escape handling can swallow the event before
    // bubble-phase global stream-interrupt listeners see it.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    focusedPanel,
    allReviews,
    focusedNoteIndex,
    navigateToReview,
    props.reviewActions,
    onExit,
    navigateFile,
    navigateHunk,
    moveLineCursor,
    openComposer,
    selectedHunkId,
    onToggleRead,
    isTouchExperience,
  ]);

  const previousContentRef = useRef(overlayData.content);

  // Keep the active line visible while moving with keyboard shortcuts, without
  // forcing the full diff tree to re-render on every cursor move.
  useEffect(() => {
    const contentChanged = previousContentRef.current !== overlayData.content;
    previousContentRef.current = overlayData.content;

    const previousLineElement = highlightedLineElementRef.current;
    if (previousLineElement) {
      previousLineElement.style.outline = "";
      previousLineElement.style.outlineOffset = "";
      highlightedLineElementRef.current = null;
    }

    // When overlay content structure changes (fallback hunks -> full-file view),
    // defer regular scrolling until the selected-hunk effect has recalculated
    // activeLineIndex. During a file-switch reveal gate we still need one initial
    // scroll so the diff appears already positioned at the selected hunk.
    if (contentChanged) {
      hunkJumpRef.current = true;
      if (!isActiveFileRevealPending) {
        return;
      }
    }

    if (isActiveFileRevealPending && !isActiveFileContentSettled) {
      return;
    }

    const lineIndexForScroll = isActiveFileRevealPending ? revealTargetLineIndex : activeLineIndex;
    if (lineIndexForScroll === null) {
      return;
    }

    const lineElement = containerRef.current?.querySelector<HTMLElement>(
      `[data-line-index="${lineIndexForScroll}"]`
    );
    if (!lineElement) {
      if (!isActiveFileRevealPending || !activeFilePath || contentChanged) {
        return;
      }

      if (revealAnimationFrameRef.current !== null) {
        cancelAnimationFrame(revealAnimationFrameRef.current);
      }

      const revealFilePath = activeFilePath;
      revealAnimationFrameRef.current = window.requestAnimationFrame(() => {
        setPendingRevealFilePath((pendingFilePath) =>
          pendingFilePath === revealFilePath ? null : pendingFilePath
        );
        revealAnimationFrameRef.current = null;
      });
      return;
    }

    const shouldRenderActiveLineOutline =
      activeLineIndex !== null && lineIndexForScroll === activeLineIndex;

    if (shouldRenderActiveLineOutline) {
      lineElement.style.outline = ACTIVE_LINE_OUTLINE;
      lineElement.style.outlineOffset = "-1px";
      highlightedLineElementRef.current = lineElement;
    }

    const block = hunkJumpRef.current ? "center" : "nearest";
    hunkJumpRef.current = false;
    lineElement.scrollIntoView({ behavior: "auto", block });

    if (!isActiveFileRevealPending || !activeFilePath) {
      return;
    }

    if (revealAnimationFrameRef.current !== null) {
      cancelAnimationFrame(revealAnimationFrameRef.current);
    }

    const revealFilePath = activeFilePath;
    revealAnimationFrameRef.current = window.requestAnimationFrame(() => {
      setPendingRevealFilePath((pendingFilePath) =>
        pendingFilePath === revealFilePath ? null : pendingFilePath
      );
      revealAnimationFrameRef.current = null;
    });
  }, [
    activeFilePath,
    activeLineIndex,
    isActiveFileContentSettled,
    isActiveFileRevealPending,
    overlayData.content,
    revealTargetLineIndex,
    scrollNonce,
  ]);

  useEffect(() => {
    return () => {
      const previousLineElement = highlightedLineElementRef.current;
      if (!previousLineElement) {
        return;
      }

      previousLineElement.style.outline = "";
      previousLineElement.style.outlineOffset = "";
      highlightedLineElementRef.current = null;
    };
  }, []);

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

  const externalComposerSelectionRequest = useMemo(() => {
    if (!inlineComposerRequest || !selectedHunk) {
      return null;
    }

    if (inlineComposerRequest.hunkId !== selectedHunk.id) {
      return null;
    }

    const lineCount = overlayData.lineHunkIds.length;
    if (lineCount === 0) {
      return null;
    }

    const clampToOverlay = (lineIndex: number) => Math.max(0, Math.min(lineCount - 1, lineIndex));

    return {
      requestId: inlineComposerRequest.requestId,
      selection: {
        startIndex: clampToOverlay(inlineComposerRequest.startIndex),
        endIndex: clampToOverlay(inlineComposerRequest.endIndex),
      },
      composerAfterIndex: clampToOverlay(inlineComposerRequest.cursorIndex),
      initialNoteText: inlineComposerRequest.prefill,
    };
  }, [inlineComposerRequest, overlayData.lineHunkIds.length, selectedHunk]);

  const shouldEnableHighlighting = overlayData.lineHunkIds.length <= MAX_HIGHLIGHTED_DIFF_LINES;

  const shouldShowFileTransitionSplash =
    currentFileHunks.length > 0 && (isActiveFileContentLoading || isActiveFileRevealPending);

  return (
    <div
      ref={containerRef}
      tabIndex={isTouchExperience ? -1 : 0}
      className="flex h-full flex-col overflow-hidden outline-none"
      data-testid="immersive-review-view"
    >
      {/* Header */}
      <div className="border-border-light bg-dark flex items-center gap-2 border-b px-3 py-2">
        {/* Back button */}
        <button
          onClick={onExit}
          className="text-muted hover:text-foreground flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-xs transition-colors"
          aria-label="Exit immersive review"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </button>

        <div className="bg-border-light hidden h-4 w-px shrink-0 sm:block" />

        {/* File navigation */}
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-initial">
          <button
            onClick={() => navigateFile(-1)}
            disabled={fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Previous file"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {/* Mobile: show filename only */}
          <span
            className="text-foreground min-w-0 flex-1 truncate font-mono text-xs sm:hidden"
            title={activeFilePath ?? undefined}
          >
            {activeFilePath?.split("/").pop() ?? "No files"}
          </span>
          {/* Desktop: show full path */}
          <span
            className="text-foreground hidden max-w-[400px] truncate font-mono text-xs sm:block"
            title={activeFilePath ?? undefined}
          >
            {activeFilePath ?? "No files"}
          </span>
          <span className="text-dim hidden shrink-0 text-[10px] sm:inline">
            {fileIndex >= 0 ? `${fileIndex + 1}/${fileCount}` : ""}
          </span>
          <button
            onClick={() => navigateFile(1)}
            disabled={fileCount <= 1}
            className="text-muted hover:text-foreground disabled:text-dim flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors disabled:cursor-default"
            aria-label="Next file"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="bg-border-light hidden h-4 w-px shrink-0 sm:block" />

        {/* Hunk read toggle — mobile only (desktop copy lives inside the summary div below) */}
        {selectedHunk && (
          <button
            type="button"
            className={cn(
              "text-muted hover:text-read flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0 transition-colors duration-150 sm:hidden",
              props.isRead(selectedHunk.id) && "text-read"
            )}
            onClick={() => onToggleRead(selectedHunk.id)}
            aria-label={props.isRead(selectedHunk.id) ? "Mark hunk as unread" : "Mark hunk as read"}
          >
            {props.isRead(selectedHunk.id) ? (
              <Check aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Circle aria-hidden="true" className="h-3 w-3" />
            )}
          </button>
        )}
        {/* Hunk selection summary — hidden on mobile, includes toggle on desktop */}
        <div className="text-muted hidden items-center gap-1 text-[10px] sm:flex">
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

      {/* Unified whole-file diff with hunk overlays + notes sidebar */}
      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          className="scrollbar-none min-h-0 min-w-0 flex-1 overflow-y-auto py-3"
        >
          {props.isLoading && currentFileHunks.length === 0 ? (
            <div className="text-muted flex items-center justify-center py-12 text-sm">
              <span className="animate-pulse">Loading diff...</span>
            </div>
          ) : currentFileHunks.length === 0 ? (
            <div className="text-muted flex items-center justify-center py-12 text-sm">
              {activeFilePath ? "No hunks for this file" : "No files to review"}
            </div>
          ) : (
            <div className="bg-dark relative overflow-hidden">
              {shouldShowFileTransitionSplash && (
                <div className="bg-dark/95 text-muted absolute inset-0 z-10 flex items-center justify-center text-sm">
                  <span className="animate-pulse">Loading file...</span>
                </div>
              )}
              <div className={cn(shouldShowFileTransitionSplash && "invisible")}>
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
                  onReviewNote={handleReviewNoteSubmit}
                  onComposerCancel={handleInlineComposerCancel}
                  reviewActions={diffReviewActions}
                  enableHighlighting={shouldEnableHighlighting}
                  selectedLineRange={selectedLineRange}
                  onLineIndexSelect={handleLineIndexSelect}
                  externalSelectionRequest={externalComposerSelectionRequest}
                  externalEditRequest={inlineReviewEditRequest}
                />
              </div>
            </div>
          )}
        </div>

        {overlayData && !isTouchExperience && (
          <ImmersiveMinimap
            content={overlayData.content}
            scrollContainerRef={scrollContainerRef}
            activeLineIndex={activeLineIndex}
            onSelectLineIndex={handleMinimapSelectLine}
            commentLineIndices={commentLineIndices}
          />
        )}

        {!isTouchExperience && (
          <aside className="border-border-light bg-dark flex w-[280px] min-w-[280px] flex-col border-l">
            <div className="border-border-light flex items-center justify-between border-b px-3 py-2">
              <h2
                className={cn(
                  "text-foreground text-xs font-medium",
                  focusedPanel === "notes" && "text-[var(--color-review-accent)]"
                )}
              >
                Notes
              </h2>
              <span className="bg-muted/20 text-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
                {allReviews.length}
              </span>
            </div>

            <div ref={notesSidebarRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {allReviews.length === 0 ? (
                <div className="text-muted flex h-full flex-col items-center justify-center text-center text-xs">
                  <p>No notes yet</p>
                  <p className="text-dim mt-1">Press Shift+L to add one</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {allReviews.map((review, noteIndex) => {
                    const normalizedUserNote = review.data.userNote.trimStart();
                    const isDislike = normalizedUserNote.startsWith(DISLIKE_NOTE_PREFIX);
                    const isLike = normalizedUserNote.startsWith(LIKE_NOTE_PREFIX);
                    const statusClasses = getReviewStatusSidebarClasses(review.status);
                    const ReviewTypeIcon = isDislike
                      ? ThumbsDown
                      : isLike
                        ? ThumbsUp
                        : MessageSquare;
                    const isActiveFileReview = review.data.filePath === activeFilePath;

                    return (
                      <div
                        key={review.id}
                        role="button"
                        tabIndex={0}
                        data-note-index={noteIndex}
                        className={cn(
                          "group/review-item border-border-light hover:bg-muted/10 focus-visible:ring-primary/40 flex w-full cursor-pointer overflow-hidden rounded border text-left outline-none transition-colors focus-visible:ring-2",
                          isActiveFileReview && "bg-muted/10",
                          focusedPanel === "notes" &&
                            noteIndex === focusedNoteIndex &&
                            "ring-2 ring-[var(--color-review-accent)]/40 bg-muted/10"
                        )}
                        onClick={() => navigateToReview(review)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            navigateToReview(review);
                          }
                        }}
                      >
                        <div className={cn("w-[3px] shrink-0", statusClasses.accent)} />

                        <div className="min-w-0 flex-1 px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <ReviewTypeIcon className={cn("size-3 shrink-0", statusClasses.icon)} />

                            <span
                              className="text-muted min-w-0 flex-1 truncate font-mono text-[10px]"
                              title={`${review.data.filePath}:L${formatLineRangeCompact(review.data.lineRange)}`}
                            >
                              {`${getFileBaseName(review.data.filePath)}:L${formatLineRangeCompact(review.data.lineRange)}`}
                            </span>

                            <span
                              className={cn(
                                "shrink-0 rounded px-1 py-0.5 text-[9px] uppercase",
                                statusClasses.badge
                              )}
                            >
                              {review.status}
                            </span>

                            {props.reviewActions?.onDelete && (
                              <button
                                type="button"
                                className="text-muted hover:text-error ml-0.5 hidden cursor-pointer items-center rounded p-0.5 transition-colors group-hover/review-item:inline-flex"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.reviewActions?.onDelete?.(review.id);
                                }}
                                aria-label="Delete review note"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            )}
                          </div>

                          <p
                            className="text-foreground mt-1 overflow-hidden text-[11px] leading-[1.4] break-words whitespace-pre-wrap"
                            style={{
                              display: "-webkit-box",
                              WebkitBoxOrient: "vertical",
                              WebkitLineClamp: 2,
                            }}
                          >
                            {review.data.userNote || "(No note text)"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Boundary toast */}
      {boundaryToast && (
        <div className="pointer-events-none absolute right-0 bottom-12 left-0 z-10 flex justify-center">
          <div className="bg-background-secondary text-muted border-border-light pointer-events-auto rounded-md border px-3 py-1.5 text-xs shadow-md">
            {boundaryToast}
          </div>
        </div>
      )}

      {!isTouchExperience && (
        <>
          {/* Shortcut bar */}
          <div className="border-border-light bg-dark flex flex-wrap items-center justify-center gap-3 border-t px-3 py-1.5">
            <KeycapGroup keys={["Esc"]} label="back" />
            <KeycapGroup keys={["H", "L"]} label="file" />
            <KeycapGroup keys={["J", "K"]} label="hunk" />
            <KeycapGroup keys={["↑", "↓"]} label="line" />
            <KeycapGroup keys={["Shift", "↑↓"]} label="select" />
            <KeycapGroup keys={["m"]} label="read" />
            <KeycapGroup keys={["⇧M"]} label="file read" />
            <KeycapGroup keys={["⇧C"]} label="comment" />
            <KeycapGroup keys={["⇧L", "⇧D"]} label="like / dislike" />
            <KeycapGroup keys={["Enter"]} label="submit" />
            <KeycapGroup keys={["Tab"]} label="notes" />
          </div>
        </>
      )}
    </div>
  );
};
