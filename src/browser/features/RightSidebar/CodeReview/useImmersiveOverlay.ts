import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { ThemeMode } from "@/browser/contexts/ThemeContext";
import {
  buildReadFileScript,
  EXIT_CODE_TOO_LARGE,
  EXIT_CODE_TOO_MANY_LINES,
  processFileContents,
} from "@/browser/utils/fileRead";
import type { DiffHunk } from "@/common/types/review";
import { preloadHighlightedDiff } from "../../Shared/DiffRenderer";

const MAX_FULL_FILE_CONTEXT_LINES = 1500;
const MAX_FULL_FILE_CONTEXT_BYTES = 256 * 1024;
const FULL_FILE_CONTEXT_REVEAL_TIMEOUT_MS = 5_000;

// Keep syntax highlighting on for larger review files now that per-line tooltip overhead is gone,
// but still cap it to avoid pathological DOM costs on extremely large diffs.
const MAX_HIGHLIGHTED_DIFF_LINES = 4000;

const FULL_FILE_CONTEXT_TIMEOUT = Symbol("full-file-context-timeout");

type FullFileContextTimeout = typeof FULL_FILE_CONTEXT_TIMEOUT;

export interface HunkLineRange {
  startIndex: number;
  endIndex: number;
  firstModifiedIndex: number | null;
  lastModifiedIndex: number | null;
}

export interface ImmersiveOverlayData {
  content: string;
  /** Small stable key used by reveal/highlight gates instead of re-comparing multi-KB content. */
  contentKey: string;
  lineHunkIds: Array<string | null>;
  hunkLineRanges: Map<string, HunkLineRange>;
}

export interface OverlayRevealIdentity {
  filePath: string;
  contentKey: string;
}

interface ActiveFileContentState {
  filePath: string | null;
  content: string | null;
  isSettled: boolean;
}

interface UseImmersiveOverlayDataInput {
  api: APIClient | null;
  workspaceId: string;
  activeFilePath: string | null;
  currentFileHunks: DiffHunk[];
  selectedHunk: DiffHunk | null;
  theme: ThemeMode;
}

interface UseImmersiveOverlayInput extends UseImmersiveOverlayDataInput {
  onRevealPending: (scrollBlock: ScrollLogicalPosition) => void;
}

interface UseImmersiveOverlayRevealInput {
  activeFilePath: string | null;
  overlayData: ImmersiveOverlayData;
  isActiveFileContentSettled: boolean;
  shouldLoadFullFileContext: boolean;
  shouldEnableHighlighting: boolean;
  onRevealPending: (scrollBlock: ScrollLogicalPosition) => void;
}

export interface ImmersiveOverlayState {
  overlayData: ImmersiveOverlayData;
  shouldEnableHighlighting: boolean;
  isActiveOverlayRevealPending: boolean;
  isActiveOverlayReadyForReveal: boolean;
  activeOverlayRevealIdentity: OverlayRevealIdentity | null;
  revealLoadingLabel: string;
  revealActiveOverlayNow: () => void;
  scheduleOverlayReveal: (overlayIdentity: OverlayRevealIdentity) => void;
  handleDiffHighlightSettledChange: (isSettled: boolean) => void;
}

const EMPTY_OVERLAY_DATA: ImmersiveOverlayData = {
  content: "",
  contentKey: "empty:0:0",
  lineHunkIds: [],
  hunkLineRanges: new Map<string, HunkLineRange>(),
};

