/**
 * Hook for managing read-more context expansion state in HunkViewer.
 * Handles loading additional context lines above/below a diff hunk.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import type { DiffHunk } from "@/common/types/review";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewReadMoreKey } from "@/common/constants/storage";
import { useAPI } from "@/browser/contexts/API";
import {
  readFileLines,
  formatAsContextLines,
  getOldFileRef,
  LINES_PER_EXPANSION,
} from "@/browser/utils/review/readFileLines";

/** Expansion state for a single hunk */
interface ReadMoreState {
  up: number; // Lines expanded upward (cumulative)
  down: number; // Lines expanded downward (cumulative)
}

interface UseReadMoreOptions {
  hunk: DiffHunk;
  hunkId: string;
  workspaceId: string;
  diffBase: string;
  includeUncommitted: boolean;
}

interface UseReadMoreResult {
  // Content
  upContent: string;
  downContent: string;
  // Loading states
  upLoading: boolean;
  downLoading: boolean;
  // Boundary states
  atBOF: boolean;
  atEOF: boolean;
  // Current expansion amounts
  readMore: ReadMoreState;
  // Handlers
  handleExpandUp: (e: React.MouseEvent) => void;
  handleExpandDown: (e: React.MouseEvent) => void;
  handleCollapseUp: (e: React.MouseEvent) => void;
  handleCollapseDown: (e: React.MouseEvent) => void;
}

export function useReadMore(options: UseReadMoreOptions): UseReadMoreResult {
  const { hunk, hunkId, workspaceId, diffBase, includeUncommitted } = options;
  const { api } = useAPI();

  // Persisted state: how many lines expanded up/down per hunk
  const [readMoreMap, setReadMoreMap] = usePersistedState<Record<string, ReadMoreState>>(
    getReviewReadMoreKey(workspaceId),
    {},
    { listener: true }
  );
  const readMore = useMemo(() => readMoreMap[hunkId] ?? { up: 0, down: 0 }, [readMoreMap, hunkId]);

  // Loading and content state (not persisted - reloads on mount)
  const [upContent, setUpContent] = useState<string>("");
  const [downContent, setDownContent] = useState<string>("");
  const [upLoading, setUpLoading] = useState(false);
  const [downLoading, setDownLoading] = useState(false);

  // BOF: true when hunk starts at line 1 (nothing to expand above)
  // For new files: oldStart=0 means no old content, so also BOF
  // For existing files: oldStart=1 means beginning of file
  const [atBOF, setAtBOF] = useState(() => hunk.oldStart <= 1);
  const [atEOF, setAtEOF] = useState(false);

  // Git ref expression to read from (merge-base for branch diffs)
  const gitRef = useMemo(
    () => getOldFileRef(diffBase, includeUncommitted),
    [diffBase, includeUncommitted]
  );

  // Load upward expansion content
  useEffect(() => {
    if (readMore.up === 0) {
      setUpContent("");
      // Keep BOF true if hunk starts at line 1 or is a new file (oldStart=0)
      setAtBOF(hunk.oldStart <= 1);
      return;
    }
    let cancelled = false;
    setUpLoading(true);

    const startLine = Math.max(1, hunk.oldStart - readMore.up);
    const endLine = hunk.oldStart - 1;

    void readFileLines(api, workspaceId, hunk.filePath, startLine, endLine, gitRef).then(
      (lines) => {
        if (cancelled) return;
        setUpLoading(false);
        if (lines) {
          setUpContent(formatAsContextLines(lines));
          setAtBOF(startLine === 1 && lines.length < readMore.up);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [api, readMore.up, hunk.oldStart, hunk.filePath, workspaceId, gitRef]);

  // Load downward expansion content
  useEffect(() => {
    if (readMore.down === 0) {
      setDownContent("");
      setAtEOF(false);
      return;
    }
    let cancelled = false;
    setDownLoading(true);

    const hunkEnd = hunk.oldStart + hunk.oldLines - 1;
    const startLine = hunkEnd + 1;
    const endLine = hunkEnd + readMore.down;

    void readFileLines(api, workspaceId, hunk.filePath, startLine, endLine, gitRef).then(
      (lines) => {
        if (cancelled) return;
        setDownLoading(false);
        if (lines) {
          setDownContent(formatAsContextLines(lines));
          setAtEOF(lines.length < readMore.down);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [api, readMore.down, hunk.oldStart, hunk.oldLines, hunk.filePath, workspaceId, gitRef]);

  // Expand/collapse handlers
  const handleExpandUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setReadMoreMap((prev) => ({
        ...prev,
        [hunkId]: { ...readMore, up: readMore.up + LINES_PER_EXPANSION },
      }));
    },
    [hunkId, readMore, setReadMoreMap]
  );

  const handleExpandDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setReadMoreMap((prev) => ({
        ...prev,
        [hunkId]: { ...readMore, down: readMore.down + LINES_PER_EXPANSION },
      }));
    },
    [hunkId, readMore, setReadMoreMap]
  );

  const handleCollapseUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setReadMoreMap((prev) => ({
        ...prev,
        [hunkId]: { ...readMore, up: 0 },
      }));
    },
    [hunkId, readMore, setReadMoreMap]
  );

  const handleCollapseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setReadMoreMap((prev) => ({
        ...prev,
        [hunkId]: { ...readMore, down: 0 },
      }));
    },
    [hunkId, readMore, setReadMoreMap]
  );

  return {
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
  };
}