async function withFullFileContextTimeout<T>(
  promise: Promise<T>
): Promise<T | FullFileContextTimeout> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T | FullFileContextTimeout>([
      promise,
      new Promise<FullFileContextTimeout>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(FULL_FILE_CONTEXT_TIMEOUT),
          FULL_FILE_CONTEXT_REVEAL_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function splitDiffLines(content: string): string[] {
  // Preserve intentionally blank trailing lines but avoid inventing an extra row
  // for the final newline that git diffs commonly include. Normalize CRLF hunk
  // rows too; full-file context does this separately, but compact overlays are
  // built directly from hunk content and should not carry raw \r into diff cells.
  const lines = content
    .split(/\r?\n/)
    .map((line) => (line.endsWith("\r") ? line.slice(0, Math.max(0, line.length - 1)) : line));
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
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

function isWithinFullFileContextLineBudget(content: string): boolean {
  return normalizeFileLines(content).length <= MAX_FULL_FILE_CONTEXT_LINES;
}

function shouldAttemptFullFileContext(selectedHunk: DiffHunk | null): boolean {
  if (!selectedHunk) {
    return false;
  }

  const lastDisplayLine = selectedHunk.newStart + Math.max(selectedHunk.newLines, 1) - 1;
  return lastDisplayLine <= MAX_FULL_FILE_CONTEXT_LINES;
}

function buildFileContentCacheKey(
  workspaceId: string,
  filePath: string,
  sortedHunks: readonly DiffHunk[]
): string {
  const hunkSignature = sortedHunks.map((hunk) => hunk.id).join("|");
  return [workspaceId, filePath, hunkSignature].join("\u0000");
}

function buildContentKey(content: string, renderedLineCount: number): string {
  // Hash once when overlay content is built; reveal/highlight checks run on every
  // cursor render and should not allocate or compare the full diff body repeatedly.
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${renderedLineCount}:${hash >>> 0}`;
}

function createOverlayData(
  contentLines: string[],
  lineHunkIds: Array<string | null>,
  hunkLineRanges: Map<string, HunkLineRange>
): ImmersiveOverlayData {
  const content = contentLines.join("\n");
  return {
    content,
    contentKey: buildContentKey(content, lineHunkIds.length),
    lineHunkIds,
    hunkLineRanges,
  };
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

  return createOverlayData(contentLines, lineHunkIds, hunkLineRanges);
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

  return createOverlayData(contentLines, lineHunkIds, hunkLineRanges);
}

export function isSameOverlayRevealIdentity(
  lhs: OverlayRevealIdentity | null,
  rhs: OverlayRevealIdentity | null
): boolean {
  return lhs?.filePath === rhs?.filePath && lhs?.contentKey === rhs?.contentKey;
}

function useImmersiveOverlayData(input: UseImmersiveOverlayDataInput) {
  const [activeFileContentState, setActiveFileContentState] = useState<ActiveFileContentState>({
    filePath: null,
    content: null,
    isSettled: true,
  });
  const fileContentCacheRef = useRef<Map<string, string | null>>(new Map());
  const shouldLoadFullFileContext = useMemo(
    () => shouldAttemptFullFileContext(input.selectedHunk),
    [input.selectedHunk]
  );
  const activeFileContentCacheKey = useMemo(
    () =>
      input.activeFilePath
        ? buildFileContentCacheKey(input.workspaceId, input.activeFilePath, input.currentFileHunks)
        : null,
    [input.activeFilePath, input.currentFileHunks, input.workspaceId]
  );

  // Load full file context only when it is cheap. If disk I/O or highlighting stalls,
  // fail open to the compact hunk overlay instead of trapping the review behind loading.
  useEffect(() => {
    const apiClient = input.api;
    const filePath = input.activeFilePath;
    const cacheKey = activeFileContentCacheKey;

    const settleContent = (content: string | null) => {
      setActiveFileContentState({
        filePath: filePath ?? null,
        content,
        isSettled: true,
      });
    };

    if (!filePath || !apiClient || !shouldLoadFullFileContext || !cacheKey) {
      settleContent(null);
      return;
    }

    if (fileContentCacheRef.current.has(cacheKey)) {
      settleContent(fileContentCacheRef.current.get(cacheKey) ?? null);
      return;
    }

    const resolvedApi = apiClient;
    const resolvedFilePath = filePath;
    const resolvedFileHunks = input.currentFileHunks;
    const resolvedTheme = input.theme;
    let cancelled = false;

    setActiveFileContentState({
      filePath: resolvedFilePath,
      content: null,
      isSettled: false,
    });

    const settleLoadedContent = (content: string | null, shouldCache: boolean) => {
      if (shouldCache) {
        fileContentCacheRef.current.set(cacheKey, content);
      }
      if (!cancelled) {
        setActiveFileContentState({
          filePath: resolvedFilePath,
          content,
          isSettled: true,
        });
      }
    };

    async function loadActiveFileContent() {
      // Keep plain file reads on the shared container root so immersive review can open
      // sibling-project files without forcing the primary repo checkout.
      const fileResult = await withFullFileContextTimeout(
        resolvedApi.workspace.executeBash({
          workspaceId: input.workspaceId,
          script: buildReadFileScript(resolvedFilePath, {
            maxSizeBytes: MAX_FULL_FILE_CONTEXT_BYTES,
            maxLineCount: MAX_FULL_FILE_CONTEXT_LINES,
          }),
        })
      );

      if (cancelled) {
        return;
      }

      if (fileResult === FULL_FILE_CONTEXT_TIMEOUT) {
        settleLoadedContent(null, false);
        return;
      }

      if (!fileResult.success) {
        settleLoadedContent(null, false);
        return;
      }

      const bashResult = fileResult.data;
      const isDeterministicBudgetMiss =
        bashResult.exitCode === EXIT_CODE_TOO_LARGE ||
        bashResult.exitCode === EXIT_CODE_TOO_MANY_LINES;

      if (!bashResult.success && !bashResult.output) {
        settleLoadedContent(null, isDeterministicBudgetMiss);
        return;
      }

      const data = processFileContents(bashResult.output ?? "", bashResult.exitCode);
      const content =
        data.type === "text" && isWithinFullFileContextLineBudget(data.content)
          ? data.content
          : null;

      if (content != null) {
        const hydratedOverlay = buildOverlayFromFileContent(content, resolvedFileHunks);
        if (hydratedOverlay.lineHunkIds.length <= MAX_HIGHLIGHTED_DIFF_LINES) {
          // Preload syntax tokens before swapping compact hunks to full-file context so
          // users do not see plain fallback rows flash into colored Shiki spans.
          const preloadResult = await withFullFileContextTimeout(
            preloadHighlightedDiff({
              content: hydratedOverlay.content,
              filePath: resolvedFilePath,
              themeMode: resolvedTheme,
            })
          );
          if (cancelled) {
            return;
          }
          if (preloadResult === FULL_FILE_CONTEXT_TIMEOUT) {
            settleLoadedContent(null, false);
            return;
          }
        }
      }

      settleLoadedContent(content, content != null || isDeterministicBudgetMiss);
    }

    loadActiveFileContent().catch(() => {
      settleLoadedContent(null, false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeFileContentCacheKey,
    input.activeFilePath,
    input.api,
    input.currentFileHunks,
    input.theme,
    input.workspaceId,
    shouldLoadFullFileContext,
  ]);

  const isActiveFileContentSettled =
    !input.activeFilePath ||
    (activeFileContentState.filePath === input.activeFilePath && activeFileContentState.isSettled);

  const resolvedActiveFileContent =
    isActiveFileContentSettled && shouldLoadFullFileContext ? activeFileContentState.content : null;
  const shouldDeferOverlayRender = Boolean(
    shouldLoadFullFileContext && !isActiveFileContentSettled
  );

  const overlayData = useMemo<ImmersiveOverlayData>(() => {
    if (input.currentFileHunks.length === 0 || shouldDeferOverlayRender) {
      return EMPTY_OVERLAY_DATA;
    }

    if (resolvedActiveFileContent != null) {
      return buildOverlayFromFileContent(resolvedActiveFileContent, input.currentFileHunks);
    }

    return buildOverlayFromHunks(input.currentFileHunks);
  }, [input.currentFileHunks, resolvedActiveFileContent, shouldDeferOverlayRender]);

  const shouldEnableHighlighting = overlayData.lineHunkIds.length <= MAX_HIGHLIGHTED_DIFF_LINES;

  return {
    overlayData,
    shouldEnableHighlighting,
    shouldLoadFullFileContext,
    isActiveFileContentSettled,
  };
}

function useImmersiveOverlayReveal(input: UseImmersiveOverlayRevealInput) {
  const { onRevealPending } = input;
  const activeOverlayRevealIdentity = useMemo<OverlayRevealIdentity | null>(
    () =>
      input.activeFilePath
        ? { filePath: input.activeFilePath, contentKey: input.overlayData.contentKey }
        : null,
    [input.activeFilePath, input.overlayData.contentKey]
  );
  const activeOverlayHighlightKey = activeOverlayRevealIdentity
    ? `${activeOverlayRevealIdentity.filePath}\u0000${activeOverlayRevealIdentity.contentKey}`
    : null;
  const [settledOverlayHighlightKey, setSettledOverlayHighlightKey] = useState<string | null>(null);

  // Hold diff reveal until overlay geometry swaps have been positioned. File
  // switches and same-file content swaps are covered by a scrollport-sized
  // shimmer overlay while hidden layout effects scroll the target hunk into place.
  const [revealedOverlayIdentity, setRevealedOverlayIdentity] =
    useState<OverlayRevealIdentity | null>(null);
  const revealAnimationFrameRef = useRef<number | null>(null);
  const activeOverlayRevealIdentityRef = useRef<OverlayRevealIdentity | null>(null);

  const isActiveOverlayRevealPending =
    activeOverlayRevealIdentity !== null &&
    !isSameOverlayRevealIdentity(revealedOverlayIdentity, activeOverlayRevealIdentity);
  const isHappyDomEnvironment = typeof window !== "undefined" && "happyDOM" in window;
  // Only worker-backed highlighting is safe to use as a reveal prerequisite; tests and
  // other non-worker shells fall back to slower main-thread highlighting.
  const canWaitForOverlayHighlight = typeof Worker !== "undefined" && !isHappyDomEnvironment;
  const shouldWaitForFullFileContextReveal = Boolean(
    isActiveOverlayRevealPending &&
    input.shouldLoadFullFileContext &&
    !input.isActiveFileContentSettled
  );
  const shouldWaitForOverlayHighlight = Boolean(
    canWaitForOverlayHighlight &&
    isActiveOverlayRevealPending &&
    input.shouldEnableHighlighting &&
    input.overlayData.lineHunkIds.length > 0 &&
    activeOverlayHighlightKey
  );
  const isActiveOverlayHighlightReadyForReveal =
    !shouldWaitForOverlayHighlight || settledOverlayHighlightKey === activeOverlayHighlightKey;
  const isActiveOverlayReadyForReveal =
    !shouldWaitForFullFileContextReveal && isActiveOverlayHighlightReadyForReveal;

  // Gate every overlay geometry swap, not just file switches. Same-file hydration
  // inserts context rows above the current hunk, so reveal only after the hidden
  // layout pass scrolls the selected full-file row into place.
  const isActiveOverlayReadyForRevealRef = useRef(isActiveOverlayReadyForReveal);
  useLayoutEffect(() => {
    isActiveOverlayReadyForRevealRef.current = isActiveOverlayReadyForReveal;
  }, [isActiveOverlayReadyForReveal]);

  const revealActiveOverlayNow = useCallback(() => {
    const activeIdentity = activeOverlayRevealIdentityRef.current;
    if (activeIdentity) {
      setRevealedOverlayIdentity(activeIdentity);
    }
  }, []);

  const scheduleOverlayReveal = useCallback((overlayIdentity: OverlayRevealIdentity) => {
    if (revealAnimationFrameRef.current !== null) {
      cancelAnimationFrame(revealAnimationFrameRef.current);
    }

    revealAnimationFrameRef.current = window.requestAnimationFrame(() => {
      setRevealedOverlayIdentity((currentRevealedIdentity) => {
        // A stale rAF from an earlier compact overlay must not reveal while a
        // newer full-file hydration is still loading/highlighting.
        if (!isActiveOverlayReadyForRevealRef.current) {
          return currentRevealedIdentity;
        }

        return isSameOverlayRevealIdentity(activeOverlayRevealIdentityRef.current, overlayIdentity)
          ? overlayIdentity
          : currentRevealedIdentity;
      });
      revealAnimationFrameRef.current = null;
    });
  }, []);

  const handleDiffHighlightSettledChange = useCallback(
    (isSettled: boolean) => {
      setSettledOverlayHighlightKey((currentKey) => {
        if (isSettled) {
          return activeOverlayHighlightKey;
        }
        return currentKey === activeOverlayHighlightKey ? null : currentKey;
      });
    },
    [activeOverlayHighlightKey]
  );

  useLayoutEffect(() => {
    if (revealAnimationFrameRef.current !== null) {
      cancelAnimationFrame(revealAnimationFrameRef.current);
      revealAnimationFrameRef.current = null;
    }

    activeOverlayRevealIdentityRef.current = activeOverlayRevealIdentity;

    if (!activeOverlayRevealIdentity) {
      setRevealedOverlayIdentity(null);
      return;
    }

    if (isActiveOverlayRevealPending) {
      // The pending state is derived during render, not set from an effect, so
      // file switches are hidden on their first paint until the scroll effect
      // reveals the positioned overlay.
      onRevealPending("center");
    }
  }, [activeOverlayRevealIdentity, isActiveOverlayRevealPending, onRevealPending]);

  useEffect(() => {
    return () => {
      if (revealAnimationFrameRef.current !== null) {
        cancelAnimationFrame(revealAnimationFrameRef.current);
      }
    };
  }, []);

  return {
    activeOverlayRevealIdentity,
    isActiveOverlayRevealPending,
    isActiveOverlayReadyForReveal,
    revealLoadingLabel: "Loading file...",
    revealActiveOverlayNow,
    scheduleOverlayReveal,
    handleDiffHighlightSettledChange,
  };
}

export function useImmersiveOverlay(input: UseImmersiveOverlayInput): ImmersiveOverlayState {
  const overlayDataState = useImmersiveOverlayData(input);
  const revealState = useImmersiveOverlayReveal({
    activeFilePath: input.activeFilePath,
    overlayData: overlayDataState.overlayData,
    isActiveFileContentSettled: overlayDataState.isActiveFileContentSettled,
    shouldLoadFullFileContext: overlayDataState.shouldLoadFullFileContext,
    shouldEnableHighlighting: overlayDataState.shouldEnableHighlighting,
    onRevealPending: input.onRevealPending,
  });

  return {
    overlayData: overlayDataState.overlayData,
    shouldEnableHighlighting: overlayDataState.shouldEnableHighlighting,
    ...revealState,
  };
}
